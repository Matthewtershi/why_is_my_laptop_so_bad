import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const appWindow = getCurrentWindow();

type Config = { webhook_url: string; token: string };
type Row = { row: number; company: string; date: string; link: string; status: string };
type Tab = "notes" | "sheet" | "settings";
type Note = { id: string; name: string; body: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- element handles ----
const views = [$("notes"), $("sheet"), $("settings")];
const tabs = Array.from(document.querySelectorAll<HTMLElement>(".tab"));

const docTabs = $("doc-tabs");
const gutter = $("gutter");
const ta = $<HTMLTextAreaElement>("ta");

const seg = $("seg");
const entry = $<HTMLFormElement>("entry");
const listView = $("list");
const company = $<HTMLInputElement>("company");
const link = $<HTMLInputElement>("link");
const date = $<HTMLInputElement>("date");
const status = $<HTMLSelectElement>("status");
const saveLabel = $("save-label");
const editBack = $<HTMLButtonElement>("edit-back");
const rows = $("rows");
const listEmpty = $("list-empty");
const webhook = $<HTMLInputElement>("webhook");
const token = $<HTMLInputElement>("token");
const flash = $("flash");

let activeTab: Tab = "notes";
let editingRow: number | null = null;
let flashTimer: number | undefined;
// The date the row already had when an edit was opened. If it comes back
// untouched we send "" so the backend omits the field entirely and the sheet
// keeps its own value — changing only the Status must not rewrite the date.
let originalDate = "";
// Last rows we fetched, so an edit can go straight back to the list without
// waiting on a round trip.
let lastRows: Row[] = [];

const todayISO = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function showFlash(msg: string, kind: "ok" | "err" | "" = "") {
  clearTimeout(flashTimer);
  flash.textContent = msg;
  flash.className = `flash show ${kind}`;
  flashTimer = window.setTimeout(() => (flash.className = "flash"), 2600);
}

// =====================================================================
//  NOTEPAD — multiple tabs, line numbers, localStorage persistence
// =====================================================================
const LS_NOTES = "np3.notes";
const LS_ACTIVE = "np3.active";
let notes: Note[] = [];
let activeId = "";
let notesTimer: number | undefined;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const activeNote = () => notes.find((n) => n.id === activeId) as Note;

function loadNotesStore() {
  try {
    notes = JSON.parse(localStorage.getItem(LS_NOTES) || "[]");
  } catch {
    notes = [];
  }
  if (!Array.isArray(notes) || notes.length === 0) notes = [{ id: uid(), name: "Note 1", body: "" }];
  activeId = localStorage.getItem(LS_ACTIVE) || notes[0].id;
  if (!notes.some((n) => n.id === activeId)) activeId = notes[0].id;
}
function persistNotes() {
  clearTimeout(notesTimer);
  localStorage.setItem(LS_NOTES, JSON.stringify(notes));
  localStorage.setItem(LS_ACTIVE, activeId);
}
function persistSoon() {
  clearTimeout(notesTimer);
  notesTimer = window.setTimeout(persistNotes, 250);
}

function updateGutter() {
  const lines = ta.value.split("\n").length || 1;
  let s = "";
  for (let i = 1; i <= lines; i++) s += i + (i < lines ? "\n" : "");
  gutter.textContent = s;
  gutter.scrollTop = ta.scrollTop;
}

function loadActiveIntoEditor() {
  ta.value = activeNote().body;
  updateGutter();
  ta.scrollTop = 0;
  gutter.scrollTop = 0;
}

function nextName() {
  const taken = new Set(notes.map((n) => n.name));
  let i = notes.length + 1;
  while (taken.has(`Note ${i}`)) i++;
  return `Note ${i}`;
}

function renderDocTabs() {
  docTabs.innerHTML = "";
  for (const n of notes) {
    const tab = document.createElement("div");
    tab.className = "doc-tab" + (n.id === activeId ? " is-active" : "");
    tab.dataset.id = n.id;
    tab.title = `${n.name} — double-click (or F2) to rename`;
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = n.name;
    tab.appendChild(nm);
    if (notes.length > 1) {
      const x = document.createElement("span");
      x.className = "x";
      x.textContent = "×";
      x.title = "close";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteDoc(n.id);
      });
      tab.appendChild(x);
    }
    tab.addEventListener("click", () => switchDoc(n.id));
    tab.addEventListener("dblclick", (e) => {
      e.preventDefault();
      beginRename(tab, n);
    });
    // Right-click renames too — double-click isn't discoverable on its own.
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      beginRename(tab, n);
    });
    docTabs.appendChild(tab);
  }
  const add = document.createElement("button");
  add.className = "doc-add";
  add.type = "button";
  add.textContent = "+";
  add.title = "new note";
  add.addEventListener("click", addDoc);
  docTabs.appendChild(add);
}

