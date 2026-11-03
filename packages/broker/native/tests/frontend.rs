mod support;

use std::{
    fs,
    io::{ErrorKind, Read, Write},
    net::Shutdown,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{
            fs::{FileTypeExt, MetadataExt, PermissionsExt, symlink},
            net::{UnixListener, UnixStream},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use support::{
    Connector, cgroup_dir, cgroups_or_skip, connect_from_child, kernel_release, own_cgroup,
    stale_socket,
};

const READY: u8 = 0;
const OPEN: u8 = 1;
const FRAME: u8 = 2;
const CLOSE: u8 = 3;
const MAX_FRAME: usize = 16 << 20;
const WAIT: Duration = Duration::from_secs(20);
const QUIET: Duration = Duration::from_millis(500);

struct Event {
    kind: u8,
    conn: u64,
    payload: Vec<u8>,
}

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> TempDir {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .subsec_nanos();
        let dir = std::env::temp_dir().join(format!(
            "orynq-sf-{}-{nanos}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).unwrap();
        TempDir(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).ok();
    }
}

struct Frontend {
    child: Child,
    stdin: Option<ChildStdin>,
    events: mpsc::Receiver<Event>,
    socket: PathBuf,
}

fn command(socket: &Path, args: &[&str], umask: u32) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_orynq-socket-frontend"));
    command
        .arg("--socket")
        .arg(socket)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The child alone takes this umask, between fork and exec.
    unsafe {
        command.pre_exec(move || {
            libc::umask(umask);
            Ok(())
        });
    }
    command
}

// The descriptor limit the frontend sizes its connection ceiling by, set in the child alone.
fn limit_descriptors(command: &mut Command, descriptors: libc::rlim_t) {
    unsafe {
        command.pre_exec(move || {
            let limit = libc::rlimit {
                rlim_cur: descriptors,
                rlim_max: descriptors,
            };
            if libc::setrlimit(libc::RLIMIT_NOFILE, &limit) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}

impl Frontend {
    fn start(dir: &TempDir, args: &[&str]) -> Frontend {
        Frontend::start_on(&dir.0.join("b.sock"), args, 0o022)
    }

    fn start_on(socket: &Path, args: &[&str], umask: u32) -> Frontend {
        Frontend::spawn(command(socket, args, umask), socket)
    }

    fn start_with_descriptors(dir: &TempDir, descriptors: libc::rlim_t) -> Frontend {
        let socket = dir.0.join("b.sock");
        let mut command = command(&socket, &[], 0o022);
        limit_descriptors(&mut command, descriptors);
        Frontend::spawn(command, &socket)
    }

    fn spawn(mut command: Command, socket: &Path) -> Frontend {
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take();
        let mut stdout = child.stdout.take().unwrap();
        let (tx, events) = mpsc::channel();
        thread::spawn(move || {
            loop {
                let mut header = [0u8; 4];
                if stdout.read_exact(&mut header).is_err() {
                    return;
                }
                let mut body = vec![0u8; u32::from_be_bytes(header) as usize];
                if stdout.read_exact(&mut body).is_err() {
                    return;
                }
                let event = Event {
                    kind: body[0],
                    conn: u64::from_be_bytes(body[1..9].try_into().unwrap()),
                    payload: body[9..].to_vec(),
                };
                if tx.send(event).is_err() {
                    return;
                }
            }
        });
        let mut frontend = Frontend {
            child,
            stdin,
            events,
            socket: socket.to_path_buf(),
        };
        let ready = frontend.next();
        assert_eq!((ready.kind, ready.conn, ready.payload.len()), (READY, 0, 0));
        frontend
    }

    fn next(&mut self) -> Event {
        self.events
            .recv_timeout(WAIT)
            .expect("no event from the frontend")
    }

    fn quiet(&mut self) -> bool {
        self.events.recv_timeout(QUIET).is_err()
    }

    fn send(&mut self, kind: u8, conn: u64, payload: &[u8]) {
        let mut message = (9 + payload.len() as u32).to_be_bytes().to_vec();
        message.push(kind);
        message.extend_from_slice(&conn.to_be_bytes());
        message.extend_from_slice(payload);
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(&message).unwrap();
        stdin.flush().unwrap();
    }

    fn connect(&mut self) -> (UnixStream, u64) {
        let client = UnixStream::connect(&self.socket).unwrap();
        let open = self.next();
        assert_eq!(open.kind, OPEN);
        (client, open.conn)
    }

    fn wait(&mut self) -> ExitStatus {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "the frontend did not exit");
            thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Frontend {
    fn drop(&mut self) {
        self.child.kill().ok();
        self.child.wait().ok();
    }
}

fn frame(payload: &[u8]) -> Vec<u8> {
    let mut framed = (payload.len() as u32).to_be_bytes().to_vec();
    framed.extend_from_slice(payload);
    framed
}

fn read_frame(client: &mut UnixStream) -> Vec<u8> {
    let mut header = [0u8; 4];
    client.read_exact(&mut header).unwrap();
    let mut body = vec![0u8; u32::from_be_bytes(header) as usize];
    client.read_exact(&mut body).unwrap();
    body
}

fn assert_closed(client: &mut UnixStream) {
    client.set_read_timeout(Some(WAIT)).unwrap();
    let mut byte = [0u8; 1];
    match client.read(&mut byte) {
        Ok(0) => {}
        Err(error) if error.kind() == ErrorKind::ConnectionReset => {}
        other => panic!("the connection is still open: {other:?}"),
    }
}

fn expect_close(frontend: &mut Frontend, conn: u64) {
    let event = frontend.next();
    assert_eq!(
        (event.kind, event.conn, event.payload.len()),
        (CLOSE, conn, 0)
    );
}

// Whether this kernel reports a peer's cgroup id: SO_PEERPIDFD (Linux 6.5) names the peer and
// PIDFD_GET_INFO (Linux 6.13) gives its cgroup id.
fn kernel_reports_cgroup_ids() -> bool {
    let mut fds = [0; 2];
    assert_eq!(
        unsafe {
            libc::socketpair(
                libc::AF_UNIX,
                libc::SOCK_STREAM | libc::SOCK_CLOEXEC,
                0,
                fds.as_mut_ptr(),
            )
        },
        0
    );
    let [ours, _theirs] = fds.map(|fd| unsafe { OwnedFd::from_raw_fd(fd) });
    let mut pidfd: libc::c_int = -1;
    let mut size = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    let found = unsafe {
        libc::getsockopt(
            ours.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERPIDFD,
            (&raw mut pidfd).cast(),
            &mut size,
        )
    } == 0;
    if !found {
        return false;
    }
    let pidfd = unsafe { OwnedFd::from_raw_fd(pidfd) };
    let mut info: libc::pidfd_info = unsafe { std::mem::zeroed() };
    info.mask = u64::from(libc::PIDFD_INFO_CGROUPID);
    let reported =
        unsafe { libc::ioctl(pidfd.as_raw_fd(), libc::PIDFD_GET_INFO, &raw mut info) } == 0;
    reported && info.mask & u64::from(libc::PIDFD_INFO_CGROUPID) != 0
}

// The frontend refuses to start where the kernel cannot report a peer's cgroup id, which
// starts_only_where_the_kernel_reports_a_peers_cgroup_id proves; every test that runs it checks
// first.
fn skip_without_cgroup_ids() -> bool {
    let missing = !kernel_reports_cgroup_ids();
    if missing {
        eprintln!("skipped: this kernel cannot report a peer's cgroup id (Linux 6.13)");
    }
    missing
}

fn is_closed(mut client: &UnixStream) -> bool {
    client.set_nonblocking(true).unwrap();
    let mut byte = [0u8; 1];
    match client.read(&mut byte) {
        Ok(0) => true,
        Err(error) if error.kind() == ErrorKind::ConnectionReset => true,
        Err(error) if error.kind() == ErrorKind::WouldBlock => false,
        other => panic!("unexpected read: {other:?}"),
    }
}

fn exit_with(socket: &Path, args: &[&str]) -> (ExitStatus, String) {
    let output = command(socket, args, 0o022)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    (output.status, String::from_utf8(output.stderr).unwrap())
}

#[test]
fn opens_each_connection_with_the_identity_the_kernel_recorded() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &[]);
    let _first = UnixStream::connect(&frontend.socket).unwrap();
    let open = frontend.next();
    assert_eq!((open.kind, open.conn), (OPEN, 1));
    let peer: serde_json::Value = serde_json::from_slice(&open.payload).unwrap();
    let keys: Vec<&String> = peer.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["cgroup", "gid", "os", "pidHint", "uid"]);
    assert_eq!(peer["os"], "linux");
    assert_eq!(peer["uid"], unsafe { libc::getuid() });
    assert_eq!(peer["gid"], unsafe { libc::getgid() });
    assert_eq!(peer["pidHint"], std::process::id());
    assert_eq!(peer["cgroup"], own_cgroup());
    let _second = UnixStream::connect(&frontend.socket).unwrap();
    assert_eq!(frontend.next().conn, 2);
}

#[test]
fn opens_with_null_when_the_connecting_process_is_gone() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &[]);
    let clients = connect_and_vanish(&mut frontend, 1);
    let open = frontend.next();
    assert_eq!(
        (open.kind, open.payload.as_slice()),
        (OPEN, b"null".as_slice())
    );
    drop(clients);
    expect_close(&mut frontend, open.conn);
}

// Connects `count` clients from a child that exits and is reaped before the frontend, stopped
// meanwhile, can accept them and ask who connected.
fn connect_and_vanish(frontend: &mut Frontend, count: usize) -> Vec<UnixStream> {
    let pid = frontend.child.id() as libc::pid_t;
    assert_eq!(unsafe { libc::kill(pid, libc::SIGSTOP) }, 0);
    let (mut connector, clients) = connect_from_child(&frontend.socket, count, None, &["true"]);
    assert!(connector.0.wait().unwrap().success());
    assert_eq!(unsafe { libc::kill(pid, libc::SIGCONT) }, 0);
    clients
}

#[test]
fn admits_at_most_32_unidentified_connections() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &[]);
    let clients = connect_and_vanish(&mut frontend, 33);
    for _ in 0..32 {
        let open = frontend.next();
        assert_eq!(
            (open.kind, open.payload.as_slice()),
            (OPEN, b"null".as_slice())
        );
    }
    assert!(frontend.quiet());
    assert_eq!(clients.iter().filter(|c| is_closed(c)).count(), 1);
}

