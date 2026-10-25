//! Native-owned provider process trees. Windows job handles close on account restart, including in-flight login workers.
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
use std::process::{Child, Command};

#[cfg(windows)]
struct WindowsProcessJob(usize);

#[cfg(unix)]
struct UnixProcessGroup {
    id: i32,
}

#[cfg(unix)]
impl UnixProcessGroup {
    fn terminate(&self) {
        // The child is deliberately kept unreaped while the group is killed.
        // Its PID therefore cannot be recycled into an unrelated process group.
        unsafe {
            let _ = libc::kill(-self.id, libc::SIGKILL);
        }
    }
}

#[cfg(unix)]
fn child_exit_state(child: &Child) -> Option<bool> {
    // `Child::try_wait` reaps the leader.  That creates a window where its
    // process-group id could be reused before descendants are terminated.
    // waitid(WNOWAIT) observes the state without reaping, so the group remains
    // tied to this child while it is being killed.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id() as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result != 0 {
        return None;
    }
    // A zero si_pid means the child is still running; a non-zero value means
    // waitid observed an exit state. Either way, the successful WNOWAIT call
    // proves that this PID has not been reaped/recycled.
    Some(unsafe { info.si_pid() != 0 })
}

#[cfg(windows)]
impl WindowsProcessJob {
    fn assign(child: &Child) -> Result<Self, String> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };

        // SAFETY: every Win32 handle created here is checked before use and is
        // closed on every error path or by `Drop`. The information buffer has
        // the exact type and size required by `SetInformationJobObject`.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err("Mivlet could not supervise the provider process tree.".into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                CloseHandle(handle);
                return Err("Mivlet could not supervise the provider process tree.".into());
            }
            if AssignProcessToJobObject(handle, child.as_raw_handle() as HANDLE) == 0 {
                CloseHandle(handle);
                return Err(
                    "Mivlet could not attach the provider to its process supervisor.".into(),
                );
            }
            Ok(Self(handle as usize))
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsProcessJob {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};

        // SAFETY: `self.0` is an owned job handle created by
        // `CreateJobObjectW`, and `Drop` runs exactly once.
        unsafe {
            CloseHandle(self.0 as HANDLE);
        }
    }
}

pub(crate) struct SupervisedChild {
    pub(crate) child: Child,
    #[cfg(windows)]
    job: Option<WindowsProcessJob>,
    #[cfg(unix)]
    group: Option<UnixProcessGroup>,
}

impl SupervisedChild {
    pub(crate) fn spawn(mut command: Command) -> Result<Self, String> {
        #[cfg(unix)]
        use std::os::unix::process::CommandExt;
        #[cfg(unix)]
        command.process_group(0);
        let child = command
            .spawn()
            .map_err(|_| "Mivlet could not start the provider runtime.".to_string())?;
        #[cfg(windows)]
        let mut child = child;
        #[cfg(windows)]
        let job = match WindowsProcessJob::assign(&child) {
            Ok(job) => Some(job),
            Err(message) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(message);
            }
        };
        #[cfg(unix)]
        let group = Some(UnixProcessGroup {
            id: child.id() as i32,
        });
        Ok(Self {
            child,
            #[cfg(windows)]
            job,
            #[cfg(unix)]
            group,
        })
    }

    pub(crate) fn terminate(&mut self) {
        #[cfg(windows)]
        {
            // Closing a KILL_ON_JOB_CLOSE job terminates the launcher and the
            // real ACP child that it creates on Windows.
            self.job.take();
        }
        #[cfg(unix)]
        if child_exit_state(&self.child).is_some() {
            if let Some(group) = self.group.take() {
                group.terminate();
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    pub(crate) fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        #[cfg(unix)]
        match child_exit_state(&self.child) {
            // Kill descendants before reaping an exited leader. The leader's
            // unreaped PID still pins the process-group id, so this is safe.
            Some(true) => {
                if let Some(group) = self.group.take() {
                    group.terminate();
                }
            }
            // Preserve Child::try_wait's non-blocking contract without
            // reaping the leader while its process group is still live.
            Some(false) => return Ok(None),
            // If waitid cannot observe the child, retain std's behavior and
            // avoid a potentially unsafe PGID kill after an unknown reap.
            None => {}
        }
        self.child.try_wait()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{thread, time::Duration};

    #[test]
    fn kills_a_descendant_after_the_group_leader_exits() {
        let directory = tempfile::tempdir().unwrap();
        let survived = directory.path().join("survived.txt");
        let script = format!(
            "(sleep 1; touch '{}') & exit 0",
            survived.to_string_lossy().replace('\'', "'\\''")
        );
        let mut command = Command::new("sh");
        command.args(["-c", &script]);
        let mut child = SupervisedChild::spawn(command).unwrap();
        thread::sleep(Duration::from_millis(100));
        child.terminate();
        thread::sleep(Duration::from_secs(2));
        assert!(!survived.exists(), "a descendant survived group cleanup");
    }
}

impl Drop for SupervisedChild {
    fn drop(&mut self) {
        self.terminate();
    }
}

impl std::ops::Deref for SupervisedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}
impl std::ops::DerefMut for SupervisedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}
impl SupervisedChild {
    pub(crate) fn kill(&mut self) -> std::io::Result<()> {
        self.terminate();
        Ok(())
    }
}
