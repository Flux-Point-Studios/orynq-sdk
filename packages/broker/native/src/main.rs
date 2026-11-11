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
    fs,
    hash::Hash,
    io,
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
    sync::{OwnedSemaphorePermit, Semaphore, mpsc},
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
// Request bytes read or waiting for stdout, per peer, per uid and in all (every unidentified client
// together is one peer and one uid). Each request reserves its announced length before its body is
// read. A peer's share is one frame, so a client that announces and stalls blocks only its own
// peer: the agent sessions sharing one uid each have their own cgroup, and it takes four stalled
// peers to fill a uid's share.
const PEER_BUDGET: u32 = MAX_FRAME;
const UID_BUDGET: u32 = 64 << 20;
const TOTAL_BUDGET: u32 = 256 << 20;
// A connection's deadline is now plus the idle period, which panics past the clock's range; a day
// is far inside it.
const MAX_IDLE_SECS: u64 = 86_400;
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
    Request(Vec<u8>, Hold),
    End,
}

struct Outgoing {
    message: Vec<u8>,
    /// The budget a request's bytes hold until they are written to stdout.
    hold: Option<Hold>,
}

/// The socket file this process created, so it removes only that file on exit.
struct SocketFile {
    path: PathBuf,
    dev: u64,
    ino: u64,
}

impl SocketFile {
    // Device and inode name the socket bind() made only while it exists; a regular file that takes
    // the number once it is gone is told apart by its type.
    fn present(&self) -> bool {
        fs::symlink_metadata(&self.path).is_ok_and(|meta| {
            meta.file_type().is_socket() && meta.dev() == self.dev && meta.ino() == self.ino
        })
    }

    fn remove(&self) {
        if self.present() {
            fs::remove_file(&self.path).ok();
        }
    }
}

struct Shared {
    out: mpsc::Sender<Outgoing>,
    conns: Mutex<HashMap<u64, mpsc::Sender<Command>>>,
    limits: Arc<Limits>,
    idle: Duration,
    socket: SocketFile,
}

/// The connections admitted, counted per peer (every unidentified client together is one), per
/// uid (None for the unidentified) and in all, and the request bytes they hold.
struct Limits {
    max_connections: usize,
    admitted: Mutex<Admitted>,
    total_budget: Arc<Semaphore>,
}

#[derive(Default)]
struct Admitted {
    peers: HashMap<String, Share>,
    uids: HashMap<Option<u32>, Share>,
    total: usize,
}

/// The connections admitted under one peer or uid, and the request bytes they may hold. A share
/// leaves with its last connection; a reservation outliving it keeps that share's budget.
struct Share {
    connections: usize,
    budget: Arc<Semaphore>,
}

fn is_full<K: Eq + Hash>(shares: &HashMap<K, Share>, key: &K, max: usize) -> bool {
    shares
        .get(key)
        .is_some_and(|share| share.connections >= max)
}

fn join<K: Eq + Hash>(shares: &mut HashMap<K, Share>, key: K, bytes: u32) -> Arc<Semaphore> {
    let share = shares.entry(key).or_insert_with(|| Share {
        connections: 0,
        budget: Arc::new(Semaphore::new(bytes as usize)),
    });
    share.connections += 1;
    Arc::clone(&share.budget)
}

fn leave<K: Eq + Hash>(shares: &mut HashMap<K, Share>, key: &K) {
    if let Some(share) = shares.get_mut(key) {
        share.connections -= 1;
        if share.connections == 0 {
            shares.remove(key);
        }
    }
}

