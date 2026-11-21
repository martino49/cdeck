use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
  pub ok: bool,
  pub stdout: String,
  pub stderr: String,
  pub code: Option<i32>,
}

impl CommandResult {
  fn fail(msg: impl Into<String>) -> Self {
    CommandResult { ok: false, stdout: String::new(), stderr: msg.into(), code: None }
  }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolLocation {
  pub found: bool,
  pub path: Option<String>,
  pub source: String,
}

pub fn bin_root() -> PathBuf {
  let base = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."));
  base.join("CDeck").join("bin")
}

#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
  use std::os::windows::process::CommandExt;
  cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_cmd: &mut Command) {}

fn first_existing(paths: &[PathBuf]) -> Option<PathBuf> {
  paths.iter().find(|p| p.exists()).cloned()
}

fn find_one_level_deep(dir: &Path, name: &str) -> Option<PathBuf> {
  let direct = dir.join(name);
  if direct.exists() {
    return Some(direct);
  }
  let entries = std::fs::read_dir(dir).ok()?;
  for entry in entries.flatten() {
    let candidate = entry.path().join(name);
    if candidate.exists() {
      return Some(candidate);
    }
  }
  None
}

fn which_cmd(name: &str) -> Option<PathBuf> {
  let probe = if cfg!(windows) { "where.exe" } else { "which" };
  let mut cmd = Command::new(probe);
  cmd.arg(name);
  hide_window(&mut cmd);
  let out = cmd.output().ok()?;
  if !out.status.success() {
    return None;
  }
  let text = String::from_utf8_lossy(&out.stdout);
  text.lines().map(str::trim).find(|l| !l.is_empty()).map(PathBuf::from)
}

fn drain<R: Read>(pipe: Option<R>) -> Vec<u8> {
  let mut buf = Vec::new();
  if let Some(mut reader) = pipe {
    let _ = reader.read_to_end(&mut buf);
  }
  buf
}

fn run_cmd(cmd: &Path, args: &[String], timeout_ms: Option<u64>) -> CommandResult {
  let mut child_cmd = Command::new(cmd);
  child_cmd.args(args);
  child_cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
  hide_window(&mut child_cmd);

  let mut child = match child_cmd.spawn() {
    Ok(c) => c,
    Err(e) => return CommandResult::fail(e.to_string()),
  };

  let stdout_pipe: Option<ChildStdout> = child.stdout.take();
  let stderr_pipe: Option<ChildStderr> = child.stderr.take();
  let out_reader = std::thread::spawn(move || drain(stdout_pipe));
  let err_reader = std::thread::spawn(move || drain(stderr_pipe));

  let timeout = timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
  let started = Instant::now();
  let mut timed_out = false;
  let status = loop {
    match child.try_wait() {
      Ok(Some(s)) => break Some(s),
      Ok(None) => {
        if started.elapsed().as_millis() as u64 >= timeout {
          timed_out = true;
          let _ = child.kill();
          let _ = child.wait();
          break None;
        }
        std::thread::sleep(Duration::from_millis(25));
      }
      Err(_) => break None,
    }
  };

  let stdout = String::from_utf8_lossy(&out_reader.join().unwrap_or_default()).to_string();
  let stderr = String::from_utf8_lossy(&err_reader.join().unwrap_or_default()).to_string();

  if timed_out {
    return CommandResult::fail(format!("timed out after {timeout}ms: {stderr}"));
  }
  match status {
    Some(s) => CommandResult { ok: s.success(), stdout, stderr, code: s.code() },
    None => CommandResult::fail(format!("failed to execute {}", cmd.display())),
  }
}

pub fn locate_bundled(name: &str) -> ToolLocation {
  let root = bin_root();
  if let Some(p) = first_existing(&[root.join(name)]) {
    return ToolLocation { found: true, path: Some(p.to_string_lossy().to_string()), source: "bundled".into() };
  }
  if let Some(p) = find_one_level_deep(&root.join(name), name) {
    return ToolLocation { found: true, path: Some(p.to_string_lossy().to_string()), source: "bundled".into() };
  }
  match which_cmd(name) {
    Some(p) => ToolLocation { found: true, path: Some(p.to_string_lossy().to_string()), source: "path".into() },
    None => ToolLocation { found: false, path: None, source: "path".into() },
  }
}

pub fn locate_bundled_exe(name: &str, exe: &str) -> ToolLocation {
  let root = bin_root();
  if let Some(p) = find_one_level_deep(&root.join(name), exe) {
    return ToolLocation { found: true, path: Some(p.to_string_lossy().to_string()), source: "bundled".into() };
  }
  if let Some(p) = first_existing(&[root.join(exe)]) {
    return ToolLocation { found: true, path: Some(p.to_string_lossy().to_string()), source: "bundled".into() };
  }
  match which_cmd(exe.trim_end_matches(".exe")) {
    Some(p) => ToolLocation { found: true, path: Some(p.to_string_lossy().to_string()), source: "path".into() },
    None => ToolLocation { found: false, path: None, source: "path".into() },
  }
}

pub fn path_version(path: &str, args: &[&str]) -> Option<String> {
  let p = PathBuf::from(path);
  if !p.exists() {
    return None;
  }
  let owned: Vec<String> = args.iter().map(|a| a.to_string()).collect();
  let res = run_cmd(&p, &owned, None);
  let first = res.stdout.lines().next().unwrap_or("").trim();
  if first.is_empty() {
    None
  } else {
    Some(first.to_string())
  }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
  pub name: String,
  pub passed: bool,
  pub detail: String,
}

pub fn run_checks() -> Vec<CheckResult> {
  let mut out = Vec::new();

  let adb = locate_bundled("adb");
  out.push(CheckResult {
    name: "adb".to_string(),
    passed: adb.found,
    detail: if adb.found {
      format!("found via {} at {}", adb.source, adb.path.clone().unwrap_or_default())
    } else {
      "adb not found on PATH or in the bundled tools folder".to_string()
    },
  });

  let scrcpy = locate_bundled_exe("scrcpy", "scrcpy.exe");
  out.push(CheckResult {
    name: "scrcpy".to_string(),
    passed: scrcpy.found,
    detail: if scrcpy.found {
      format!("found via {} at {}", scrcpy.source, scrcpy.path.clone().unwrap_or_default())
    } else {
      "scrcpy not found on PATH or in the bundled tools folder".to_string()
    },
  });

  out.push(CheckResult {
    name: "tauri-bridge".to_string(),
    passed: true,
    detail: "Rust commands are reachable from the webview".to_string(),
  });

  out
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SelfTestReport {
  pub code: i32,
  pub passed: bool,
  pub path: String,
  pub summary: String,
  pub checks: Vec<CheckResult>,
}
