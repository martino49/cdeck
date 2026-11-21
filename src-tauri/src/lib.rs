mod adb;
mod tools;

use tauri::Manager;

#[derive(serde::Serialize)]
struct AppInfo {
  version: String,
  adb: adb::AdbLocation,
  platform: String,
}

#[tauri::command]
fn app_info() -> AppInfo {
  AppInfo {
    version: env!("CARGO_PKG_VERSION").to_string(),
    adb: adb::locate_adb(),
    platform: "win32".to_string(),
  }
}

#[tauri::command]
async fn adb_locate() -> adb::AdbLocation {
  adb::locate_adb()
}

#[tauri::command]
async fn adb_version() -> Option<String> {
  tauri::async_runtime::spawn_blocking(adb::adb_version)
    .await
    .unwrap_or(None)
}

#[tauri::command]
async fn adb_devices() -> Vec<adb::DeviceInfo> {
  tauri::async_runtime::spawn_blocking(adb::list_devices)
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn adb_mdns() -> Vec<adb::MdnsService> {
  tauri::async_runtime::spawn_blocking(adb::mdns_services)
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn adb_pair(target: String, code: String) -> adb::CommandResult {
  tauri::async_runtime::spawn_blocking(move || adb::adb_pair(target, code))
    .await
    .unwrap_or_else(|_| adb::CommandResult {
      ok: false,
      stdout: String::new(),
      stderr: "task failed".into(),
      code: None,
    })
}

#[tauri::command]
async fn adb_connect(target: String) -> adb::CommandResult {
  tauri::async_runtime::spawn_blocking(move || adb::adb_connect(target))
    .await
    .unwrap_or_else(|_| adb::CommandResult {
      ok: false,
      stdout: String::new(),
      stderr: "task failed".into(),
      code: None,
    })
}

#[tauri::command]
async fn adb_disconnect(serial: String) -> adb::CommandResult {
  tauri::async_runtime::spawn_blocking(move || adb::adb_disconnect(serial))
    .await
    .unwrap_or_else(|_| adb::CommandResult {
      ok: false,
      stdout: String::new(),
      stderr: "task failed".into(),
      code: None,
    })
}

#[tauri::command]
async fn adb_shell(serial: String, command: String) -> adb::CommandResult {
  tauri::async_runtime::spawn_blocking(move || adb::adb_shell(serial, command))
    .await
    .unwrap_or_else(|_| adb::CommandResult {
      ok: false,
      stdout: String::new(),
      stderr: "task failed".into(),
      code: None,
    })
}

#[tauri::command]
async fn adb_reverse_list(serial: String) -> Vec<String> {
  tauri::async_runtime::spawn_blocking(move || adb::reverse_list(serial))
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn adb_ensure_reverse(serial: String, ports: Vec<u16>) -> Vec<adb::ReverseResult> {
  tauri::async_runtime::spawn_blocking(move || adb::ensure_reverse(serial, ports))
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn adb_discover_wireless() -> Vec<adb::WirelessTarget> {
  tauri::async_runtime::spawn_blocking(adb::discover_wireless)
    .await
    .unwrap_or_default()
}

#[tauri::command]
fn open_devtools(app: tauri::AppHandle) -> Result<(), String> {
  let window = app.get_webview_window("main").ok_or("main window not found")?;
  window.open_devtools();
  Ok(())
}

#[tauri::command]
fn close_devtools(app: tauri::AppHandle) -> Result<(), String> {
  let window = app.get_webview_window("main").ok_or("main window not found")?;
  window.close_devtools();
  Ok(())
}

#[tauri::command]
fn is_devtools_open(app: tauri::AppHandle) -> Result<bool, String> {
  let window = app.get_webview_window("main").ok_or("main window not found")?;
  Ok(window.is_devtools_open())
}

#[tauri::command]
fn toggle_devtools(app: tauri::AppHandle) -> Result<bool, String> {
  let window = app.get_webview_window("main").ok_or("main window not found")?;
  if window.is_devtools_open() {
    window.close_devtools();
    Ok(false)
  } else {
    window.open_devtools();
    Ok(true)
  }
}

#[tauri::command]
async fn scrcpy_locate() -> tools::ToolLocation {
  tauri::async_runtime::spawn_blocking(|| tools::locate_bundled_exe("scrcpy", "scrcpy.exe"))
    .await
    .unwrap_or_else(|_| tools::ToolLocation {
      found: false,
      path: None,
      source: "error".into(),
    })
}

#[tauri::command]
async fn scrcpy_version(path: Option<String>) -> Option<String> {
  tauri::async_runtime::spawn_blocking(move || {
    let p = path?;
    tools::path_version(&p, &["--version"])
  })
  .await
  .unwrap_or(None)
}

#[tauri::command]
async fn run_selftest() -> tools::SelfTestReport {
  tauri::async_runtime::spawn_blocking(|| {
    let checks = tools::run_checks();
    let failed = checks.iter().filter(|c| !c.passed).count();
    tools::SelfTestReport {
      code: if failed == 0 { 0 } else { 1 },
      passed: failed == 0,
      path: String::new(),
      summary: format!("{}/{} checks passed", checks.len() - failed, checks.len()),
      checks,
    }
  })
  .await
  .unwrap_or_else(|_| tools::SelfTestReport {
    code: 1,
    passed: false,
    path: String::new(),
    summary: "self-test failed to run".into(),
    checks: vec![],
  })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      app_info,
      adb_locate,
      adb_version,
      adb_devices,
      adb_mdns,
      adb_pair,
      adb_connect,
      adb_disconnect,
      adb_shell,
      adb_reverse_list,
      adb_ensure_reverse,
      adb_discover_wireless,
      open_devtools,
      close_devtools,
      is_devtools_open,
      toggle_devtools,
      scrcpy_locate,
      scrcpy_version,
      run_selftest
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}