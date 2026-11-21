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
pub struct DeviceInfo {
    pub serial: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport_id: Option<String>,
    pub transport: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MdnsService {
    pub instance: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub raw: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AdbLocation {
    pub found: bool,
    pub path: Option<String>,
    pub source: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WirelessTarget {
    pub host: String,
    pub port: u16,
    pub instance: String,
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

fn which_adb() -> Option<PathBuf> {
    let probe = if cfg!(windows) { "where.exe" } else { "which" };
    let mut cmd = Command::new(probe);
    cmd.arg("adb");
    hide_window(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
}

pub fn locate_adb() -> AdbLocation {
    let root = bin_root();
    if let Some(p) = first_existing(&[root.join("scrcpy").join("adb.exe")]) {
        return AdbLocation { found: true, path: Some(p.to_string_lossy().to_string()), source: "bundled".into() };
    }
    if let Some(p) = find_one_level_deep(&root.join("platform-tools"), "adb.exe") {
        return AdbLocation { found: true, path: Some(p.to_string_lossy().to_string()), source: "bundled".into() };
    }
    match which_adb() {
        Some(p) => AdbLocation { found: true, path: Some(p.to_string_lossy().to_string()), source: "path".into() },
        None => AdbLocation { found: false, path: None, source: "path".into() },
    }
}

pub fn resolve_adb_path() -> Option<PathBuf> {
    locate_adb().path.map(PathBuf::from)
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

pub fn run_adb(args: Vec<String>, timeout_ms: Option<u64>) -> CommandResult {
    match resolve_adb_path() {
        Some(adb) => run_cmd(&adb, &args, timeout_ms),
        None => CommandResult::fail("adb not found"),
    }
}

pub fn adb_version() -> Option<String> {
    let res = run_adb(vec!["version".into()], None);
    let first = res.stdout.lines().next().unwrap_or("").trim();
    if first.is_empty() {
        return None;
    }
    if let Some(idx) = first.find("Version ") {
        return Some(first[idx + 8..].trim().to_string());
    }
    Some(first.to_string())
}

fn capture_key(line: &str, key: &str) -> Option<String> {
    let idx = line.find(key)? + key.len();
    let rest = &line[idx..];
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let value = rest[..end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

pub fn list_devices() -> Vec<DeviceInfo> {
    let res = run_adb(vec!["devices".into(), "-l".into()], None);
    if !res.ok {
        return Vec::new();
    }
    let mut devices = Vec::new();
    for line in res.stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("List of devices") {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        let serial = parts[0].to_string();
        let state = parts[1].to_string();
        let transport = if serial.contains(':') || serial.starts_with("adb-") {
            "tcpip"
        } else {
            "usb"
        };
        devices.push(DeviceInfo {
            serial,
            state,
            model: capture_key(trimmed, "model:"),
            product: capture_key(trimmed, "product:"),
            device: capture_key(trimmed, "device:"),
            transport_id: capture_key(trimmed, "transport_id:"),
            transport: transport.to_string(),
        });
    }
    devices
}

fn is_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4 && parts.iter().all(|p| p.parse::<u8>().is_ok())
}

fn parse_mdns_line(line: &str) -> Option<MdnsService> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.len() < 3 {
        return None;
    }
    let host_port = parts[parts.len() - 1];
    let mut split = host_port.splitn(2, ':');
    let host = split.next().unwrap_or("");
    let port_raw = split.next().unwrap_or("");
    if !is_ipv4(host) {
        return None;
    }
    let port: u16 = port_raw.parse().ok()?;
    Some(MdnsService {
        instance: parts[0].to_string(),
        kind: parts[1].to_string(),
        host: host.to_string(),
        port,
        raw: trimmed.to_string(),
    })
}

pub fn mdns_services() -> Vec<MdnsService> {
    let res = run_adb(vec!["mdns".into(), "services".into()], None);
    if !res.ok {
        return Vec::new();
    }
    res.stdout
        .lines()
        .filter_map(parse_mdns_line)
        .collect()
}

fn serial_args(serial: &str) -> Vec<String> {
    if serial.trim().is_empty() {
        Vec::new()
    } else {
        vec!["-s".into(), serial.to_string()]
    }
}

pub fn adb_pair(target: String, code: String) -> CommandResult {
    run_adb(vec!["pair".into(), target, code.trim().to_string()], None)
}

pub fn adb_connect(target: String) -> CommandResult {
    run_adb(vec!["connect".into(), target], None)
}

pub fn adb_disconnect(serial: String) -> CommandResult {
    let mut args = vec!["disconnect".into()];
    if !serial.trim().is_empty() {
        args.push(serial);
    }
    run_adb(args, None)
}

pub fn adb_shell(serial: String, command: String) -> CommandResult {
    let mut args = serial_args(&serial);
    args.push("shell".into());
    args.push(command);
    run_adb(args, None)
}

pub fn reverse_list(serial: String) -> Vec<String> {
    let mut args = serial_args(&serial);
    args.push("reverse".into());
    args.push("--list".into());
    let res = run_adb(args, None);
    if !res.ok {
        return Vec::new();
    }
    res.stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(String::from)
        .collect()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReverseResult {
    pub serial: String,
    pub port: u16,
    pub ok: bool,
    pub detail: String,
}

pub fn ensure_reverse(serial: String, ports: Vec<u16>) -> Vec<ReverseResult> {
    let mut results = Vec::new();
    for port in ports {
        let mut args = serial_args(&serial);
        args.push("reverse".into());
        args.push(format!("tcp:{port}"));
        args.push(format!("tcp:{port}"));
        let res = run_adb(args, None);
        results.push(ReverseResult {
            serial: serial.clone(),
            port,
            ok: res.ok,
            detail: format!("{}{}", res.stdout.trim(), res.stderr.trim()).trim().to_string(),
        });
    }
    results
}

pub fn discover_wireless() -> Vec<WirelessTarget> {
    mdns_services()
        .into_iter()
        .filter(|s| s.kind.contains("adb-tls-connect"))
        .map(|s| WirelessTarget {
            instance: s.instance,
            host: s.host,
            port: s.port,
        })
        .collect()
}