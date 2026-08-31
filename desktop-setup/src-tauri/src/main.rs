#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};

use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;

struct SidecarState(Arc<Mutex<Option<CommandChild>>>);

fn main() {
    let sidecar_state = Arc::new(Mutex::new(None));
    let setup_sidecar_state = Arc::clone(&sidecar_state);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(sidecar_state))
        .setup(move |app| {
            #[cfg(not(debug_assertions))]
            {
                // The sample DMG carries this marker so testers can run the
                // packaged app without touching their normal Avatar or agent
                // configuration. Production bundles do not contain it.
                if let (Ok(resource_dir), Ok(home_dir)) = (app.path().resource_dir(), app.path().home_dir()) {
                    if resource_dir.join("NAAVOS_SAMPLE_MODE").is_file() {
                        let sample_home = std::env::var_os("NAAVOS_SAMPLE_HOME")
                            .map(std::path::PathBuf::from)
                            .unwrap_or_else(|| home_dir.join("NAAvOS-Sample-Test"));
                        std::env::set_var("RADOS_HOME", sample_home);
                        std::env::set_var("NAAVOS_SAMPLE_MODE", "1");
                    }
                }
            }
            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_shell::process::CommandEvent;
                use tauri_plugin_shell::ShellExt;

                let sidecar = app
                    .shell()
                    .sidecar("radoss-setup")
                    .map_err(|error| std::io::Error::other(format!("could not prepare setup sidecar: {error}")))?
                    // Let the operating system choose the loopback port. This
                    // prevents a normal install and an isolated tester build
                    // from colliding when they run at the same time.
                    .args(["--port", "0"]);
                let (mut events, child) = sidecar
                    .spawn()
                    .map_err(|error| std::io::Error::other(format!("could not start setup sidecar: {error}")))?;
                *setup_sidecar_state
                    .lock()
                    .map_err(|_| std::io::Error::other("sidecar state lock poisoned"))? = Some(child);
                let process_state = Arc::clone(&setup_sidecar_state);
                let window_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut stdout_buffer = String::new();
                    while let Some(event) = events.recv().await {
                        match event {
                            CommandEvent::Stdout(bytes) => {
                                stdout_buffer.push_str(&String::from_utf8_lossy(&bytes));
                                while let Some(newline) = stdout_buffer.find('\n') {
                                    let line = stdout_buffer[..newline].trim().to_owned();
                                    stdout_buffer.drain(..=newline);
                                    if let Some(url) = line
                                        .strip_prefix("radoss-setup-service ")
                                        .and_then(|value| value.trim().parse::<tauri::Url>().ok())
                                    {
                                        if let Some(window) = window_handle.get_webview_window("main") {
                                            if let Err(error) = window.navigate(url) {
                                                eprintln!("radoss setup sidecar navigation failed: {error}");
                                            }
                                        }
                                    }
                                }
                            }
                            CommandEvent::Stderr(bytes) => {
                                eprintln!("radoss setup sidecar: {}", String::from_utf8_lossy(&bytes));
                            }
                            _ => {}
                        }
                    }
                    if let Ok(mut state) = process_state.lock() {
                        state.take();
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building NAAvOS Avatar OS desktop shell");

    app.run(move |app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SidecarState>() {
                    if let Ok(mut child_slot) = state.0.lock() {
                        if let Some(child) = child_slot.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
