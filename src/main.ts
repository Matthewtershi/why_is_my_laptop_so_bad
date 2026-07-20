import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

const appWindow = getCurrentWindow();

type Config = { webhook_url: string; token: string };
type Row = { row: number; company: string; date: string; link: string; status: string };

// ---- element handles ----
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = document.querySelector(".stage") as HTMLElement;
const seg = $("seg");
const entry = $<HTMLFormElement>("entry");
const listView = $("list");
const settingsView = $("settings");
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

let editingRow: number | null = null;
let flashTimer: number | undefined;

// ---- helpers ----
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

function replayEntrance() {
  entry.classList.remove("animate");
  void entry.offsetWidth; // reflow to restart CSS animations
  entry.classList.add("animate");
}

function setActiveView(el: HTMLElement) {
  for (const v of stage.querySelectorAll(".view")) v.classList.remove("is-active");
  el.classList.add("is-active");
}

function setSeg(mode: "add" | "edit") {
  seg.dataset.mode = mode;
  seg.querySelectorAll(".seg").forEach((b) =>
    b.classList.toggle("is-active", (b as HTMLElement).dataset.mode === mode)
  );
}

// ---- views ----
function showAdd(focus = true) {
  editingRow = null;
  saveLabel.textContent = "Save";
  editBack.hidden = true;
  entry.reset();
  date.value = todayISO();
  status.value = "Applied";
  setSeg("add");
  setActiveView(entry);
  replayEntrance();
  if (focus) setTimeout(() => company.focus(), 30);
}

async function showEditList() {
  setSeg("edit");
  setActiveView(listView);
  rows.innerHTML = "";
  listEmpty.hidden = true;
  const loading = document.createElement("p");
  loading.className = "empty";
  loading.textContent = "Loading…";
  rows.after(loading);
  try {
    const res: any = await invoke("fetch_recent", { limit: 25 });
    loading.remove();
    if (!res?.ok) return showFlash(res?.error ?? "Could not load rows", "err");
    renderRows(res.rows as Row[]);
  } catch (e) {
    loading.remove();
    showFlash(String(e), "err");
  }
}

function renderRows(list: Row[]) {
  rows.innerHTML = "";
  listEmpty.hidden = list.length > 0;
  for (const r of list) {
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="co"></span><span class="dt"></span><span class="st"></span>`;
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
  setActiveView(entry);
  replayEntrance();
  setTimeout(() => company.focus(), 30);
}

async function showSettings() {
  const cfg = (await invoke("get_config")) as Config;
  webhook.value = cfg.webhook_url;
  token.value = cfg.token;
  setActiveView(settingsView);
}

// ---- actions ----
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
      // Append: confirm briefly, then hide — snappy "record and vanish".
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

async function saveSettings() {
  try {
    await invoke("save_config", {
      webhookUrl: webhook.value.trim(),
      token: token.value.trim(),
    });
    showFlash("Settings saved ✓", "ok");
    showAdd();
  } catch (e) {
    showFlash(String(e), "err");
  }
}

// ---- wiring ----
seg.querySelectorAll(".seg").forEach((b) =>
  b.addEventListener("click", () => {
    const mode = (b as HTMLElement).dataset.mode;
    if (mode === "add") showAdd();
    else showEditList();
  })
);

entry.addEventListener("submit", submitEntry);
editBack.addEventListener("click", showEditList);
$("refresh").addEventListener("click", showEditList);
$("nav-settings").addEventListener("click", showSettings);
$("settings-back").addEventListener("click", () => showAdd());
$("save-settings").addEventListener("click", saveSettings);
$("btn-close").addEventListener("click", () => appWindow.hide());

// Esc always dismisses to tray (fast, Snipping-Tool style)
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    appWindow.hide();
  }
});

// Rust asks us to reset to Add + focus whenever the window is summoned.
listen("reset-focus", () => {
  if (settingsView.classList.contains("is-active")) return; // don't yank first-run setup
  showAdd();
});

// ---- boot ----
(async () => {
  date.value = todayISO();
  const cfg = (await invoke("get_config")) as Config;
  if (!cfg.webhook_url) {
    await showSettings();
    showFlash("Add your web-app URL + token to begin", "");
  } else {
    showAdd();
  }
})();
