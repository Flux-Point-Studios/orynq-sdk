//! Helpers shared by the frontend's unit tests (src/main.rs) and its integration tests.

use std::{
    ffi::CString,
    fs,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{
            ffi::{OsStrExt, OsStringExt},
            net::UnixStream,
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU32, Ordering},
};

const CGROUP_ROOT: &str = "/sys/fs/cgroup";

pub fn kernel_release() -> (u32, u32) {
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

pub fn own_cgroup() -> String {
    let text = fs::read_to_string("/proc/self/cgroup").unwrap();
    text.lines()
        .find_map(|line| line.strip_prefix("0::"))
        .unwrap()
        .to_string()
}

pub fn cgroup_dir(cgroup: &str) -> PathBuf {
    Path::new(CGROUP_ROOT).join(cgroup.trim_start_matches('/'))
}

/// A child process killed and reaped on drop.
pub struct Connector(pub Child);

impl Drop for Connector {
    fn drop(&mut self) {
        self.0.kill().ok();
        self.0.wait().ok();
    }
}

// Connects `count` clients from a child process that first joins `cgroup`, when one is given, and
// then execs `program`. Each connection's peer is that child, and once it has exec'd only this test
// holds the client ends, since every descriptor here is close-on-exec.
pub fn connect_from_child(
    socket: &Path,
    count: usize,
    cgroup: Option<&Path>,
    program: &[&str],
) -> (Connector, Vec<UnixStream>) {
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (slot, byte) in address
        .sun_path
        .iter_mut()
        .zip(socket.as_os_str().as_bytes())
    {
        *slot = *byte as libc::c_char;
    }
    let clients: Vec<OwnedFd> = (0..count)
        .map(|_| {
            let fd =
                unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
            assert!(fd >= 0);
            unsafe { OwnedFd::from_raw_fd(fd) }
        })
        .collect();
    let fds: Vec<RawFd> = clients.iter().map(AsRawFd::as_raw_fd).collect();
    let procs = cgroup.map(|cgroup| {
        CString::new(cgroup.join("cgroup.procs").into_os_string().into_vec()).unwrap()
    });
    let mut command = Command::new(program[0]);
    command
        .args(&program[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if let Some(procs) = &procs {
                // Writing 0 moves the writing process.
                let fd = libc::open(procs.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC);
                if fd < 0 || libc::write(fd, b"0".as_ptr().cast(), 1) != 1 {
                    return Err(std::io::Error::last_os_error());
                }
                libc::close(fd);
            }
            for &fd in &fds {
                let size = std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
                if libc::connect(fd, (&raw const address).cast(), size) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let child = Connector(command.spawn().unwrap());
    (child, clients.into_iter().map(UnixStream::from).collect())
}

/// Child cgroups of this test's own cgroup, removed on drop once their processes are gone.
pub struct Cgroups(pub Vec<PathBuf>);

impl Drop for Cgroups {
    fn drop(&mut self) {
        for path in &self.0 {
            fs::remove_dir(path).ok();
        }
    }
}

// An unprivileged account can create a cgroup only under one delegated to it (a systemd user
// session's); elsewhere mkdir is refused, which is the only skip, and it is checked as such.
pub fn cgroups_or_skip(count: usize) -> Option<Cgroups> {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let own = cgroup_dir(&own_cgroup());
    let mut cgroups = Cgroups(Vec::new());
    for _ in 0..count {
        let path = own.join(format!(
            "orynq-sf-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        if let Err(error) = fs::create_dir(&path) {
            assert!(
                matches!(
                    error.raw_os_error(),
                    Some(libc::EROFS | libc::EACCES | libc::EPERM)
                ),
                "{error}"
            );
            eprintln!("skipped: no cgroup is delegated to this account ({error})");
            return None;
        }
        cgroups.0.push(path);
    }
    Some(cgroups)
}
