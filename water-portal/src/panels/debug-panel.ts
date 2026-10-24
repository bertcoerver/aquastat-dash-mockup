/*
 * A floating window that shows app state as a JSON tree, for development: objects
 * fold open and closed, and "Copy" copies it all as JSON. Drag it by its title bar;
 * resize it from the bottom-right corner; × closes it, and "Debug window" in the Layers
 * menu brings it back. Its position, size, whether it's open and which branches are
 * folded are remembered in this browser. Above the tree, numbers to tune (see
 * debugNumber), also remembered.
 */

const STORAGE_KEY = "water-portal:debug-panel";
const FOLDED_KEY = "water-portal:debug-folded";
const CLOSED_KEY = "water-portal:debug-closed";
const SETTINGS_KEY = "water-portal:debug-settings";

interface Layout {
  left: number;
  top: number;
  width: number;
  height: number;
  collapsed: boolean;
}

/**
 * Returns a function that replaces one top-level entry (e.g. "click") and redraws it.
 * Entries are shown in the order of `order`.
 */
export function initDebugPanel(order: string[]): (key: string, value: unknown) => void {
  const panel = document.getElementById("debug-panel")!;
  const head = document.getElementById("debug-head")!;
  const body = document.getElementById("debug-body")!;
  const collapse = document.getElementById("debug-collapse")!;
  const copy = document.getElementById("debug-copy")!;
  const close = document.getElementById("debug-close")!;
  const toggle = document.getElementById("debug-toggle") as HTMLInputElement;
  const content: Record<string, unknown> = {};
  const folded = new Set<string>(loadFolded());

  // One block per top-level entry, so an update redraws only its own entry.
  const blocks = new Map(
    order.map((key) => {
      const block = document.createElement("div");
      body.append(block);
      return [key, block];
    }),
  );

  // Remember which branches the user folded.
  body.addEventListener(
    "toggle",
    (e) => {
      const details = e.target as HTMLDetailsElement;
      const path = details.dataset.path!;
      if (details.open) folded.delete(path);
      else folded.add(path);
      try {
        localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]));
      } catch {
        // Not kept without storage.
      }
    },
    true, // toggle doesn't bubble
  );

  copy.addEventListener("click", async () => {
    const ordered = Object.fromEntries(order.filter((k) => k in content).map((k) => [k, content[k]]));
    await navigator.clipboard.writeText(JSON.stringify(ordered, null, 2));
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1200);
  });

  // Restore the last layout, if any.
  const saved = load();
  if (saved) {
    Object.assign(panel.style, {
      left: `${saved.left}px`,
      top: `${saved.top}px`,
      right: "auto",
      width: `${saved.width}px`,
      height: `${saved.height}px`,
    });
    setCollapsed(saved.collapsed);
  }
  setClosed(loadClosed());

  function setClosed(closed: boolean) {
    panel.hidden = closed;
    toggle.checked = !closed;
    try {
      localStorage.setItem(CLOSED_KEY, String(closed));
    } catch {
      // Not kept without storage.
    }
  }

  close.addEventListener("click", () => setClosed(true));
  toggle.addEventListener("change", () => setClosed(!toggle.checked));

  function setCollapsed(collapsed: boolean) {
    panel.classList.toggle("collapsed", collapsed);
    collapse.setAttribute("aria-expanded", String(!collapsed));
    collapse.textContent = collapsed ? "+" : "–";
    collapse.title = collapsed ? "Expand" : "Collapse";
  }

  collapse.addEventListener("click", () => {
    setCollapsed(!panel.classList.contains("collapsed"));
    save();
  });

  // Dragging by the title bar, kept inside the window.
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return; // not when pressing a button
    head.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, left: panel.offsetLeft, top: panel.offsetTop };
    const move = (m: PointerEvent) => {
      const left = clamp(start.left + m.clientX - start.x, 0, window.innerWidth - panel.offsetWidth);
      const top = clamp(start.top + m.clientY - start.y, 0, window.innerHeight - head.offsetHeight);
      Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, right: "auto" });
    };
    const end = () => {
      head.removeEventListener("pointermove", move);
      save();
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", end, { once: true });
    head.addEventListener("pointercancel", end, { once: true });
  });

  // Resizing uses CSS `resize: both`; remember the new size (not the first size, which
  // would pin it before the top bar is laid out).
  let sized = false;
  new ResizeObserver(() => {
    if (sized) save();
    sized = true;
  }).observe(panel);

  function save() {
    if (panel.hidden) return; // (it measures 0 then)
    const layout: Layout = {
      left: panel.offsetLeft,
      top: panel.offsetTop,
      width: panel.offsetWidth,
      height: panel.classList.contains("collapsed") ? (load()?.height ?? panel.offsetHeight) : panel.offsetHeight,
      collapsed: panel.classList.contains("collapsed"),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Storage can be unavailable (private browsing); the layout just isn't kept.
    }
  }

  return (key, value) => {
    content[key] = value;
    let block = blocks.get(key);
    if (!block) {
      block = document.createElement("div");
      body.append(block);
      blocks.set(key, block);
    }
    block.replaceChildren(tree(key, value, key, folded));
  };
}

