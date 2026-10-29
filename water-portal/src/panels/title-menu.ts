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
 *
 * Or a checklist (`multi`): several options are chosen at once, a pick checks or unchecks
 * one, and the list stays open (built again, as a pick can uncheck others).
 *
 * An option can have a row of icons to its right, one of them picked (how a map is
 * drawn, say): a click on one, or ←/→ on the option, picks another (onIcon).
 *
 * Options can be in groups: a heading goes before each group (its options together).
 * Or in a tree: each option indented by its level (a parent, still an option, above its own).
 */

export interface MenuOption {
  id: string;
  label: string;
  /** A note to the right, e.g. how the option is drawn. */
  hint?: string;
  /** Its group's name, a heading above the group. */
  group?: string;
  /** How deep it is in a tree (0: the top), for its indent. */
  level?: number;
  /** Icons to the right (`html`: an <svg>), and the id of the one picked. */
  icons?: { id: string; html: string; label: string; title: string }[];
  icon?: string;
}

export interface TitleMenu {
  /** Show the title. */
  setLabel(label: string): void;
}

/**
 * `options` is asked for each time the menu opens; `current` is the chosen option's id
 * (a checklist's: the checked ones').
 */
export function initTitleMenu(
  button: HTMLButtonElement,
  options: () => { options: MenuOption[]; current: string | string[] | null },
  onPick: (id: string) => void,
  { multi = false, onIcon }: { multi?: boolean; onIcon?: (id: string, icon: string) => void } = {},
): TitleMenu {
  const label = button.querySelector<HTMLElement>(".title-menu-label")!;
  const list = document.createElement("ul");
  list.className = "combobox-list title-menu-list";
  list.role = "listbox";
  list.id = `${button.id}-list`;
  list.tabIndex = -1;
  list.hidden = true;
  list.setAttribute("aria-label", button.getAttribute("aria-label") ?? "");
  if (multi) list.setAttribute("aria-multiselectable", "true");
  document.body.append(list);
  button.setAttribute("aria-controls", list.id);

  let shown: MenuOption[] = [];
  let chosen = new Set<string>();
  let active = -1;

  /** Fill the list; returns the first chosen option's index (-1: none). */
  function build() {
    const { options: all, current } = options();
    chosen = new Set(Array.isArray(current) ? current : current === null ? [] : [current]);
    shown = all;
    list.replaceChildren(
      ...all.flatMap((o, i) => {
        const li = document.createElement("li");
        li.id = `${list.id}-${i}`;
        li.role = "option";
        li.dataset.index = String(i);
        li.setAttribute("aria-selected", String(chosen.has(o.id)));
        if (o.level) li.style.setProperty("--level", String(o.level));
        const text = document.createElement("span");
        text.textContent = o.label;
        li.append(text);
        if (o.hint) {
          const hint = document.createElement("small");
          hint.textContent = o.hint;
          li.append(hint);
        }
        if (o.icons?.length) {
          const icons = document.createElement("span");
          icons.className = "title-menu-icons";
          icons.innerHTML = o.icons
            .map((c) => `<span data-icon="${c.id}" title="${c.label}: ${c.title[0].toLowerCase()}${c.title.slice(1)}"${c.id === o.icon ? ' class="picked"' : ""}>${c.html}</span>`)
            .join("");
          li.append(icons);
          const picked = o.icons.find((c) => c.id === o.icon);
          if (picked) li.setAttribute("aria-label", `${o.label}, as ${picked.label.toLowerCase()}`);
        }
        if (!o.group || o.group === all[i - 1]?.group) return [li];
        const heading = document.createElement("li");
        heading.className = "title-menu-group";
        heading.role = "presentation";
        heading.textContent = o.group;
        return [heading, li];
      }),
    );
    return all.findIndex((o) => chosen.has(o.id));
  }

  function open() {
    const first = build();
    list.hidden = false;
    place();
    button.setAttribute("aria-expanded", "true");
    setActive(Math.max(0, first));
    list.focus();
    // (Only while open: there are dozens of these menus, one per legend section.)
    document.addEventListener("pointerdown", onPressElsewhere);
    window.addEventListener("resize", onResize);
  }
  // A press anywhere else closes it (on the title, its click does).
  const onPressElsewhere = (e: PointerEvent) => {
    const target = e.target as Node;
    if (!list.contains(target) && !button.contains(target)) close(false);
  };
  const onResize = () => close(false);

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
    document.removeEventListener("pointerdown", onPressElsewhere);
    window.removeEventListener("resize", onResize);
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

  /** Pick option `i`'s icon `icon` (on an option not chosen, the one it's offered in too: it's chosen so). */
  function pickIcon(i: number, icon: string | undefined) {
    const option = shown[i];
    if (!option || !icon || (icon === option.icon && chosen.has(option.id))) return;
    onIcon?.(option.id, icon);
    build();
    setActive(i);
  }

  function pick(i: number) {
    const option = shown[i];
    if (multi) {
      if (!option) return;
      onPick(option.id);
      build();
      return setActive(i);
    }
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
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && shown[active]?.icons) {
      e.preventDefault();
      const icons = shown[active].icons!;
      const at = icons.findIndex((c) => c.id === shown[active].icon) + (e.key === "ArrowRight" ? 1 : -1);
      pickIcon(active, icons[Math.min(icons.length - 1, Math.max(0, at))]?.id);
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
    const icon = (e.target as HTMLElement).closest<HTMLElement>("[data-icon]");
    if (li && icon) pickIcon(Number(li.dataset.index), icon.dataset.icon);
    else if (li) pick(Number(li.dataset.index));
  });
  list.addEventListener("pointermove", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("[role=option]");
    if (li && Number(li.dataset.index) !== active) setActive(Number(li.dataset.index));
  });
  list.addEventListener("focusout", (e) => {
    if (e.relatedTarget !== button) close(false);
  });

  return {
    setLabel(text) {
      label.textContent = text;
    },
  };
}