#[test]
fn admits_at_most_128_connections_per_uid_across_its_cgroups() {
    if skip_without_cgroup_ids() {
        return;
    }
    let Some(cgroups) = cgroups_or_skip(5) else {
        return;
    };
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &[]);
    let expect_opens = |frontend: &mut Frontend, connector: &Connector, cgroup: &Path, count| {
        for _ in 0..count {
            let open = frontend.next();
            assert_eq!(open.kind, OPEN);
            let peer: serde_json::Value = serde_json::from_slice(&open.payload).unwrap();
            assert_eq!(peer["pidHint"], connector.0.id());
            assert_eq!(cgroup_dir(peer["cgroup"].as_str().unwrap()), cgroup);
        }
    };
    let mut held = Vec::new();
    for cgroup in &cgroups.0[..4] {
        let (connector, clients) =
            connect_from_child(&frontend.socket, 32, Some(cgroup), &["sleep", "600"]);
        expect_opens(&mut frontend, &connector, cgroup, 32);
        held.push((connector, clients));
    }
    let fifth = &cgroups.0[4];
    let (_refused_by, mut refused) =
        connect_from_child(&frontend.socket, 1, Some(fifth), &["sleep", "600"]);
    assert_closed(&mut refused[0]);
    assert!(frontend.quiet());
    drop(held[0].1.pop());
    assert_eq!(frontend.next().kind, CLOSE);
    let (admitter, _admitted) =
        connect_from_child(&frontend.socket, 1, Some(fifth), &["sleep", "600"]);
    expect_opens(&mut frontend, &admitter, fifth, 1);
}

