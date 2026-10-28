/*
 * A text field with a dropdown tree that narrows as you type (an ARIA combobox), with
 * nested options that can be opened and closed. Expects this markup (see index.html):
 *
 *   <div class="combobox">
 *     <input role="combobox" aria-controls="LIST_ID" …>
 *     <button class="combobox-clear" …>×</button>
 *     <ul class="combobox-list" id="LIST_ID" role="tree" hidden></ul>
 *   </div>
 *
 * Search keeps whole branches: an option that matches stays visible with everything
 * under it (closed, but there to open), and with the options above it (opened, so the
 * match can be seen in place). Typing "Nile" shows the Nile basin with all of its
 * sub-basins, and the "White Nile" ones opened up to.
 *
 * Keys: ↓/↑ move, → opens (or goes to the first child), ← closes (or goes to the
 * parent), Enter picks, Escape closes the dropdown.
 *
 * The clear button goes up a level: from an option inside a branch to the top-level
 * option it's in (a country to its region, a sub-basin to its major basin), and from a
 * top-level option to none.
 */
export interface TreeOption<D = unknown> {
  /** Unique across the tree. */
  key: string;
  label: string;
  /** Shown faintly after the label, and matched too (e.g. a code) by numbers of HINT_DIGITS or more. */
  hint?: string;
  parent: TreeOption<D> | null;
  children: TreeOption<D>[];
  data: D;
}

export interface TreeCombobox {
  /** Show an option as chosen (or none), without calling onSelect. */
  setValue(key: string | null): void;
}

// With more matches than this, opening every branch they are in would list most of
// the tree; the branches stay closed instead.
const MAX_OPENED_MATCHES = 300;
// A number typed matches the hints (codes) only from this many digits on.
const HINT_DIGITS = 3;
// Deeper options are indented no further (river trees go 38 levels deep).
const MAX_INDENT = 12;

