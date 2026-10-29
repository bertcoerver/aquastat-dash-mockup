/*
 * The Local panel's dam cards: all of AQUASTAT's dams (with coordinates), and the one
 * picked (a click on it on the map, or its name in the title) among them.
 *
 * - "Dams": how many there are, and the picked dam's fields as a list.
 * - A card per attribute of the Dams map (vector-maps.ts, in the legend's order), each
 *   driving the map with its attribute (data-pin "dams:<attribute>", local-panel.ts):
 *   - an amount or value (capacity, area, height, year): how many dams have each value,
 *     as a strip of bars (on a log scale for the amounts, which span orders of
 *     magnitude), the median dashed, the picked dam's value marked, with how many
 *     dams it is above;
 *   - classes (purpose, location checked): the share of dams in each, in the map's
 *     colours, the picked dam's class in full.
 *
 * Hover a strip's bar to read it. Plain HTML and SVG: the cards are made once, their
 * contents drawn again on every change (their classes, set by the panel, stay); the
 * strips are laid out in % of the card's width, so they need no measuring.
 */
import { fmt } from "../basin/variables";
import { DAMS, PURPOSES, type Dams, type VectorAttribute } from "./vector-maps";
import { fmtNumber } from "../lib/format";
import { esc } from "../lib/html";

export interface DamCards {
  setData(dams: Dams): void;
  setSelected(index: number | null): void;
}

type Attribute = VectorAttribute<Dams>;
type Strip = ReturnType<typeof stripOf>;

/** The picked dam's value against the others: "higher than 91%". */
const MORE: Record<string, string> = { height: "higher", capacity: "larger", area: "larger", year: "newer" };
const BINS = 32;
const H = 30; // px, a strip's height

const count = (n: number) => fmtNumber(n);
const pct = (share: number) => `${Math.round(share * 100)}%`;

