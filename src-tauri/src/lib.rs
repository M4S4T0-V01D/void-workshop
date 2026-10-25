mod policy;
mod restart;
mod sidecar;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sidecar::Sidecar;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

#[derive(Default)]
struct AppState {
    sidecar: Mutex<Option<Arc<Sidecar>>>,
    start_error: Mutex<Option<String>>,
    /// Closing the window hides it instead of quitting, so paired phones can keep working.
    background: AtomicBool,
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// The window tells the shell whether "keep running in the background" is on.
#[tauri::command]
fn set_background_mode(state: tauri::State<'_, AppState>, on: bool) {
    state.background.store(on, Ordering::Relaxed);
}

fn start_sidecar(app: &tauri::AppHandle) -> Result<Arc<Sidecar>, String> {
    let launch = sidecar::locate()?;
    let events = app.clone();
    let exits = app.clone();
    Sidecar::spawn(
        &launch,
        move |event, payload| {
            if event == "app.restart" {
                admin_restart(&events, &payload);
                return;
            }
            let _ = events.emit("sidecar-event", json!({ "event": event, "payload": payload }));
        },
        move |code| {
            let _ = exits.emit("sidecar-exit", json!({ "code": code }));
        },
    )
}

/// An admin dev session asked to install the new build and restart: hand over to the helper and quit.
fn admin_restart(app: &tauri::AppHandle, payload: &Value) {
    let hidden = app.get_webview_window("main").map(|w| !w.is_visible().unwrap_or(true)).unwrap_or(false);
    match restart::parse(payload).and_then(|req| restart::spawn_helper(&req, hidden)) {
        Ok(()) => app.exit(0),
        Err(e) => {
            eprintln!("void-workshop: restart failed: {e}");
            let _ = app.emit(
                "sidecar-event",
                json!({ "event": "admin.restartFailed", "payload": { "message": format!("VOID Workshop could not restart itself: {e}") } }),
            );
        }
    }
}

/// Forward an allow-listed call to the sidecar. Parameters are never logged.
#[tauri::command]
async fn sidecar_call(state: tauri::State<'_, AppState>, method: String, params: Value) -> Result<Value, Value> {
    let sc = state.sidecar.lock().ok().and_then(|s| s.clone());
    match sc {
        Some(sc) => sc.call(&method, params).await,
        None => {
            let why = state.start_error.lock().ok().and_then(|e| e.clone()).unwrap_or_else(|| "The agent backend is not running.".into());
            Err(json!({ "code": "sidecar-unavailable", "message": why }))
        }
    }
}

/// Restart the sidecar after a crash.
#[tauri::command]
fn sidecar_restart(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Some(old) = state.sidecar.lock().map_err(|e| e.to_string())?.take() {
        old.shutdown();
    }
    match start_sidecar(&app) {
        Ok(sc) => {
            *state.sidecar.lock().map_err(|e| e.to_string())? = Some(sc);
            *state.start_error.lock().map_err(|e| e.to_string())? = None;
            Ok(())
        }
        Err(e) => {
            *state.start_error.lock().map_err(|e| e.to_string())? = Some(e.clone());
            Err(e)
        }
    }
}

/// Native folder picker. The chosen path is validated again by the sidecar.
#[tauri::command]
async fn pick_project_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title("Select a project folder").pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let picked = rx.await.map_err(|e| e.to_string())?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}

/// Open Claude's sign-in page in the default browser. The sidecar has no display access, so the
/// window passes the URL the runtime produced; anything but a Claude OAuth link is refused.
#[tauri::command]
fn open_login_url(url: String) -> Result<(), String> {
    if !policy::is_login_url(&url) {
        return Err("Only Claude sign-in links can be opened.".into());
    }
    std::process::Command::new("xdg-open")
        .arg(&url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|mut child| {
            // Reap xdg-open so it does not linger as a zombie.
            std::thread::spawn(move || child.wait());
        })
        .map_err(|e| format!("Could not open the browser: {e}"))
}

#[tauri::command]
fn startup_error(state: tauri::State<'_, AppState>) -> Option<String> {
    state.start_error.lock().ok().and_then(|e| e.clone())
}

pub fn run() {
    if policy::running_as_root() {
        eprintln!("VOID Workshop refuses to run as root. Start it as your normal user.");
        std::process::exit(1);
    }
    // WebKitGTK's DMA-BUF renderer crashes on some Wayland + NVIDIA setups ("Error 71 (Protocol
    // error)"). Fall back to the shared-memory renderer unless the user chose otherwise.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            // Tray: the way back to a hidden window, and a real Quit.
            let show = MenuItem::with_id(app, "show", "Show VOID Workshop", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main").menu(&menu).tooltip("VOID Workshop");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| match event.id().as_ref() {
                "show" => show_main(app),
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                    show_main(tray.app_handle());
                }
            })
            .build(app)?;
            // `--hidden` (used for start at login) keeps the window in the tray until it is opened.
            if !std::env::args().any(|a| a == "--hidden") {
                show_main(&handle);
            }
            let state = app.state::<AppState>();
            match start_sidecar(&handle) {
                Ok(sc) => *state.sidecar.lock().expect("state") = Some(sc),
                Err(e) => {
                    eprintln!("void-workshop: {e}");
                    *state.start_error.lock().expect("state") = Some(e);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<AppState>().background.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_call,
            sidecar_restart,
            pick_project_dir,
            open_login_url,
            set_background_mode,
            startup_error
        ])
        .build(tauri::generate_context!())
        .expect("error while building VOID Workshop");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let state = handle.state::<AppState>();
            let sc = state.sidecar.lock().ok().and_then(|mut s| s.take());
            if let Some(sc) = sc {
                sc.shutdown();
            }
        }
    });
}