#[test]
fn admits_no_more_connections_than_its_descriptors_allow() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    // The frontend keeps 64 descriptors for itself, which leaves three for connections.
    let mut frontend = Frontend::start_with_descriptors(&dir, 67);
    let mut clients: Vec<(UnixStream, u64)> = (0..3).map(|_| frontend.connect()).collect();
    let mut refused = UnixStream::connect(&frontend.socket).unwrap();
    assert_closed(&mut refused);
    assert!(frontend.quiet());
    let (client, conn) = clients.pop().unwrap();
    drop(client);
    expect_close(&mut frontend, conn);
    let (_again, _) = frontend.connect();
}

#[test]
fn refuses_to_start_without_a_descriptor_for_a_connection() {
    let dir = TempDir::new();
    let mut command = command(&dir.0.join("b.sock"), &[], 0o022);
    limit_descriptors(&mut command, 64);
    let output = command.stdin(Stdio::null()).output().unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert_eq!(output.status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("RLIMIT_NOFILE"), "{stderr}");
    assert!(!dir.0.join("b.sock").exists());
}

#[test]
fn creates_the_socket_with_its_mode_whatever_the_umask() {
    if skip_without_cgroup_ids() {
        return;
    }
    for (umask, args, mode) in [
        (0o000, vec![], 0o600),
        (0o777, vec!["--mode", "0660"], 0o660),
        (0o022, vec!["--mode", "666"], 0o666),
    ] {
        let dir = TempDir::new();
        let frontend = Frontend::start_on(&dir.0.join("b.sock"), &args, umask);
        let meta = fs::symlink_metadata(&frontend.socket).unwrap();
        assert!(meta.file_type().is_socket());
        assert_eq!(meta.uid(), unsafe { libc::getuid() });
        assert_eq!(meta.permissions().mode() & 0o7777, mode);
    }
}

