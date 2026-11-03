//! Unix-socket transport for the orynq credential broker on Linux.
//!
//! This process owns the broker's socket and hands `{connId, peer, frame}` to its Node parent over
//! stdio, with each caller's identity taken from the kernel. It never parses a frame or JSON.
//!
//! stdio messages, both directions: `u32 length | u8 kind | u64 connId | payload`, big-endian, where
//! length counts kind, connId and payload. Kinds: 0 ready, 1 open (payload: peer JSON or `null`),
//! 2 frame, 3 close. The parent sends only frame (a response) and close.

use std::{
    collections::HashMap,
    ffi::CString,
    fs, io,
    mem::{MaybeUninit, offset_of, size_of},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{
            ffi::OsStrExt,
            fs::{FileTypeExt, MetadataExt},
            net::{UnixListener as StdUnixListener, UnixStream as StdUnixStream},
        },
    },
    path::{Path, PathBuf},
    process,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream, unix::OwnedReadHalf},
    sync::mpsc,
    time::{Instant, sleep, sleep_until, timeout},
};

const READY: u8 = 0;
const OPEN: u8 = 1;
const FRAME: u8 = 2;
const CLOSE: u8 = 3;
const MAX_FRAME: u32 = 16 << 20;
const MAX_PER_PEER: usize = 32;
// Across a uid's gids and cgroups, both of which the account can multiply.
const MAX_PER_UID: usize = 128;
const MAX_CONNECTIONS: usize = 1024;
// Descriptors kept back from connections: stdio, the runtime's and the listener's, and the pidfd
// and /proc file each identification opens.
const RESERVED_FDS: libc::rlim_t = 64;
const BACKLOG: libc::c_int = 128;
const CGROUP_ROOT: &str = "/sys/fs/cgroup";

struct Config {
    socket: PathBuf,
    mode: u32,
    idle: Duration,
}

enum Command {
    Frame(Vec<u8>),
    Close,
}

enum Incoming {
    /// A request, already framed as the FRAME message that carries it to the parent.
    Request(Vec<u8>),
    End,
}

/// The socket file this process created, so it removes only that file on exit.
struct SocketFile {
    path: PathBuf,
    dev: u64,
    ino: u64,
}

impl SocketFile {
    fn remove(&self) {
        let ours = fs::symlink_metadata(&self.path)
            .is_ok_and(|meta| meta.dev() == self.dev && meta.ino() == self.ino);
        if ours {
            fs::remove_file(&self.path).ok();
        }
    }
}

struct Shared {
    out: mpsc::Sender<Vec<u8>>,
    conns: Mutex<HashMap<u64, mpsc::Sender<Command>>>,
    limits: Arc<Limits>,
    idle: Duration,
    socket: SocketFile,
}

/// The connections admitted, counted per peer (every unidentified client together is one), per
/// uid (None for the unidentified) and in all.
struct Limits {
    max_connections: usize,
    admitted: Mutex<Admitted>,
}

#[derive(Default)]
struct Admitted {
    peers: HashMap<String, usize>,
    uids: HashMap<Option<u32>, usize>,
    total: usize,
}

impl Limits {
    fn new(max_connections: usize) -> Arc<Limits> {
        Arc::new(Limits {
            max_connections,
            admitted: Mutex::default(),
        })
    }

    fn admitted(&self) -> std::sync::MutexGuard<'_, Admitted> {
        self.admitted
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn claim(self: &Arc<Self>, peer: Option<&Peer>) -> Option<Slot> {
        let key = peer.map_or_else(String::new, Peer::key);
        let uid = peer.map(|peer| peer.uid);
        let mut admitted = self.admitted();
        if admitted.total >= self.max_connections
            || admitted.peers.get(&key).is_some_and(|&n| n >= MAX_PER_PEER)
            || admitted.uids.get(&uid).is_some_and(|&n| n >= MAX_PER_UID)
        {
            return None;
        }
        admitted.total += 1;
        *admitted.peers.entry(key.clone()).or_default() += 1;
        *admitted.uids.entry(uid).or_default() += 1;
        Some(Slot {
            limits: Arc::clone(self),
            key,
            uid,
        })
    }
}