/**
 * A number to tune in the debug window, above the tree. `onChange` runs with the value
 * kept from last time, if it isn't `value`, and on every change. Clearing the field
 * goes back to `value`.
 */
export function debugNumber(
  { key, label, value, min, max, step = 1 }: { key: string; label: string; value: number; min: number; max: number; step?: number },
  onChange: (value: number) => void,
) {
  const row = document.createElement("label");
  row.className = "debug-setting";
  const input = document.createElement("input");
  Object.assign(input, { type: "number", min, max, step, placeholder: String(value), title: `Default ${value}` });
  row.append(label, input);
  document.getElementById("debug-settings")!.append(row);

  const kept = loadSettings()[key];
  if (typeof kept === "number" && kept !== value) {
    input.value = String(kept);
    onChange(kept);
  }
  input.addEventListener("input", () => {
    const n = input.value === "" ? value : clamp(input.valueAsNumber, min, max);
    if (Number.isNaN(n)) return; // mid-typing
    const settings = loadSettings();
    if (n === value) delete settings[key];
    else settings[key] = n;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Not kept without storage.
    }
    onChange(n);
  });
  input.addEventListener("change", () => {
    if (input.value !== "") input.value = String(clamp(input.valueAsNumber || value, min, max));
  });
}

function loadSettings(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

/** One entry of the tree: a foldable branch for a non-empty object or array, else a line. */
function tree(key: string, value: unknown, path: string, folded: Set<string>): HTMLElement {
  const label = document.createElement("span");
  label.className = "jv-key";
  label.textContent = key;

  const entries = value && typeof value === "object" ? Object.entries(value) : [];
  if (entries.length === 0) {
    const line = document.createElement("div");
    line.className = "jv-line";
    line.append(label, ": ", leaf(value));
    return line;
  }

  const details = document.createElement("details");
  details.className = "jv-branch";
  details.dataset.path = path;
  details.open = !folded.has(path);
  const summary = document.createElement("summary");
  const preview = document.createElement("span");
  preview.className = "jv-preview";
  preview.textContent = previewOf(value as object);
  summary.append(label, ": ", preview);
  const children = document.createElement("div");
  children.className = "jv-children";
  for (const [k, v] of entries) children.append(tree(k, v, `${path}.${k}`, folded));
  details.append(summary, children);
  return details;
}

function leaf(value: unknown) {
  const span = document.createElement("span");
  const type = value === null || value === undefined ? "null" : typeof value;
  span.className = `jv-${type}`;
  span.textContent = type === "string" ? JSON.stringify(value) : String(value ?? null);
  return span;
}

/** A one-line summary for a folded branch, e.g. { m49: 404, name: "Kenya" }. */
function previewOf(value: object) {
  const isArray = Array.isArray(value);
  const parts = Object.entries(value).map(([k, v]) => {
    const text = v && typeof v === "object" ? (Array.isArray(v) ? "[…]" : "{…}") : JSON.stringify(v ?? null);
    return isArray ? text : `${k}: ${text}`;
  });
  const inner = parts.join(", ");
  const short = inner.length > 60 ? `${inner.slice(0, 59)}…` : inner;
  return isArray ? `[${short}]` : `{ ${short} }`;
}

function loadFolded(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function loadClosed() {
  try {
    return localStorage.getItem(CLOSED_KEY) === "true";
  } catch {
    return false;
  }
}

function load(): Layout | null {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    return null;
  }
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));