#[test]
fn refuses_a_mode_that_is_not_read_write_bits_with_the_owner_able_to_connect() {
    let dir = TempDir::new();
    for mode in ["0700", "0400", "04600", "0601x", "", "1000000"] {
        let (status, stderr) = exit_with(&dir.0.join("b.sock"), &["--mode", mode]);
        assert_eq!(status.code(), Some(1), "{mode}");
        assert!(stderr.contains("--mode"), "{stderr}");
    }
    assert!(!dir.0.join("b.sock").exists());
}

// A connection's deadline is now plus the idle period, which overflows the clock past some bound.
#[test]
fn refuses_an_idle_period_outside_1_second_to_a_day() {
    let dir = TempDir::new();
    for idle in ["0", "86401", "18446744073709551615", "-1", "1.5", ""] {
        let (status, stderr) = exit_with(&dir.0.join("b.sock"), &["--idle-secs", idle]);
        assert_eq!(status.code(), Some(1), "{idle}");
        assert!(stderr.contains("--idle-secs"), "{stderr}");
    }
    assert!(!dir.0.join("b.sock").exists());
}

#[test]
fn serves_a_connection_at_either_end_of_its_idle_period_bounds() {
    if skip_without_cgroup_ids() {
        return;
    }
    for idle in ["1", "86400"] {
        let dir = TempDir::new();
        let mut frontend = Frontend::start(&dir, &["--idle-secs", idle]);
        let (mut client, conn) = frontend.connect();
        client.write_all(&frame(b"ping")).unwrap();
        assert_eq!(frontend.next().kind, FRAME, "{idle}");
        frontend.send(FRAME, conn, b"pong");
        assert_eq!(read_frame(&mut client), b"pong");
    }
}

#[test]
fn forwards_each_request_and_writes_its_reply() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &[]);
    let (mut client, conn) = frontend.connect();
    for request in [b"{\"id\":1}".as_slice(), b"{\"id\":2}"] {
        client.write_all(&frame(request)).unwrap();
        let event = frontend.next();
        assert_eq!(
            (event.kind, event.conn, event.payload.as_slice()),
            (FRAME, conn, request)
        );
        frontend.send(FRAME, conn, b"reply");
        assert_eq!(read_frame(&mut client), b"reply");
    }
}

