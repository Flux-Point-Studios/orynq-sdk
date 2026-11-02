//! Named-pipe transport for the orynq credential broker on Windows.
//!
//! libuv sets no SDDL on a pipe and exposes no pipe handle, so this process owns the pipe and hands
//! `{connId, peer, frame}` to its Node parent over stdio. It never parses a frame.
//!
//! stdio messages, both directions: `u32 length | u8 kind | u64 connId | payload`, big-endian, where
//! length counts kind, connId and payload. Kinds: 0 ready, 1 open (payload: peer JSON or `null`),
//! 2 frame, 3 close. The parent sends only frame (a response) and close.

use std::{
    collections::HashMap,
    ffi::c_void,
    os::windows::io::AsRawHandle,
    process,
    ptr::null_mut,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, ReadHalf},
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    sync::mpsc,
    time::{Instant, sleep_until, timeout},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, LocalFree},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            ConvertStringSidToSidW, SDDL_REVISION_1,
        },
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, PSECURITY_DESCRIPTOR,
        PSID, RevertToSelf, SECURITY_ATTRIBUTES, TOKEN_INFORMATION_CLASS, TOKEN_MANDATORY_LABEL,
        TOKEN_QUERY, TOKEN_STATISTICS, TOKEN_USER, TokenIntegrityLevel, TokenSessionId,
        TokenStatistics, TokenUser,
    },
    System::{
        Pipes::{GetNamedPipeClientProcessId, ImpersonateNamedPipeClient},
        Threading::{GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken},
    },
};

const READY: u8 = 0;
const OPEN: u8 = 1;
const FRAME: u8 = 2;
const CLOSE: u8 = 3;
const MAX_FRAME: u32 = 16 << 20;
const MAX_PER_PEER: usize = 32;
// Read/write data, read attributes, READ_CONTROL, SYNCHRONIZE. Never FILE_CREATE_PIPE_INSTANCE (0x4):
// a client holding it could create instances of this pipe and answer other clients.
const CLIENT_RIGHTS: &str = "0x120083";

struct Config {
    pipe: String,
    admit: Vec<String>,
    idle: Duration,
}

enum Command {
    Frame(Vec<u8>),
    Close,
}

struct Shared {
    out: mpsc::Sender<Vec<u8>>,
    conns: Mutex<HashMap<u64, mpsc::Sender<Command>>>,
    per_peer: Mutex<HashMap<String, usize>>,
    idle: Duration,
}

impl Shared {
    async fn emit(&self, kind: u8, conn: u64, payload: &[u8]) {
        let mut message = Vec::with_capacity(13 + payload.len());
        message.extend_from_slice(&(9 + payload.len() as u32).to_be_bytes());
        message.push(kind);
        message.extend_from_slice(&conn.to_be_bytes());
        message.extend_from_slice(payload);
        if self.out.send(message).await.is_err() {
            process::exit(0);
        }
    }

    fn claim(self: &Arc<Self>, peer: String) -> Option<Slot> {
        let mut counts = self.per_peer.lock().unwrap();
        let count = counts.entry(peer.clone()).or_insert(0);
        if *count >= MAX_PER_PEER {
            return None;
        }
        *count += 1;
        Some(Slot {
            shared: Arc::clone(self),
            peer,
        })
    }
}

struct Slot {
    shared: Arc<Shared>,
    peer: String,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut counts = self.shared.per_peer.lock().unwrap();
        if let Some(count) = counts.get_mut(&self.peer) {
            *count -= 1;
            if *count == 0 {
                counts.remove(&self.peer);
            }
        }
    }
}

struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

