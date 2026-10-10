import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const appWindow = getCurrentWindow();

type Config = { webhook_url: string; token: string; dailys_dir: string };
type Row = { row: number; company: string; date: string; link: string; status: string };
type Tab = "notes" | "sheet" | "dailys" | "settings";
type Note = { id: string; name: string; body: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- element handles ----
const views = [$("notes"), $("sheet"), $("dailys"), $("settings")];
const tabs = Array.from(document.querySelectorAll<HTMLElement>(".tab"));

const docTabs = $("doc-tabs");
const gutter = $("gutter");
const ta = $<HTMLTextAreaElement>("ta");

const topicTabs = $("topic-tabs");
const logEl = $("log");
const dailyTa = $<HTMLTextAreaElement>("daily-ta");
const dailySrc = $<HTMLInputElement>("daily-src");
const dailyWc = $("daily-wc");

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
const dailysDirInput = $<HTMLInputElement>("dailys-dir");
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
      renameNote(tab, n);
    });
    // Right-click renames too — double-click isn't discoverable on its own.
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      renameNote(tab, n);
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
  if (tab && n && !tab.querySelector(".rename")) renameNote(tab, n);
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

function renameNote(tab: HTMLElement, n: Note) {
  beginRename(
    tab,
    n.name,
    32,
    (name) => {
      n.name = name;
      persistNotes();
    },
    () => {
      renderDocTabs();
      setTimeout(() => ta.focus(), 10);
    }
  );
}

// Swap a tab's label for an inline name field. Shared by note tabs and Dailys
// topics; `onCommit` only runs for a non-empty name, and `finish` runs once
// either way (after onCommit settles, so a slow rename repaints the result).
function beginRename(
  tab: HTMLElement,
  current: string,
  maxLength: number,
  onCommit: (name: string) => void | Promise<void>,
  finish: () => void
) {
  const nm = tab.querySelector(".nm") as HTMLElement | null;
  if (!nm) return;
  const input = document.createElement("input");
  input.className = "rename";
  input.maxLength = maxLength;
  input.value = current;
  nm.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const name = input.value.trim().slice(0, maxLength);
    void Promise.resolve(name ? onCommit(name) : undefined).finally(finish);
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
//  DAILYS — one append-only Markdown log per topic, on disk
//  The files are the source of truth (Rust reads/writes them); only the
//  unsent draft and the open topic live in localStorage.
// =====================================================================
const LS_TOPIC = "np3.dailys.topic";
const LS_DRAFTS = "np3.dailys.drafts";
type DailyDraft = { text: string; src: string };
let topics: string[] = [];
let activeTopic = "";
let drafts: Record<string, DailyDraft> = {};
let draftsTimer: number | undefined;
let logging = false;

function loadDrafts() {
  try {
    drafts = JSON.parse(localStorage.getItem(LS_DRAFTS) || "{}") || {};
  } catch {
    drafts = {};
  }
}
function persistDrafts() {
  clearTimeout(draftsTimer);
  localStorage.setItem(LS_DRAFTS, JSON.stringify(drafts));
  localStorage.setItem(LS_TOPIC, activeTopic);
}

const countWords = (s: string) => (s.match(/\S+/g) || []).length;
function updateWordCount() {
  const n = countWords(dailyTa.value);
  dailyWc.textContent = `${n} word${n === 1 ? "" : "s"}`;
}

async function loadTopics() {
  try {
    const res = await invoke<{ dir: string; topics: string[] }>("dailys_list");
    topics = res.topics;
  } catch (e) {
    showFlash(String(e), "err");
    topics = [];
  }
  const want = (activeTopic || localStorage.getItem(LS_TOPIC) || "").toLowerCase();
  activeTopic = topics.find((t) => t.toLowerCase() === want) ?? topics[0] ?? "";
  renderTopicTabs();
  await loadActiveTopic();
}

function renderTopicTabs() {
  topicTabs.innerHTML = "";
  for (const t of topics) {
    const tab = document.createElement("div");
    tab.className = "doc-tab" + (t === activeTopic ? " is-active" : "");
    tab.dataset.id = t;
    tab.title = `${t} — double-click (or F2) to rename`;
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = t;
    tab.appendChild(nm);
    // No close button on purpose: a topic is a diary file. Deleting one is
    // done in the folder, where it goes to the Recycle Bin.
    tab.addEventListener("click", () => switchTopic(t));
    tab.addEventListener("dblclick", (e) => {
      e.preventDefault();
      renameTopic(tab, t);
    });
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      renameTopic(tab, t);
    });
    topicTabs.appendChild(tab);
  }
  const add = document.createElement("button");
  add.className = "doc-add";
  add.type = "button";
  add.textContent = "+";
  add.title = "new topic";
  add.addEventListener("click", addTopic);
  topicTabs.appendChild(add);
}

