use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Persisted, local-only settings. The token gates access to your Apps Script
/// web app; it never leaves this machine except in requests to your own sheet.
#[derive(Default, Clone, Serialize, Deserialize)]
struct Config {
    webhook_url: String,
    token: String,
}

fn config_path(app: &AppHandle) -> tauri::Result<PathBuf> {
    Ok(app.path().app_config_dir()?.join("config.json"))
}

fn load_config(app: &AppHandle) -> Config {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Show + focus the window and tell the UI to reset to Add mode / focus Company.
fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = w.emit("reset-focus", ());
    }
}

/// Global-hotkey behavior: visible -> hide, hidden -> show. Feels like the
/// Snipping Tool: one keystroke to summon, one to dismiss.
fn toggle_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        match w.is_visible() {
            Ok(true) => {
                let _ = w.hide();
            }
            _ => show_window(app),
        }
    }
}

#[tauri::command]
fn get_config(state: State<'_, Mutex<Config>>) -> Config {
    state.lock().unwrap().clone()
}

#[tauri::command]
fn save_config(
    app: AppHandle,
    state: State<'_, Mutex<Config>>,
    webhook_url: String,
    token: String,
) -> Result<(), String> {
    let cfg = Config { webhook_url, token };
    let path = config_path(&app).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&cfg).unwrap())
        .map_err(|e| e.to_string())?;
    *state.lock().unwrap() = cfg;
    Ok(())
}

/// Append a new row or update an existing one via the Apps Script web app.
#[tauri::command]
async fn submit_entry(
    state: State<'_, Mutex<Config>>,
    action: String,
    row: Option<u64>,
    company: String,
    date: String,
    link: String,
    status: String,
) -> Result<serde_json::Value, String> {
    let cfg = { state.lock().unwrap().clone() };
    if cfg.webhook_url.is_empty() {
        return Err("No webhook configured — open Settings (gear) first.".into());
    }
    let mut body = serde_json::json!({
        "token": cfg.token,
        "action": action,
        "company": company,
        "date": date,
        "link": link,
        "status": status,
    });
    if let Some(r) = row {
        body["row"] = serde_json::json!(r);
    }
    let client = reqwest::Client::new();
    let resp = client
        .post(&cfg.webhook_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Bad response from sheet: {e}"))
}

/// Fetch the most recent rows so the UI can offer them for editing.
#[tauri::command]
async fn fetch_recent(
    state: State<'_, Mutex<Config>>,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    let cfg = { state.lock().unwrap().clone() };
    if cfg.webhook_url.is_empty() {
        return Err("No webhook configured — open Settings (gear) first.".into());
    }
    let limit_s = limit.unwrap_or(25).to_string();
    let client = reqwest::Client::new();
    let resp = client
        .get(&cfg.webhook_url)
        .query(&[("token", cfg.token.as_str()), ("limit", limit_s.as_str())])
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Bad response from sheet: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin: a second launch (e.g. autostart + manual)
        // just focuses the running instance instead of fighting over the hotkey.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_window(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            submit_entry,
            fetch_recent
        ])
        .on_window_event(|window, event| {
            // Closing (or Esc-triggered close) hides to tray instead of quitting,
            // so the hotkey stays live in the background.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // Load persisted settings into managed state.
            let cfg = load_config(&handle);
            let first_run = cfg.webhook_url.is_empty();
            app.manage(Mutex::new(cfg));

            // Register Ctrl+Alt+Space globally. Clear any stale registration
            // first, and treat a conflict as non-fatal (fall back to the tray
            // icon) rather than crashing the whole app.
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
            let gs = app.global_shortcut();
            let _ = gs.unregister_all();
            if let Err(e) = gs.register(shortcut) {
                eprintln!("warning: could not register Ctrl+Alt+Space ({e}); use the tray icon.");
            }

            // Launch on login so the hotkey is always available.
            use tauri_plugin_autostart::ManagerExt;
            let _ = app.autolaunch().enable();

            // System tray: left-click opens; menu has Open / Quit.
            let open_i = MenuItem::with_id(app, "open", "Open  (Ctrl+Alt+Space)", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &quit_i])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("NotePad+++ — Ctrl+Alt+Space")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_window(app),
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
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // First run with no webhook set: pop the window so the user can
            // configure it. Otherwise stay hidden in the tray until summoned.
            if first_run {
                show_window(&handle);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
