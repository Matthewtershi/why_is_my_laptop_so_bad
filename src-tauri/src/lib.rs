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
#[serde(default)]
struct Config {
    webhook_url: String,
    token: String,
    /// Where Dailys live. Empty means the default under Documents.
    dailys_dir: String,
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
    dailys_dir: String,
) -> Result<(), String> {
    let cfg = Config { webhook_url, token, dailys_dir };
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
//
// Worse, the receipt chain sometimes redirects BACK to /exec:
//   POST /exec              -> 302 googleusercontent   (doPost ran, row written)
//   GET  googleusercontent  -> 302 script.google.com/.../exec   <-- no query!
//   GET  /exec              -> runs doGet with NO token -> {"ok":false,
//                              "error":"unauthorized"} -> 302 googleusercontent
//   GET  googleusercontent  -> we read THAT and believe the write was rejected
// The receipt then looks perfectly readable while describing a completely
// different request, so the app announced "token rejected" on a row it had
// just written. Never follow a redirect that re-invokes the script.
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

/// Apps Script serves a script's stored output from googleusercontent. A hop to
/// anywhere else mid-chain means we are being sent back to run the script again
/// rather than to collect its output.
fn serves_stored_output(u: &reqwest::Url) -> bool {
    u.host_str()
        .is_some_and(|h| h == "googleusercontent.com" || h.ends_with(".googleusercontent.com"))
}

/// A healthy read answers in a few seconds; the pathological ones sit in the
/// googleusercontent bounce for 30-45s and usually 404 anyway. Cutting them off
/// early and retrying is both faster and likelier to succeed.
const READ_TIMEOUT: u64 = 18;

/// GET `url`, walking any redirect chain, and parse the JSON at the end.
///
/// `receipt` marks a chain that is collecting a POST's stored output, which is
/// confined to googleusercontent so it can never wander back into the script.
async fn read_json(
    client: &reqwest::Client,
    url: &str,
    receipt: bool,
) -> Result<serde_json::Value, String> {
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
            let target = reqwest::Url::parse(&next)
                .and_then(|base| base.join(loc))
                .map_err(|e| format!("bad redirect target: {e}"))?;
            // Refuse to be sent back into the script. Following this would run
            // doGet with no token and return someone else's answer, which the
            // caller cannot tell apart from its own.
            if target.path().ends_with("/exec") {
                return Err("redirected back to the script instead of its output".into());
            }
            if receipt && !serves_stored_output(&target) {
                return Err(format!(
                    "receipt redirected to {}, which does not serve script output",
                    target.host_str().unwrap_or("?")
                ));
            }
            next = target.to_string();
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
            match read_json(&client, &url, true).await {
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
        match read_json(&client, &url, false).await {
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

// ---------------------------------------------------------------------------
// Dailys
//
// One Markdown file per topic, appended to and never rewritten, so a diary
// entry can't be lost to a bad save. Plain files on purpose: they open in any
// editor, survive the app, and sync for free if the folder sits inside Google
// Drive / OneDrive.
// ---------------------------------------------------------------------------

fn dailys_dir(app: &AppHandle, state: &State<'_, Mutex<Config>>) -> Result<PathBuf, String> {
    let custom = state.lock().unwrap().dailys_dir.trim().to_string();
    if !custom.is_empty() {
        let p = PathBuf::from(custom);
        if !p.is_absolute() {
            return Err("Dailys folder must be a full path (e.g. C:\\Users\\you\\Dailys)".into());
        }
        return Ok(p);
    }
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    Ok(docs.join("Notepad+++ Dailys"))
}

/// Turn a topic name into something safe to use as a file stem: no path
/// separators or characters Windows rejects, no leading/trailing dots or
/// spaces (which also rules out `.` and `..`), and not a reserved device name.
fn topic_stem(name: &str) -> Result<String, String> {
    const BANNED: &str = "<>:\"/\\|?*";
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() && !BANNED.contains(*c))
        .take(60)
        .collect();
    let stem = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    if stem.is_empty() {
        return Err("Topic name can't be empty".into());
    }
    let upper = stem.to_ascii_uppercase();
    let base = upper.split('.').next().unwrap_or("");
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&base)
        || ((base.starts_with("COM") || base.starts_with("LPT"))
            && base.len() == 4
            && base.as_bytes()[3].is_ascii_digit());
    if reserved {
        return Err(format!("\"{stem}\" is a reserved name on Windows"));
    }
    Ok(stem)
}

fn topic_path(dir: &std::path::Path, name: &str) -> Result<PathBuf, String> {
    Ok(dir.join(format!("{}.md", topic_stem(name)?)))
}

#[derive(Serialize)]
struct DailysIndex {
    dir: String,
    topics: Vec<String>,
}

/// The folder in use and the topics in it, alphabetically.
#[tauri::command]
fn dailys_list(app: AppHandle, state: State<'_, Mutex<Config>>) -> Result<DailysIndex, String> {
    let dir = dailys_dir(&app, &state)?;
    let mut topics = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("md")) {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    topics.push(stem.to_string());
                }
            }
        }
    }
    topics.sort_by_key(|t| t.to_lowercase());
    Ok(DailysIndex { dir: dir.to_string_lossy().into_owned(), topics })
}

