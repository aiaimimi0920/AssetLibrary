//! One supervised child per workspace; cancellation never releases admission before reaping.
use crate::{
    inspection_executor::InspectionWorkspace,
    local_inspection::{InspectionRequest, InspectionResult, inspect_local},
};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const REQUEST_LIMIT: u64 = 64 * 1024;
const RESULT_LIMIT: u64 = 2 * 1024 * 1024;
const REQUEST_FILE: &str = "inspection-request.json";
const RESULT_FILE: &str = "inspection-result.json";

pub fn run_child_entry() -> io::Result<()> {
    let request: InspectionRequest = read_json(Path::new(REQUEST_FILE), REQUEST_LIMIT)?;
    let result = inspect_local(Path::new("artifact.zip"), &request);
    write_json(Path::new(RESULT_FILE), &result, RESULT_LIMIT)
}

pub async fn inspect(
    workspace: InspectionWorkspace,
    request: InspectionRequest,
) -> io::Result<(InspectionWorkspace, InspectionResult)> {
    let mut command = isolated_command(&std::env::current_exe()?);
    command.arg("--inspect-local");
    inspect_with_command(workspace, request, command).await
}

fn isolated_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    // No account, database, storage, proxy or telemetry credentials enter the child.
    command
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        if let Some(system_root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", system_root);
        }
    }
    command
}

struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

async fn inspect_with_command(
    workspace: InspectionWorkspace,
    request: InspectionRequest,
    mut command: Command,
) -> io::Result<(InspectionWorkspace, InspectionResult)> {
    let cancellation = CancelOnDrop(Arc::new(AtomicBool::new(false)));
    let cancelled = cancellation.0.clone();
    let (workspace, result) = workspace
        .inspect(move |archive| {
            let directory = archive.parent().expect("workspace archive has a parent");
            write_json(&directory.join(REQUEST_FILE), &request, REQUEST_LIMIT)?;
            command.current_dir(directory);
            supervise(command, &cancelled)?;
            read_json(&directory.join(RESULT_FILE), RESULT_LIMIT)
        })
        .await
        .map_err(|_| io::Error::other("inspection supervisor failed"))?;
    Ok((workspace, result?))
}

struct ReapOnDrop(Option<Child>);

impl Drop for ReapOnDrop {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            if child.wait().is_err() {
                // Never admit another job after losing ownership of a live child.
                eprintln!("scanner cannot reap inspection child; terminating worker");
                std::process::abort();
            }
        }
    }
}

fn supervise(mut command: Command, cancelled: &AtomicBool) -> io::Result<()> {
    if cancelled.load(Ordering::Acquire) {
        return Err(io::ErrorKind::Interrupted.into());
    }
    let mut owner = ReapOnDrop(Some(command.spawn()?));
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(io::ErrorKind::Interrupted.into());
        }
        if let Some(status) = owner.0.as_mut().expect("owned child").try_wait()? {
            // try_wait has reaped the child; only now may its workspace be released.
            owner.0 = None;
            return if status.success() {
                Ok(())
            } else {
                Err(io::Error::other("inspection child exited unsuccessfully"))
            };
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn read_json<T: DeserializeOwned>(path: &Path, limit: u64) -> io::Result<T> {
    let mut bytes = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::other(
            "inspection protocol document exceeds limit",
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| io::Error::other("invalid inspection protocol document"))
}

fn write_json<T: Serialize>(path: &Path, value: &T, limit: u64) -> io::Result<()> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| io::Error::other("invalid inspection document"))?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::other(
            "inspection protocol document exceeds limit",
        ));
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?
        .write_all(&bytes)
}

#[cfg(test)]
#[path = "inspection_process_tests.rs"]
mod tests;