struct Slot {
    limits: Arc<Limits>,
    key: String,
    uid: Option<u32>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut admitted = self.limits.admitted();
        admitted.total -= 1;
        release(&mut admitted.peers, &self.key);
        release(&mut admitted.uids, &self.uid);
    }
}

fn release<K: Eq + std::hash::Hash>(counts: &mut HashMap<K, usize>, key: &K) {
    if let Some(count) = counts.get_mut(key) {
        *count -= 1;
        if *count == 0 {
            counts.remove(key);
        }
    }
}

impl Shared {
    async fn emit(&self, kind: u8, conn: u64, payload: &[u8]) {
        self.send(message(kind, conn, payload)).await;
    }

    async fn send(&self, message: Vec<u8>) {
        if self.out.send(message).await.is_err() {
            self.exit(0);
        }
    }

    fn exit(&self, code: i32) -> ! {
        self.socket.remove();
        process::exit(code);
    }

    fn connections(&self) -> std::sync::MutexGuard<'_, HashMap<u64, mpsc::Sender<Command>>> {
        self.conns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn header(kind: u8, conn: u64, payload_len: u32) -> [u8; 13] {
    let mut header = [0u8; 13];
    header[..4].copy_from_slice(&(9 + payload_len).to_be_bytes());
    header[4] = kind;
    header[5..].copy_from_slice(&conn.to_be_bytes());
    header
}

// The Windows sidecar's emit(), byte for byte.
fn message(kind: u8, conn: u64, payload: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(13 + payload.len());
    message.extend_from_slice(&header(kind, conn, payload.len() as u32));
    message.extend_from_slice(payload);
    message
}

fn valid_length(length: u32) -> bool {
    (9..=9 + MAX_FRAME).contains(&length)
}

/// A parent message after its length: a reply of 1 byte to 16 MiB, or an empty close.
fn parse_command(mut message: Vec<u8>) -> Result<(u64, Command), String> {
    let conn = u64::from_be_bytes(message[1..9].try_into().map_err(|_| "short message")?);
    match (message[0], message.len() > 9) {
        (FRAME, true) => Ok((conn, Command::Frame(message.split_off(9)))),
        (CLOSE, false) => Ok((conn, Command::Close)),
        (kind, _) => Err(format!(
            "parent sent a kind {kind} message of {} bytes",
            message.len()
        )),
    }
}

struct Peer {
    uid: u32,
    gid: u32,
    pid: u32,
    cgroup: String,
}

impl Peer {
    fn key(&self) -> String {
        format!("{}:{}:{}", self.uid, self.gid, self.cgroup)
    }

