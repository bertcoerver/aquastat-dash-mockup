/*
 * A text field with a dropdown list that narrows as you type (an ARIA combobox).
 * Expects this markup (see index.html):
 *
 *   <div class="combobox">
 *     <input role="combobox" aria-controls="LIST_ID" …>
 *     <button class="combobox-clear" …>×</button>
 *     <ul class="combobox-list" id="LIST_ID" role="listbox" hidden></ul>
 *   </div>
 *
 * Keys: ↓/↑ move through the list, Enter picks, Escape closes.
 */

export interface ComboboxOption {
  id: number;
  label: string;
  /** Shown faintly after the label, and matched too (e.g. a code). */
  hint?: string;
}

export interface Combobox {
  /** Show an option as chosen (or none), without calling onSelect. */
  setValue(id: number | null): void;
}

export function initCombobox(
  root: HTMLElement,
  options: ComboboxOption[],
  onSelect: (option: ComboboxOption | null) => void,
): Combobox {
  const input = root.querySelector<HTMLInputElement>("input")!;
  const clear = root.querySelector<HTMLButtonElement>(".combobox-clear")!;
  const list = root.querySelector<HTMLUListElement>(".combobox-list")!;
  const byId = new Map(options.map((o) => [o.id, o]));
  const searchText = new Map(options.map((o) => [o.id, normalize(`${o.label} ${o.hint ?? ""}`)]));

  let value: ComboboxOption | null = null;
  let shown: ComboboxOption[] = [];
  let active = -1;

  function open(query: string) {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    const matches = options.filter((o) => terms.every((t) => searchText.get(o.id)!.includes(t)));
    // Names that start with what was typed come first.
    const first = terms[0];
    shown = first ? [...matches].sort((a, b) => +!normalize(a.label).startsWith(first) - +!normalize(b.label).startsWith(first)) : matches;

    list.innerHTML = "";
    if (shown.length === 0) {
      const empty = document.createElement("li");
      empty.className = "combobox-empty";
      empty.textContent = "No matches";
      list.append(empty);
    }
    shown.forEach((o, i) => {
      const li = document.createElement("li");
      li.id = `${list.id}-${i}`;
      li.role = "option";
      li.dataset.index = String(i);
      li.setAttribute("aria-selected", String(o.id === value?.id));
      li.append(o.label);
      if (o.hint) {
        const hint = document.createElement("small");
        hint.textContent = o.hint;
        li.append(hint);
      }
      list.append(li);
    });
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    setActive(shown.findIndex((o) => o.id === value?.id));
  }

  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }

  function setActive(i: number) {
    list.querySelector(".active")?.classList.remove("active");
    active = i;
    const li = i >= 0 ? document.getElementById(`${list.id}-${i}`) : null;
    if (li) {
      li.classList.add("active");
      li.scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", li.id);
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function show(option: ComboboxOption | null) {
    value = option;
    input.value = option?.label ?? "";
    clear.hidden = !option;
  }

  function pick(option: ComboboxOption | null) {
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
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) return open(input.value);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive(Math.min(shown.length - 1, Math.max(0, active + step)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = shown[active] ?? (shown.length === 1 ? shown[0] : undefined);
      if (!list.hidden && option) pick(option);
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
    const li = (e.target as HTMLElement).closest<HTMLElement>("[role=option]");
    if (li) pick(shown[Number(li.dataset.index)]);
  });
  list.addEventListener("pointermove", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("[role=option]");
    if (li && Number(li.dataset.index) !== active) setActive(Number(li.dataset.index));
  });
  clear.addEventListener("click", () => pick(null));

  show(null);
  return { setValue: (id) => show(id === null ? null : (byId.get(id) ?? null)) };
}

/** Lower case without accents, so "cote" finds "Côte d'Ivoire". */
export function normalize(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}