impl Limits {
    fn new(max_connections: usize) -> Arc<Limits> {
        Arc::new(Limits {
            max_connections,
            admitted: Mutex::default(),
            total_budget: Arc::new(Semaphore::new(TOTAL_BUDGET as usize)),
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
            || is_full(&admitted.peers, &key, MAX_PER_PEER)
            || is_full(&admitted.uids, &uid, MAX_PER_UID)
        {
            return None;
        }
        admitted.total += 1;
        let budget = Budget {
            peer: join(&mut admitted.peers, key.clone(), PEER_BUDGET),
            uid: join(&mut admitted.uids, uid, UID_BUDGET),
            total: Arc::clone(&self.total_budget),
        };
        Some(Slot {
            limits: Arc::clone(self),
            key,
            uid,
            budget,
        })
    }
}

struct Slot {
    limits: Arc<Limits>,
    key: String,
    uid: Option<u32>,
    budget: Budget,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut admitted = self.limits.admitted();
        admitted.total -= 1;
        leave(&mut admitted.peers, &self.key);
        leave(&mut admitted.uids, &self.uid);
    }
}

#[derive(Clone)]
struct Budget {
    peer: Arc<Semaphore>,
    uid: Arc<Semaphore>,
    total: Arc<Semaphore>,
}

struct Hold {
    _permits: Vec<OwnedSemaphorePermit>,
}

impl Budget {
    // Narrowest share first, so a request waiting on a wider one holds no more than its own peer's
    // or uid's share, and a fixed order cannot deadlock.
    async fn reserve(&self, bytes: u32) -> Option<Hold> {
        let mut permits = Vec::with_capacity(3);
        for share in [&self.peer, &self.uid, &self.total] {
            permits.push(Arc::clone(share).acquire_many_owned(bytes).await.ok()?);
        }
        Some(Hold { _permits: permits })
    }
}

impl Shared {
    async fn emit(&self, kind: u8, conn: u64, payload: &[u8]) {
        self.send(message(kind, conn, payload), None).await;
    }