    fn json(&self) -> Vec<u8> {
        json!({ "os": "linux", "uid": self.uid, "gid": self.gid, "pidHint": self.pid, "cgroup": self.cgroup })
            .to_string()
            .into_bytes()
    }
}

fn getsockopt<T: Copy>(fd: RawFd, option: libc::c_int) -> io::Result<T> {
    let mut value = MaybeUninit::<T>::zeroed();
    let mut length = size_of::<T>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            option,
            value.as_mut_ptr().cast(),
            &mut length,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if length as usize != size_of::<T>() {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok(unsafe { value.assume_init() })
}

fn peer_pidfd(fd: RawFd) -> io::Result<OwnedFd> {
    let raw: libc::c_int = getsockopt(fd, libc::SO_PEERPIDFD)?;
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

fn pidfd_info(pidfd: &OwnedFd) -> io::Result<libc::pidfd_info> {
    let mut info: libc::pidfd_info = unsafe { std::mem::zeroed() };
    info.mask = u64::from(libc::PIDFD_INFO_PID | libc::PIDFD_INFO_CGROUPID);
    if unsafe { libc::ioctl(pidfd.as_raw_fd(), libc::PIDFD_GET_INFO, &raw mut info) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info)
}

/// The pid /proc/self/fdinfo shows for a pidfd: -1 once the process is reaped, 0 outside this pid
/// namespace.
fn fdinfo_pid(pidfd: &OwnedFd) -> Option<u32> {
    let text = fs::read_to_string(format!("/proc/self/fdinfo/{}", pidfd.as_raw_fd())).ok()?;
    let pid: i64 = text
        .lines()
        .find_map(|line| line.strip_prefix("Pid:"))?
        .trim()
        .parse()
        .ok()?;
    u32::try_from(pid).ok().filter(|&pid| pid > 0)
}

/// The pid of a pidfd's process in this pid namespace, and its cgroup id where PIDFD_GET_INFO
/// (Linux 6.13) reports one; None once the process has been reaped.
fn pidfd_process(pidfd: &OwnedFd) -> Option<(u32, Option<u64>)> {
    match pidfd_info(pidfd) {
        Ok(info) => {
            let cgroup =
                (info.mask & u64::from(libc::PIDFD_INFO_CGROUPID) != 0).then_some(info.cgroupid);
            (info.tgid > 0).then_some((info.tgid, cgroup))
        }
        Err(error) if matches!(error.raw_os_error(), Some(libc::ENOTTY | libc::EINVAL)) => {
            fdinfo_pid(pidfd).map(|pid| (pid, None))
        }
        Err(_) => None,
    }
}

fn cgroup_path(pid: u32) -> Option<String> {
    let text = fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
    let path = text.lines().find_map(|line| line.strip_prefix("0::"))?;
    path.starts_with('/').then(|| path.to_string())
}

fn is_cgroup2(path: &Path) -> bool {
    let Ok(text) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut stat = MaybeUninit::<libc::statfs>::zeroed();
    unsafe {
        libc::statfs(text.as_ptr(), stat.as_mut_ptr()) == 0
            && stat.assume_init().f_type == libc::CGROUP2_SUPER_MAGIC
    }
}

// On cgroup v2 a cgroup's id is its directory's inode number. Without a cgroup2 mount here there is
// nothing to compare the id with, and the pidfd-guarded read stands on its own.
fn same_cgroup(path: &str, id: u64) -> bool {
    let root = Path::new(CGROUP_ROOT);
    if !is_cgroup2(root) {
        return true;
    }
    fs::metadata(root.join(path.trim_start_matches('/'))).is_ok_and(|meta| meta.ino() == id)
}

// The kernel's record of who connected: SO_PEERCRED's uid and gid, and the cgroup of the process
// SO_PEERPIDFD names. /proc/<pid>/cgroup is read only while that pidfd shows the same live pid
// before and after, so a reused pid cannot answer for it; where PIDFD_GET_INFO gives the cgroup id,
// the path must be that cgroup's.
fn identify(fd: RawFd) -> Option<Peer> {
    let credentials: libc::ucred = getsockopt(fd, libc::SO_PEERCRED).ok()?;
    let pidfd = peer_pidfd(fd).ok()?;
    let (pid, cgroup_id) = pidfd_process(&pidfd)?;
    let cgroup = cgroup_path(pid)?;
    if pidfd_process(&pidfd)?.0 != pid || cgroup_id.is_some_and(|id| !same_cgroup(&cgroup, id)) {
        return None;
    }
    Some(Peer {
        uid: credentials.uid,
        gid: credentials.gid,
        pid,
        cgroup,
    })
}

// As many connections as the descriptor limit leaves room for, up to MAX_CONNECTIONS: a uid's
// ceiling cannot bound an account that owns subordinate uids.
fn connection_ceiling() -> Result<usize, String> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return Err(format!(
            "cannot read RLIMIT_NOFILE: {}",
            io::Error::last_os_error()
        ));
    }
    match limit.rlim_cur.checked_sub(RESERVED_FDS) {
        Some(spare) if spare > 0 => {
            Ok(usize::try_from(spare).map_or(MAX_CONNECTIONS, |spare| spare.min(MAX_CONNECTIONS)))
        }
        _ => Err(format!(
            "RLIMIT_NOFILE is {}, which leaves no descriptor for a connection beyond the {RESERVED_FDS} this process keeps",
            limit.rlim_cur
        )),
    }
}

fn check_kernel() -> Result<(), String> {
    let mut fds = [0; 2];
    if unsafe {
        libc::socketpair(
            libc::AF_UNIX,
            libc::SOCK_STREAM | libc::SOCK_CLOEXEC,
            0,
            fds.as_mut_ptr(),
        )
    } != 0
    {
        return Err(format!(
            "cannot create a socket pair: {}",
            io::Error::last_os_error()
        ));
    }
    let pair = unsafe { [OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])] };
    peer_pidfd(pair[0].as_raw_fd())
        .map(drop)
        .map_err(|error| format!("this kernel lacks SO_PEERPIDFD (Linux 6.5 or later): {error}"))
}

