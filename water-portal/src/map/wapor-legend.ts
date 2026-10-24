/*
 * The legend for the WaPOR raster (Local view): period, colour ramp and whether the
 * raster is loading or not published yet, and a button for how much of the values in
 * view the colours span. For a dekad it also has the quality slider, which hides
 * pixels whose NDVI input is gap-filled over more dekads. The markup lives in
 * index.html.
 */
import type { WaporPeriod, WaporStretch } from "./layers/wapor";
import type { WaporRamp } from "./layers/wapor-shader";

export type WaporStatus = "checking" | "loading" | "ready" | "missing" | "error";
export type QualityStatus = "checking" | "ready" | "missing";

const STATUS_TEXT: Record<WaporStatus, string> = {
  checking: "Looking for the map…",
  loading: "Loading…",
  ready: "",
  missing: "Not published yet for this period.",
  error: "Couldn't reach WaPOR's storage.",
};

const QUALITY_TEXT: Record<Exclude<QualityStatus, "ready">, string> = {
  checking: "Looking for the quality layer…",
  missing: "Quality layer not published yet for this dekad.",
};

/**
 * Slider positions, from showing everything (0) to only pixels observed this dekad
 * (MAX_GAP + 1). In between, the longest gap shown goes down one dekad per step. WaPOR's
 * own legend for the layer stops at "more than 12 dekads".
 */
const MAX_GAP = 12;
const maxGapAt = (position: number) => (position === 0 ? null : MAX_GAP + 1 - position);

function describe(maxGap: number | null) {
  if (maxGap === null) return "All pixels shown";
  if (maxGap === 0) return "Observed this dekad only";
  return `Hiding gaps over ${maxGap} dekad${maxGap === 1 ? "" : "s"}`;
}

const $ = (id: string) => document.getElementById(id)!;

/** The stretch button's settings, in the order it goes through them. */
const STRETCHES: WaporStretch[] = [0, 1, 5];
const stretchLabel = (cut: WaporStretch) => `${cut}–${100 - cut}%`;

/** A legend stop, with as many decimals as the range needs. */
function fmtStop(v: number, span: number) {
  const decimals = span >= 10 ? 0 : span >= 1 ? 1 : span >= 0.1 ? 2 : 3;
  return v.toFixed(decimals);
}

export interface WaporLegend {
  /** Show the legend for a period (null hides it). */
  show(period: WaporPeriod | null, status?: WaporStatus): void;
  /** Show the colour map the raster is drawn with. */
  ramp(ramp: WaporRamp): void;
  /** The quality slider: shown for a dekad, disabled while there's no quality layer. */
  quality(status: QualityStatus | null): void;
}

/**
 * `onMaxGap` runs when the quality slider moves: the longest gap to show, or null.
 * `onStretch` runs when the stretch button is pressed, and once at the start.
 */
export function initWaporLegend({
  onMaxGap,
  onStretch,
}: {
  onMaxGap: (maxGap: number | null) => void;
  onStretch: (cut: WaporStretch) => void;
}): WaporLegend {
  const legend = $("wapor-legend");
  const section = $("wapor-quality");
  const input = $("wapor-quality-input") as HTMLInputElement;
  const value = $("wapor-quality-value");
  const status = $("wapor-quality-status");
  input.max = String(MAX_GAP + 1);

  function update() {
    const maxGap = maxGapAt(Number(input.value));
    value.textContent = describe(maxGap);
    input.setAttribute("aria-valuetext", describe(maxGap));
    section.classList.toggle("filtering", maxGap !== null);
    return maxGap;
  }
  input.addEventListener("input", () => onMaxGap(update()));
  update(); // starts at "all", as the map does

  const stretchButton = $("wapor-stretch");
  let stretch: WaporStretch = 1;
  function showStretch() {
    const next = STRETCHES[(STRETCHES.indexOf(stretch) + 1) % STRETCHES.length];
    stretchButton.textContent = stretchLabel(stretch);
    stretchButton.title =
      (stretch === 0 ? "Colours span all values in view." : `Colours span the values in view without the lowest and highest ${stretch}%.`) +
      ` Click for ${stretchLabel(next)}.`;
  }
  stretchButton.addEventListener("click", () => {
    stretch = STRETCHES[(STRETCHES.indexOf(stretch) + 1) % STRETCHES.length];
    showStretch();
    onStretch(stretch);
  });
  showStretch();
  onStretch(stretch);

  return {
    show(period, status = "ready") {
      legend.hidden = !period;
      if (!period) return;
      legend.dataset.status = status;
      $("wapor-period").textContent = period.label;
      $("wapor-status").textContent = STATUS_TEXT[status];
      $("wapor-note").textContent = period.note ?? "";
    },
    ramp({ quantities: q, colors }) {
      // Stops sit where their value falls between the first and the last.
      const span = q[4] - q[0];
      const at = (v: number) => ((v - q[0]) / span) * 100;
      $("wapor-ramp").style.background =
        `linear-gradient(to right, ${colors.map((c, i) => `${c} ${at(q[i])}%`).join(", ")})`;
      $("wapor-ticks").innerHTML = q.map((v) => `<span style="left:${at(v)}%">${fmtStop(v, span)}</span>`).join("");
    },
    quality(state) {
      section.hidden = !state;
      if (!state) return;
      // The position is kept while it's disabled, and applies again on the next dekad.
      input.disabled = state !== "ready";
      section.dataset.status = state;
      status.textContent = state === "ready" ? "" : QUALITY_TEXT[state];
    },
  };
}