/** A strip's dams, sorted, and its bins (over the middle 99% of the values: the rest go in the end bins). */
function stripOf(a: Attribute & { kind: "amount" | "value" }, d: Dams) {
  const log = a.kind === "amount";
  const values: number[] = [];
  for (let i = 0; i < d.count; i++) {
    const v = a.value(d, i);
    if (v !== null && (!log || v > 0)) values.push(v);
  }
  values.sort((x, y) => x - y);
  const t = (v: number) => (log ? Math.log10(v) : v);
  const at = (q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
  const [lo, hi] = [t(at(0.005)), t(at(0.995))];
  const span = hi - lo || 1;
  const binOf = (v: number) => Math.max(0, Math.min(BINS - 1, Math.floor(((t(v) - lo) / span) * BINS)));
  const counts = new Array<number>(BINS).fill(0);
  for (const v of values) counts[binOf(v)]++;
  /** Where a value is along the strip (0–1). */
  const x = (v: number) => Math.max(0, Math.min(1, (t(v) - lo) / span));
  /** A bin's values, from–to. */
  const range = (b: number) => [lo + (span * b) / BINS, lo + (span * (b + 1)) / BINS].map((u) => (log ? 10 ** u : u));
  /** The share of the dams below a value. */
  const below = (v: number) => {
    let [p, q] = [0, values.length];
    while (p < q) {
      const m = (p + q) >> 1;
      if (values[m] < v) p = m + 1;
      else q = m;
    }
    return p / values.length;
  };
  // Ticks: powers of ten (log), else every 20 years.
  const ticks: number[] = [];
  if (log) for (let p = Math.ceil(lo); p <= Math.floor(hi); p++) ticks.push(10 ** p);
  else for (let y = Math.ceil(lo / 20) * 20; y <= hi; y += 20) ticks.push(y);
  return { log, values, counts, binOf, x, range, below, median: at(0.5), ticks };
}

/** Make the cards in `container` (filled in once the dams are loaded). */
export function initDamCards(container: HTMLElement, tooltip: HTMLElement): DamCards {
  const card = (pin: string, title: string) => {
    const section = document.createElement("section");
    section.className = "wb-section lp-section cp-card";
    section.dataset.pin = pin;
    section.tabIndex = 0;
    section.setAttribute("aria-label", title);
    section.innerHTML =
      `<h3><span>${esc(title)}</span><span class="cp-card-actions"><button class="cp-unpin" data-unpin type="button" ` +
      `title="Remove pin" aria-label="Remove pin">×</button></span></h3><div class="dc-body"></div>`;
    container.append(section);
    return section.querySelector<HTMLElement>(".dc-body")!;
  };
  const overview = card("dams", "Dams");
  const attributes = DAMS.attributes.map((a) => ({ a, body: card(`dams:${a.id}`, a.label) }));

  let dams: Dams | null = null;
  let strips = new Map<string, Strip>();
  let selected: number | null = null;

  function draw() {
    if (!dams) {
      overview.innerHTML = `<p class="dc-intro">Loading the dams…</p>`;
      return;
    }
    const d = dams;
    const i = selected;
    const name = i === null ? "" : esc(DAMS.name(d, i));
    overview.innerHTML = overviewHtml(d, i, name);
    for (const { a, body } of attributes) body.innerHTML = a.kind === "classes" ? classesHtml(a, d, i, name) : stripHtml(a, strips.get(a.id)!, d, i, name);
  }

  function overviewHtml(d: Dams, i: number | null, name: string) {
    if (i === null) {
      return (
        `<p class="dc-intro">All ${count(d.count)} dams in AQUASTAT with coordinates. Click a dam on the map, or search for one ` +
        "in the title, to see it among them. Hover a card to see its attribute on the map; click to pin it.</p>"
      );
    }
    const own = PURPOSES.filter((_, b) => d.purposes[i] & (1 << b));
    const river = [d.river[i], d.basin[i] && d.basin[i] !== d.river[i] ? `(${d.basin[i]})` : ""].filter(Boolean).join(" ");
    const facts: [string, string][] = [
      ["Country", d.country[i] || "–"],
      ["River", river || "–"],
      ["Purposes", own.join(", ") || "none given"],
      ["Coordinates", `${d.lat[i].toFixed(4)}, ${d.lon[i].toFixed(4)}`],
    ];
    return (
      `<p class="dc-intro"><b>${name}</b>, among all ${count(d.count)} dams in AQUASTAT with coordinates in the cards below.</p>` +
      `<dl class="dc-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`
    );
  }

  function stripHtml(a: Attribute & { kind: "amount" | "value" }, st: Strip, d: Dams, i: number | null, name: string) {
    const unit = a.unit ? ` ${a.unit}` : "";
    const show = (v: number) => (st.log ? fmt(v) : String(Math.round(v)));
    const v = i === null ? null : a.value(d, i);
    const has = v !== null && (!st.log || v > 0);
    const own = i === null ? "" : has ? `${name}: ${show(v)}${unit}, ${MORE[a.id] ?? "more"} than ${pct(st.below(v))}` : `${name}: not given`;
    const max = Math.max(...st.counts);
    const w = 100 / BINS;
    const ownBin = has ? st.binOf(v) : -1;
    const bars = st.counts
      .map((n, b) => {
        const h = n ? Math.max(1.5, (n / max) * (H - 2)) : 0;
        const [from, to] = st.range(b);
        const tip = `${show(from)}–${show(to)}${unit}: ${count(n)} dam${n === 1 ? "" : "s"}`;
        return (
          `<rect class="dc-bar${b === ownBin ? " dc-bar-own" : ""}" x="${b * w + 0.15}" y="${H - h}" width="${w - 0.3}" height="${h}"/>` +
          `<rect class="dc-hit" x="${b * w}" y="0" width="${w}" height="${H}" data-tip="${esc(tip)}"/>`
        );
      })
      .join("");
    const mx = st.x(st.median) * 100;
    const marker = has ? `<line class="dc-mark" x1="${st.x(v) * 100}" x2="${st.x(v) * 100}" y1="0" y2="${H}"/>` : "";
    // (Powers of ten as they are, 0.1, 10, 1,000; years as years.)
    const ticks = st.ticks.map((t) => `<span style="left:${st.x(t) * 100}%">${st.log ? fmtNumber(t) : t}</span>`).join("");
    return (
      `<div class="dc-head"><span><i class="dc-dash"></i>median ${show(st.median)}${unit}</span><span>${count(st.values.length)} of ${count(d.count)} dams</span></div>` +
      (own ? `<div class="dc-head dc-own">${own}</div>` : "") +
      `<svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" height="${H}" role="img" aria-label="${esc(`${a.label} of ${count(st.values.length)} dams, median ${show(st.median)}${unit}`)}">` +
      `${bars}<line class="dc-median" x1="${mx}" x2="${mx}" y1="0" y2="${H}"/>${marker}</svg>` +
      `<div class="dc-ticks">${ticks}</div>${noteHtml(a)}`
    );
  }

  function classesHtml(a: Attribute & { kind: "classes" }, d: Dams, i: number | null, name: string) {
    const counts = a.classes.map(() => 0);
    for (let k = 0; k < d.count; k++) counts[a.classOf(d, k)]++;
    const own = i === null ? -1 : a.classOf(d, i);
    const rows = a.classes
      .map((c, k) => {
        const share = counts[k] / d.count;
        return (
          `<span class="dc-class${k === own ? " dc-class-own" : ""}"><i style="background:${c.color}"></i>${esc(c.label)}</span>` +
          `<span class="dc-share"><i style="width:${share * 100}%;background:${c.color}"></i></span>` +
          `<span class="dc-pct" title="${count(counts[k])} dams">${pct(share)}</span>`
        );
      })
      .join("");
    const ownLine = own >= 0 ? `<div class="dc-head dc-own">${name}: ${esc(a.classes[own].label.toLowerCase())}</div>` : "";
    return `${ownLine}<div class="dc-classes${own >= 0 ? " has-own" : ""}">${rows}</div>${noteHtml(a)}`;
  }

  const noteHtml = (a: Attribute) => (a.note ? `<p class="dc-note">${esc(a.note)}.</p>` : "");

  // A bar's tooltip, right of the pointer (left, where there's no room).
  container.addEventListener("pointermove", (e) => {
    const tip = (e.target as Element).closest<SVGElement>("[data-tip]")?.dataset.tip;
    if (!tip) return void (tooltip.hidden = true);
    // (Plain: not the map's tooltip, which the same element shows, panels/map-tip.ts.)
    tooltip.classList.remove("map-tip");
    tooltip.textContent = tip;
    tooltip.hidden = false;
    const w = tooltip.offsetWidth;
    tooltip.style.left = `${e.clientX + 14 + w < window.innerWidth - 8 ? e.clientX + 14 : Math.max(8, e.clientX - w - 14)}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
  });
  container.addEventListener("pointerleave", () => (tooltip.hidden = true));

  draw();
  return {
    setData(next) {
      if (dams) return;
      dams = next;
      strips = new Map(DAMS.attributes.flatMap((a) => (a.kind === "classes" ? [] : [[a.id, stripOf(a, next)] as const])));
      draw();
    },
    setSelected(index) {
      if (index === selected) return;
      selected = index;
      draw();
    },
  };
}