fn parse_args() -> Result<Config, String> {
    let mut args = std::env::args().skip(1);
    let (mut socket, mut mode, mut idle) = (None, 0o600, Duration::from_secs(300));
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--socket" => socket = Some(PathBuf::from(value)),
            "--mode" => {
                mode = u32::from_str_radix(&value, 8)
                    .ok()
                    .filter(|mode| mode & !0o666 == 0 && mode & 0o600 == 0o600)
                    .ok_or("--mode must be octal read and write bits that include the owner's (0600 to 0666)")?;
            }
            "--idle-secs" => {
                idle = Duration::from_secs(
                    value
                        .parse()
                        .map_err(|_| "--idle-secs must be a whole number")?,
                );
            }
            _ => return Err(format!("unknown flag {flag}")),
        }
    }
    let socket = socket.ok_or("--socket is required")?;
    if !socket.is_absolute() {
        return Err("--socket must be an absolute path".into());
    }
    Ok(Config { socket, mode, idle })
}

// Only a stale socket this account created may be replaced; a live one belongs to a running broker.
fn clear_path(path: &Path) -> Result<(), String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("cannot inspect {}: {error}", path.display())),
    };
    if !meta.file_type().is_socket() || meta.uid() != unsafe { libc::geteuid() } {
        return Err(format!(
            "{} exists and is not this account's socket",
            path.display()
        ));
    }
    match StdUnixStream::connect(path) {
        Ok(_) => Err(format!("{} is in use by another process", path.display())),
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => fs::remove_file(path)
            .map_err(|error| format!("cannot remove the stale socket {}: {error}", path.display())),
        Err(error) => Err(format!("cannot probe {}: {error}", path.display())),
    }
}

fn open_socket(config: &Config) -> Result<(StdUnixListener, SocketFile), String> {
    clear_path(&config.socket)?;
    let (fd, socket) = bind(&config.socket)?;
    let listener = finish(fd, &socket, config.mode).inspect_err(|_| socket.remove())?;
    Ok((listener, socket))
}

fn os_error(what: &str, path: &Path) -> String {
    format!(
        "cannot {what} {}: {}",
        path.display(),
        io::Error::last_os_error()
    )
}