export function initTreeCombobox<D>(
  root: HTMLElement,
  roots: TreeOption<D>[],
  onSelect: (option: TreeOption<D> | null) => void,
): TreeCombobox {
  const input = root.querySelector<HTMLInputElement>("input")!;
  const clear = root.querySelector<HTMLButtonElement>(".combobox-clear")!;
  const list = root.querySelector<HTMLUListElement>(".combobox-list")!;

  const all: TreeOption<D>[] = [];
  (function collect(nodes: TreeOption<D>[]) {
    for (const node of nodes) {
      all.push(node);
      collect(node.children);
    }
  })(roots);
  const byKey = new Map(all.map((o) => [o.key, o]));
  const labelText = new Map(all.map((o) => [o, normalize(o.label)]));
  const hintText = new Map(all.map((o) => [o, normalize(o.hint ?? "")]));
  /** A term matches the name, or (a number of HINT_DIGITS or more: not the "2" of "Blue Nile 2") the hint. */
  const matches = (o: TreeOption<D>, t: string) =>
    labelText.get(o)!.includes(t) || (t.length >= HINT_DIGITS && /^\d+$/.test(t) && hintText.get(o)!.includes(t));

  let value: TreeOption<D> | null = null;
  let terms: string[] = [];
  let matched = new Set<TreeOption<D>>();
  let kept: Set<TreeOption<D>> | null = null; // null: everything
  let opened = new Set<TreeOption<D>>();
  let rows: { option: TreeOption<D>; level: number }[] = [];
  let active: TreeOption<D> | null = null;

  function open(query: string) {
    terms = normalize(query).split(/\s+/).filter(Boolean);
    opened = new Set();
    if (terms.length === 0) {
      matched = new Set();
      kept = null;
      // Open up to the current value, so it shows in place.
      for (let p = value?.parent; p; p = p.parent) opened.add(p);
      active = value;
    } else {
      matched = new Set(all.filter((o) => terms.every((t) => matches(o, t))));
      kept = new Set();
      for (const option of matched) {
        keepBranch(option, kept);
        for (let p = option.parent; p && !kept.has(p); p = p.parent) kept.add(p);
      }
      if (matched.size <= MAX_OPENED_MATCHES) {
        for (const option of matched) for (let p = option.parent; p && !opened.has(p); p = p.parent) opened.add(p);
      }
      active = null;
    }
    render();
    if (!active && terms.length) active = rows.find((r) => matched.has(r.option))?.option ?? null;
    // (Shown first: a hidden list can't be scrolled.)
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    list.scrollTop = 0;
    setActive(active);
    // The current value in the middle of the list, as it opens.
    if (!terms.length) centre(active);
  }

  /** Scroll the list (only: not the page around it) to have an option's row in its middle. */
  function centre(option: TreeOption<D> | null) {
    const li = document.getElementById(`${list.id}-${rows.findIndex((r) => r.option === option)}`);
    if (!li) return;
    const offset = li.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollTop += offset - (list.clientHeight - li.offsetHeight) / 2;
  }

  function keepBranch(option: TreeOption<D>, into: Set<TreeOption<D>>) {
    if (into.has(option)) return;
    into.add(option);
    for (const child of option.children) keepBranch(child, into);
  }

  /** The visible rows: what's kept, inside opened branches. */
  function render() {
    rows = [];
    const walk = (nodes: TreeOption<D>[], level: number) => {
      for (const option of nodes) {
        if (kept && !kept.has(option)) continue;
        rows.push({ option, level });
        if (opened.has(option)) walk(option.children, level + 1);
      }
    };
    walk(terms.length ? rankTop(roots) : roots, 1);

    list.innerHTML = "";
    if (rows.length === 0) {
      const empty = document.createElement("li");
      empty.className = "combobox-empty";
      empty.textContent = "No matches";
      list.append(empty);
    }
    rows.forEach(({ option, level }, i) => {
      const li = document.createElement("li");
      li.id = `${list.id}-${i}`;
      li.role = "treeitem";
      li.dataset.index = String(i);
      li.style.setProperty("--indent", String(Math.min(level, MAX_INDENT) - 1));
      li.setAttribute("aria-level", String(level));
      li.setAttribute("aria-selected", String(option === value));
      if (option.children.length) li.setAttribute("aria-expanded", String(opened.has(option)));
      if (level > MAX_INDENT) li.title = pathOf(option);

      const toggle = document.createElement("span");
      toggle.className = "tree-toggle";
      toggle.ariaHidden = "true";
      if (option.children.length) toggle.textContent = "▸";
      const label = document.createElement("span");
      label.className = "tree-label";
      label.append(marked(option.label, matched.has(option) ? terms : []));
      li.append(toggle, label);
      if (option.hint) {
        const hint = document.createElement("small");
        hint.textContent = option.hint;
        li.append(hint);
      }
      list.append(li);
    });
  }

  /**
   * Top-level options whose own name starts with the search first, then those holding
   * one that does ("India" in Southern Asia before Bassas da India), then other matches.
   */
  function rankTop(nodes: TreeOption<D>[]) {
    const starts = (o: TreeOption<D>) => normalize(o.label).startsWith(terms[0]);
    const holding = new Set<TreeOption<D>>();
    for (const o of matched) {
      if (!o.parent || !starts(o)) continue;
      let top = o;
      while (top.parent) top = top.parent;
      holding.add(top);
    }
    const rank = (o: TreeOption<D>) => (starts(o) ? 0 : holding.has(o) ? 1 : matched.has(o) ? 2 : 3);
    return [...nodes].sort((a, b) => rank(a) - rank(b));
  }

  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = null;
  }

  function setActive(option: TreeOption<D> | null) {
    list.querySelector(".active")?.classList.remove("active");
    active = option;
    const i = rows.findIndex((r) => r.option === option);
    const li = i >= 0 ? document.getElementById(`${list.id}-${i}`) : null;
    if (li) {
      li.classList.add("active");
      li.scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", li.id);
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function setOpened(option: TreeOption<D>, open: boolean) {
    if (!option.children.length || opened.has(option) === open) return;
    if (open) opened.add(option);
    else opened.delete(option);
    const scroll = list.scrollTop;
    render();
    list.scrollTop = scroll;
    setActive(option);
  }

  function show(option: TreeOption<D> | null) {
    value = option;
    input.value = option?.label ?? "";
    clear.hidden = !option;
  }

  function pick(option: TreeOption<D> | null) {
    show(option);
    close();
    onSelect(option);
  }

  input.addEventListener("focus", () => {
    input.select();
    open("");
  });
  input.addEventListener("input", () => open(input.value));
  input.addEventListener("blur", () => {
    close();
    show(value); // undo half-typed text
  });
  input.addEventListener("keydown", (e) => {
    const i = rows.findIndex((r) => r.option === active);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) return open(input.value);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive(rows[Math.min(rows.length - 1, Math.max(0, i + step))]?.option ?? null);
    } else if (e.key === "ArrowRight" && !list.hidden && active) {
      e.preventDefault();
      if (active.children.length && !opened.has(active)) setOpened(active, true);
      else if (opened.has(active)) setActive(rows[i + 1]?.option ?? active);
    } else if (e.key === "ArrowLeft" && !list.hidden && active) {
      e.preventDefault();
      if (opened.has(active)) setOpened(active, false);
      else if (active.parent) setActive(active.parent);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!list.hidden && active) pick(active);
    } else if (e.key === "Escape" && !list.hidden) {
      e.preventDefault();
      close();
      show(value);
      input.select();
    }
  });

  // pointerdown, not click: picking must happen before the input loses focus.
  list.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const target = e.target as HTMLElement;
    const li = target.closest<HTMLElement>("[role=treeitem]");
    if (!li) return;
    const option = rows[Number(li.dataset.index)].option;
    if (target.closest(".tree-toggle") && option.children.length) setOpened(option, !opened.has(option));
    else pick(option);
  });
  list.addEventListener("pointermove", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("[role=treeitem]");
    const option = li && rows[Number(li.dataset.index)].option;
    if (option && option !== active) setActive(option);
  });
  clear.addEventListener("click", () => pick(value ? topOf(value) : null));

  show(null);
  return { setValue: (key) => show(key === null ? null : (byKey.get(key) ?? null)) };
}