#[test]
fn closes_a_connection_that_sends_a_request_before_its_reply() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &[]);
    let (mut client, conn) = frontend.connect();
    client
        .write_all(&[frame(b"a"), frame(b"b")].concat())
        .unwrap();
    assert_eq!(frontend.next().kind, FRAME);
    expect_close(&mut frontend, conn);
    assert_closed(&mut client);

    let (mut client, conn) = frontend.connect();
    client.write_all(&frame(b"a")).unwrap();
    assert_eq!(frontend.next().kind, FRAME);
    client.write_all(&frame(b"b")).unwrap();
    expect_close(&mut frontend, conn);
    assert_closed(&mut client);
}

#[test]
fn closes_a_connection_on_the_first_byte_it_sends_while_a_request_runs() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &[]);
    let (mut client, conn) = frontend.connect();
    client.write_all(&frame(b"a")).unwrap();
    assert_eq!(frontend.next().kind, FRAME);
    client.write_all(&[0]).unwrap();
    expect_close(&mut frontend, conn);
    assert_closed(&mut client);
}

fn peak_kib(pid: u32) -> u64 {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    status
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))
        .and_then(|value| value.trim().strip_suffix("kB"))
        .and_then(|value| value.trim().parse().ok())
        .unwrap()
}

#[test]
fn forwards_a_16_mib_request_holding_one_copy_of_it() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &[]);
    let (client, conn) = frontend.connect();
    let before = peak_kib(frontend.child.id());
    let writer = {
        let mut client = client.try_clone().unwrap();
        thread::spawn(move || client.write_all(&frame(&vec![0x61u8; MAX_FRAME])).unwrap())
    };
    let event = frontend.next();
    writer.join().unwrap();
    assert_eq!(
        (event.kind, event.conn, event.payload.len()),
        (FRAME, conn, MAX_FRAME)
    );
    let grown = peak_kib(frontend.child.id()) - before;
    assert!(grown < 24 << 10, "the frontend grew by {grown} KiB");
}

/// A frontend whose READY was read and nothing after it, so whatever it forwards waits on a full
/// stdout.
struct Stalled {
    child: Child,
    _stdin: ChildStdin,
    _stdout: ChildStdout,
    socket: PathBuf,
}

impl Stalled {
    fn start(dir: &TempDir) -> Stalled {
        let socket = dir.0.join("b.sock");
        let mut child = command(&socket, &[], 0o022).spawn().unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let mut ready = [0u8; 13];
        stdout.read_exact(&mut ready).unwrap();
        assert_eq!(ready, [0, 0, 0, 9, READY, 0, 0, 0, 0, 0, 0, 0, 0]);
        Stalled {
            child,
            _stdin: stdin,
            _stdout: stdout,
            socket,
        }
    }
}

impl Drop for Stalled {
    fn drop(&mut self) {
        self.child.kill().ok();
        self.child.wait().ok();
    }
}

#[test]
fn holds_at_most_16_mib_of_one_peers_requests_while_its_parent_reads_nothing() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let frontend = Stalled::start(&dir);
    let before = peak_kib(frontend.child.id());
    let request = Arc::new(frame(&vec![0x62u8; MAX_FRAME]));
    let clients: Vec<UnixStream> = (0..32)
        .map(|_| UnixStream::connect(&frontend.socket).unwrap())
        .collect();
    // Each client pipelines two requests; a write the frontend leaves unread gives up after 2 s.
    let writers: Vec<_> = clients
        .iter()
        .map(|client| {
            let mut client = client.try_clone().unwrap();
            let request = Arc::clone(&request);
            client
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            thread::spawn(move || {
                for _ in 0..2 {
                    if client.write_all(&request).is_err() {
                        return;
                    }
                }
            })
        })
        .collect();
    for writer in writers {
        writer.join().unwrap();
    }
    let grown = peak_kib(frontend.child.id()) - before;
    assert!(grown < 40 << 10, "the frontend grew by {grown} KiB");
}