function switchTopic(t: string) {
  if (t === activeTopic) return;
  activeTopic = t;
  for (const el of topicTabs.querySelectorAll<HTMLElement>(".doc-tab")) {
    el.classList.toggle("is-active", el.dataset.id === t);
  }
  persistDrafts();
  void loadActiveTopic();
  setTimeout(() => dailyTa.focus(), 10);
}

async function addTopic() {
  const taken = new Set(topics.map((t) => t.toLowerCase()));
  let i = topics.length + 1;
  while (taken.has(`topic ${i}`)) i++;
  try {
    const name = await invoke<string>("dailys_create", { topic: `Topic ${i}` });
    topics.push(name);
    activeTopic = name;
    persistDrafts();
    renderTopicTabs();
    await loadActiveTopic();
    renameActiveTopic();
  } catch (e) {
    showFlash(String(e), "err");
  }
}

function renameActiveTopic() {
  const tab = topicTabs.querySelector<HTMLElement>(".doc-tab.is-active");
  if (tab && activeTopic && !tab.querySelector(".rename")) renameTopic(tab, activeTopic);
  else setTimeout(() => dailyTa.focus(), 10);
}

function renameTopic(tab: HTMLElement, from: string) {
  beginRename(
    tab,
    from,
    60,
    async (to) => {
      if (to === from) return;
      try {
        const name = await invoke<string>("dailys_rename", { from, to });
        topics = topics.map((t) => (t === from ? name : t));
        if (drafts[from]) {
          drafts[name] = drafts[from];
          delete drafts[from];
        }
        if (activeTopic === from) activeTopic = name;
        persistDrafts();
      } catch (e) {
        showFlash(String(e), "err");
      }
    },
    () => {
      renderTopicTabs();
      setTimeout(() => dailyTa.focus(), 10);
    }
  );
}

async function loadActiveTopic() {
  const topic = activeTopic;
  const d = drafts[topic] ?? { text: "", src: "" };
  dailyTa.value = d.text;
  dailySrc.value = d.src;
  updateWordCount();
  if (!topic) return renderLog("");
  try {
    const md = await invoke<string>("dailys_read", { topic });
    if (topic === activeTopic) renderLog(md);
  } catch (e) {
    showFlash(String(e), "err");
  }
}

// A line of the user's own text that starts with "## " would read back as a
// new entry, so it is escaped on the way in and unescaped for display.
const escapeHeadings = (s: string) => s.replace(/^(#{1,6} )/gm, "\\$1");
const unescapeHeadings = (s: string) => s.replace(/^\\(#{1,6} )/gm, "$1");

function parseEntries(md: string) {
  return md
    .split(/^## /m)
    .slice(1)
    .map((part) => {
      const nl = part.indexOf("\n");
      return {
        head: (nl < 0 ? part : part.slice(0, nl)).trim(),
        body: unescapeHeadings(nl < 0 ? "" : part.slice(nl + 1).trim()),
      };
    });
}

// Text with every http(s) link turned into something clickable. Built from
// nodes, not innerHTML, since the file may have been edited by hand.
function appendLinkified(el: HTMLElement, text: string) {
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    // Sentence punctuation right after a link is almost never part of it.
    const url = m[0].replace(/[.,;:!?)\]]+$/, "");
    const at = m.index ?? 0;
    el.append(text.slice(last, at));
    const a = document.createElement("a");
    a.textContent = url;
    a.title = url;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      invoke("open_link", { url }).catch((err) => showFlash(String(err), "err"));
    });
    el.append(a);
    last = at + url.length;
  }
  el.append(text.slice(last));
}

