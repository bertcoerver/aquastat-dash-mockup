/*
 * The core of a statistics panel (the Country and Basin panels): the tiles and cards
 * that drive the map (map-drivers.ts), the pin, the legend's checklist of all the maps
 * and which are checked, and from those the maps on the map: those checked (else the
 * first tile's), with the previewed or pinned chart's in their slots. Pins and picks
 * are kept per scope (a topic, a basin), so they're there on coming back. What a map
 * is, and how each is drawn, is the panel's.
 *
 * Ids: a tile's or card's is its own; a map it brings along has "<driver>~<index>".
 * The checklist lists each map once, by its title (charts share maps): see optionId.
 */
import { initDrivers, markDrivers, type Driver, type Drivers } from "./map-drivers";
import { onePerSlot, toggled } from "./legend";
import { freeShape, type MapShapes } from "./shape-switch";
import { iconSvg } from "./shape-icons";
import type { MenuOption } from "./title-menu";

/** A map on the map: its tile or card, how it's drawn (the legend's slot) and which of its ways that is. */
export interface PanelLayer<Spec> {
  d: Driver;
  spec: Spec;
  slot: string;
  mode: string;
}

/** A map in the checklist. */
export interface MapOption<Spec> {
  id: string;
  spec: Spec;
  group?: string;
}

interface Options<Ctx, Spec extends { id: string; title: string }> {
  /** The panel's element: the drivers in it are marked as previewed, pinned, shown. */
  root: HTMLElement;
  /** The legend's slots, in its order. */
  slots: string[];
  /** Where pins and picks are kept: the topic, or the basin. */
  scope(): string;
  /** Whether the panel is on screen. */
  enabled(): boolean;
  /** What is drawn: the context and the maps on the map (null: nothing yet). */
  current(): { ctx: Ctx; layers: PanelLayer<Spec>[] } | null;
  /** All the maps, each once, in the checklist's order. */
  menuMaps(ctx: Ctx): MapOption<Spec>[];
  /** Whether an id is one of this panel's tiles or cards (or a map one brings along). */
  known(id: string): boolean;
  /** The map shown with nothing checked, previewed or pinned: the first tile's. */
  firstId(): string;
  /** A driver's map, drawn as the legend has it. */
  layerOf(ctx: Ctx, d: Driver): PanelLayer<Spec>;
  /** A driver's map and those it brings along, each in a slot of its own. */
  leadLayers(ctx: Ctx, lead: Driver): PanelLayer<Spec>[];
  /** How a map can be drawn, and is. */
  shapesOf(spec: Spec, ctx: Ctx): MapShapes;
  /** Whether the checklist lists a map (default: every one). */
  listed?(ctx: Ctx, option: MapOption<Spec>, on: string[]): boolean;
  /** A chart pinned, or unpinned: fly to its area, say. */
  onPin?(d: Driver | null): void;
  /** The pin or the picks changed (for the URL). */
  onPicks?(): void;
  /** The maps on the map changed: draw them again (the drivers are marked here). */
  onChange(): void;
  onX?(x: number, d: Driver | null): void;
  onCsv?(id: string): void;
  tooltip: HTMLElement;
}

