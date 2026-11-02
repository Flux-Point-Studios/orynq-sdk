use std::{
    fs::File,
    io::{self, Read, Write},
    iter::once,
    os::windows::io::FromRawHandle,
    process::{Child, ChildStdin, Command, Stdio},
    ptr::{null, null_mut},
    sync::mpsc,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use windows_sys::Win32::{
    Foundation::{GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, LocalFree},
    Security::{
        ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
        Authorization::{ConvertSidToStringSidW, GetSecurityInfo, SE_KERNEL_OBJECT},
        DACL_SECURITY_INFORMATION, GetAce, GetAclInformation, GetTokenInformation,
        OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, TOKEN_QUERY, TOKEN_STATISTICS,
        TokenStatistics,
    },
    Storage::FileSystem::{
        CreateFileW, OPEN_EXISTING, SECURITY_ANONYMOUS, SECURITY_IDENTIFICATION,
        SECURITY_SQOS_PRESENT,
    },
    System::{
        RemoteDesktop::ProcessIdToSessionId,
        Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

const READY: u8 = 0;
const OPEN: u8 = 1;
const FRAME: u8 = 2;
const CLOSE: u8 = 3;
const MAX_FRAME: u32 = 16 << 20;
const WAIT: Duration = Duration::from_secs(20);

struct Event {
    kind: u8,
    conn: u64,
    payload: Vec<u8>,
}

struct Frontend {
    child: Child,
    stdin: Option<ChildStdin>,
    events: mpsc::Receiver<Event>,
    pipe: String,
}

fn unique_pipe() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!(
        r"\\.\pipe\orynq-frontend-test-{}-{nanos}",
        std::process::id()
    )
}

fn spawn(pipe: &str, args: &[&str]) -> Child {
    Command::new(env!("CARGO_BIN_EXE_orynq-pipe-frontend"))
        .arg("--pipe")
        .arg(pipe)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

impl Frontend {
    fn start(args: &[&str]) -> Frontend {
        Frontend::start_on(&unique_pipe(), args)
    }

    fn start_on(pipe: &str, args: &[&str]) -> Frontend {
        let mut child = spawn(pipe, args);
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
            pipe: pipe.to_string(),
        };
        assert_eq!(frontend.next().kind, READY);
        frontend
    }

    fn next(&mut self) -> Event {
        self.events
            .recv_timeout(WAIT)
            .expect("no event from the frontend")
    }

    fn quiet_for(&mut self, period: Duration) -> bool {
        self.events.recv_timeout(period).is_err()
    }

    fn send(&mut self, kind: u8, conn: u64, payload: &[u8]) {
        let mut message = ((9 + payload.len()) as u32).to_be_bytes().to_vec();
        message.push(kind);
        message.extend_from_slice(&conn.to_be_bytes());
        message.extend_from_slice(payload);
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(&message).unwrap();
        stdin.flush().unwrap();
    }

    fn connect(&self) -> File {
        connect(&self.pipe, SECURITY_IDENTIFICATION).unwrap()
    }
}

impl Drop for Frontend {
    fn drop(&mut self) {
        self.child.kill().ok();
        self.child.wait().ok();
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(once(0)).collect()
}

fn connect(pipe: &str, level: u32) -> io::Result<File> {
    let name = wide(pipe);
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            null(),
            OPEN_EXISTING,
            SECURITY_SQOS_PRESENT | level,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_handle(handle) })
    }
}

fn frame(body: &[u8]) -> Vec<u8> {
    let mut framed = (body.len() as u32).to_be_bytes().to_vec();
    framed.extend_from_slice(body);
    framed
}

fn read_frame(client: &mut File) -> Vec<u8> {
    let mut header = [0u8; 4];
    client.read_exact(&mut header).unwrap();
    let mut body = vec![0u8; u32::from_be_bytes(header) as usize];
    client.read_exact(&mut body).unwrap();
    body
}

fn closed_within(mut client: File, period: Duration) -> bool {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut byte = [0u8; 1];
        tx.send(matches!(client.read(&mut byte), Ok(0) | Err(_)))
            .ok();
    });
    rx.recv_timeout(period).unwrap_or(false)
}

fn principal(event: &Event) -> serde_json::Value {
    assert_eq!(event.kind, OPEN);
    serde_json::from_slice(&event.payload).unwrap()
}

fn whoami(args: &[&str]) -> String {
    let exe = format!(
        r"{}\System32\whoami.exe",
        std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())
    );
    String::from_utf8(Command::new(exe).args(args).output().unwrap().stdout).unwrap()
}

fn own_sid() -> String {
    whoami(&["/user", "/fo", "csv", "/nh"])
        .trim()
        .split(',')
        .nth(1)
        .unwrap()
        .replace('"', "")
}

