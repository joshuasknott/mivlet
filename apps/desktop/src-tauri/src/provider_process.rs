//! Native-owned provider process trees. Windows job handles close on account restart, including in-flight login workers.
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
use std::process::{Child, Command};

#[cfg(windows)]
struct WindowsProcessJob(usize);

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
}

impl SupervisedChild {
    pub(crate) fn spawn(mut command: Command) -> Result<Self, String> {
        let mut child = command
            .spawn()
            .map_err(|_| "Mivlet could not start the provider runtime.".to_string())?;
        #[cfg(windows)]
        let job = match WindowsProcessJob::assign(&child) {
            Ok(job) => Some(job),
            Err(message) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(message);
            }
        };
        Ok(Self {
            child,
            #[cfg(windows)]
            job,
        })
    }

    pub(crate) fn terminate(&mut self) {
        #[cfg(windows)]
        {
            // Closing a KILL_ON_JOB_CLOSE job terminates the launcher and the
            // real ACP child that it creates on Windows.
            self.job.take();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
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