export interface PanelCore<Ctx, Spec> {
  drivers: Drivers;
  /** The pinned tile or card of the scope (null: none). */
  pinned(): Driver | null;
  /** Forget a scope's pin and what was unchecked of it (another basin's chart isn't this one's). */
  forgetPin(scope?: string): void;
  /** The ids checked in the legend, oldest first (undefined: nothing picked yet: the first tile's). */
  chosen(): string[] | undefined;
  setChosen(ids: string[]): void;
  /** A map's tile or card, and which of the maps it brings along it is (null: its own). */
  parseId(id: string): { base: string; also: number | null };
  /** The checklist's option for a map (by its title, as charts share maps). */
  optionId(ctx: Ctx, spec: Spec): string;
  /** The previewed or pinned tile or card. */
  leadDriver(): Driver | null;
  /** The tile or card the map follows: previewed, pinned, or the first map on it. */
  activeDriver(): Driver | null;
  /** The maps on the map: those checked (else the first tile's), with the previewed or pinned chart's in their slots. */
  shownLayers(ctx: Ctx): PanelLayer<Spec>[];
  /** Check or uncheck a map. */
  toggle(id: string): void;
  /** The checklist for the legend: each map with the icons of its ways, as drawn or as it would be. */
  checklist(): { options: MenuOption[]; current: string[] };
  /** The checklist clicked: checked, a map is drawn as it was offered. */
  check(id: string): void;
  /**
   * A map switched shape: it goes last among those checked, so it takes its new slot
   * from the map there, and the checked maps it covered stay off (not shown again in the
   * slot it left).
   */
  switched(match: (spec: Spec) => boolean): void;
  /** Mark the drivers in the panel: the one the map follows, the previewed and the pinned. */
  markAll(): void;
  /** The scope's pin and picks, for the URL (`maps`: undefined when nothing was picked). */
  snapshot(): PanelPicks;
  /** The scope's pin and picks from the URL (not drawn: the panel draws next). */
  restore(picks: PanelPicks): void;
}

/** A pinned chart (its tile or card, and the row or series) and the maps checked, as the URL keeps them. */
export interface PanelPicks {
  pin: Driver | null;
  maps: string[] | undefined;
}

