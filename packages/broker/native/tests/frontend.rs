use std::{
    fs,
    io::{ErrorKind, Read, Write},
    net::Shutdown,
    os::unix::{
        fs::{FileTypeExt, MetadataExt, PermissionsExt, symlink},
        net::{UnixListener, UnixStream},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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

impl Frontend {
    fn start(dir: &TempDir, args: &[&str]) -> Frontend {
        Frontend::start_on(&dir.0.join("b.sock"), args, 0o022)
    }

    fn start_on(socket: &Path, args: &[&str], umask: u32) -> Frontend {
        let mut child = command(socket, args, umask).spawn().unwrap();
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

fn kernel_release() -> (u32, u32) {
    let mut name: libc::utsname = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::uname(&mut name) }, 0);
    let release = unsafe { std::ffi::CStr::from_ptr(name.release.as_ptr()) }
        .to_str()
        .unwrap();
    let mut parts = release
        .split(|c: char| !c.is_ascii_digit())
        .map(|part| part.parse().unwrap());
    (parts.next().unwrap(), parts.next().unwrap())
}

fn has_peer_pidfd() -> bool {
    let mut fds = [0; 2];
    assert_eq!(
        unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) },
        0
    );
    let mut pidfd: libc::c_int = -1;
    let mut size = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    let found = unsafe {
        libc::getsockopt(
            fds[0],
            libc::SOL_SOCKET,
            libc::SO_PEERPIDFD,
            (&raw mut pidfd).cast(),
            &mut size,
        )
    } == 0;
    unsafe {
        libc::close(fds[0]);
        libc::close(fds[1]);
        if found {
            libc::close(pidfd);
        }
    }
    found
}

// The frontend refuses to start without SO_PEERPIDFD, which
// starts_only_where_the_kernel_has_so_peerpidfd proves; every test that runs it checks first.
fn skip_without_peer_pidfd() -> bool {
    let missing = !has_peer_pidfd();
    if missing {
        eprintln!("skipped: this kernel lacks SO_PEERPIDFD (Linux 6.5)");
    }
    missing
}

fn own_cgroup() -> String {
    let text = fs::read_to_string("/proc/self/cgroup").unwrap();
    text.lines()
        .find_map(|line| line.strip_prefix("0::"))
        .unwrap()
        .to_string()
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
    if skip_without_peer_pidfd() {
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
    if skip_without_peer_pidfd() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &[]);
    let socket = std::ffi::CString::new(frontend.socket.to_str().unwrap()).unwrap();
    let pid = frontend.child.id() as libc::pid_t;
    // Stopped, the frontend cannot accept until the connecting process has exited and been reaped.
    assert_eq!(unsafe { libc::kill(pid, libc::SIGSTOP) }, 0);
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (slot, byte) in address.sun_path.iter_mut().zip(socket.as_bytes()) {
        *slot = *byte as libc::c_char;
    }
    let child = unsafe { libc::fork() };
    if child == 0 {
        // Only async-signal-safe calls between fork and _exit.
        unsafe {
            let fd = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0);
            let size = std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
            let connected = libc::connect(fd, (&raw const address).cast(), size);
            libc::_exit(if connected == 0 { 0 } else { 1 });
        }
    }
    let mut status = 0;
    assert_eq!(unsafe { libc::waitpid(child, &mut status, 0) }, child);
    assert!(libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0);
    assert_eq!(unsafe { libc::kill(pid, libc::SIGCONT) }, 0);
    let open = frontend.next();
    assert_eq!(
        (open.kind, open.payload.as_slice()),
        (OPEN, b"null".as_slice())
    );
    expect_close(&mut frontend, open.conn);
}

#[test]
fn creates_the_socket_with_its_mode_whatever_the_umask() {
    if skip_without_peer_pidfd() {
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

#[test]
fn forwards_each_request_and_writes_its_reply() {
    if skip_without_peer_pidfd() {
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
    if skip_without_peer_pidfd() {
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
    if skip_without_peer_pidfd() {
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

fn peak_kib(frontend: &Frontend) -> u64 {
    let status = fs::read_to_string(format!("/proc/{}/status", frontend.child.id())).unwrap();
    status
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))
        .and_then(|value| value.trim().strip_suffix("kB"))
        .and_then(|value| value.trim().parse().ok())
        .unwrap()
}

#[test]
fn forwards_a_16_mib_request_holding_one_copy_of_it() {
    if skip_without_peer_pidfd() {
        return;
    }
    let dir = TempDir::new();
    let mut frontend = Frontend::start(&dir, &[]);
    let (client, conn) = frontend.connect();
    let before = peak_kib(&frontend);
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
    let grown = peak_kib(&frontend) - before;
    assert!(grown < 24 << 10, "the frontend grew by {grown} KiB");
}

#[test]
fn takes_frames_of_1_byte_to_16_mib_and_drops_a_client_that_sends_another() {
    if skip_without_peer_pidfd() {
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
    if skip_without_peer_pidfd() {
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
    if skip_without_peer_pidfd() {
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
    if skip_without_peer_pidfd() {
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
    if skip_without_peer_pidfd() {
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
    if skip_without_peer_pidfd() {
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
    if skip_without_peer_pidfd() {
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
    if skip_without_peer_pidfd() {
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
fn exits_on_a_parent_message_it_does_not_accept() {
    if skip_without_peer_pidfd() {
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
    if skip_without_peer_pidfd() {
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
    if skip_without_peer_pidfd() {
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
    if skip_without_peer_pidfd() {
        return;
    }
    let dir = TempDir::new();
    let path = dir.0.join("b.sock");
    drop(UnixListener::bind(&path).unwrap());
    assert!(fs::symlink_metadata(&path).unwrap().file_type().is_socket());
    let mut frontend = Frontend::start_on(&path, &[], 0o022);
    let (_client, conn) = frontend.connect();
    assert_eq!(conn, 1);
}

#[test]
fn starts_only_where_the_kernel_has_so_peerpidfd() {
    let dir = TempDir::new();
    if has_peer_pidfd() {
        Frontend::start(&dir, &[]);
        return;
    }
    let (major, minor) = kernel_release();
    assert!(
        (major, minor) < (6, 5),
        "SO_PEERPIDFD is missing on Linux {major}.{minor}"
    );
    let (status, stderr) = exit_with(&dir.0.join("b.sock"), &[]);
    assert_eq!(status.code(), Some(1));
    assert!(stderr.contains("lacks SO_PEERPIDFD"), "{stderr}");
}