function renderLog(md: string) {
  logEl.innerHTML = "";
  const entries = parseEntries(md);
  if (entries.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = activeTopic
      ? "no entries yet — write below, Ctrl+Enter to log"
      : "no topics yet — + to start one, or just write (it goes in Journal)";
    logEl.appendChild(p);
    return;
  }
  for (const en of entries) {
    const div = document.createElement("div");
    div.className = "entry";
    const hd = document.createElement("div");
    hd.className = "entry-hd";
    hd.textContent = en.head;
    const body = document.createElement("div");
    body.className = "entry-body";
    appendLinkified(body, en.body);
    div.append(hd, body);
    logEl.appendChild(div);
  }
  // Newest is at the bottom, right above where you write the next one.
  logEl.scrollTop = logEl.scrollHeight;
}

function formatEntry(text: string, srcRaw: string) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
  let out = `## ${todayISO()} (${weekday}) ${p(d.getHours())}:${p(d.getMinutes())}\n\n${escapeHeadings(text)}\n`;
  const srcs = srcRaw.split(/[\s,]+/).filter(Boolean);
  if (srcs.length) out += `\nSources:\n${srcs.map((s) => `- ${s}`).join("\n")}\n`;
  return out;
}

async function logEntry() {
  if (logging) return;
  const text = dailyTa.value.replace(/^\s*\n/, "").trimEnd();
  const src = dailySrc.value.trim();
  if (!text.trim()) {
    showFlash("write something first", "err");
    dailyTa.focus();
    return;
  }
  logging = true;
  const draftKey = activeTopic;
  try {
    let topic = activeTopic;
    if (!topic) {
      topic = await invoke<string>("dailys_create", { topic: "Journal" });
      topics = [...topics, topic];
      activeTopic = topic;
      renderTopicTabs();
    }
    await invoke("dailys_append", { topic, text: formatEntry(text, src) });
    // Only clear the draft once it is safely on disk; a failure keeps it.
    delete drafts[draftKey];
    delete drafts[topic];
    persistDrafts();
    const words = countWords(text);
    showFlash(`logged ✓ — ${words} word${words === 1 ? "" : "s"}`, "ok");
    if (topic === activeTopic) await loadActiveTopic();
  } catch (e) {
    showFlash(`couldn't log — ${e}`, "err");
  } finally {
    logging = false;
    dailyTa.focus();
  }
}

function saveDraftSoon() {
  drafts[activeTopic] = { text: dailyTa.value, src: dailySrc.value };
  clearTimeout(draftsTimer);
  draftsTimer = window.setTimeout(persistDrafts, 250);
}

dailyTa.addEventListener("input", () => {
  updateWordCount();
  saveDraftSoon();
});
dailySrc.addEventListener("input", saveDraftSoon);
dailyTa.addEventListener("blur", persistDrafts);
dailySrc.addEventListener("blur", persistDrafts);
dailySrc.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.ctrlKey) {
    e.preventDefault();
    void logEntry();
  }
});

// =====================================================================
//  tabs (Notes / Sheet / Dailys / Settings)
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
  } else if (name === "dailys") {
    // Re-list every time so topics added or renamed in Explorer show up.
    void loadTopics();
    setTimeout(() => dailyTa.focus(), 20);
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
  dailysDirInput.value = cfg.dailys_dir;
}

