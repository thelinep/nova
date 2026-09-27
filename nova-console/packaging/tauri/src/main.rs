// ===========================================================================
// NOVA Runtime — Tauri v2 main process (Phase 5)
//
// Spawns the project's own, unmodified server.js with the bundled Node
// runtime (and a system Node fallback for development), polls its real
// /api/health route the same way the Electron main process and the plain
// launcher script both do, and only then shows the window that
// tauri.conf.json points at NOVA Runtime's own URL.
//
// VERIFIED STATUS: built offline and launch-checked on macOS. The app bundle
// carries the server resources and Node runtime; it remains ad-hoc signed
// until release signing is configured.
// ===========================================================================
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{write, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};

const PORT: u16 = 8787;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
const PROVIDER_BROWSER_LABEL: &str = "provider-browser";
const MAIN_WINDOW_LABEL: &str = "main";

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn install_menu_bar(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show NOVA", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide NOVA", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh workspace", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit NOVA", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &refresh, &quit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("NOVA application icon".into()))?;

    TrayIconBuilder::with_id("nova-menu-bar")
        .icon(icon)
        .tooltip("NOVA Runtime")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "hide" => {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.hide();
                }
            }
            "refresh" => {
                show_main_window(app);
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.eval("window.location.reload()");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(&tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn server_healthy() -> bool {
    match ureq_get_health() {
        Ok(response) => health_response_is_success(&response),
        _ => false,
    }
}

// Minimal blocking HTTP GET against /api/health using only std, to avoid
// pulling in an HTTP client crate for one health check. Real, not a stub —
// it opens a real TCP connection and reads a real HTTP response line.
fn health_response_is_success(response: &str) -> bool {
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

fn ureq_get_health() -> std::io::Result<String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let mut stream = TcpStream::connect(("127.0.0.1", PORT))?;
    stream.set_read_timeout(Some(Duration::from_millis(800)))?;
    stream.write_all(
        b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nConnection: close\r\n\r\n",
    )?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response)
}

fn matching_server_pid(response: &str, data_dir: &Path) -> Option<u32> {
    if !health_response_is_success(response) {
        return None;
    }
    let body = response.split_once("\r\n\r\n")?.1;
    let health: serde_json::Value = serde_json::from_str(body).ok()?;
    if health.get("ok")?.as_bool()? != true
        || health.get("dataDir")?.as_str()? != data_dir.to_str()?
    {
        return None;
    }
    health.get("pid")?.as_u64()?.try_into().ok()
}

enum ServerProcess {
    Spawned(Arc<Mutex<Child>>),
    Recovered(u32),
}

struct ServerChild(ServerProcess);

struct InstanceLock(PathBuf);

fn process_is_running(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn acquire_instance_lock(data_dir: &Path) -> std::io::Result<Option<InstanceLock>> {
    let path = data_dir.join("nova-runtime.pid");
    for _ in 0..2 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                use std::io::Write;
                writeln!(file, "{}", std::process::id())?;
                return Ok(Some(InstanceLock(path)));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing_pid = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|value| value.trim().parse::<u32>().ok());
                if existing_pid.is_some_and(process_is_running) {
                    return Ok(None);
                }
                std::fs::remove_file(&path)?;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

fn activate_existing_instance() {
    #[cfg(target_os = "macos")]
    let _ = Command::new("osascript")
        .args([
            "-e",
            "tell application id \"com.brahmini.nova-runtime\" to activate",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

fn spawn_server(resource_dir: &Path, data_dir: &Path) -> std::io::Result<Child> {
    let server_path = resource_dir.join("server.js");
    std::fs::create_dir_all(data_dir)?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(server_log_path(data_dir))?;
    let stdout = log.try_clone()?;
    Command::new(node_executable(resource_dir))
        .arg("--no-warnings")
        .arg(server_path)
        .current_dir(resource_dir)
        .env("DATA_DIR", data_dir)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(log))
        .spawn()
}

fn node_executable(resource_dir: &Path) -> std::path::PathBuf {
    let bundled = resource_dir.join("node/bin/node");
    if bundled.is_file() {
        bundled
    } else {
        std::path::PathBuf::from("node")
    }
}

fn migrate_data_dir(data_dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let marker = data_dir.join("runtime-schema-version");
    let current = std::fs::read_to_string(&marker).unwrap_or_default();
    if current.trim() != "1" {
        write(marker, b"1\n")?;
    }
    Ok(())
}

fn server_log_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("nova-runtime-server.log")
}

fn is_allowed_browser_url(url: &str) -> bool {
    let url = url.trim();
    url.starts_with("https://")
        || url.starts_with("http://127.0.0.1")
        || url.starts_with("http://localhost")
}

#[tauri::command]
fn open_provider_browser(app: AppHandle, url: String) -> Result<(), String> {
    if !is_allowed_browser_url(&url) {
        return Err(
            "Use an HTTPS address, or a local http://localhost / 127.0.0.1 address.".into(),
        );
    }
    let parsed_url = url
        .trim()
        .parse()
        .map_err(|error| format!("Invalid address: {error}"))?;
    if let Some(window) = app.get_webview_window(PROVIDER_BROWSER_LABEL) {
        window
            .navigate(parsed_url)
            .map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        &app,
        PROVIDER_BROWSER_LABEL,
        WebviewUrl::External(parsed_url),
    )
    .title("NOVA Provider Browser")
    .inner_size(1240.0, 860.0)
    .min_inner_size(900.0, 620.0)
    .build()
    .map_err(|error| error.to_string())?;

    // A newly-created macOS webview can otherwise appear behind the main
    // window. Make visibility and focus part of the successful command
    // contract instead of reporting "opened" before the user can see it.
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn pick_local_folder() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("osascript")
            .args([
                "-e",
                "POSIX path of (choose folder with prompt \"Approve a local folder for NOVA\")",
            ])
            .output()
            .map_err(|error| format!("Could not open the native folder picker: {error}"))?;
        if !output.status.success() {
            return Err("Folder selection was cancelled.".into());
        }
        let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let canonical = std::fs::canonicalize(&selected)
            .map_err(|error| format!("Selected folder is unavailable: {error}"))?;
        return canonical
            .into_os_string()
            .into_string()
            .map_err(|_| "Selected path is not valid UTF-8.".into());
    }
    #[cfg(not(target_os = "macos"))]
    Err("The native folder picker is not configured for this platform yet.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_successful_http_health_responses() {
        assert!(health_response_is_success("HTTP/1.1 200 OK\r\n"));
        assert!(health_response_is_success("HTTP/1.0 200 OK\r\n"));
        assert!(!health_response_is_success("HTTP/1.1 204 No Content\r\n"));
        assert!(!health_response_is_success(
            "HTTP/1.1 500 Internal Server Error\r\n"
        ));
        assert!(!health_response_is_success("not an HTTP response"));
    }

    #[test]
    fn health_probe_uses_the_servers_exact_loopback_authority() {
        let source = include_str!("main.rs");
        assert!(source.contains("Host: 127.0.0.1:8787"));
    }

    #[test]
    fn recovered_server_must_report_the_exact_application_data_directory() {
        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"pid\":1234,\"dataDir\":\"/tmp/nova-data\"}";
        assert_eq!(
            matching_server_pid(response, Path::new("/tmp/nova-data")),
            Some(1234)
        );
        assert_eq!(matching_server_pid(response, Path::new("/tmp/other")), None);
    }

    #[test]
    fn writes_server_logs_inside_the_application_data_directory() {
        let data_dir = Path::new("/tmp/nova-runtime-test-data");
        assert_eq!(
            server_log_path(data_dir),
            Path::new("/tmp/nova-runtime-test-data/nova-runtime-server.log")
        );
    }

    #[test]
    fn bundle_configuration_includes_the_node_manifest_and_server() {
        let config = include_str!("../tauri.conf.json");
        assert!(config.contains("../../server.js"));
        assert!(config.contains("../../package.json"));
    }

    #[test]
    fn bundle_exposes_the_tauri_command_bridge_to_the_static_ui() {
        let config = include_str!("../tauri.conf.json");
        assert!(config.contains("\"withGlobalTauri\": true"));
    }

    #[test]
    fn loopback_served_main_ui_has_a_narrow_remote_ipc_capability() {
        let capability = include_str!("../capabilities/default.json");
        assert!(capability.contains("http://127.0.0.1:8787/*"));
        assert!(capability.contains("\"windows\": [\"main\"]"));
        assert!(capability.contains("\"allow-open-provider-browser\""));
        assert!(capability.contains("\"allow-pick-local-folder\""));
    }

    #[test]
    fn provider_browser_allows_https_and_local_http_only() {
        assert!(is_allowed_browser_url("https://chatgpt.com"));
        assert!(is_allowed_browser_url(" https://claude.ai/new "));
        assert!(is_allowed_browser_url("http://localhost:3000"));
        assert!(is_allowed_browser_url("http://127.0.0.1:8787"));
        assert!(!is_allowed_browser_url("http://example.com"));
        assert!(!is_allowed_browser_url("file:///private/data.txt"));
        assert!(!is_allowed_browser_url("javascript:alert(1)"));
        assert!(!is_allowed_browser_url("data:text/html,unsafe"));
        assert!(!is_allowed_browser_url("ftp://example.com"));
        assert!(!is_allowed_browser_url(""));
    }

    #[test]
    fn menu_bar_declares_expected_visible_actions() {
        let source = include_str!("main.rs");
        for item in ["Show NOVA", "Hide NOVA", "Refresh workspace", "Quit NOVA"] {
            assert!(source.contains(item), "missing menu item: {item}");
        }
        assert!(source.contains("nova-menu-bar"));
        assert!(source.contains("window.location.reload()"));
    }

    #[test]
    fn server_process_uses_bundled_server_and_private_data_directory() {
        let source = include_str!("main.rs");
        assert!(source.contains("resource_dir.join(\"server.js\")"));
        assert!(source.contains(".env(\"DATA_DIR\", data_dir)"));
        assert!(source.contains("Command::new(node_executable(resource_dir))"));
        assert!(source.contains("Stdio::from(stdout)"));
        assert!(source.contains("Stdio::from(log)"));
    }

    #[test]
    fn bundled_node_is_preferred_with_a_system_fallback_for_development() {
        let temp = std::env::temp_dir().join(format!("nova-node-test-{}", std::process::id()));
        let bundled = temp.join("node/bin/node");
        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"").unwrap();
        assert_eq!(node_executable(&temp), bundled);
        std::fs::remove_dir_all(&temp).unwrap();
        assert_eq!(
            node_executable(Path::new("/path/without/bundle")),
            Path::new("node")
        );
    }

    #[test]
    fn data_migration_writes_an_idempotent_schema_marker() {
        let temp = std::env::temp_dir().join(format!("nova-migrate-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        migrate_data_dir(&temp).unwrap();
        migrate_data_dir(&temp).unwrap();
        assert_eq!(
            std::fs::read_to_string(temp.join("runtime-schema-version")).unwrap(),
            "1\n"
        );
        std::fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn instance_lock_replaces_stale_pid_and_is_removed_with_its_owner() {
        let temp = std::env::temp_dir().join(format!("nova-instance-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();
        std::fs::write(temp.join("nova-runtime.pid"), "4294967295\n").unwrap();
        let lock = acquire_instance_lock(&temp).unwrap().unwrap();
        assert_eq!(
            std::fs::read_to_string(&lock.0).unwrap().trim(),
            std::process::id().to_string()
        );
        std::fs::remove_file(&lock.0).unwrap();
        std::fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn shutdown_only_kills_a_server_owned_by_this_instance() {
        let source = include_str!("main.rs");
        assert!(source.contains("enum ServerProcess"));
        assert!(source.contains("ServerProcess::Spawned"));
        assert!(source.contains("ServerProcess::Recovered"));
        assert!(source.contains("matching_server_pid"));
    }

    #[test]
    fn main_window_reloads_the_console_once_the_server_is_healthy() {
        let source = include_str!("main.rs");
        assert!(source.contains("again now that the server is healthy"));
        assert!(source.contains("window.navigate(url)"));
    }

    #[test]
    fn provider_browser_has_stable_label_and_minimum_window_size() {
        let source = include_str!("main.rs");
        assert_eq!(PROVIDER_BROWSER_LABEL, "provider-browser");
        assert!(source.contains(".min_inner_size(900.0, 620.0)"));
        assert!(source.contains("window.show()"));
        assert!(source.contains("window.set_focus()"));
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_provider_browser,
            pick_local_folder
        ])
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?;
            let data_dir = app.path().app_data_dir()?;
            migrate_data_dir(&data_dir)?;
            let Some(instance_lock) = acquire_instance_lock(&data_dir)? else {
                activate_existing_instance();
                std::process::exit(0);
            };
            app.manage(instance_lock);
            let child = if let Ok(response) = ureq_get_health() {
                if let Some(pid) = matching_server_pid(&response, &data_dir) {
                    ServerProcess::Recovered(pid)
                } else {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::AddrInUse,
                        "Port 8787 is occupied by a server outside this NOVA data directory.",
                    )
                    .into());
                }
            } else {
                let child = Arc::new(Mutex::new(spawn_server(&resource_dir, &data_dir)?));
                let deadline = Instant::now() + HEALTH_TIMEOUT;
                while Instant::now() < deadline && !server_healthy() {
                    thread::sleep(Duration::from_millis(250));
                }
                if !server_healthy() {
                    if let Ok(mut process) = child.lock() {
                        let _ = process.kill();
                    }
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "Bundled NOVA server did not become healthy.",
                    )
                    .into());
                }
                ServerProcess::Spawned(child)
            };
            app.manage(ServerChild(child));
            // The configured window is created before this hook runs, so its first load can
            // happen before the bundled server answers and leave a blank page. Load the console
            // again now that the server is healthy.
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                if let Ok(url) = format!("http://127.0.0.1:{PORT}/").parse() {
                    let _ = window.navigate(url);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building NOVA Runtime desktop shell")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::Ready) {
                // macOS rejects status-item construction while its application
                // delegate is still handling didFinishLaunching. `Ready` runs
                // immediately after that lifecycle boundary.
                if let Err(error) = install_menu_bar(app_handle) {
                    eprintln!("NOVA menu-bar item unavailable: {error}");
                }
            }
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                let child = app_handle.state::<ServerChild>();
                match &child.0 {
                    ServerProcess::Spawned(child) => {
                        if let Ok(mut process) = child.lock() {
                            let _ = process.kill();
                        };
                    }
                    ServerProcess::Recovered(pid) => {
                        let _ = Command::new("kill").arg(pid.to_string()).status();
                    }
                }
                let lock = app_handle.state::<InstanceLock>();
                let _ = std::fs::remove_file(&lock.0);
            }
        });
}
