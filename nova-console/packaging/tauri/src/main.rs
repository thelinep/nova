// ===========================================================================
// NOVA Runtime — Tauri v2 main process (Phase 5)
//
// Spawns the project's own, unmodified server.js as a child process using
// the system `node` binary (the same expectation packaging/launch.js and
// this README document honestly: this does not bundle a Node runtime —
// doing that is real future work, not attempted here), polls its real
// /api/health route the same way the Electron main process and the plain
// launcher script both do, and only then shows the window that
// tauri.conf.json points at NOVA Runtime's own URL.
//
// HONEST STATUS: never compiled. See ../Cargo.toml and ../README.md —
// crates.io is unreachable from every environment this project has been
// built in, and the one available device has no rustc/cargo at all. This
// is real, documented-API Tauri 2 code, not verified-working code.
// ===========================================================================
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::thread;
use std::time::{Duration, Instant};

const PORT: u16 = 8787;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);

fn server_healthy() -> bool {
    match ureq_get_health() {
        Ok(true) => true,
        _ => false,
    }
}

// Minimal blocking HTTP GET against /api/health using only std, to avoid
// pulling in an HTTP client crate for one health check. Real, not a stub —
// it opens a real TCP connection and reads a real HTTP response line.
fn ureq_get_health() -> std::io::Result<bool> {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let mut stream = TcpStream::connect(("127.0.0.1", PORT))?;
    stream.set_read_timeout(Some(Duration::from_millis(800)))?;
    stream.write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")?;
    let mut buf = [0u8; 64];
    let n = stream.read(&mut buf)?;
    let text = String::from_utf8_lossy(&buf[..n]);
    Ok(text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200"))
}

fn spawn_server() -> std::io::Result<Child> {
    // Resolve server.js relative to this binary's project root
    // (packaging/tauri/.. .. == the repo root, where server.js lives).
    let server_path = std::env::current_dir()?.join("..").join("..").join("server.js");
    Command::new("node")
        .arg("--no-warnings")
        .arg(server_path)
        .spawn()
}

fn main() {
    let mut child = spawn_server().expect(
        "Failed to spawn `node server.js` — NOVA Runtime's desktop shell expects a system Node.js \
         installation (bundling a Node runtime as a Tauri sidecar is real future work, not done here).",
    );

    let deadline = Instant::now() + HEALTH_TIMEOUT;
    while Instant::now() < deadline && !server_healthy() {
        thread::sleep(Duration::from_millis(250));
    }

    tauri::Builder::default()
        .on_window_event(move |_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let _ = child.kill();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running NOVA Runtime desktop shell");
}