impl SecurityDescriptor {
    fn from_sddl(sddl: &str) -> Result<Self, String> {
        let text = wide(sddl);
        let mut descriptor = null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        };
        if ok == 0 {
            Err(format!(
                "invalid security descriptor: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(Self(descriptor))
        }
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

struct Token(HANDLE);

impl Drop for Token {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

impl Token {
    // u64 storage keeps the pointer-bearing TOKEN_* structs aligned.
    fn info(&self, class: TOKEN_INFORMATION_CLASS) -> Option<Vec<u64>> {
        let mut needed = 0u32;
        unsafe { GetTokenInformation(self.0, class, null_mut(), 0, &mut needed) };
        if needed == 0 {
            return None;
        }
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
        let ok = unsafe {
            GetTokenInformation(
                self.0,
                class,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        };
        (ok != 0).then_some(buffer)
    }

    fn user_sid(&self) -> Option<String> {
        let user = self.info(TokenUser)?;
        sid_text(unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid })
    }

    fn peer(&self, pipe: HANDLE) -> Option<serde_json::Value> {
        let stats = self.info(TokenStatistics)?;
        let luid = unsafe { (*stats.as_ptr().cast::<TOKEN_STATISTICS>()).AuthenticationId };
        let session = self.info(TokenSessionId)?;
        let label = self.info(TokenIntegrityLevel)?;
        let integrity = unsafe {
            let sid = (*label.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()).Label.Sid;
            *GetSidSubAuthority(sid, u32::from(*GetSidSubAuthorityCount(sid)) - 1)
        };
        let mut pid = 0u32;
        let pid = (unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) } != 0).then_some(pid);
        Some(json!({
            "os": "windows",
            "sid": self.user_sid()?,
            "logonLuid": ((u64::from(luid.HighPart as u32) << 32) | u64::from(luid.LowPart)).to_string(),
            "tsSessionId": unsafe { *session.as_ptr().cast::<u32>() },
            "integrityRid": integrity,
            "pidHint": pid,
        }))
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn sid_text(sid: PSID) -> Option<String> {
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return None;
    }
    let length = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
    let value = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).ok();
    unsafe { LocalFree(text.cast()) };
    value
}

fn own_sid() -> Option<String> {
    let mut handle = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle) } == 0 {
        return None;
    }
    Token(handle).user_sid()
}

// The client's identity as the kernel recorded it at connect time. Impersonation is held only between
// these two calls with no await in between, so no other task runs on this thread as the client. A
// thread that cannot revert would keep acting as the client, so the process aborts instead.
fn identify(pipe: HANDLE) -> Option<serde_json::Value> {
    if unsafe { ImpersonateNamedPipeClient(pipe) } == 0 {
        return None;
    }
    let mut handle = null_mut();
    let opened = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut handle) };
    if unsafe { RevertToSelf() } == 0 {
        process::abort();
    }
    if opened == 0 {
        return None;
    }
    Token(handle).peer(pipe)
}

// Users and service SIDs only: SDDL aliases and well-known groups would admit whole populations.
fn admissible(sid: &str, own: &str) -> bool {
    let account = sid.starts_with("S-1-5-21-") || sid.starts_with("S-1-5-80-");
    let numeric = sid[2..]
        .split('-')
        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()));
    if !account || !numeric || sid == own {
        return false;
    }
    let text = wide(sid);
    let mut parsed = null_mut();
    if unsafe { ConvertStringSidToSidW(text.as_ptr(), &mut parsed) } == 0 {
        return false;
    }
    unsafe { LocalFree(parsed) };
    true
}

fn parse_args() -> Result<Config, String> {
    let mut args = std::env::args().skip(1);
    let (mut pipe, mut admit, mut idle) = (None, Vec::new(), Duration::from_secs(300));
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--pipe" => pipe = Some(value),
            "--admit" => admit.push(value),
            "--idle-secs" => {
                idle = Duration::from_secs(
                    value
                        .parse()
                        .map_err(|_| "--idle-secs must be a whole number")?,
                )
            }
            _ => return Err(format!("unknown flag {flag}")),
        }
    }
    let pipe = pipe.ok_or("--pipe is required")?;
    if !pipe.starts_with(r"\\.\pipe\") {
        return Err(r"--pipe must be a local \\.\pipe\ path".into());
    }
    Ok(Config { pipe, admit, idle })
}

async fn read_frames(
    mut reader: ReadHalf<NamedPipeServer>,
    first: u32,
    frames: mpsc::Sender<Vec<u8>>,
) {
    let mut length = first;
    loop {
        if length == 0 || length > MAX_FRAME {
            return;
        }
        let mut body = vec![0u8; length as usize];
        if reader.read_exact(&mut body).await.is_err() || frames.send(body).await.is_err() {
            return;
        }
        length = match reader.read_u32().await {
            Ok(length) => length,
            Err(_) => return,
        };
    }
}

