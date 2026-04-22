use std::collections::HashMap;
use std::io;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);
const DROP_KILL_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug)]
struct TrackedProcess {
    label: String,
    started_at: Instant,
}

#[derive(Default)]
pub struct ProcessRegistry {
    processes: Mutex<HashMap<u32, TrackedProcess>>,
}

static PROCESS_REGISTRY: OnceLock<ProcessRegistry> = OnceLock::new();

pub fn process_registry() -> &'static ProcessRegistry {
    PROCESS_REGISTRY.get_or_init(ProcessRegistry::default)
}

impl ProcessRegistry {
    fn register(&self, pid: u32, label: &str) {
        self.processes.lock().unwrap().insert(
            pid,
            TrackedProcess {
                label: label.to_string(),
                started_at: Instant::now(),
            },
        );
    }

    fn unregister(&self, pid: u32) {
        self.processes.lock().unwrap().remove(&pid);
    }

    pub fn tracked_count(&self) -> usize {
        self.processes.lock().unwrap().len()
    }

    pub fn snapshot(&self) -> Vec<(u32, String, Instant)> {
        self.processes
            .lock()
            .unwrap()
            .iter()
            .map(|(pid, process)| (*pid, process.label.clone(), process.started_at))
            .collect()
    }

    pub fn terminate_all(&self) -> Result<(), String> {
        let tracked = self.snapshot();
        let mut errors = Vec::new();
        for (pid, label, started_at) in tracked {
            log::warn!(
                "Terminating tracked process tree '{}' (pid {}) after {:?}",
                label,
                pid,
                started_at.elapsed()
            );
            if let Err(err) = terminate_process_tree(pid) {
                errors.push(format!("{label} (pid {pid}): {err}"));
            }
        }
        self.processes.lock().unwrap().clear();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join(" | "))
        }
    }

    #[cfg(test)]
    fn clear_for_tests(&self) {
        self.processes.lock().unwrap().clear();
    }
}

pub struct ManagedChild {
    child: Child,
    pid: u32,
    label: String,
    registered: bool,
}

impl ManagedChild {
    pub fn spawn(command: &mut Command, label: impl Into<String>) -> io::Result<Self> {
        configure_command(command);
        let label = label.into();
        let child = command.spawn()?;
        let pid = child.id();
        process_registry().register(pid, &label);
        Ok(Self {
            child,
            pid,
            label,
            registered: true,
        })
    }

    pub fn id(&self) -> u32 {
        self.pid
    }

    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        if status.is_some() {
            self.unregister();
        }
        Ok(status)
    }

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        let status = self.child.wait()?;
        self.unregister();
        Ok(status)
    }

    pub fn wait_with_timeout(&mut self, timeout: Duration) -> io::Result<Option<ExitStatus>> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(Some(status));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            thread::sleep(PROCESS_POLL_INTERVAL);
        }
    }

    pub fn terminate_tree(&mut self) -> io::Result<()> {
        log::warn!(
            "Force-terminating process tree '{}' (pid {})",
            self.label,
            self.pid
        );
        terminate_process_tree(self.pid)?;
        let _ = self.wait_with_timeout(DROP_KILL_TIMEOUT)?;
        self.unregister();
        Ok(())
    }

    fn unregister(&mut self) {
        if self.registered {
            process_registry().unregister(self.pid);
            self.registered = false;
        }
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        match self.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) => {
                let _ = self.terminate_tree();
            }
            Err(_) => {
                self.unregister();
            }
        }
    }
}

#[cfg(unix)]
fn configure_command(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn configure_command(_command: &mut Command) {}

#[cfg(windows)]
fn terminate_process_tree(pid: u32) -> io::Result<()> {
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        // `taskkill` returns a non-zero status when the process is already gone.
        Ok(())
    }
}

#[cfg(unix)]
fn terminate_process_tree(pid: u32) -> io::Result<()> {
    let pid = pid as i32;
    signal_process_group_or_fallback(pid, libc::SIGTERM)?;

    thread::sleep(Duration::from_millis(250));

    signal_process_group_or_fallback(pid, libc::SIGKILL)?;
    Ok(())
}

#[cfg(unix)]
fn signal_process_group_or_fallback(pid: i32, signal: i32) -> io::Result<()> {
    let group_status = unsafe { libc::kill(-pid, signal) };
    if group_status == 0 {
        return Ok(());
    }

    let err = io::Error::last_os_error();
    match err.raw_os_error() {
        Some(libc::ESRCH) => Ok(()),
        Some(libc::EPERM) => terminate_processes_individually(pid, signal),
        _ => Err(err),
    }
}