export function initPanelCore<Ctx, Spec extends { id: string; title: string }>({
  root,
  slots,
  scope,
  enabled,
  current,
  menuMaps,
  known,
  firstId,
  layerOf,
  leadLayers,
  shapesOf,
  listed,
  onPin,
  onPicks,
  onChange,
  onX,
  onCsv,
  tooltip,
}: Options<Ctx, Spec>): PanelCore<Ctx, Spec> {
  const pins = new Map<string, Driver>();
  /** The pinned chart's maps unchecked in the legend since it was pinned (by title), per scope. */
  const dropped = new Map<string, Set<string>>();
  /** The maps checked in the legend, oldest first, per scope (none: the first tile's). */
  const chosen = new Map<string, string[]>();

  const pinned = () => pins.get(scope()) ?? null;
  const parseId = (id: string) => {
    const [base, k] = id.split("~");
    return { base, also: k === undefined ? null : Number(k) };
  };
  const optionId = (ctx: Ctx, spec: Spec) => menuMaps(ctx).find((m) => m.spec.title === spec.title)?.id ?? spec.id;

  const drivers = initDrivers(root, {
    enabled,
    pinned,
    setPinned(d) {
      if (d) pins.set(scope(), d);
      else pins.delete(scope());
      dropped.delete(scope());
      onPin?.(d);
      onPicks?.();
    },
    onChange() {
      onChange();
      markAll();
    },
    onX,
    onCsv,
    tooltip,
  });

  function leadDriver(): Driver | null {
    const d = drivers.preview() ?? pinned();
    return d && known(d.id) ? d : null;
  }

  function activeDriver(): Driver | null {
    const cur = current();
    const d = leadDriver() ?? (cur ? (shownLayers(cur.ctx)[0]?.d ?? null) : null);
    return d && { ...d, id: parseId(d.id).base };
  }

  function shownLayers(ctx: Ctx): PanelLayer<Spec>[] {
    const lead = leadDriver();
    const kept = chosen.get(scope());
    const picked = (kept ?? []).filter(known);
    // (The first tile's only alone: under a chart's map, it would show when that one changes
    // slot. None if all were unchecked.)
    const first = kept?.length === 0 || lead ? [] : [firstId()];
    const layers = (picked.length ? picked : first).map((id) => layerOf(ctx, { id, sub: null }));
    if (!lead) return onePerSlot(layers, slots);
    const set = leadLayers(ctx, lead);
    const titles = new Set(set.map((l) => l.spec.title));
    // (Less those unchecked since it was pinned, also as its rows are previewed.)
    const pin = pinned();
    const off = pin && parseId(pin.id).base === parseId(lead.id).base ? dropped.get(scope()) : undefined;
    const left = set.filter((l) => !off?.has(l.spec.title));
    return onePerSlot([...layers.filter((m) => !titles.has(m.spec.title)), ...left], slots);
  }

  function toggle(id: string) {
    const cur = current();
    if (!cur) return;
    const ctx = cur.ctx;
    const pin = pinned();
    const lead = pin && known(pin.id) ? leadLayers(ctx, pin) : [];
    const off = dropped.get(scope()) ?? new Set<string>();
    const own = lead.find((l) => optionId(ctx, l.spec) === id);
    if (own) {
      // One of the pinned chart's maps.
      if (!off.delete(own.spec.title)) off.add(own.spec.title);
    } else {
      const titles = new Set(lead.map((l) => l.spec.title));
      const ids = toggled(cur.layers.filter((l) => !titles.has(l.spec.title)).map((l) => optionId(ctx, l.spec)), id);
      chosen.set(scope(), ids);
      // Checked in a slot the pinned chart's maps use, it takes that slot.
      if (pin && ids.includes(id)) {
        const slot = layerOf(ctx, { id, sub: null }).slot;
        for (const l of lead) if (l.slot === slot) off.add(l.spec.title);
      }
    }
    if (pin) dropped.set(scope(), off);
    drivers.clearPreview();
    onChange();
    markAll();
    onPicks?.();
  }

  function checklist() {
    const cur = current();
    if (!cur) return { options: [], current: [] };
    const ctx = cur.ctx;
    const on = cur.layers.map((l) => optionId(ctx, l.spec));
    const taken = new Set(cur.layers.map((l) => l.slot));
    const options = menuMaps(ctx)
      .filter((option) => listed?.(ctx, option, on) ?? true)
      .map(({ id, spec, group }) => {
        const m = shapesOf(spec, ctx);
        const icons = m.options.map((o) => ({ id: o.id, html: iconSvg(o.icon), label: o.label, title: o.title }));
        // (On the map, as drawn: a chart can have it drawn its own way.)
        const drawn = cur.layers.find((l) => optionId(ctx, l.spec) === id)?.mode;
        return { id, label: spec.title, group, icons, icon: drawn ?? freeShape(m, taken) };
      });
    return { options, current: on };
  }

  function check(id: string) {
    const cur = current();
    if (!cur) return;
    const ctx = cur.ctx;
    const spec = menuMaps(ctx).find((m) => m.id === id)?.spec;
    if (spec && !cur.layers.some((l) => optionId(ctx, l.spec) === id)) {
      const m = shapesOf(spec, ctx);
      m.set(freeShape(m, new Set(cur.layers.map((l) => l.slot))));
    }
    toggle(id);
  }

  function switched(match: (spec: Spec) => boolean) {
    const cur = current();
    if (!cur) return;
    const shown = new Set(cur.layers.map((l) => l.spec.title));
    const specOf = (id: string) => layerOf(cur.ctx, { id, sub: null }).spec;
    const ids = (chosen.get(scope()) ?? []).filter((id) => shown.has(specOf(id).title));
    const moved = ids.find((id) => match(specOf(id)));
    chosen.set(scope(), moved ? [...ids.filter((id) => id !== moved), moved] : ids);
    onPicks?.();
  }

  function markAll() {
    markDrivers(root, activeDriver(), drivers.preview(), pinned());
  }

  return {
    drivers,
    pinned,
    forgetPin(at = scope()) {
      pins.delete(at);
      dropped.delete(at);
      onPicks?.();
    },
    chosen: () => chosen.get(scope()),
    setChosen(ids) {
      chosen.set(scope(), ids);
      onPicks?.();
    },
    snapshot: () => ({ pin: pinned(), maps: chosen.get(scope()) }),
    restore({ pin, maps }) {
      if (pin) pins.set(scope(), pin);
      else pins.delete(scope());
      dropped.delete(scope());
      if (maps) chosen.set(scope(), maps);
      else chosen.delete(scope());
    },
    parseId,
    optionId,
    leadDriver,
    activeDriver,
    shownLayers,
    toggle,
    checklist,
    check,
    switched,
    markAll,
  };
}