// Every agent session runs as one uid, each in its own unit cgroup.
#[test]
fn serves_one_cgroup_of_a_uid_while_another_stalls_four_16_mib_requests() {
    if skip_without_cgroup_ids() {
        return;
    }
    let Some(cgroups) = cgroups_or_skip(2) else {
        return;
    };
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &["--idle-secs", "30"]);
    let (_stalling, mut stalled) =
        connect_from_child(&frontend.socket, 4, Some(&cgroups.0[0]), &["sleep", "600"]);
    for client in &mut stalled {
        assert_eq!(frontend.next().kind, OPEN);
        client.write_all(&(MAX_FRAME as u32).to_be_bytes()).unwrap();
    }
    // Long enough for the frontend to read each announced length and reserve it.
    thread::sleep(QUIET);
    let (_serving, mut served) =
        connect_from_child(&frontend.socket, 1, Some(&cgroups.0[1]), &["sleep", "600"]);
    let open = frontend.next();
    assert_eq!(open.kind, OPEN);
    served[0].write_all(&frame(b"hello")).unwrap();
    let event = frontend
        .events
        .recv_timeout(Duration::from_secs(5))
        .expect("the request waited on another cgroup's stalled ones");
    assert_eq!(
        (event.kind, event.conn, event.payload.as_slice()),
        (FRAME, open.conn, b"hello".as_slice())
    );
}

#[test]
fn takes_frames_of_1_byte_to_16_mib_and_drops_a_client_that_sends_another() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &[]);
    for length in [0u32, (MAX_FRAME + 1) as u32, u32::MAX] {
        let (mut client, conn) = frontend.connect();
        client.write_all(&length.to_be_bytes()).unwrap();
        expect_close(&mut frontend, conn);
        assert_closed(&mut client);
    }
    let (mut client, conn) = frontend.connect();
    let largest = vec![0x78u8; MAX_FRAME];
    let writer = {
        let mut client = client.try_clone().unwrap();
        let framed = frame(&largest);
        thread::spawn(move || client.write_all(&framed).unwrap())
    };
    let event = frontend.next();
    writer.join().unwrap();
    assert_eq!(
        (event.kind, event.conn, event.payload.len()),
        (FRAME, conn, MAX_FRAME)
    );
    assert!(event.payload == largest);
    frontend.send(FRAME, conn, &largest);
    assert!(read_frame(&mut client) == largest);
}

#[test]
fn closes_a_connection_that_completes_no_request_while_idle() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &["--idle-secs", "1"]);
    let started = Instant::now();
    let (mut client, conn) = frontend.connect();
    client.write_all(&[0, 0]).unwrap();
    thread::sleep(Duration::from_millis(600));
    client.write_all(&[0]).unwrap();
    expect_close(&mut frontend, conn);
    let waited = started.elapsed();
    assert!(
        waited >= Duration::from_millis(900) && waited < Duration::from_millis(1500),
        "{waited:?}"
    );
    assert_closed(&mut client);
}

#[test]
fn stops_the_idle_clock_while_a_request_runs_and_restarts_it_when_the_reply_drains() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &["--idle-secs", "2"]);
    let (mut client, conn) = frontend.connect();
    client.write_all(&frame(b"slow")).unwrap();
    assert_eq!(frontend.next().kind, FRAME);
    thread::sleep(Duration::from_millis(2500));
    frontend.send(FRAME, conn, b"late");
    assert_eq!(read_frame(&mut client), b"late");
    let drained = Instant::now();
    expect_close(&mut frontend, conn);
    let waited = drained.elapsed();
    assert!(
        waited >= Duration::from_millis(1800) && waited < Duration::from_millis(2600),
        "{waited:?}"
    );
}

#[test]
fn closes_a_connection_whose_client_leaves_its_reply_unread() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &["--idle-secs", "1"]);
    let (client, conn) = frontend.connect();
    (&client).write_all(&frame(b"big")).unwrap();
    assert_eq!(frontend.next().kind, FRAME);
    let sent = Instant::now();
    frontend.send(FRAME, conn, &vec![0u8; 8 << 20]);
    expect_close(&mut frontend, conn);
    let waited = sent.elapsed();
    assert!(
        waited >= Duration::from_millis(900) && waited < Duration::from_millis(3000),
        "{waited:?}"
    );
    drop(client);
}

