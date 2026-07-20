# Sheet Shortcut

A tiny Tauri tray app for Windows that adds an internship application to your
Google Sheet from anywhere with **Ctrl + Alt + Space** — a small window pops up,
you type Company + portal link, hit Enter, and it records the row and vanishes.
You can also edit recent rows.

```
Company │ Date Submitted │ Link │ Status
```

- **Fast:** lives in the system tray, so the hotkey summons an already-running
  window instantly (no cold start).
- **Small:** a ~400×340 window, styled as a designer's **sketchbook page** —
  felt-tip ink on dot-grid paper, wobbly hand-drawn boxes, diagonal hatching,
  and a yellow highlighter marking the active tab.
- **No Google Cloud / OAuth:** writes through a ~15-line Apps Script web app.

---

## How it works

```
Ctrl+Alt+Space ▶ Tauri window ▶ Rust command ▶ HTTPS POST ▶ Apps Script ▶ your Sheet
   (global        (tiny         (native, uses      (with        (doPost / doGet)
    hotkey)        webview)      SChannel TLS)      secret)
```

- **Add** appends a row. **Edit** pulls your recent rows (via `doGet`) so you
  can click one and update its Status/etc.
- Date auto-fills to today; Status defaults to `Applied`. The only real typing
  is Company + Link.
- The window does **not** hide when it loses focus, so you can tab to your
  browser to copy the portal link mid-entry. `Esc` or the × dismisses it.

---

## Setup

### 1. Google side
Follow [`google-apps-script/SETUP.md`](./google-apps-script/SETUP.md) — paste
the script, deploy as a web app, copy the `/exec` URL + secret. ~5 minutes.

### 2. The app
On first launch it opens straight to **Settings**. Paste the web-app URL and the
secret token, Save. Done — press **Ctrl+Alt+Space** to add applications.

Settings are stored locally at:
```
%APPDATA%\com.matthewtershi.sheetshortcut\config.json
```

---

## Develop / build

Prerequisites (already installed on this machine): Node, Rust (**GNU**
toolchain — `stable-x86_64-pc-windows-gnu`), WebView2, and the **mingw-w64
toolchain** on `PATH` (`C:\msys64\mingw64\bin`) — the GNU toolchain needs its
`dlltool`/`as` to build Windows import libraries, and `windres` (which uses
`gcc` as its preprocessor) to embed the app icon. Installed here via:

```
winget install MSYS2.MSYS2
C:\msys64\usr\bin\bash -lc "pacman -S mingw-w64-x86_64-binutils mingw-w64-x86_64-gcc"
```

```bash
npm install            # once
npm run tauri dev      # hot-reloading dev app
npm run tauri build    # produces the NSIS installer
```

The installer lands in:
```
src-tauri/target/release/bundle/nsis/Sheet Shortcut_0.1.0_x64-setup.exe
```
Double-click to install. It registers itself to launch on login (so the hotkey
is always live) and to appear in the system tray.

### Why the GNU toolchain?
To avoid the ~3–6 GB MSVC C++ Build Tools + Windows SDK download. Networking
uses `reqwest` with `native-tls`, which on Windows is **SChannel** — pure Rust
bindings to the OS, so no OpenSSL and no C compiler are needed. Linking uses the
GNU toolchain's self-contained `rust-lld`; the only external piece is the
mingw-w64 toolchain (`dlltool`/`as`/`windres`/`gcc`) — a few hundred MB, far
lighter than the MSVC path's 3–6 GB.

**GNU gotcha — `WebView2Loader.dll` must be bundled.** MSVC links this shim
statically, so Tauri's bundler doesn't package it; the GNU build imports it
*dynamically*, so without it the installed app dies at startup with
"WebView2Loader.dll was not found". It only appears to work from
`target/{debug,release}/` because cargo drops a copy next to the exe. Fix:
`src-tauri/WebView2Loader.dll` is committed and shipped via
`bundle.resources` in `tauri.conf.json`. If you ever bump the WebView2
crates, refresh that DLL from `target/release/WebView2Loader.dll`.

> Always verify by running the **installed** app, not the one in `target/`.

---

## Design trade-offs (the honest list)

- **Background process:** the app stays resident in the tray to keep the hotkey
  instant. That's a few MB of idle RAM — the cost of "feels like Snipping Tool."
- **GNU vs MSVC:** leaner to install, slightly less battle-tested. Fine for a
  personal tool.
- **Apps Script webhook vs Sheets API:** dead simple and no OAuth, at the cost
  of a secret-gated public URL (standard for personal webhooks).
- **Row limit for Edit:** the picker loads the most recent 25 rows by default
  (tunable in `fetch_recent`).

---

## Project layout

```
src/                     frontend (vanilla TS + Vite)
  index.html             window markup
  main.ts                view logic, keyboard, invokes
  styles.css             the hand-drawn "Sketchbook" theme
src-tauri/               Rust backend
  src/lib.rs             tray, global hotkey, autostart, config, webhook calls
  tauri.conf.json        window (tiny, borderless, always-on-top, hidden start)
  capabilities/          window/event permissions granted to the UI
google-apps-script/
  Code.gs                the webhook (doPost append/update, doGet recent)
  SETUP.md               Google setup walkthrough
```