async fn serve(pipe: NamedPipeServer, conn: u64, shared: Arc<Shared>) {
    let handle = pipe.as_raw_handle() as usize;
    let (mut reader, mut writer) = tokio::io::split(pipe);
    let Ok(Ok(first)) = timeout(shared.idle, reader.read_u32()).await else {
        return;
    };
    if first == 0 || first > MAX_FRAME {
        return;
    }
    let peer = identify(handle as HANDLE);
    let key = peer.as_ref().map_or_else(String::new, |p| {
        p["sid"].as_str().unwrap_or_default().to_string()
    });
    let Some(_slot) = shared.claim(key) else {
        return;
    };

    let (commands_tx, mut commands) = mpsc::channel(4);
    shared.conns.lock().unwrap().insert(conn, commands_tx);
    shared
        .emit(
            OPEN,
            conn,
            peer.map_or_else(|| b"null".to_vec(), |p| p.to_string().into_bytes())
                .as_slice(),
        )
        .await;

    let (frames_tx, mut frames) = mpsc::channel(1);
    let reading = tokio::spawn(read_frames(reader, first, frames_tx));
    let mut deadline = Instant::now() + shared.idle;
    let mut in_flight = false;
    loop {
        tokio::select! {
            frame = frames.recv() => match frame {
                Some(body) if !in_flight => {
                    in_flight = true;
                    shared.emit(FRAME, conn, &body).await;
                }
                _ => break,
            },
            command = commands.recv() => match command {
                Some(Command::Frame(response)) if in_flight && response.len() <= MAX_FRAME as usize => {
                    in_flight = false;
                    let mut framed = (response.len() as u32).to_be_bytes().to_vec();
                    framed.extend_from_slice(&response);
                    if writer.write_all(&framed).await.is_err() || writer.flush().await.is_err() {
                        break;
                    }
                }
                _ => break,
            },
            () = sleep_until(deadline) => break,
        }
        deadline = Instant::now() + shared.idle;
    }
    reading.abort();
    shared.conns.lock().unwrap().remove(&conn);
    shared.emit(CLOSE, conn, &[]).await;
}

async fn route_commands(shared: Arc<Shared>) {
    let mut stdin = tokio::io::stdin();
    loop {
        let Ok(length) = stdin.read_u32().await else {
            process::exit(0)
        };
        if !(9..=9 + MAX_FRAME).contains(&length) {
            eprintln!("orynq-pipe-frontend: parent sent a {length}-byte message");
            process::exit(2);
        }
        let mut message = vec![0u8; length as usize];
        if stdin.read_exact(&mut message).await.is_err() {
            process::exit(0);
        }
        let conn = u64::from_be_bytes(message[1..9].try_into().unwrap());
        let command = match message[0] {
            FRAME => Command::Frame(message.split_off(9)),
            CLOSE => Command::Close,
            kind => {
                eprintln!("orynq-pipe-frontend: parent sent message kind {kind}");
                process::exit(2);
            }
        };
        let sender = shared.conns.lock().unwrap().get(&conn).cloned();
        if let Some(sender) = sender {
            // A send fails only when the connection ended after the lookup; its close event is on its way.
            sender.send(command).await.ok();
        }
    }
}

async fn run() -> Result<(), String> {
    let config = parse_args()?;
    let own = own_sid().ok_or("cannot read this process's account SID")?;
    if let Some(sid) = config.admit.iter().find(|sid| !admissible(sid, &own)) {
        return Err(format!(
            "refusing to admit {sid}: only user (S-1-5-21-…) and service (S-1-5-80-…) SIDs other than this process's own"
        ));
    }
    let admitted: String = config
        .admit
        .iter()
        .map(|sid| format!("(A;;{CLIENT_RIGHTS};;;{sid})"))
        .collect();
    let descriptor =
        SecurityDescriptor::from_sddl(&format!("O:{own}D:P(A;;GA;;;SY)(A;;GA;;;{own}){admitted}"))?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let mut create = |first: bool| unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(
                &config.pipe,
                (&raw mut attributes).cast::<c_void>(),
            )
            .map_err(|error| format!("cannot create {}: {error}", config.pipe))
    };

    let mut server = create(true)?;
    let (out, mut outgoing) = mpsc::channel::<Vec<u8>>(64);
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = outgoing.recv().await {
            if stdout.write_all(&message).await.is_err() || stdout.flush().await.is_err() {
                process::exit(0);
            }
        }
    });
    let shared = Arc::new(Shared {
        out,
        conns: Mutex::default(),
        per_peer: Mutex::default(),
        idle: config.idle,
    });
    tokio::spawn(route_commands(Arc::clone(&shared)));
    shared.emit(READY, 0, &[]).await;

    let mut next_conn = 1u64;
    loop {
        let connected = server.connect().await;
        let instance = std::mem::replace(&mut server, create(false)?);
        if connected.is_ok() {
            tokio::spawn(serve(instance, next_conn, Arc::clone(&shared)));
            next_conn += 1;
        }
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("orynq-pipe-frontend: {error}");
        process::exit(1);
    }
}
