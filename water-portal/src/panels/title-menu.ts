/*
 * A title that is also a menu: it reads as text with a small ▾, and a click lists the
 * alternatives (an ARIA listbox popup). Like the place pickers in the panel titles, but
 * without search, for a handful of options. Expects this markup (see index.html):
 *
 *   <button class="title-menu" aria-haspopup="listbox" aria-expanded="false">
 *     <span class="title-menu-label"></span><span class="title-caret"></span>
 *   </button>
 *
 * The list is put on <body>, so the box the title is in (scrolling, blurred) doesn't
 * clip it; it opens below the title, or above it in the lower half of the window.
 *
 * Keys: Enter, Space or ↓ open; ↓/↑ move; Enter picks; Escape or Tab closes.
 */

export interface MenuOption {
  id: string;
  label: string;
}

export interface TitleMenu {
  /** Show the title. */
  setLabel(label: string): void;
}

/** `options` is asked for each time the menu opens; `current` is the chosen option's id. */
export function initTitleMenu(
  button: HTMLButtonElement,
  options: () => { options: MenuOption[]; current: string | null },
  onPick: (id: string) => void,
): TitleMenu {
  const label = button.querySelector<HTMLElement>(".title-menu-label")!;
  const list = document.createElement("ul");
  list.className = "combobox-list title-menu-list";
  list.role = "listbox";
  list.id = `${button.id}-list`;
  list.tabIndex = -1;
  list.hidden = true;
  list.setAttribute("aria-label", button.getAttribute("aria-label") ?? "");
  document.body.append(list);
  button.setAttribute("aria-controls", list.id);

  let shown: MenuOption[] = [];
  let active = -1;

  function open() {
    const { options: all, current } = options();
    shown = all;
    list.replaceChildren(
      ...all.map((o, i) => {
        const li = document.createElement("li");
        li.id = `${list.id}-${i}`;
        li.role = "option";
        li.dataset.index = String(i);
        li.setAttribute("aria-selected", String(o.id === current));
        li.textContent = o.label;
        return li;
      }),
    );
    list.hidden = false;
    place();
    button.setAttribute("aria-expanded", "true");
    setActive(Math.max(0, all.findIndex((o) => o.id === current)));
    list.focus();
  }

  function place() {
    const r = button.getBoundingClientRect();
    const up = r.top > window.innerHeight / 2;
    Object.assign(list.style, {
      position: "fixed",
      left: `${Math.min(r.left, window.innerWidth - list.offsetWidth - 8)}px`,
      right: "auto",
      top: up ? "auto" : `${r.bottom + 4}px`,
      bottom: up ? `${window.innerHeight - r.top + 4}px` : "auto",
    });
  }

  function close(refocus: boolean) {
    if (list.hidden) return;
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    list.removeAttribute("aria-activedescendant");
    if (refocus) button.focus();
  }

  function setActive(i: number) {
    list.querySelector(".active")?.classList.remove("active");
    active = i;
    const li = document.getElementById(`${list.id}-${i}`);
    if (!li) return;
    li.classList.add("active");
    li.scrollIntoView({ block: "nearest" });
    list.setAttribute("aria-activedescendant", li.id);
  }

  function pick(i: number) {
    const option = shown[i];
    close(false);
    button.blur(); // back to reading as text
    if (option) onPick(option.id);
  }

  button.addEventListener("click", () => (list.hidden ? open() : close(true)));
  button.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && list.hidden) {
      e.preventDefault();
      open();
    }
  });
  list.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.min(shown.length - 1, Math.max(0, active + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // (Escape elsewhere unpins the map)
      close(true);
    } else if (e.key === "Tab") {
      close(true);
    }
  });
  // pointerdown, not click: before the list loses focus.
  list.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const li = (e.target as HTMLElement).closest<HTMLElement>("[role=option]");
    if (li) pick(Number(li.dataset.index));
  });
  list.addEventListener("pointermove", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("[role=option]");
    if (li && Number(li.dataset.index) !== active) setActive(Number(li.dataset.index));
  });
  // A press anywhere else closes it (on the title, its click does).
  document.addEventListener("pointerdown", (e) => {
    const target = e.target as Node;
    if (!list.contains(target) && !button.contains(target)) close(false);
  });
  list.addEventListener("focusout", (e) => {
    if (e.relatedTarget !== button) close(false);
  });
  window.addEventListener("resize", () => close(false));

  return {
    setLabel(text) {
      label.textContent = text;
    },
  };
}