fn own_integrity_rid() -> u64 {
    let label = whoami(&["/groups", "/fo", "csv", "/nh"])
        .lines()
        .find_map(|line| {
            line.split(',')
                .find(|field| field.contains("S-1-16-"))
                .map(str::to_string)
        })
        .unwrap();
    label
        .replace('"', "")
        .rsplit('-')
        .next()
        .unwrap()
        .parse()
        .unwrap()
}

fn own_session() -> u64 {
    let mut session = 0u32;
    assert_ne!(
        unsafe { ProcessIdToSessionId(std::process::id(), &mut session) },
        0
    );
    session as u64
}

fn own_logon_luid() -> String {
    let mut token: HANDLE = null_mut();
    assert_ne!(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) },
        0
    );
    let mut stats: TOKEN_STATISTICS = unsafe { std::mem::zeroed() };
    let mut length = 0u32;
    let size = std::mem::size_of::<TOKEN_STATISTICS>() as u32;
    assert_ne!(
        unsafe {
            GetTokenInformation(
                token,
                TokenStatistics,
                (&raw mut stats).cast(),
                size,
                &mut length,
            )
        },
        0
    );
    (((stats.AuthenticationId.HighPart as u32 as u64) << 32)
        | stats.AuthenticationId.LowPart as u64)
        .to_string()
}

fn sid_text(sid: PSID) -> String {
    let mut text = null_mut();
    assert_ne!(unsafe { ConvertSidToStringSidW(sid, &mut text) }, 0);
    let length = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
    let value = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).unwrap();
    unsafe { LocalFree(text.cast()) };
    value
}

fn owner_and_aces(client: &File) -> (String, Vec<(String, u32)>) {
    use std::os::windows::io::AsRawHandle;
    let mut owner: PSID = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            client.as_raw_handle(),
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    assert_eq!(status, 0);
    let mut info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32;
    assert_ne!(
        unsafe { GetAclInformation(dacl, (&raw mut info).cast(), size, AclSizeInformation) },
        0
    );
    let aces = (0..info.AceCount)
        .map(|index| {
            let mut ace = null_mut();
            assert_ne!(unsafe { GetAce(dacl, index, &mut ace) }, 0);
            let ace = ace.cast::<ACCESS_ALLOWED_ACE>();
            (
                sid_text(unsafe { (&raw mut (*ace).SidStart).cast() }),
                unsafe { (*ace).Mask },
            )
        })
        .collect();
    let owner = sid_text(owner);
    unsafe { LocalFree(descriptor) };
    (owner, aces)
}

#[test]
fn reports_the_callers_identity_from_impersonation() {
    let mut frontend = Frontend::start(&[]);
    let mut client = frontend.connect();
    client.write_all(&frame(b"{}")).unwrap();
    let identity = principal(&frontend.next());
    assert_eq!(identity["sid"], own_sid());
    assert_eq!(identity["session"], own_session());
    assert_eq!(identity["integrity"], own_integrity_rid());
    assert_eq!(identity["logonLuid"], own_logon_luid());
    assert_eq!(identity["pid"], std::process::id() as u64);
}