#[cfg(unix)]
fn terminate_processes_individually(root_pid: i32, signal: i32) -> io::Result<()> {
    let mut targets = process_descendants(root_pid)?;
    targets.push(root_pid);

    let mut last_error = None;
    let mut signaled_any = false;
    for target in targets {
        match signal_process(target, signal) {
            Ok(true) => signaled_any = true,
            Ok(false) => {}
            Err(err) => last_error = Some(err),
        }
    }

    if signaled_any || last_error.is_none() {
        Ok(())
    } else {
        Err(last_error.unwrap())
    }
}

#[cfg(unix)]
fn signal_process(pid: i32, signal: i32) -> io::Result<bool> {
    let status = unsafe { libc::kill(pid, signal) };
    if status == 0 {
        return Ok(true);
    }

    let err = io::Error::last_os_error();
    match err.raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        _ => Err(err),
    }
}

#[cfg(unix)]
fn process_descendants(root_pid: i32) -> io::Result<Vec<i32>> {
    let output = Command::new("/bin/ps")
        .args(["-A", "-o", "pid=", "-o", "ppid="])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()?;

    if !output.status.success() {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            format!("ps exited with status {}", output.status),
        ));
    }

    let snapshot = String::from_utf8_lossy(&output.stdout);
    Ok(collect_descendants(
        root_pid,
        &parse_process_snapshot(snapshot.as_ref()),
    ))
}

#[cfg(unix)]
fn parse_process_snapshot(snapshot: &str) -> Vec<(i32, i32)> {
    snapshot
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let ppid = fields.next()?.parse().ok()?;
            Some((pid, ppid))
        })
        .collect()
}

#[cfg(unix)]
fn collect_descendants(root_pid: i32, processes: &[(i32, i32)]) -> Vec<i32> {
    fn visit(root_pid: i32, processes: &[(i32, i32)], descendants: &mut Vec<i32>) {
        for &(pid, ppid) in processes {
            if ppid != root_pid {
                continue;
            }
            visit(pid, processes, descendants);
            descendants.push(pid);
        }
    }

    let mut descendants = Vec::new();
    visit(root_pid, processes, &mut descendants);
    descendants
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    fn test_lock() -> &'static Mutex<()> {
        static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        TEST_LOCK.get_or_init(|| Mutex::new(()))
    }

    fn test_guard() -> MutexGuard<'static, ()> {
        test_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn spawn_sleep_process() -> ManagedChild {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("powershell");
            command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
            command
        };

        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "sleep 30"]);
            command
        };

        ManagedChild::spawn(&mut command, "test sleeper").unwrap()
    }

    #[test]
    fn terminate_tree_stops_child_process() {
        let _guard = test_guard();
        process_registry().clear_for_tests();
        let mut child = spawn_sleep_process();
        assert!(process_registry().tracked_count() >= 1);
        child.terminate_tree().unwrap();
        assert!(child
            .wait_with_timeout(Duration::from_secs(1))
            .unwrap()
            .is_some());
        assert_eq!(process_registry().tracked_count(), 0);
    }

    #[test]
    fn terminate_all_kills_registered_processes() {
        let _guard = test_guard();
        process_registry().clear_for_tests();
        let mut first = spawn_sleep_process();
        let mut second = spawn_sleep_process();

        assert!(process_registry().tracked_count() >= 2);
        process_registry().terminate_all().unwrap();

        assert!(first
            .wait_with_timeout(Duration::from_secs(2))
            .unwrap()
            .is_some());
        assert!(second
            .wait_with_timeout(Duration::from_secs(2))
            .unwrap()
            .is_some());
        assert_eq!(process_registry().tracked_count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn parse_process_snapshot_skips_invalid_rows() {
        let snapshot = " 101 1\ninvalid\n 202 not-a-number\n303 101 extra\n";
        assert_eq!(parse_process_snapshot(snapshot), vec![(101, 1), (303, 101)]);
    }

    #[cfg(unix)]
    #[test]
    fn collect_descendants_returns_nested_children() {
        let processes = vec![(10, 1), (11, 10), (12, 11), (13, 10), (20, 2)];
        assert_eq!(collect_descendants(10, &processes), vec![12, 11, 13]);
    }
}