#[test]
fn answers_a_client_that_half_closes_after_its_request_then_closes() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &[]);
    let (mut client, conn) = frontend.connect();
    client.write_all(&frame(b"last")).unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    assert_eq!(frontend.next().kind, FRAME);
    assert!(frontend.quiet());
    frontend.send(FRAME, conn, b"answer");
    assert_eq!(read_frame(&mut client), b"answer");
    expect_close(&mut frontend, conn);
    assert_closed(&mut client);

    let (client, conn) = frontend.connect();
    client.shutdown(Shutdown::Write).unwrap();
    expect_close(&mut frontend, conn);
}

#[test]
fn closes_a_connection_when_the_parent_closes_it_or_answers_no_request() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &[]);
    let (mut client, conn) = frontend.connect();
    frontend.send(CLOSE, conn, &[]);
    expect_close(&mut frontend, conn);
    assert_closed(&mut client);

    let (mut client, conn) = frontend.connect();
    frontend.send(FRAME, conn, b"unasked");
    expect_close(&mut frontend, conn);
    assert_closed(&mut client);

    frontend.send(CLOSE, 999, &[]);
    frontend.send(FRAME, 999, b"nobody");
    let (_client, _) = frontend.connect();
}

#[test]
fn admits_at_most_32_connections_per_peer() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &[]);
    let mut clients: Vec<(UnixStream, u64)> = (0..32).map(|_| frontend.connect()).collect();
    let mut refused = UnixStream::connect(&frontend.socket).unwrap();
    assert_closed(&mut refused);
    assert!(frontend.quiet());
    let (client, conn) = clients.pop().unwrap();
    drop(client);
    expect_close(&mut frontend, conn);
    let (_again, _) = frontend.connect();
}

#[test]
fn exits_when_stdin_closes_and_removes_its_socket() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &[]);
    let (mut client, _) = frontend.connect();
    drop(frontend.stdin.take());
    assert_eq!(frontend.wait().code(), Some(0));
    assert!(!frontend.socket.exists());
    assert_closed(&mut client);
}

#[test]
fn leaves_the_socket_another_frontend_bound_at_its_path_when_it_exits() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut first = Frontend::start(&dir, &[]);
    fs::remove_file(&first.socket).unwrap();
    let mut second = Frontend::start(&dir, &[]);
    drop(first.stdin.take());
    assert_eq!(first.wait().code(), Some(0));
    let (_client, conn) = second.connect();
    assert_eq!(conn, 1);
}

#[test]
fn exits_on_a_parent_message_it_does_not_accept() {
    if skip_without_cgroup_ids() {
        return;
    }
    let mut cases: Vec<Vec<u8>> = vec![
        vec![0, 0, 0, 8],
        ((9 + MAX_FRAME + 1) as u32).to_be_bytes().to_vec(),
    ];
    for (kind, payload) in [
        (READY, &b""[..]),
        (OPEN, b"null"),
        (4, b"x"),
        (FRAME, b""),
        (CLOSE, b"x"),
    ] {
        let mut message = (9 + payload.len() as u32).to_be_bytes().to_vec();
        message.push(kind);
        message.extend_from_slice(&1u64.to_be_bytes());
        message.extend_from_slice(payload);
        cases.push(message);
    }
    for message in cases {
        let dir = TempDir::new();
        let mut frontend = Frontend::start(&dir, &[]);
        let stdin = frontend.stdin.as_mut().unwrap();
        stdin.write_all(&message).unwrap();
        stdin.flush().unwrap();
        assert_eq!(frontend.wait().code(), Some(2), "{message:?}");
    }
}