// Repaint the highlight in place. Rebuilding the tab strip here would replace
// the element mid-gesture, so the second click of a double-click would land on
// a brand-new node and the browser would never fire `dblclick` — which is why
// rename appeared not to exist.
function markActiveDocTab() {
  for (const el of docTabs.querySelectorAll<HTMLElement>(".doc-tab")) {
    el.classList.toggle("is-active", el.dataset.id === activeId);
  }
}

function switchDoc(id: string) {
  if (id === activeId) return;
  activeId = id;
  loadActiveIntoEditor();
  markActiveDocTab();
  persistNotes();
  setTimeout(() => ta.focus(), 10);
}

function addDoc() {
  const n: Note = { id: uid(), name: nextName(), body: "" };
  notes.push(n);
  activeId = n.id;
  loadActiveIntoEditor();
  renderDocTabs();
  persistNotes();
  // Open the new tab straight into rename so you can name it as you make it;
  // Enter or Esc drops you into the editor either way.
  renameActiveDoc();
}

function renameActiveDoc() {
  const tab = docTabs.querySelector<HTMLElement>(".doc-tab.is-active");
  const n = notes.find((x) => x.id === activeId);
  if (tab && n && !tab.querySelector(".rename")) beginRename(tab, n);
  else setTimeout(() => ta.focus(), 10);
}

function deleteDoc(id: string) {
  const idx = notes.findIndex((n) => n.id === id);
  if (idx < 0) return;
  notes.splice(idx, 1);
  if (notes.length === 0) notes.push({ id: uid(), name: "Note 1", body: "" });
  if (activeId === id) activeId = notes[Math.min(idx, notes.length - 1)].id;
  loadActiveIntoEditor();
  renderDocTabs();
  persistNotes();
  setTimeout(() => ta.focus(), 10);
}

function beginRename(tab: HTMLElement, n: Note) {
  const nm = tab.querySelector(".nm") as HTMLElement | null;
  if (!nm) return;
  const input = document.createElement("input");
  input.className = "rename";
  input.maxLength = 32;
  input.value = n.name;
  nm.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = () => {
    renderDocTabs();
    setTimeout(() => ta.focus(), 10);
  };
  const commit = () => {
    if (done) return;
    done = true;
    n.name = input.value.trim().slice(0, 32) || n.name;
    persistNotes();
    finish();
  };
  // Keep every keystroke inside the field: Esc here means "cancel the rename",
  // not the global "hide the window".
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      done = true;
      finish();
    }
  });
  input.addEventListener("blur", commit);
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
}

ta.addEventListener("input", () => {
  activeNote().body = ta.value;
  updateGutter();
  persistSoon();
});
ta.addEventListener("scroll", () => {
  gutter.scrollTop = ta.scrollTop;
});
ta.addEventListener("blur", persistNotes);

// =====================================================================
//  tabs (Notes / Sheet / Settings)
// =====================================================================
function showTab(name: Tab) {
  activeTab = name;
  for (const v of views) v.classList.toggle("is-active", v.id === name);
  for (const t of tabs) t.classList.toggle("is-active", t.dataset.tab === name);
  if (name === "notes") {
    setTimeout(() => ta.focus(), 20);
  } else if (name === "sheet") {
    if (!entry.classList.contains("is-active") && !listView.classList.contains("is-active")) showAdd(false);
    if (entry.classList.contains("is-active")) setTimeout(() => company.focus(), 30);
  } else {
    void loadSettings();
  }
}

// =====================================================================
//  sheet — add / edit
// =====================================================================
function setSeg(mode: "add" | "edit") {
  seg.querySelectorAll<HTMLElement>(".seg").forEach((b) => b.classList.toggle("is-active", b.dataset.mode === mode));
}
function setSub(el: HTMLElement) {
  for (const s of document.querySelectorAll(".subview")) s.classList.toggle("is-active", s === el);
}
function replayEntrance() {
  entry.classList.remove("animate");
  void entry.offsetWidth;
  entry.classList.add("animate");
}

function showAdd(focus = true) {
  editingRow = null;
  originalDate = "";
  saveLabel.textContent = "Save";
  editBack.hidden = true;
  entry.reset();
  date.value = todayISO();
  status.value = "Applied";
  setSeg("add");
  setSub(entry);
  replayEntrance();
  if (focus && activeTab === "sheet") setTimeout(() => company.focus(), 30);
}

async function showEditList() {
  setSeg("edit");
  setSub(listView);
  rows.innerHTML = "";
  // Apps Script routinely takes 2-13s to answer, so say something rather than
  // leaving an empty panel that looks broken.
  listEmpty.textContent = "loading…";
  listEmpty.hidden = false;
  await refreshList();
}

