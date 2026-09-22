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

/// v0.2 shipped under the product name "Sheet Shortcut". The NSIS uninstall
/// key is keyed on the product name, so the renamed installer lands beside the
/// old copy rather than replacing it. Drop the old copy's launch-on-login entry
/// so the two don't race for the global hotkey at the next login. (Actually
/// uninstalling it is destructive, so that's left to the user.)
#[cfg(windows)]
fn drop_legacy_autostart() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("reg")
        .args([
            "delete",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "Sheet Shortcut",
            "/f",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
fn drop_legacy_autostart() {}

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

// ---------------------------------------------------------------------------
// Talking to Apps Script
//
// A web app answers /exec with a 302 pointing at a one-shot
// script.googleusercontent.com URL that holds the script's output. The script
// has ALREADY RUN by the time that 302 is issued. That second leg is
// unreliable in practice: measured on this deployment it 404s in bursts (5 of
// 12 sequential reads) and can bounce googleusercontent -> script.google.com
// several times, taking 45s.
//
// So the two legs mean different things and must not share an error path:
//   POST fails outright  -> the script never ran   -> the write did NOT happen
//   302 received         -> the script ran         -> the write DID happen
// Reporting a failed receipt-read as a failed write is what made the app cry
// wolf on rows that were already in the sheet.
// ---------------------------------------------------------------------------

/// Redirect hops to walk before giving up. Apps Script normally uses one, but
/// its re-route dance has been observed bouncing seven times.
const MAX_HOPS: usize = 10;

/// Redirects are followed by hand (see above), so the POST can tell "the script
/// ran" from "the script never ran". Timeouts are per-request, not global: the
/// POST must be given room to finish, while a receipt read should give up early
/// and let the retry take a fresh URL.
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

/// A healthy read answers in a few seconds; the pathological ones sit in the
/// googleusercontent bounce for 30-45s and usually 404 anyway. Cutting them off
/// early and retrying is both faster and likelier to succeed.
const READ_TIMEOUT: u64 = 18;

/// GET `url`, walking any redirect chain, and parse the JSON at the end.
async fn read_json(client: &reqwest::Client, url: &str) -> Result<serde_json::Value, String> {
    let mut next = url.to_string();
    for _ in 0..MAX_HOPS {
        let resp = client
            .get(&next)
            .timeout(std::time::Duration::from_secs(READ_TIMEOUT))
            .send()
            .await
            .map_err(|e| format!("network error: {e}"))?;
        if let Some(loc) = resp.headers().get(reqwest::header::LOCATION) {
            let loc = loc.to_str().map_err(|e| format!("bad redirect: {e}"))?;
            // Join against the current URL so a relative Location still works.
            next = reqwest::Url::parse(&next)
                .and_then(|base| base.join(loc))
                .map(|u| u.to_string())
                .map_err(|e| format!("bad redirect target: {e}"))?;
            continue;
        }
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        return resp
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("bad response: {e}"));
    }
    Err("too many redirects".into())
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
        "link": link,
        "status": status,
    });
    // An empty date means "leave the cell alone" — the UI sends that when an
    // edit didn't touch the date, so changing only the Status can't rewrite
    // (and re-round-trip) the date the sheet already holds.
    if !date.is_empty() {
        body["date"] = serde_json::json!(date);
    }
    if let Some(r) = row {
        body["row"] = serde_json::json!(r);
    }

    let client = http_client()?;
    // The POST is the only non-idempotent step, so it is sent exactly once and
    // never retried — a retry here is how you get duplicate rows. It also gets
    // a generous timeout: giving up early would not stop the sheet from being
    // written, it would only leave us unable to tell that it was.
    let resp = client
        .post(&cfg.webhook_url)
        .timeout(std::time::Duration::from_secs(90))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = resp.status();
    if !status.is_redirection() {
        if !status.is_success() {
            return Err(format!("Sheet returned HTTP {status}"));
        }
        // Some deployments answer inline with no redirect.
        return resp
            .json::<serde_json::Value>()
            .await
            .map_err(|e| format!("Bad response from sheet: {e}"));
    }

    // Past this point the script has run and the row is written. Try to read
    // the receipt so a real script-level rejection (unauthorized, bad row) can
    // still surface, but never turn a failed read into a failed write.
    let receipt = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|loc| {
            reqwest::Url::parse(&cfg.webhook_url)
                .and_then(|base| base.join(loc))
                .ok()
        })
        .map(|u| u.to_string());

    if let Some(url) = receipt {
        for attempt in 0..3u64 {
            match read_json(&client, &url).await {
                Ok(v) => return Ok(v),
                Err(_) if attempt < 2 => {
                    // The 404s arrive in bursts, so pause before re-reading.
                    tokio::time::sleep(std::time::Duration::from_millis(700 * (attempt + 1))).await;
                }
                Err(_) => break,
            }
        }
    }

    // The write landed but the receipt is unreadable. Say so honestly rather
    // than claiming the save failed.
    Ok(serde_json::json!({ "ok": true, "unverified": true }))
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
    let mut url = reqwest::Url::parse(&cfg.webhook_url).map_err(|e| format!("Bad webhook URL: {e}"))?;
    url.query_pairs_mut()
        .append_pair("token", &cfg.token)
        .append_pair("limit", &limit.unwrap_or(25).to_string());
    let url = url.to_string();

    let client = http_client()?;
    // A read changes nothing, so the whole request can simply be retried until
    // Apps Script serves a result instead of a 404.
    let mut last = String::new();
    for attempt in 0..4u64 {
        match read_json(&client, &url).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = e;
                if attempt < 3 {
                    tokio::time::sleep(std::time::Duration::from_millis(700 * (attempt + 1))).await;
                }
            }
        }
    }
    Err(format!("Could not reach the sheet after 4 tries — {last}"))
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            drop_legacy_autostart();

            // System tray: left-click opens; menu has Open / Quit.
            let open_i = MenuItem::with_id(app, "open", "Open  (Ctrl+Alt+Space)", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &quit_i])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Notepad+++ — Ctrl+Alt+Space")
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
