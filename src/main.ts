import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

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

function switchDoc(id: string) {
  activeId = id;
  loadActiveIntoEditor();
  renderDocTabs();
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
  setTimeout(() => ta.focus(), 10);
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
  const nm = tab.querySelector(".nm") as HTMLElement;
  const input = document.createElement("input");
  input.className = "rename";
  input.value = n.name;
  nm.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    n.name = input.value.trim() || n.name;
    persistNotes();
    renderDocTabs();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      done = true;
      renderDocTabs();
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
  listEmpty.hidden = true;
  try {
    const res: any = await invoke("fetch_recent", { limit: 25 });
    if (!res?.ok) return showFlash(res?.error ?? "Could not load rows", "err");
    renderRows(res.rows as Row[]);
  } catch (e) {
    showFlash(String(e), "err");
  }
}

function renderRows(list: Row[]) {
  rows.innerHTML = "";
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
  setSub(entry);
  replayEntrance();
  setTimeout(() => company.focus(), 30);
}

async function submitEntry(e: Event) {
  e.preventDefault();
  if (!company.value.trim()) {
    showFlash("Company is required", "err");
    company.focus();
    return;
  }
  const save = $<HTMLButtonElement>("save");
  save.disabled = true;
  try {
    const res: any = await invoke("submit_entry", {
      action: editingRow ? "update" : "append",
      row: editingRow,
      company: company.value.trim(),
      date: date.value.trim() || todayISO(),
      link: link.value.trim(),
      status: status.value,
    });
    if (!res?.ok) throw new Error(res?.error ?? "Sheet rejected the write");
    save.classList.add("ok");
    if (editingRow) {
      showFlash("Row updated ✓", "ok");
      setTimeout(() => {
        save.classList.remove("ok");
        showEditList();
      }, 550);
    } else {
      showFlash("Saved to sheet ✓", "ok");
      setTimeout(async () => {
        save.classList.remove("ok");
        showAdd(false);
        await appWindow.hide();
      }, 620);
    }
  } catch (err) {
    showFlash(String(err instanceof Error ? err.message : err), "err");
  } finally {
    save.disabled = false;
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
  date.value = todayISO();
  loadNotesStore();
  renderDocTabs();
  loadActiveIntoEditor();
  showTab("notes");
})();