// Creates and binds the socket, and records which file bind() made.
fn bind(path: &Path) -> Result<(OwnedFd, SocketFile), String> {
    let bytes = path.as_os_str().as_bytes();
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.len() >= address.sun_path.len() {
        return Err(format!("{} is too long for a socket path", path.display()));
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (slot, byte) in address.sun_path.iter_mut().zip(bytes) {
        *slot = *byte as libc::c_char;
    }
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if raw < 0 {
        return Err(os_error("create a socket for", path));
    }
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let size = (offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1) as libc::socklen_t;
    if unsafe { libc::bind(fd.as_raw_fd(), (&raw const address).cast(), size) } != 0 {
        return Err(os_error("bind", path));
    }
    let meta = fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?;
    if !meta.file_type().is_socket() || meta.uid() != unsafe { libc::geteuid() } {
        return Err(format!(
            "{} changed while it was being created",
            path.display()
        ));
    }
    let socket = SocketFile {
        path: path.to_path_buf(),
        dev: meta.dev(),
        ino: meta.ino(),
    };
    Ok((fd, socket))
}

// No client can connect before listen(), so the mode is in place for the first one whatever the
// umask made of the file bind() created.
fn finish(fd: OwnedFd, socket: &SocketFile, mode: u32) -> Result<StdUnixListener, String> {
    let text = CString::new(socket.path.as_os_str().as_bytes())
        .map_err(|_| "the socket path holds a NUL byte")?;
    if unsafe {
        libc::fchmodat(
            libc::AT_FDCWD,
            text.as_ptr(),
            mode,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(os_error("set the mode of", &socket.path));
    }
    let same = fs::symlink_metadata(&socket.path).is_ok_and(|meta| {
        meta.dev() == socket.dev && meta.ino() == socket.ino && meta.mode() & 0o7777 == mode
    });
    if !same {
        return Err(format!(
            "{} changed while it was being created",
            socket.path.display()
        ));
    }
    if unsafe { libc::listen(fd.as_raw_fd(), BACKLOG) } != 0 {
        return Err(os_error("listen on", &socket.path));
    }
    let listener = StdUnixListener::from(fd);
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("cannot configure the socket: {error}"))?;
    Ok(listener)
}

// Reads each request straight into the FRAME message that carries it, and nothing more until it is
// answered: a byte that arrives first starts a second request in flight, which ends the connection
// unread. A client may end its side only between requests.
async fn read_requests(
    mut reader: OwnedReadHalf,
    conn: u64,
    in_flight: Arc<AtomicBool>,
    requests: mpsc::Sender<Incoming>,
) {
    loop {
        let mut length = [0u8; 4];
        match reader.read(&mut length[..1]).await {
            Ok(0) => {
                requests.send(Incoming::End).await.ok();
                return;
            }
            Ok(_) if !in_flight.load(Ordering::SeqCst) => {}
            _ => return,
        }
        if reader.read_exact(&mut length[1..]).await.is_err() {
            return;
        }
        let length = u32::from_be_bytes(length);
        if length == 0 || length > MAX_FRAME {
            return;
        }
        let total = 13 + length as usize;
        let mut message = Vec::with_capacity(total);
        message.extend_from_slice(&header(FRAME, conn, length));
        // read_buf fills the spare capacity without zeroing it first, so the pages an announced
        // length reserves are touched only as its bytes arrive.
        while message.len() < total {
            let remaining = (total - message.len()) as u64;
            match (&mut reader).take(remaining).read_buf(&mut message).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
        }
        in_flight.store(true, Ordering::SeqCst);
        if requests.send(Incoming::Request(message)).await.is_err() {
            return;
        }
    }
}

// One request in flight. The idle clock runs while no request does and restarts when a reply has
// drained; a reply that does not drain within the idle period closes the connection too.
async fn serve(stream: UnixStream, conn: u64, shared: Arc<Shared>) {
    let peer = identify(stream.as_raw_fd());
    let Some(_slot) = shared.limits.claim(peer.as_ref()) else {
        return;
    };
    let (commands_tx, mut commands) = mpsc::channel(4);
    shared.connections().insert(conn, commands_tx);
    let open = peer.map_or_else(|| b"null".to_vec(), |peer| peer.json());
    shared.emit(OPEN, conn, &open).await;

    let (reader, mut writer) = stream.into_split();
    let in_flight = Arc::new(AtomicBool::new(false));
    let (requests_tx, mut requests) = mpsc::channel(1);
    let reading = tokio::spawn(read_requests(
        reader,
        conn,
        Arc::clone(&in_flight),
        requests_tx,
    ));
    let mut deadline = Instant::now() + shared.idle;
    let mut ending = false;
    loop {
        tokio::select! {
            incoming = requests.recv(), if !ending => match incoming {
                Some(Incoming::Request(message)) => shared.send(message).await,
                Some(Incoming::End) if in_flight.load(Ordering::SeqCst) => ending = true,
                _ => break,
            },
            command = commands.recv() => match command {
                Some(Command::Frame(response)) if in_flight.swap(false, Ordering::SeqCst) => {
                    let mut framed = (response.len() as u32).to_be_bytes().to_vec();
                    framed.extend_from_slice(&response);
                    if !matches!(timeout(shared.idle, writer.write_all(&framed)).await, Ok(Ok(()))) || ending {
                        break;
                    }
                    deadline = Instant::now() + shared.idle;
                }
                _ => break,
            },
            () = sleep_until(deadline), if !in_flight.load(Ordering::SeqCst) => break,
        }
    }
    reading.abort();
    shared.connections().remove(&conn);
    shared.emit(CLOSE, conn, &[]).await;
}

async fn route_commands(shared: Arc<Shared>) {
    let mut stdin = tokio::io::stdin();
    loop {
        let Ok(length) = stdin.read_u32().await else {
            shared.exit(0)
        };
        if !valid_length(length) {
            eprintln!("orynq-socket-frontend: parent sent a {length}-byte message");
            shared.exit(2);
        }
        let mut message = vec![0u8; length as usize];
        if stdin.read_exact(&mut message).await.is_err() {
            shared.exit(0);
        }
        let (conn, command) = match parse_command(message) {
            Ok(parsed) => parsed,
            Err(error) => {
                eprintln!("orynq-socket-frontend: {error}");
                shared.exit(2);
            }
        };
        let sender = shared.connections().get(&conn).cloned();
        if let Some(sender) = sender {
            // A send fails only when the connection ended after the lookup; its close event is on its way.
            sender.send(command).await.ok();
        }
    }
}

async fn run(
    listener: StdUnixListener,
    socket: SocketFile,
    idle: Duration,
    max_connections: usize,
) -> Result<(), String> {
    let listener = match UnixListener::from_std(listener) {
        Ok(listener) => listener,
        Err(error) => {
            socket.remove();
            return Err(format!("cannot serve the socket: {error}"));
        }
    };
    let (out, mut outgoing) = mpsc::channel::<Vec<u8>>(64);
    let shared = Arc::new(Shared {
        out,
        conns: Mutex::default(),
        limits: Limits::new(max_connections),
        idle,
        socket,
    });
    let writer = Arc::clone(&shared);
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = outgoing.recv().await {
            if stdout.write_all(&message).await.is_err() || stdout.flush().await.is_err() {
                writer.exit(0);
            }
        }
    });
    tokio::spawn(route_commands(Arc::clone(&shared)));
    shared.emit(READY, 0, &[]).await;

    let mut next_conn = 1u64;
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(serve(stream, next_conn, Arc::clone(&shared)));
                next_conn += 1;
            }
            // Out of descriptors or memory: back off rather than spin; the backlog holds the clients.
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(libc::EMFILE | libc::ENFILE | libc::ENOBUFS | libc::ENOMEM)
                ) =>
            {
                sleep(Duration::from_millis(50)).await;
            }
            Err(_) => {}
        }
    }
}

