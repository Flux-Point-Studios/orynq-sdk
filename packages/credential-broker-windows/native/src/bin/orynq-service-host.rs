//! Runs a program as a Windows service. The service control manager starts this host under the
//! service's account; the host starts the program with a held-open stdin, and a stop request closes
//! that stdin, killing the program only if it outlives the grace period.
//!
//! Service ImagePath: `orynq-service-host <service-name> <program> [args...]`. The program's stdout
//! and stderr append to `%ProgramData%\<service-name>\service.log`.

use std::{
    env,
    ffi::OsString,
    fs::OpenOptions,
    io,
    path::PathBuf,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
    },
    thread,
    time::{Duration, Instant},
};

use windows_service::{
    define_windows_service,
    service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    },
    service_control_handler::{self, ServiceControlHandlerResult, ServiceStatusHandle},
    service_dispatcher,
};

const GRACE: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(100);
const EXIT_BAD_ARGUMENTS: u32 = 1;
const EXIT_NO_LOG: u32 = 2;
const EXIT_NO_PROGRAM: u32 = 3;
const EXIT_PROGRAM_ENDED: u32 = 4;

fn supervise(mut child: Child, stop: Receiver<()>, grace: Duration) -> io::Result<ExitStatus> {
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        match stop.recv_timeout(POLL) {
            Err(RecvTimeoutError::Timeout) => {}
            Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    drop(child.stdin.take());
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        thread::sleep(POLL);
    }
    child.kill()?;
    child.wait()
}

fn status(state: ServiceState, exit_code: ServiceExitCode, wait_hint: Duration) -> ServiceStatus {
    let controls_accepted = if state == ServiceState::Running {
        ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN
    } else {
        ServiceControlAccept::empty()
    };
    ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted,
        exit_code,
        checkpoint: 0,
        wait_hint,
        process_id: None,
    }
}

fn start_program(name: &OsString, program: &OsString, args: &[OsString]) -> Result<Child, u32> {
    let mut log_path = PathBuf::from(env::var_os("ProgramData").ok_or(EXIT_NO_LOG)?);
    log_path.push(name);
    log_path.push("service.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|_| EXIT_NO_LOG)?;
    let log_err = log.try_clone().map_err(|_| EXIT_NO_LOG)?;
    Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(log)
        .stderr(log_err)
        .spawn()
        .map_err(|_| EXIT_NO_PROGRAM)
}

// An exit nobody asked for is a failure, even with code 0, so the service's recovery actions restart it.
fn run(handle: ServiceStatusHandle, stop: Receiver<()>, stopping: &AtomicBool) -> ServiceExitCode {
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let [name, program, rest @ ..] = args.as_slice() else {
        return ServiceExitCode::ServiceSpecific(EXIT_BAD_ARGUMENTS);
    };
    let child = match start_program(name, program, rest) {
        Ok(child) => child,
        Err(code) => return ServiceExitCode::ServiceSpecific(code),
    };
    if handle
        .set_service_status(status(
            ServiceState::Running,
            ServiceExitCode::NO_ERROR,
            Duration::ZERO,
        ))
        .is_err()
    {
        return ServiceExitCode::ServiceSpecific(EXIT_PROGRAM_ENDED);
    }
    match supervise(child, stop, GRACE) {
        Ok(_) if stopping.load(Ordering::SeqCst) => ServiceExitCode::NO_ERROR,
        _ => ServiceExitCode::ServiceSpecific(EXIT_PROGRAM_ENDED),
    }
}

fn service_main(_start_arguments: Vec<OsString>) {
    let (stop_tx, stop) = mpsc::channel();
    let stopping = Arc::new(AtomicBool::new(false));
    let registered: Arc<OnceLock<ServiceStatusHandle>> = Arc::new(OnceLock::new());
    let handler = {
        let (stopping, registered) = (Arc::clone(&stopping), Arc::clone(&registered));
        move |control| match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                stopping.store(true, Ordering::SeqCst);
                if let Some(handle) = registered.get() {
                    let pending = status(
                        ServiceState::StopPending,
                        ServiceExitCode::NO_ERROR,
                        GRACE + Duration::from_secs(5),
                    );
                    handle.set_service_status(pending).ok();
                }
                // Fails only once supervision has already returned, when there is nothing left to stop.
                stop_tx.send(()).ok();
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };
    let name = env::args_os().nth(1).unwrap_or_default();
    let Ok(handle) = service_control_handler::register(name, handler) else {
        return;
    };
    registered.set(handle).ok();
    let exit_code = run(handle, stop, &stopping);
    handle
        .set_service_status(status(ServiceState::Stopped, exit_code, Duration::ZERO))
        .ok();
}

define_windows_service!(ffi_service_main, service_main);

fn main() {
    if let Err(error) = service_dispatcher::start("", ffi_service_main) {
        eprintln!("orynq-service-host runs only under the service control manager: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::supervise;
    use std::{
        process::{Command, Stdio},
        sync::mpsc,
        time::{Duration, Instant},
    };

    fn system32(exe: &str) -> String {
        format!(
            r"{}\System32\{exe}",
            std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())
        )
    }

    fn spawn(exe: &str, args: &[&str]) -> std::process::Child {
        Command::new(system32(exe))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    #[test]
    fn returns_the_status_of_a_child_that_exits_by_itself() {
        let (_stop, stopped) = mpsc::channel();
        let status = supervise(
            spawn("cmd.exe", &["/c", "exit 7"]),
            stopped,
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(status.code(), Some(7));
    }

    #[test]
    fn stops_a_child_by_closing_its_stdin() {
        let (stop, stopped) = mpsc::channel();
        let child = spawn("sort.exe", &[]);
        stop.send(()).unwrap();
        let started = Instant::now();
        let status = supervise(child, stopped, Duration::from_secs(10)).unwrap();
        assert_eq!(status.code(), Some(0));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn kills_a_child_that_ignores_stdin_after_the_grace_period() {
        let (stop, stopped) = mpsc::channel();
        let child = spawn("ping.exe", &["-n", "60", "127.0.0.1"]);
        stop.send(()).unwrap();
        let started = Instant::now();
        let status = supervise(child, stopped, Duration::from_millis(500)).unwrap();
        assert!(!status.success());
        assert!(started.elapsed() >= Duration::from_millis(500));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn treats_a_dropped_stop_channel_as_a_stop() {
        let (stop, stopped) = mpsc::channel::<()>();
        drop(stop);
        let status = supervise(spawn("sort.exe", &[]), stopped, Duration::from_secs(10)).unwrap();
        assert_eq!(status.code(), Some(0));
    }
}