    async fn send(&self, message: Vec<u8>, hold: Option<Hold>) {
        if self.out.send(Outgoing { message, hold }).await.is_err() {
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

/// The pid of a pidfd's process and its cgroup id; None once the process is reaped. The pid is 0
/// outside this pid namespace and the id 0 where the kernel reports none, and neither names
/// anything under /proc or /sys/fs/cgroup.
fn pidfd_process(pidfd: &OwnedFd) -> Option<(u32, u64)> {
    pidfd_info(pidfd)
        .ok()
        .map(|info| (info.tgid, info.cgroupid))
}

fn cgroup_path(pid: u32) -> Option<String> {
    let text = fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
    let path = text.lines().find_map(|line| line.strip_prefix("0::"))?;
    path.starts_with('/').then(|| path.to_string())
}

// On cgroup v2 a cgroup's id is its directory's inode number.
fn same_cgroup(path: &str, id: u64) -> bool {
    fs::metadata(Path::new(CGROUP_ROOT).join(path.trim_start_matches('/')))
        .is_ok_and(|meta| meta.ino() == id)
}

// The kernel's record of who connected: SO_PEERCRED's uid and gid, and the cgroup of the process
// SO_PEERPIDFD names. /proc/<pid>/cgroup is read only while that pidfd shows the same live pid
// before and after, so a reused pid cannot answer for it, and the path must name the cgroup whose
// id PIDFD_GET_INFO reported.
fn identify(fd: RawFd) -> Option<Peer> {
    let credentials: libc::ucred = getsockopt(fd, libc::SO_PEERCRED).ok()?;
    let pidfd = peer_pidfd(fd).ok()?;
    let (pid, cgroup_id) = pidfd_process(&pidfd)?;
    #[cfg(test)]
    tests::between_reads(tests::Read::Pid);
    let cgroup = cgroup_path(pid)?;
    #[cfg(test)]
    tests::between_reads(tests::Read::Cgroup);
    let same_process = pidfd_process(&pidfd).is_some_and(|(again, _)| again == pid);
    (same_process && same_cgroup(&cgroup, cgroup_id)).then_some(Peer {
        uid: credentials.uid,
        gid: credentials.gid,
        pid,
        cgroup,
    })
}

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
    ceiling(limit.rlim_cur)
}

// As many connections as the descriptor limit leaves room for, up to MAX_CONNECTIONS: a uid's
// ceiling cannot bound an account that owns subordinate uids.
fn ceiling(descriptors: libc::rlim_t) -> Result<usize, String> {
    match descriptors.checked_sub(RESERVED_FDS) {
        Some(spare) if spare > 0 => {
            Ok(usize::try_from(spare).map_or(MAX_CONNECTIONS, |spare| spare.min(MAX_CONNECTIONS)))
        }
        _ => Err(format!(
            "RLIMIT_NOFILE is {descriptors}, which leaves no descriptor for a connection beyond the {RESERVED_FDS} this process keeps"
        )),
    }
}

fn socket_pair() -> io::Result<[OwnedFd; 2]> {
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
        return Err(io::Error::last_os_error());
    }
    Ok(fds.map(|fd| unsafe { OwnedFd::from_raw_fd(fd) }))
}

// The frontend identifies its own end of a socket pair as it would any peer, which fails where the
// kernel reports no cgroup id (before Linux 6.13) or /sys/fs/cgroup does not resolve one.
fn check_kernel() -> Result<(), String> {
    let pair = socket_pair().map_err(|error| format!("cannot create a socket pair: {error}"))?;
    identify(pair[0].as_raw_fd()).map(drop).ok_or_else(|| {
        "cannot identify a peer by its cgroup: this needs SO_PEERPIDFD and PIDFD_GET_INFO (Linux 6.13 or later) and the cgroup2 hierarchy at /sys/fs/cgroup".into()
    })
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
                idle = value
                    .parse()
                    .ok()
                    .filter(|secs| (1..=MAX_IDLE_SECS).contains(secs))
                    .map(Duration::from_secs)
                    .ok_or_else(|| {
                        format!("--idle-secs must be a whole number of seconds from 1 to {MAX_IDLE_SECS}")
                    })?;
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

// Only a stale socket that `owner`, this account, created may be replaced; a live one belongs to a
// running broker.
fn clear_path(path: &Path, owner: u32) -> Result<(), String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("cannot inspect {}: {error}", path.display())),
    };
    if !meta.file_type().is_socket() || meta.uid() != owner {
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
    clear_path(&config.socket, unsafe { libc::geteuid() })?;
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
    let socket = SocketFile {
        path: path.to_path_buf(),
        dev: meta.dev(),
        ino: meta.ino(),
    };
    Ok((fd, socket))
}

// No client can connect before listen(), so the mode is in place for the first one whatever the
// umask made of the file bind() created. fchmodat succeeds only on a file this account owns, so
// the file still being the recorded socket afterwards means the mode was set on it.
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
    if !socket.present() {
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
    budget: Budget,
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
        let Some(hold) = budget.reserve(length).await else {
            return;
        };
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
        if requests
            .send(Incoming::Request(message, hold))
            .await
            .is_err()
        {
            return;
        }
    }
}