// `silent` keeps a post-write refresh from stomping on the flash the UI is
// already showing, or shouting about a hiccup the user can't act on.
async function refreshList(silent = false) {
  try {
    const res: any = await invoke("fetch_recent", { limit: 25 });
    if (!res?.ok) {
      if (!silent) {
        showFlash(res?.error ?? "Could not load rows", "err");
        listEmpty.textContent = "couldn't load — hit refresh";
        listEmpty.hidden = false;
      }
      return;
    }
    lastRows = res.rows as Row[];
    renderRows(lastRows);
  } catch (e) {
    if (!silent) {
      showFlash(String(e), "err");
      listEmpty.textContent = "couldn't load — hit refresh";
      listEmpty.hidden = false;
    }
  }
}

function renderRows(list: Row[]) {
  rows.innerHTML = "";
  listEmpty.textContent = "nothing here yet —";
  listEmpty.hidden = list.length > 0;
  for (const r of list) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="co"></span><span class="dt"></span><span class="st"></span>`;
    (li.querySelector(".co") as HTMLElement).textContent = r.company || "(untitled)";
    (li.querySelector(".dt") as HTMLElement).textContent = r.date || "";
    (li.querySelector(".st") as HTMLElement).textContent = r.status || "";
    li.addEventListener("click", () => showEditForm(r));
    rows.appendChild(li);
  }
}

function showEditForm(r: Row) {
  editingRow = r.row;
  saveLabel.textContent = "Update";
  editBack.hidden = false;
  setSeg("edit");
  company.value = r.company;
  link.value = r.link;
  date.value = r.date || todayISO();
  status.value = r.status || "Applied";
  originalDate = date.value;
  setSub(entry);
  replayEntrance();
  setTimeout(() => company.focus(), 30);
}

type Draft = { row: number | null; company: string; date: string; link: string; status: string };

// Fire-and-forget: the UI has already moved on, so only the failure path is
// interesting. Hiding the window *is* the success signal.
function writeInBackground(d: Draft, sentDate: string, onOk?: () => void) {
  void invoke("submit_entry", {
    action: d.row === null ? "append" : "update",
    row: d.row,
    company: d.company,
    date: sentDate,
    link: d.link,
    status: d.status,
  })
    .then((res: any) => {
      if (!res?.ok) {
        const err = String(res?.error ?? "Sheet rejected the write");
        throw new Error(
          err.toLowerCase() === "unauthorized" ? "token rejected — check the SECRET in Code.gs" : err
        );
      }
      // The row is in the sheet but Apps Script never served the receipt (its
      // result URL 404s in bursts). That is not a failed write, so it must not
      // drag the window back up — just say so if anyone is looking.
      if (res.unverified) showFlash("saved — sheet didn't send a receipt", "");
      onOk?.();
    })
    .catch((err) => recoverFailedWrite(d, err));
}

// The write lost. Pull the window back up and hand the entry back so Enter
// retries it — unless the user has since started typing something else, in
// which case say what failed rather than clobbering their work.
async function recoverFailedWrite(d: Draft, err: unknown) {
  const msg = String(err instanceof Error ? err.message : err);
  showTab("sheet");
  if (!company.value.trim() && !link.value.trim()) {
    editingRow = d.row;
    originalDate = d.row === null ? "" : d.date;
    saveLabel.textContent = d.row === null ? "Save" : "Update";
    editBack.hidden = d.row === null;
    setSeg(d.row === null ? "add" : "edit");
    company.value = d.company;
    link.value = d.link;
    date.value = d.date;
    status.value = d.status;
    setSub(entry);
    showFlash(`couldn't save — ${msg}`, "err");
    setTimeout(() => company.focus(), 30);
  } else {
    showFlash(`couldn't save "${d.company}" — ${msg}`, "err");
  }
  try {
    await appWindow.show();
    await appWindow.setFocus();
  } catch {}
}

function submitEntry(e: Event) {
  e.preventDefault();
  if (!company.value.trim()) {
    showFlash("Company is required", "err");
    company.focus();
    return;
  }
  const d: Draft = {
    row: editingRow,
    company: company.value.trim(),
    date: date.value.trim() || todayISO(),
    link: link.value.trim(),
    status: status.value,
  };
  const sentDate = d.row !== null && d.date === originalDate ? "" : d.date;

  if (d.row === null) {
    // Close first, write after. Waiting on the round trip is what made Enter
    // feel slow; if the write fails, recoverFailedWrite brings the window back.
    showAdd(false);
    void appWindow.hide();
    writeInBackground(d, sentDate);
  } else {
    // Same idea for an edit: patch the cached row and show the list right away,
    // then reconcile with the sheet once the write lands.
    const cached = lastRows.find((r) => r.row === d.row);
    if (cached) Object.assign(cached, { company: d.company, date: d.date, link: d.link, status: d.status });
    setSeg("edit");
    setSub(listView);
    renderRows(lastRows);
    showFlash("Row updated ✓", "ok");
    writeInBackground(d, sentDate, () => void refreshList(true));
  }
}