fn start() -> Result<(), String> {
    let config = parse_args()?;
    let max_connections = connection_ceiling()?;
    check_kernel()?;
    let (listener, socket) = open_socket(&config)?;
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            socket.remove();
            return Err(format!("cannot start the runtime: {error}"));
        }
    };
    runtime.block_on(run(listener, socket, config.idle, max_connections))
}

fn main() {
    if let Err(error) = start() {
        eprintln!("orynq-socket-frontend: {error}");
        process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: &str =
        include_str!("../../../core/src/__tests__/fixtures/broker-mux-vectors.json");

    fn vectors() -> serde_json::Value {
        serde_json::from_str(VECTORS).unwrap()
    }

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn writes_every_golden_vector_as_the_windows_sidecar_does() {
        for vector in vectors()["valid"].as_array().unwrap() {
            let kind = vector["kind"].as_u64().unwrap() as u8;
            let conn: u64 = vector["conn"].as_str().unwrap().parse().unwrap();
            let payload = vector["payloadUtf8"].as_str().unwrap().as_bytes();
            assert_eq!(
                message(kind, conn, payload),
                hex(vector["hex"].as_str().unwrap()),
                "{}",
                vector["name"]
            );
        }
        let large = &vectors()["large"];
        let payload = vec![
            large["fill"].as_u64().unwrap() as u8;
            large["payloadBytes"].as_u64().unwrap() as usize
        ];
        let encoded = message(
            FRAME,
            large["conn"].as_str().unwrap().parse().unwrap(),
            &payload,
        );
        assert_eq!(encoded[..13], hex(large["headerHex"].as_str().unwrap()));
        assert_eq!(encoded.len(), 13 + payload.len());
    }

    fn command_of(bytes: &[u8]) -> Result<(u64, Command), String> {
        let length = u32::from_be_bytes(bytes[..4].try_into().unwrap());
        if !valid_length(length) {
            return Err("length".into());
        }
        parse_command(bytes[4..].to_vec())
    }

    #[test]
    fn accepts_from_its_parent_only_a_reply_frame_or_an_empty_close() {
        for vector in vectors()["valid"].as_array().unwrap() {
            let bytes = hex(vector["hex"].as_str().unwrap());
            let parsed = command_of(&bytes);
            match vector["kind"].as_u64().unwrap() as u8 {
                FRAME => assert!(
                    matches!(parsed, Ok((_, Command::Frame(ref body))) if body.as_slice() == vector["payloadUtf8"].as_str().unwrap().as_bytes())
                ),
                CLOSE => assert!(matches!(parsed, Ok((4294967296, Command::Close)))),
                _ => assert!(parsed.is_err(), "{}", vector["name"]),
            }
        }
        for vector in vectors()["invalid"].as_array().unwrap() {
            let mut bytes = hex(vector["hex"].as_str().unwrap());
            let length = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
            if valid_length(length as u32) {
                bytes.resize(4 + length, 0);
            }
            assert!(command_of(&bytes).is_err(), "{}", vector["name"]);
        }
        assert!(
            valid_length(9 + MAX_FRAME) && !valid_length(9 + MAX_FRAME + 1) && !valid_length(8)
        );
    }

    fn peer(uid: u32, gid: u32, cgroup: &str) -> Peer {
        Peer {
            uid,
            gid,
            pid: 1,
            cgroup: cgroup.into(),
        }
    }

    #[test]
    fn admits_32_connections_per_peer_and_128_per_uid_however_many_gids_and_cgroups_it_spreads_over()
     {
        let limits = Limits::new(MAX_CONNECTIONS);
        let mut slots = Vec::new();
        for n in 0..MAX_PER_UID as u32 {
            let spread = peer(1000, n % 2, &format!("/cg/{}", n / 32));
            slots.push(limits.claim(Some(&spread)).unwrap());
        }
        assert!(limits.claim(Some(&peer(1000, 7, "/cg/new"))).is_none());
        assert!(limits.claim(Some(&peer(1001, 7, "/cg/new"))).is_some());
        slots.pop();
        assert!(limits.claim(Some(&peer(1000, 7, "/cg/new"))).is_some());

        let one = peer(2000, 2000, "/one");
        let _peer_slots: Vec<Slot> = (0..MAX_PER_PEER)
            .map(|_| limits.claim(Some(&one)).unwrap())
            .collect();
        assert!(limits.claim(Some(&one)).is_none());
        let _unidentified: Vec<Slot> = (0..MAX_PER_PEER)
            .map(|_| limits.claim(None).unwrap())
            .collect();
        assert!(limits.claim(None).is_none());
    }

    #[test]
    fn admits_no_more_connections_in_all_than_its_ceiling() {
        let limits = Limits::new(3);
        let slots: Vec<Slot> = (0..3)
            .map(|uid| limits.claim(Some(&peer(uid, uid, "/"))).unwrap())
            .collect();
        assert!(limits.claim(Some(&peer(9, 9, "/"))).is_none());
        assert!(limits.claim(None).is_none());
        drop(slots);
        assert_eq!(limits.admitted().total, 0);
        assert!(limits.admitted().peers.is_empty() && limits.admitted().uids.is_empty());
        assert!(limits.claim(None).is_some());
    }

    fn pair() -> [OwnedFd; 2] {
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
        unsafe { [OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])] }
    }

    fn own_cgroup() -> String {
        cgroup_path(process::id()).unwrap()
    }

    fn kernel_release() -> (u32, u32) {
        let mut name: libc::utsname = unsafe { std::mem::zeroed() };
        assert_eq!(unsafe { libc::uname(&mut name) }, 0);
        let release = unsafe { std::ffi::CStr::from_ptr(name.release.as_ptr()) };
        let mut parts = release
            .to_str()
            .unwrap()
            .split(|c: char| !c.is_ascii_digit())
            .map(|part| part.parse().unwrap());
        (parts.next().unwrap(), parts.next().unwrap())
    }

    // A kernel before 6.5 has no SO_PEERPIDFD; that is the only skip, and it is checked as such.
    fn peer_pidfd_or_skip(fd: RawFd) -> Option<OwnedFd> {
        match peer_pidfd(fd) {
            Ok(pidfd) => Some(pidfd),
            Err(error) => {
                assert_eq!(error.raw_os_error(), Some(libc::ENOPROTOOPT));
                assert!(kernel_release() < (6, 5));
                eprintln!("skipped: this kernel lacks SO_PEERPIDFD (Linux 6.5)");
                None
            }
        }
    }

    // A kernel before 6.13 refuses PIDFD_GET_INFO as an unknown ioctl; that is the only skip.
    fn pidfd_info_or_skip(pidfd: &OwnedFd) -> Option<libc::pidfd_info> {
        match pidfd_info(pidfd) {
            Ok(info) => Some(info),
            Err(error) => {
                assert!(matches!(
                    error.raw_os_error(),
                    Some(libc::ENOTTY | libc::EINVAL)
                ));
                assert!(kernel_release() < (6, 13));
                eprintln!("skipped: this kernel lacks PIDFD_GET_INFO (Linux 6.13)");
                None
            }
        }
    }

    #[test]
    fn names_the_peer_pid_by_pidfd_info_and_by_fdinfo_alike() {
        let [ours, _theirs] = pair();
        let Some(pidfd) = peer_pidfd_or_skip(ours.as_raw_fd()) else {
            return;
        };
        assert_eq!(fdinfo_pid(&pidfd), Some(process::id()));
        assert_eq!(
            pidfd_process(&pidfd).map(|(pid, _)| pid),
            Some(process::id())
        );
        if let Some(info) = pidfd_info_or_skip(&pidfd) {
            assert_eq!(info.tgid, process::id());
        }
    }

    #[test]
    fn binds_the_cgroup_path_to_the_cgroup_id_the_kernel_reports() {
        let [ours, _theirs] = pair();
        let Some(pidfd) = peer_pidfd_or_skip(ours.as_raw_fd()) else {
            return;
        };
        let Some(info) = pidfd_info_or_skip(&pidfd) else {
            assert_eq!(pidfd_process(&pidfd), Some((process::id(), None)));
            return;
        };
        assert_ne!(info.mask & u64::from(libc::PIDFD_INFO_CGROUPID), 0);
        assert_eq!(
            pidfd_process(&pidfd),
            Some((process::id(), Some(info.cgroupid)))
        );
        assert!(is_cgroup2(Path::new(CGROUP_ROOT)));
        assert!(same_cgroup(&own_cgroup(), info.cgroupid));
        assert!(!same_cgroup(
            &format!("{}/no-such-child", own_cgroup().trim_end_matches('/')),
            info.cgroupid
        ));
    }

    #[test]
    fn identifies_a_socket_peer_as_the_kernel_recorded_it() {
        let [ours, _theirs] = pair();
        if peer_pidfd_or_skip(ours.as_raw_fd()).is_none() {
            return;
        }
        let peer = identify(ours.as_raw_fd()).unwrap();
        assert_eq!(
            (peer.uid, peer.gid, peer.pid),
            (
                unsafe { libc::getuid() },
                unsafe { libc::getgid() },
                process::id()
            )
        );
        assert_eq!(peer.cgroup, own_cgroup());
        assert_eq!(
            peer.key(),
            format!("{}:{}:{}", peer.uid, peer.gid, peer.cgroup)
        );
    }
}
