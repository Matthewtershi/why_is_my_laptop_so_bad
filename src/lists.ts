// Markdown-style lists for plain textareas: Enter continues a list, Enter on
// an empty item ends (or un-nests) it, Tab / Shift+Tab nest an item.
//
// The planners are pure functions of (text, selection) so they can be tested
// without a DOM; applyEdit is the only part that touches the textarea.

/** Replace [from, to) with `text`, then put the caret at `caret`. */
export type Edit = { from: number; to: number; text: string; caret: number };

// indent, marker ("-", "*", "+", "3." or "3)"), the gap after it, a checkbox
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])( +)(\[[ xX]\] )?/;

type Item = { indent: string; marker: string; gap: string; box: string; len: number };

function parseItem(line: string): Item | null {
  const m = ITEM.exec(line);
  if (!m) return null;
  return { indent: m[1], marker: m[2], gap: m[3], box: m[4] ?? "", len: m[0].length };
}

const indentOf = (line: string) => (/^[ \t]*/.exec(line) as RegExpExecArray)[0];
const lineStartAt = (v: string, pos: number) => (pos === 0 ? 0 : v.lastIndexOf("\n", pos - 1) + 1);
const lineEndAt = (v: string, pos: number) => {
  const i = v.indexOf("\n", pos);
  return i < 0 ? v.length : i;
};
const numbered = (marker: string) => /^(\d+)([.)])$/.exec(marker);
const nextMarker = (marker: string) => {
  const m = numbered(marker);
  return m ? `${Number(m[1]) + 1}${m[2]}` : marker;
};
const linesAbove = (v: string, lineStart: number) => (lineStart === 0 ? [] : v.slice(0, lineStart - 1).split("\n"));

/** The closest earlier item at exactly this indent, if the list reaches it. */
function sibling(above: string[], width: number): Item | null {
  for (let i = above.length - 1; i >= 0; i--) {
    const line = above[i];
    if (!line.trim()) continue;
    const it = parseItem(line);
    const w = (it ? it.indent : indentOf(line)).length;
    if (w > width) continue; // a deeper item, or text wrapped under one
    if (w < width) return null;
    return it;
  }
  return null;
}

/** The item this one is nested under. */
function parent(above: string[], width: number): Item | null {
  for (let i = above.length - 1; i >= 0; i--) {
    const line = above[i];
    if (!line.trim()) continue;
    const it = parseItem(line);
    if (it && it.indent.length < width) return it;
    if (!it && indentOf(line).length === 0) return null; // left the list
  }
  return null;
}

/** What Enter should do, or null to let the textarea insert a plain newline. */
export function enterEdit(v: string, start: number, end: number): Edit | null {
  if (start !== end) return null;
  const ls = lineStartAt(v, start);
  const before = v.slice(ls, start);
  const item = parseItem(before);
  if (!item) {
    // Not a list, but still keep the line's indentation.
    const indent = indentOf(before);
    if (!indent || indent === before) return null;
    return { from: start, to: start, text: "\n" + indent, caret: start + 1 + indent.length };
  }
  const rest = v.slice(start, lineEndAt(v, start));
  if (before.length === item.len && !rest.trim()) {
    // Enter on an empty item: step out one level, or end the list.
    if (item.indent) return nestEdit(v, start, end, -1);
    return { from: ls, to: start, text: "", caret: ls };
  }
  const text = `\n${item.indent}${nextMarker(item.marker)}${item.gap}${item.box ? "[ ] " : ""}`;
  return { from: start, to: start, text, caret: start + text.length };
}

/**
 * Tab (dir 1) / Shift+Tab (dir -1) on a list item. Null when the caret isn't
 * on a single list line, so Tab keeps its usual meaning everywhere else.
 */
export function nestEdit(v: string, start: number, end: number, dir: 1 | -1): Edit | null {
  const ls = lineStartAt(v, start);
  const le = lineEndAt(v, start);
  if (end > le) return null;
  const item = parseItem(v.slice(ls, le));
  if (!item) return null;
  const above = linesAbove(v, ls);

  let indent: string;
  if (dir > 0) {
    // Line up under the previous item's text, which is where Markdown expects
    // a child to start ("1. " needs 3 spaces, "- " needs 2).
    const prev = sibling(above, item.indent.length);
    indent = prev ? prev.indent + " ".repeat(prev.marker.length + prev.gap.length) : item.indent + "  ";
  } else {
    if (!item.indent) return { from: start, to: start, text: "", caret: start };
    indent = parent(above, item.indent.length)?.indent ?? "";
  }

  // A numbered item picks up the count of the list it lands in, or starts one.
  let marker = item.marker;
  const num = numbered(marker);
  if (num) {
    const sib = sibling(above, indent.length);
    if (sib && numbered(sib.marker)) marker = nextMarker(sib.marker);
    else if (dir > 0) marker = `1${num[2]}`;
  }

  const prefix = indent + marker + item.gap + item.box;
  const delta = prefix.length - item.len;
  const caret = start - ls >= item.len ? start + delta : ls + prefix.length;
  return { from: ls, to: ls + item.len, text: prefix, caret };
}

export function applyEdit(el: HTMLTextAreaElement, ed: Edit) {
  if (ed.from !== ed.to || ed.text) {
    el.setSelectionRange(ed.from, ed.to);
    // execCommand keeps the edit on the browser's undo stack (Ctrl+Z works);
    // assigning .value would wipe the undo history instead.
    const ok = ed.text
      ? document.execCommand("insertText", false, ed.text)
      : document.execCommand("delete", false);
    if (!ok) {
      el.setRangeText(ed.text, ed.from, ed.to, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  el.setSelectionRange(ed.caret, ed.caret);
}

/** Wire list keys into a textarea. Modified keys (Ctrl+Enter etc.) pass through. */
export function enableLists(el: HTMLTextAreaElement) {
  el.addEventListener("keydown", (e) => {
    if (e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
    let ed: Edit | null = null;
    if (e.key === "Enter" && !e.shiftKey) ed = enterEdit(el.value, el.selectionStart, el.selectionEnd);
    else if (e.key === "Tab") ed = nestEdit(el.value, el.selectionStart, el.selectionEnd, e.shiftKey ? -1 : 1);
    if (!ed) return;
    e.preventDefault();
    applyEdit(el, ed);
  });
}
