# Releasing & auto-update

The app updates itself. CI (GitHub Actions) builds + signs a release when you
push a version tag; installed apps read the release's `latest.json`, download the
new signed installer, and replace themselves in place — **your config and notes
are untouched** (they live in `%APPDATA%` / `localStorage`, which installers
never clear).

## One-time setup (do this once)

Add two repository secrets:
**GitHub → your repo → Settings → Secrets and variables → Actions → New repository secret**

1. **`TAURI_SIGNING_PRIVATE_KEY`**
   Paste the entire contents of the private key file:
   ```
   C:\Users\matth\.tauri\np3-updater.key
   ```
   (Open it in Notepad, select all, copy. It's a short base64 blob. **Never commit
   this file** — it lives outside the repo on purpose.)

2. **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`**
   Leave the value **empty** (the key was generated without a password).

> The matching **public** key is already baked into `src-tauri/tauri.conf.json`
> (`plugins.updater.pubkey`) — that's what the app uses to verify updates.
> If you ever lose `np3-updater.key`, you must generate a new keypair
> (`npm run tauri signer generate`), update the pubkey in the config, and every
> installed copy will need one manual reinstall to trust the new key.

## Cutting a release

1. Bump the version in **all three** to the same value (e.g. `0.3.1`):
   - `src-tauri/tauri.conf.json`  → `"version"`
   - `src-tauri/Cargo.toml`       → `version`
   - `package.json`               → `"version"`

   The `v…` label in Settings reads the real version at runtime via
   `getVersion()`, so there is nothing to bump in `index.html`.
2. Commit, then tag and push the tag:
   ```bash
   git add -A && git commit -m "release 0.3.1"
   git tag v0.3.1
   git push origin main --tags
   ```
3. GitHub Actions (`.github/workflows/release.yml`) builds on `windows-latest`
   (MSVC), signs the installer + `latest.json`, and publishes a GitHub Release
   named `Notepad+++ v0.3.1`.
4. Within a few seconds of the release going live, any running app that's on an
   older version will notice on its next launch (or via **Settings → check for
   updates**), install the update, and relaunch.

## Notes

- The tag **must** start with `v` (that's what triggers the workflow).
- The tag version should be **higher** than what's installed, or the app sees
  "you're on the latest version".
- The updater matches on the **version** in `latest.json`, not on the product
  name, so it keeps working across the v0.3.0 rename (see below).
- CI builds with the **MSVC** toolchain (GitHub runners have it) — none of the
  local GNU/mingw setup is needed on CI.

## The v0.3.0 rename (one-time)

`productName` went from `Sheet Shortcut` to `Notepad+++`. NSIS keys its
uninstall entry on the **product name**
(`HKCU\…\Uninstall\${PRODUCTNAME}`), so the v0.3.0 installer does not
see the v0.2.0 install: it lands beside it in `%LOCALAPPDATA%\Notepad+++`
rather than replacing it.

What that costs, once:

- Your settings and notes carry over untouched. Both are keyed on the **bundle
  identifier** (`com.matthewtershi.sheetshortcut`), which deliberately did
  **not** change.
- On its first run v0.3.0 deletes the old `Sheet Shortcut` launch-on-login
  registry entry, so the two copies cannot both start up and fight over
  Ctrl+Alt+Space.
- The stale **Sheet Shortcut** entry in *Add or remove programs* is yours to
  remove by hand, and the old copy keeps running until you quit it from its
  tray icon or reboot. Uninstalling it does not touch v0.3.0.

Any future rename costs the same, so pick the name once.