const configArgs = () => ({
  webhookUrl: webhook.value.trim(),
  token: token.value.trim(),
  dailysDir: dailysDirInput.value.trim(),
});
async function saveSettings() {
  try {
    await invoke("save_config", configArgs());
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
    await invoke("save_config", configArgs());
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
  persistDrafts();
  appWindow.hide();
});
$("daily-log").addEventListener("click", () => void logEntry());
$("daily-folder").addEventListener("click", () =>
  invoke("dailys_open_folder").catch((e) => showFlash(String(e), "err"))
);

// =====================================================================
//  window size — resizable from any edge or the corner grip, remembered
// =====================================================================
const LS_SIZE = "np3.size";
const DEFAULT_SIZE = { w: 440, h: 396 };
const MIN_SIZE = 380; // matches minWidth/minHeight in tauri.conf.json
let sizeTimer: number | undefined;
let lastGripDown = 0;

async function restoreSize() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_SIZE) || "null");
    if (s && s.w >= MIN_SIZE && s.h >= MIN_SIZE) await appWindow.setSize(new LogicalSize(s.w, s.h));
  } catch {}
}

void appWindow.onResized(({ payload }) => {
  clearTimeout(sizeTimer);
  sizeTimer = window.setTimeout(async () => {
    const l = payload.toLogical(await appWindow.scaleFactor());
    // Minimizing reports a tiny size; don't remember that.
    if (l.width < MIN_SIZE || l.height < MIN_SIZE) return;
    localStorage.setItem(LS_SIZE, JSON.stringify({ w: Math.round(l.width), h: Math.round(l.height) }));
  }, 300);
});

// The native resize loop swallows the mouseup, so `dblclick` never fires on
// the grip; spot the second press ourselves instead.
$("grip").addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const now = Date.now();
  if (now - lastGripDown < 400) {
    lastGripDown = 0;
    localStorage.removeItem(LS_SIZE);
    void appWindow.setSize(new LogicalSize(DEFAULT_SIZE.w, DEFAULT_SIZE.h));
    return;
  }
  lastGripDown = now;
  void appWindow.startResizeDragging("SouthEast");
});

window.addEventListener("keydown", (e) => {
  // Ctrl+Tab cycles the three main sections
  if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key === "Tab") {
    e.preventDefault();
    const order: Tab[] = ["notes", "sheet", "dailys"];
    showTab(order[(order.indexOf(activeTab) + 1) % order.length]);
    return;
  }
  if (e.ctrlKey && e.key === "Enter" && activeTab === "dailys") {
    e.preventDefault();
    void logEntry();
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
    if (e.code === "Digit3") {
      e.preventDefault();
      showTab("dailys");
      return;
    }
  }
  // F2 renames the open note tab / topic — the same gesture Explorer uses.
  if (e.key === "F2" && (activeTab === "notes" || activeTab === "dailys")) {
    e.preventDefault();
    if (activeTab === "notes") renameActiveDoc();
    else renameActiveTopic();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    persistNotes();
    persistDrafts();
    appWindow.hide();
  }
});

listen("reset-focus", () => {
  if (activeTab === "notes") setTimeout(() => ta.focus(), 20);
  else if (activeTab === "sheet" && entry.classList.contains("is-active")) setTimeout(() => company.focus(), 20);
  else if (activeTab === "dailys") setTimeout(() => dailyTa.focus(), 20);
});

// ---- boot ----
(async () => {
  // Show the real installed version rather than a number that goes stale.
  getVersion()
    .then((v) => ($("app-ver").textContent = `v${v}`))
    .catch(() => {});
  void restoreSize();
  date.value = todayISO();
  loadDrafts();
  loadNotesStore();
  renderDocTabs();
  loadActiveIntoEditor();
  showTab("notes");
  // silent background update check shortly after launch
  setTimeout(() => checkForUpdates(false), 3500);
})();
