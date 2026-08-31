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
                        std::env::set_var("RADOS_HOME", home_dir.join("NAAvOS-Sample-Test"));
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
                    .args(["--port", "49312"]);
                let (mut events, child) = sidecar
                    .spawn()
                    .map_err(|error| std::io::Error::other(format!("could not start setup sidecar: {error}")))?;
                *setup_sidecar_state
                    .lock()
                    .map_err(|_| std::io::Error::other("sidecar state lock poisoned"))? = Some(child);
                let process_state = Arc::clone(&setup_sidecar_state);
                tauri::async_runtime::spawn(async move {
                    while let Some(event) = events.recv().await {
                        if let CommandEvent::Stderr(bytes) = event {
                            eprintln!("radoss setup sidecar: {}", String::from_utf8_lossy(&bytes));
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
