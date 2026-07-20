# Google side setup (~5 minutes, one time)

This connects the app to your sheet through a tiny Apps Script "web app". No
Google Cloud project, no OAuth — just a URL and a shared secret.

### 1. Prepare the sheet
Open your internships spreadsheet. Row 1 must be these headers, in this order:

| A | B | C | D |
|---|---|---|---|
| Company | Date Submitted | Link | Status |

### 2. Add the script
1. In the sheet: **Extensions → Apps Script**.
2. Delete whatever is in `Code.gs` and paste the contents of
   [`Code.gs`](./Code.gs) from this folder.
3. Generate a secret and set it at the top of the script:
   - A quick way: run `openssl rand -hex 24` in a terminal, or use any password
     generator (24+ random characters).
   - Replace `REPLACE_WITH_A_LONG_RANDOM_TOKEN` with it. **Keep this value** —
     you'll paste the same one into the app.
4. (Optional) If your applications live on a specific tab, set `SHEET_NAME`.
   Leave `''` to use the first tab.
5. **Save** (💾).

### 3. Deploy as a web app
1. Top right: **Deploy → New deployment**.
2. Gear icon → **Web app**.
3. Configure:
   - **Description:** anything (e.g. `sheet-shortcut`)
   - **Execute as:** **Me**
   - **Who has access:** **Anyone with the link**
     *(the secret token is what actually protects it — see note below)*
4. **Deploy**, then **Authorize access** and approve the Google prompts
   (it's your own script writing to your own sheet).
5. Copy the **Web app URL**. It ends in `/exec`. This is your webhook URL.

### 4. Put it into the app
Open Sheet Shortcut (it opens to Settings on first run), and paste:
- **Apps Script web-app URL** → the `/exec` URL
- **Secret token** → the exact value you set in step 2

Save. Press **Ctrl+Alt+Space** anywhere and add your first application.

---

### Notes & security
- **"Anyone with the link" + a secret token** is the standard pattern for a
  personal Apps Script webhook. The URL alone does nothing without the token;
  every request is rejected unless the token matches. Keep the URL/token
  private (they're stored locally in your app config, not in the code).
- **Re-deploying:** if you edit `Code.gs` later, use
  **Deploy → Manage deployments → (edit) → New version** so the `/exec` URL
  stays the same. Creating a *new* deployment gives a new URL you'd have to
  re-paste.
- **Rotating the secret:** change `SECRET` in the script *and* the token in the
  app's Settings. They must always match.