/** The top-level option an option is in (null: it is one). */
function topOf<D>(option: TreeOption<D>): TreeOption<D> | null {
  let top = option;
  while (top.parent) top = top.parent;
  return top === option ? null : top;
}

/** "Nile › White Nile 1 › Bahr el Ghazal", for a tooltip. */
function pathOf(option: TreeOption<unknown>) {
  const names: string[] = [];
  for (let o: TreeOption<unknown> | null = option; o; o = o.parent) names.unshift(o.label);
  return names.join(" › ");
}

/** The label with the searched-for parts in <mark>. */
function marked(label: string, terms: string[]) {
  const fragment = document.createDocumentFragment();
  const text = normalize(label);
  // normalize() keeps one character per character for nearly all names; if not,
  // the positions wouldn't line up, so skip the marking.
  if (!terms.length || text.length !== label.length) {
    fragment.append(label);
    return fragment;
  }
  const hit = new Array<boolean>(label.length).fill(false);
  for (const term of terms) {
    for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + 1)) hit.fill(true, at, at + term.length);
  }
  let start = 0;
  for (let i = 1; i <= label.length; i++) {
    if (i === label.length || hit[i] !== hit[start]) {
      const part = label.slice(start, i);
      if (hit[start]) {
        const mark = document.createElement("mark");
        mark.textContent = part;
        fragment.append(mark);
      } else {
        fragment.append(part);
      }
      start = i;
    }
  }
  return fragment;
}

/** Lower case without accents, so "cote" finds "Côte d'Ivoire". */
function normalize(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
