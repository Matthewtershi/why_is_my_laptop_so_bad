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

1. Bump the version in **all three** to the same value (e.g. `0.2.1`):
   - `src-tauri/tauri.conf.json`  → `"version"`
   - `src-tauri/Cargo.toml`       → `version`
   - `package.json`               → `"version"` (and the `v0.2.0` label in
     `index.html` / the `.ver` span, cosmetic)
2. Commit, then tag and push the tag:
   ```bash
   git add -A && git commit -m "release 0.2.1"
   git tag v0.2.1
   git push origin main --tags
   ```
3. GitHub Actions (`.github/workflows/release.yml`) builds on `windows-latest`
   (MSVC), signs the installer + `latest.json`, and publishes a GitHub Release
   named `NotePad+++ v0.2.1`.
4. Within a few seconds of the release going live, any running app that's on an
   older version will notice on its next launch (or via **Settings → check for
   updates**), install the update, and relaunch.

## Notes

- The tag **must** start with `v` (that's what triggers the workflow).
- The tag version should be **higher** than what's installed, or the app sees
  "you're on the latest version".
- First release: push `v0.2.0` to establish the baseline release + prove the
  pipeline. Your next change → bump to `v0.2.1` and the installed app
  auto-updates to it.
- CI builds with the **MSVC** toolchain (GitHub runners have it) — none of the
  local GNU/mingw setup is needed on CI.