#[tauri::command]
fn dailys_read(app: AppHandle, state: State<'_, Mutex<Config>>, topic: String) -> Result<String, String> {
    let path = topic_path(&dailys_dir(&app, &state)?, &topic)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Couldn't read {}: {e}", path.display())),
    }
}

/// Start a new topic file. Returns the name actually used (after cleaning).
#[tauri::command]
fn dailys_create(app: AppHandle, state: State<'_, Mutex<Config>>, topic: String) -> Result<String, String> {
    use std::io::Write;
    let dir = dailys_dir(&app, &state)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let stem = topic_stem(&topic)?;
    let path = dir.join(format!("{stem}.md"));
    // create_new: never clobber an existing log.
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => format!("A topic called \"{stem}\" already exists"),
            _ => format!("Couldn't create {}: {e}", path.display()),
        })?;
    writeln!(f, "# {stem}").map_err(|e| e.to_string())?;
    Ok(stem)
}

/// Append one already-formatted entry to the end of a topic's log.
#[tauri::command]
fn dailys_append(
    app: AppHandle,
    state: State<'_, Mutex<Config>>,
    topic: String,
    text: String,
) -> Result<(), String> {
    use std::io::Write;
    let dir = dailys_dir(&app, &state)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let path = topic_path(&dir, &topic)?;
    // Keep a blank line between the previous entry and this one even if the
    // file was last saved by an editor that drops the trailing newline.
    let sep = match std::fs::read(&path) {
        Ok(b) if b.is_empty() || b.ends_with(b"\n\n") => "",
        Ok(b) if b.ends_with(b"\n") => "\n",
        Ok(_) => "\n\n",
        Err(_) => "",
    };
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)
        .map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    f.write_all(format!("{sep}{text}").as_bytes())
        .and_then(|_| f.sync_all())
        .map_err(|e| format!("Couldn't save to {}: {e}", path.display()))
}

/// Rename a topic's file, and its `# Title` line if it still matches.
#[tauri::command]
fn dailys_rename(
    app: AppHandle,
    state: State<'_, Mutex<Config>>,
    from: String,
    to: String,
) -> Result<String, String> {
    let dir = dailys_dir(&app, &state)?;
    let from_stem = topic_stem(&from)?;
    let old = dir.join(format!("{from_stem}.md"));
    let stem = topic_stem(&to)?;
    let new = dir.join(format!("{stem}.md"));
    // Windows paths are case-insensitive, so "foo" -> "Foo" is the same file.
    let same_file = from_stem.to_lowercase() == stem.to_lowercase();
    if !same_file && new.exists() {
        return Err(format!("A topic called \"{stem}\" already exists"));
    }
    std::fs::rename(&old, &new).map_err(|e| format!("Couldn't rename: {e}"))?;
    if let Ok(body) = std::fs::read_to_string(&new) {
        let first = body.lines().next().unwrap_or("");
        if first.trim_end() == format!("# {from_stem}") {
            let rest = &body[first.len()..];
            let _ = std::fs::write(&new, format!("# {stem}{rest}"));
        }
    }
    Ok(stem)
}

/// Show the Dailys folder in Explorer.
#[tauri::command]
fn dailys_open_folder(app: AppHandle, state: State<'_, Mutex<Config>>) -> Result<(), String> {
    let dir = dailys_dir(&app, &state)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Open a source link in the default browser. Web links only, so a log entry
/// can never be used to launch an arbitrary program.
#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    let u = reqwest::Url::parse(&url).map_err(|_| "not a valid link".to_string())?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err("only http(s) links can be opened".into());
    }
    std::process::Command::new("explorer")
        .arg(u.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
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
            fetch_recent,
            dailys_list,
            dailys_read,
            dailys_create,
            dailys_append,
            dailys_rename,
            dailys_open_folder,
            open_link
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