// =====================================================================
//  auto-update
// =====================================================================
async function checkForUpdates(manual = false) {
  try {
    const update = await check();
    if (update) {
      showFlash(`update ${update.version} found — installing…`, "");
      await update.downloadAndInstall();
      showFlash("updated ✓ — restarting", "ok");
      setTimeout(() => relaunch(), 900);
    } else if (manual) {
      showFlash("you're on the latest version ✓", "ok");
    }
  } catch (e) {
    if (!manual) return;
    // Say what actually went wrong. "try again later" sent us hunting through
    // the app when the real answer was a 404: no release published yet.
    const msg = String(e instanceof Error ? e.message : e);
    showFlash(
      /404|not found/i.test(msg) ? "no release published yet — nothing to update to" : `update check failed — ${msg}`,
      "err"
    );
  }
}

// =====================================================================
//  settings
// =====================================================================
async function loadSettings() {
  const cfg = (await invoke("get_config")) as Config;
  webhook.value = cfg.webhook_url;
  token.value = cfg.token;
}
async function saveSettings() {
  try {
    await invoke("save_config", { webhookUrl: webhook.value.trim(), token: token.value.trim() });
    showFlash("Settings saved ✓", "ok");
    showTab("sheet");
  } catch (e) {
    showFlash(String(e), "err");
  }
}

// Save the entered values, then hit the webhook so the user gets an immediate,
// specific verdict instead of a silent failure later.
async function testConnection() {
  if (!webhook.value.trim()) return showFlash("Enter the web-app URL first", "err");
  try {
    await invoke("save_config", { webhookUrl: webhook.value.trim(), token: token.value.trim() });
  } catch {}
  showFlash("testing…", "");
  try {
    const res: any = await invoke("fetch_recent", { limit: 1 });
    if (res?.ok) return showFlash("connected ✓ — sheet reachable", "ok");
    if (String(res?.error).toLowerCase().includes("unauthorized"))
      return showFlash("token rejected — use the SECRET from Code.gs, not the URL", "err");
    showFlash(res?.error ?? "connection failed", "err");
  } catch {
    showFlash("couldn't reach the URL — check the /exec link is right", "err");
  }
}

// =====================================================================
//  wiring
// =====================================================================
tabs.forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab as Tab)));
seg.querySelectorAll<HTMLElement>(".seg").forEach((b) =>
  b.addEventListener("click", () => (b.dataset.mode === "add" ? showAdd() : showEditList()))
);
entry.addEventListener("submit", submitEntry);
editBack.addEventListener("click", showEditList);
$("refresh").addEventListener("click", showEditList);
$("save-settings").addEventListener("click", saveSettings);
$("test-conn").addEventListener("click", testConnection);
$("check-updates").addEventListener("click", () => checkForUpdates(true));
$("btn-close").addEventListener("click", () => {
  persistNotes();
  appWindow.hide();
});

window.addEventListener("keydown", (e) => {
  // Ctrl+Tab toggles between the two main sections
  if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key === "Tab") {
    e.preventDefault();
    showTab(activeTab === "notes" ? "sheet" : "notes");
    return;
  }
  if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey) {
    if (e.code === "Digit1") {
      e.preventDefault();
      showTab("notes");
      return;
    }
    if (e.code === "Digit2") {
      e.preventDefault();
      showTab("sheet");
      return;
    }
  }
  // F2 renames the open note tab — the same gesture Explorer uses.
  if (e.key === "F2" && activeTab === "notes") {
    e.preventDefault();
    renameActiveDoc();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    persistNotes();
    appWindow.hide();
  }
});

listen("reset-focus", () => {
  if (activeTab === "notes") setTimeout(() => ta.focus(), 20);
  else if (activeTab === "sheet" && entry.classList.contains("is-active")) setTimeout(() => company.focus(), 20);
});

// ---- boot ----
(async () => {
  // Show the real installed version rather than a number that goes stale.
  getVersion()
    .then((v) => ($("app-ver").textContent = `v${v}`))
    .catch(() => {});
  date.value = todayISO();
  loadNotesStore();
  renderDocTabs();
  loadActiveIntoEditor();
  showTab("notes");
  // silent background update check shortly after launch
  setTimeout(() => checkForUpdates(false), 3500);
})();