#[test]
fn refuses_a_path_that_exists_and_is_not_its_own_socket() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let file = dir.0.join("file");
    fs::write(&file, b"keep").unwrap();
    let directory = dir.0.join("dir");
    fs::create_dir(&directory).unwrap();
    let dangling = dir.0.join("dangling");
    symlink(dir.0.join("nowhere"), &dangling).unwrap();
    let stale = dir.0.join("stale.sock");
    drop(UnixListener::bind(&stale).unwrap());
    let link = dir.0.join("link");
    symlink(&stale, &link).unwrap();
    for path in [&file, &directory, &dangling, &link] {
        let (status, stderr) = exit_with(path, &[]);
        assert_eq!(status.code(), Some(1), "{path:?}");
        assert!(
            stderr.contains("exists and is not this account's socket"),
            "{stderr}"
        );
    }
    assert_eq!(fs::read(&file).unwrap(), b"keep");
    assert!(directory.is_dir());
    assert!(
        fs::symlink_metadata(&dangling)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[test]
fn refuses_a_socket_another_process_is_serving() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let mut serving = Frontend::start(&dir, &[]);
    let (status, stderr) = exit_with(&serving.socket, &[]);
    assert_eq!(status.code(), Some(1));
    assert!(stderr.contains("is in use"), "{stderr}");
    let (_client, _) = serving.connect();
}

#[test]
fn replaces_its_own_stale_socket() {
    if skip_without_cgroup_ids() {
        return;
    }
    let dir = TempDir::new();
    let path = dir.0.join("b.sock");
    stale_socket(&path);
    assert!(fs::symlink_metadata(&path).unwrap().file_type().is_socket());
    let mut frontend = Frontend::start_on(&path, &[], 0o022);
    let (_client, conn) = frontend.connect();
    assert_eq!(conn, 1);
}

#[test]
fn starts_only_where_the_kernel_reports_a_peers_cgroup_id() {
    let dir = TempDir::new();
    if kernel_reports_cgroup_ids() {
        Frontend::start(&dir, &[]);
        return;
    }
    let (major, minor) = kernel_release();
    assert!(
        (major, minor) < (6, 13),
        "PIDFD_GET_INFO is missing on Linux {major}.{minor}"
    );
    let (status, stderr) = exit_with(&dir.0.join("b.sock"), &[]);
    assert_eq!(status.code(), Some(1));
    assert!(
        stderr.contains("cannot identify a peer by its cgroup"),
        "{stderr}"
    );
}

// Answers PIDFD_GET_INFO with ENOTTY in the child alone, as a kernel before 6.13 does.
fn refuse_pidfd_get_info(command: &mut Command) {
    let statement = |code: u32, k: u32| libc::sock_filter {
        code: code as u16,
        jt: 0,
        jf: 0,
        k,
    };
    let jump = |k: u32, jf: u8| libc::sock_filter {
        code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
        jt: 0,
        jf,
        k,
    };
    let filter = [
        statement(libc::BPF_LD | libc::BPF_W | libc::BPF_ABS, 0),
        jump(libc::SYS_ioctl as u32, 3),
        // The low half of the request, args[1], on a little-endian machine.
        statement(libc::BPF_LD | libc::BPF_W | libc::BPF_ABS, 24),
        jump(libc::PIDFD_GET_INFO as u32, 1),
        statement(
            libc::BPF_RET | libc::BPF_K,
            libc::SECCOMP_RET_ERRNO | libc::ENOTTY as u32,
        ),
        statement(libc::BPF_RET | libc::BPF_K, libc::SECCOMP_RET_ALLOW),
    ];
    unsafe {
        command.pre_exec(move || {
            let program = libc::sock_fprog {
                len: filter.len() as u16,
                filter: filter.as_ptr().cast_mut(),
            };
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
                || libc::syscall(
                    libc::SYS_seccomp,
                    libc::SECCOMP_SET_MODE_FILTER,
                    0,
                    &raw const program,
                ) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[test]
fn refuses_to_start_where_the_kernel_cannot_report_a_peers_cgroup_id() {
    let dir = TempDir::new();
    let mut command = command(&dir.0.join("b.sock"), &[], 0o022);
    refuse_pidfd_get_info(&mut command);
    let output = command.stdin(Stdio::null()).output().unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert_eq!(output.status.code(), Some(1), "{stderr}");
    assert!(
        stderr.contains("cannot identify a peer by its cgroup"),
        "{stderr}"
    );
    assert!(!dir.0.join("b.sock").exists());
}