#[test]
fn relays_a_frame_and_its_response() {
    let mut frontend = Frontend::start(&[]);
    let mut client = frontend.connect();
    client
        .write_all(&frame(
            br#"{"jsonrpc":"2.0","id":1,"method":"broker.hello"}"#,
        ))
        .unwrap();
    let open = frontend.next();
    let request = frontend.next();
    assert_eq!((request.kind, request.conn), (FRAME, open.conn));
    assert_eq!(
        request.payload,
        br#"{"jsonrpc":"2.0","id":1,"method":"broker.hello"}"#
    );
    frontend.send(FRAME, open.conn, br#"{"jsonrpc":"2.0","id":1,"result":{}}"#);
    assert_eq!(
        read_frame(&mut client),
        br#"{"jsonrpc":"2.0","id":1,"result":{}}"#
    );
}

#[test]
fn gives_an_anonymous_client_no_principal() {
    let mut frontend = Frontend::start(&[]);
    let mut client = connect(&frontend.pipe, SECURITY_ANONYMOUS).unwrap();
    client.write_all(&frame(b"{}")).unwrap();
    let event = frontend.next();
    assert_eq!(event.kind, OPEN);
    assert_eq!(event.payload, b"null");
}

#[test]
fn accepts_a_frame_of_exactly_sixteen_mebibytes() {
    let mut frontend = Frontend::start(&[]);
    let mut client = frontend.connect();
    let body = vec![b'x'; MAX_FRAME as usize];
    let writer = thread::spawn(move || client.write_all(&frame(&body)).map(|()| client));
    frontend.next();
    let request = frontend.next();
    assert_eq!(
        (request.kind, request.payload.len()),
        (FRAME, MAX_FRAME as usize)
    );
    writer.join().unwrap().unwrap();
}

#[test]
fn closes_on_an_oversize_first_frame_without_opening() {
    let mut frontend = Frontend::start(&[]);
    let mut client = frontend.connect();
    client.write_all(&(MAX_FRAME + 1).to_be_bytes()).unwrap();
    assert!(closed_within(client, WAIT));
    let mut next = frontend.connect();
    next.write_all(&frame(b"{}")).unwrap();
    assert_eq!(frontend.next().kind, OPEN);
}

#[test]
fn closes_on_a_zero_length_frame() {
    let mut frontend = Frontend::start(&[]);
    let mut client = frontend.connect();
    client.write_all(&frame(b"{}")).unwrap();
    let open = frontend.next();
    frontend.next();
    frontend.send(FRAME, open.conn, b"{}");
    read_frame(&mut client);
    client.write_all(&0u32.to_be_bytes()).unwrap();
    let close = frontend.next();
    assert_eq!((close.kind, close.conn), (CLOSE, open.conn));
    assert!(closed_within(client, WAIT));
}

#[test]
fn refuses_a_second_request_while_one_is_in_flight() {
    let mut frontend = Frontend::start(&[]);
    let mut client = frontend.connect();
    client
        .write_all(&[frame(b"{}"), frame(b"{}")].concat())
        .unwrap();
    let open = frontend.next();
    assert_eq!(frontend.next().kind, FRAME);
    let close = frontend.next();
    assert_eq!((close.kind, close.conn), (CLOSE, open.conn));
}

#[test]
fn closes_idle_connections() {
    let mut frontend = Frontend::start(&["--idle-secs", "1"]);
    let silent = frontend.connect();
    assert!(closed_within(silent, Duration::from_secs(5)));
    let mut client = frontend.connect();
    client.write_all(&frame(b"{}")).unwrap();
    let open = frontend.next();
    frontend.next();
    frontend.send(FRAME, open.conn, b"{}");
    read_frame(&mut client);
    let close = frontend.next();
    assert_eq!((close.kind, close.conn), (CLOSE, open.conn));
}

#[test]
fn closes_a_connection_when_the_parent_says_so() {
    let mut frontend = Frontend::start(&[]);
    let mut client = frontend.connect();
    client.write_all(&frame(b"{}")).unwrap();
    let open = frontend.next();
    frontend.next();
    frontend.send(CLOSE, open.conn, &[]);
    assert!(closed_within(client, WAIT));
}

#[test]
fn caps_connections_per_principal_at_thirty_two() {
    let mut frontend = Frontend::start(&[]);
    let mut clients = Vec::new();
    for _ in 0..32 {
        let mut client = frontend.connect();
        client.write_all(&frame(b"{}")).unwrap();
        assert_eq!(frontend.next().kind, OPEN);
        assert_eq!(frontend.next().kind, FRAME);
        clients.push(client);
    }
    let mut extra = frontend.connect();
    extra.write_all(&frame(b"{}")).unwrap();
    assert!(closed_within(extra, WAIT));
    assert!(frontend.quiet_for(Duration::from_millis(500)));
}

#[test]
fn owns_the_pipe_and_grants_admitted_accounts_no_instance_creation() {
    let admitted = "S-1-5-21-1-2-3-1001";
    let frontend = Frontend::start(&["--admit", admitted]);
    let client = frontend.connect();
    let (owner, aces) = owner_and_aces(&client);
    assert_eq!(owner, own_sid());
    let granted: Vec<u32> = aces
        .iter()
        .filter(|(sid, _)| sid == admitted)
        .map(|(_, mask)| *mask)
        .collect();
    assert_eq!(granted, vec![0x0012_0083]);
    assert!(
        aces.iter()
            .all(|(sid, _)| sid == admitted || sid == "S-1-5-18" || *sid == own_sid())
    );
}

#[test]
fn refuses_to_admit_aliases_groups_and_itself() {
    for admit in [
        "WD",
        "S-1-1-0",
        "S-1-5-11",
        "S-1-5-32-545",
        "S-1-5-21-1-2-3-1001)(A;;GA;;;WD",
        &own_sid(),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_orynq-pipe-frontend"))
            .args(["--pipe", &unique_pipe(), "--admit", admit])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(!output.status.success(), "admitted {admit}");
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn refuses_to_start_on_a_pipe_name_already_in_use() {
    let first = Frontend::start(&[]);
    let output = spawn(&first.pipe, &[]).wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}

#[test]
fn exits_when_the_parent_closes_stdin() {
    let mut frontend = Frontend::start(&[]);
    frontend.stdin.take();
    let deadline = std::time::Instant::now() + WAIT;
    while frontend.child.try_wait().unwrap().is_none() {
        assert!(
            std::time::Instant::now() < deadline,
            "frontend outlived its parent"
        );
        thread::sleep(Duration::from_millis(50));
    }
}