// One request in flight. The idle clock runs while no request does and restarts when a reply has
// drained; a reply that does not drain within the idle period closes the connection too.
async fn serve(stream: UnixStream, conn: u64, shared: Arc<Shared>) {
    let peer = identify(stream.as_raw_fd());
    let Some(slot) = shared.limits.claim(peer.as_ref()) else {
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
        slot.budget.clone(),
        requests_tx,
    ));
    let mut deadline = Instant::now() + shared.idle;
    let mut ending = false;
    loop {
        tokio::select! {
            incoming = requests.recv(), if !ending => match incoming {
                Some(Incoming::Request(message, hold)) => shared.send(message, Some(hold)).await,
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
    let (out, mut outgoing) = mpsc::channel::<Outgoing>(64);
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
        while let Some(Outgoing { message, hold }) = outgoing.recv().await {
            if stdout.write_all(&message).await.is_err() || stdout.flush().await.is_err() {
                writer.exit(0);
            }
            drop(hold);
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
#[path = "../tests/support/mod.rs"]
mod support;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::support::{
        Connector, cgroup_dir, cgroups_or_skip, connect_from_child, kernel_release, own_cgroup,
        stale_socket,
    };
    use std::{cell::RefCell, sync::atomic::AtomicU32};

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
        let admitted = limits.admitted();
        assert_eq!(admitted.total, 0);
        assert!(admitted.peers.is_empty() && admitted.uids.is_empty());
        drop(admitted);
        assert!(limits.claim(None).is_some());
    }

    // The reservation, or None while it waits.
    async fn reserve_now(budget: &Budget, bytes: u32) -> Option<Hold> {
        timeout(Duration::from_millis(100), budget.reserve(bytes))
            .await
            .ok()
            .flatten()
    }

    fn claim(limits: &Arc<Limits>, uid: u32, cgroup: &str) -> Slot {
        limits.claim(Some(&peer(uid, uid, cgroup))).unwrap()
    }

    #[tokio::test]
    async fn reserves_request_bytes_up_to_16_mib_per_peer_64_mib_per_uid_and_256_mib_in_all() {
        let limits = Limits::new(MAX_CONNECTIONS);
        let [first, second] = [(); 2].map(|()| claim(&limits, 7, "/a"));
        let _first = reserve_now(&first.budget, PEER_BUDGET).await.unwrap();
        assert!(reserve_now(&second.budget, 1).await.is_none());
        let [anonymous, other_anonymous] = [(); 2].map(|()| limits.claim(None).unwrap());
        let _anonymous = reserve_now(&anonymous.budget, PEER_BUDGET).await.unwrap();
        assert!(reserve_now(&other_anonymous.budget, 1).await.is_none());

        let limits = Limits::new(MAX_CONNECTIONS);
        let peers: Vec<Slot> = (0..5)
            .map(|n| claim(&limits, 7, &format!("/{n}")))
            .collect();
        let mut holds = Vec::new();
        for slot in &peers[..4] {
            holds.push(reserve_now(&slot.budget, PEER_BUDGET).await.unwrap());
        }
        assert!(reserve_now(&peers[4].budget, 1).await.is_none());
        let other_uid = claim(&limits, 8, "/0");
        assert!(reserve_now(&other_uid.budget, PEER_BUDGET).await.is_some());
        holds.pop();
        assert!(reserve_now(&peers[4].budget, PEER_BUDGET).await.is_some());

        let limits = Limits::new(MAX_CONNECTIONS);
        let slots: Vec<Slot> = (0..17)
            .map(|n| claim(&limits, n / 4, &format!("/{}", n % 4)))
            .collect();
        let mut holds = Vec::new();
        for slot in &slots[..16] {
            holds.push(reserve_now(&slot.budget, PEER_BUDGET).await.unwrap());
        }
        assert!(reserve_now(&slots[16].budget, 1).await.is_none());
        holds.pop();
        assert!(reserve_now(&slots[16].budget, PEER_BUDGET).await.is_some());
    }

    // Every agent session runs as one uid, each in its own unit cgroup: a session that announces
    // requests and stalls must not hold the share the others need.
    #[tokio::test]
    async fn serves_another_cgroup_of_a_uid_while_one_stalls_four_16_mib_requests() {
        let limits = Limits::new(MAX_CONNECTIONS);
        let slots: Vec<Slot> = (0..4).map(|_| claim(&limits, 7, "/session-a")).collect();
        let stalled: Vec<_> = slots
            .iter()
            .map(|slot| {
                let budget = slot.budget.clone();
                tokio::spawn(async move { budget.reserve(MAX_FRAME).await })
            })
            .collect();
        sleep(Duration::from_millis(50)).await;
        let other = claim(&limits, 7, "/session-b");
        assert!(reserve_now(&other.budget, MAX_FRAME).await.is_some());
        stalled.iter().for_each(|task| task.abort());
    }

    // A kernel before 6.13 cannot report a peer's cgroup id (SO_PEERPIDFD came in 6.5 and
    // PIDFD_GET_INFO in 6.13); that is the only skip, and it is checked as such.
    fn pidfd_or_skip(fd: RawFd) -> Option<OwnedFd> {
        let pidfd = match peer_pidfd(fd) {
            Ok(pidfd) => pidfd,
            Err(error) => {
                assert_eq!(error.raw_os_error(), Some(libc::ENOPROTOOPT));
                assert!(kernel_release() < (6, 5));
                eprintln!("skipped: this kernel lacks SO_PEERPIDFD (Linux 6.5)");
                return None;
            }
        };
        if let Err(error) = pidfd_info(&pidfd) {
            assert!(matches!(
                error.raw_os_error(),
                Some(libc::ENOTTY | libc::EINVAL)
            ));
            assert!(kernel_release() < (6, 13));
            eprintln!("skipped: this kernel lacks PIDFD_GET_INFO (Linux 6.13)");
            return None;
        }
        Some(pidfd)
    }

    #[test]
    fn names_a_peer_by_its_pid_and_cgroup_id() {
        let [ours, _theirs] = socket_pair().unwrap();
        let Some(pidfd) = pidfd_or_skip(ours.as_raw_fd()) else {
            return;
        };
        let info = pidfd_info(&pidfd).unwrap();
        assert_ne!(info.mask & u64::from(libc::PIDFD_INFO_CGROUPID), 0);
        assert_eq!(pidfd_process(&pidfd), Some((process::id(), info.cgroupid)));
    }

    #[test]
    fn binds_a_cgroup_path_only_to_the_id_of_its_directory() {
        let [ours, _theirs] = socket_pair().unwrap();
        let Some(pidfd) = pidfd_or_skip(ours.as_raw_fd()) else {
            return;
        };
        let (_, id) = pidfd_process(&pidfd).unwrap();
        let own = own_cgroup();
        assert!(same_cgroup(&own, id));
        assert!(!same_cgroup(&own, id + 1));
        assert!(!same_cgroup(
            &format!("{}/no-such-child", own.trim_end_matches('/')),
            id
        ));
    }

    #[test]
    fn identifies_a_socket_peer_as_the_kernel_recorded_it() {
        let [ours, _theirs] = socket_pair().unwrap();
        if pidfd_or_skip(ours.as_raw_fd()).is_none() {
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
        assert!(check_kernel().is_ok());
    }

    #[derive(Clone, Copy, PartialEq)]
    pub(super) enum Read {
        Pid,
        Cgroup,
    }

    type Hook = (Read, Box<dyn FnOnce()>);

    thread_local! {
        static BETWEEN_READS: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }

    // Runs the hook a test set on this thread for this point in identify().
    pub(super) fn between_reads(read: Read) {
        let hook = BETWEEN_READS.with(|hook| {
            let mut hook = hook.borrow_mut();
            if hook.as_ref().is_some_and(|(at, _)| *at == read) {
                hook.take()
            } else {
                None
            }
        });
        if let Some((_, run)) = hook {
            run();
        }
    }

    fn identify_with(fd: RawFd, at: Read, run: impl FnOnce() + 'static) -> Option<Peer> {
        BETWEEN_READS.with(|hook| *hook.borrow_mut() = Some((at, Box::new(run))));
        let peer = identify(fd);
        assert!(
            BETWEEN_READS.with(|hook| hook.borrow().is_none()),
            "identify() returned before the hook"
        );
        peer
    }

    fn temp_socket_path() -> PathBuf {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        std::env::temp_dir().join(format!(
            "orynq-sf-unit-{}-{}.sock",
            process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    // The accepted end of a connection made by a child that then execs sleep, so the peer lives
    // until it is killed.
    fn sleeping_peer() -> (Connector, StdUnixStream, Vec<StdUnixStream>) {
        let path = temp_socket_path();
        let listener = StdUnixListener::bind(&path).unwrap();
        let (connector, clients) = connect_from_child(&path, 1, None, &["sleep", "600"]);
        let (accepted, _) = listener.accept().unwrap();
        fs::remove_file(&path).unwrap();
        (connector, accepted, clients)
    }

    #[test]
    fn keeps_64_descriptors_and_admits_at_most_1024_connections_whatever_the_limit() {
        for descriptors in [0, 63, 64] {
            let error = ceiling(descriptors).unwrap_err();
            assert!(error.contains("RLIMIT_NOFILE"), "{error}");
        }
        for (descriptors, connections) in [
            (65, 1),
            (1087, 1023),
            (1088, 1024),
            (1089, 1024),
            (1 << 20, 1024),
            (libc::RLIM_INFINITY, 1024),
        ] {
            assert_eq!(ceiling(descriptors), Ok(connections), "{descriptors}");
        }
    }

    // An unprivileged test cannot make a socket another uid owns, so it names another owner.
    #[test]
    fn replaces_a_stale_socket_only_when_its_owner_is_this_account() {
        let path = temp_socket_path();
        stale_socket(&path);
        let owner = unsafe { libc::geteuid() };
        let error = clear_path(&path, owner + 1).unwrap_err();
        assert!(
            error.contains("exists and is not this account's socket"),
            "{error}"
        );
        assert!(fs::symlink_metadata(&path).unwrap().file_type().is_socket());
        assert_eq!(clear_path(&path, owner), Ok(()));
        assert!(fs::symlink_metadata(&path).is_err());
    }

    #[test]
    fn listens_only_on_the_socket_it_bound() {
        let path = temp_socket_path();
        let (fd, file) = bind(&path).unwrap();
        fs::remove_file(&path).unwrap();
        let other = StdUnixListener::bind(&path).unwrap();
        let error = finish(fd, &file, 0o600).unwrap_err();
        assert!(
            error.contains("changed while it was being created"),
            "{error}"
        );
        file.remove();
        assert!(fs::symlink_metadata(&path).unwrap().file_type().is_socket());
        drop(other);
        fs::remove_file(&path).unwrap();
    }

    // An inode number is reused once its file is gone; a regular file holding the one the socket
    // had is not the socket.
    #[test]
    fn removes_only_the_socket_it_bound() {
        let path = temp_socket_path();
        fs::write(&path, b"keep").unwrap();
        let meta = fs::symlink_metadata(&path).unwrap();
        let file = SocketFile {
            path: path.clone(),
            dev: meta.dev(),
            ino: meta.ino(),
        };
        file.remove();
        assert_eq!(fs::read(&path).unwrap(), b"keep");
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn refuses_a_peer_reaped_between_its_reads() {
        let [ours, _theirs] = socket_pair().unwrap();
        if pidfd_or_skip(ours.as_raw_fd()).is_none() {
            return;
        }
        let (mut connector, accepted, _clients) = sleeping_peer();
        let pid = connector.0.id();
        assert_eq!(
            identify(accepted.as_raw_fd()).map(|peer| peer.pid),
            Some(pid)
        );
        let peer = identify_with(accepted.as_raw_fd(), Read::Cgroup, move || {
            connector.0.kill().unwrap();
            connector.0.wait().unwrap();
        });
        assert!(peer.is_none());
    }

    #[test]
    fn refuses_a_peer_that_moves_to_another_cgroup_between_its_reads() {
        let [ours, _theirs] = socket_pair().unwrap();
        if pidfd_or_skip(ours.as_raw_fd()).is_none() {
            return;
        }
        let Some(cgroups) = cgroups_or_skip(1) else {
            return;
        };
        let (connector, accepted, _clients) = sleeping_peer();
        assert_eq!(identify(accepted.as_raw_fd()).unwrap().cgroup, own_cgroup());
        let procs = cgroups.0[0].join("cgroup.procs");
        let pid = connector.0.id();
        let peer = identify_with(accepted.as_raw_fd(), Read::Pid, move || {
            fs::write(procs, pid.to_string()).unwrap();
        });
        assert!(peer.is_none());
        let moved = identify(accepted.as_raw_fd()).unwrap();
        assert_eq!(cgroup_dir(&moved.cgroup), cgroups.0[0]);
    }
}
