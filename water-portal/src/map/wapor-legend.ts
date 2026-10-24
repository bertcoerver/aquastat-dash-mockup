/*
 * The legend for the WaPOR raster (Local view): period, colour ramp and whether the
 * raster is loading or not published yet. For a dekad it also has the quality slider,
 * which hides pixels whose NDVI input is gap-filled over more dekads. The markup lives
 * in index.html.
 */
import type { WaporPeriod } from "./layers/wapor";

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

export interface WaporLegend {
  /** Show the legend for a period (null hides it). */
  show(period: WaporPeriod | null, status?: WaporStatus): void;
  /** The quality slider: shown for a dekad, disabled while there's no quality layer. */
  quality(status: QualityStatus | null): void;
}

/** `onMaxGap` runs when the quality slider moves: the longest gap to show, or null. */
export function initWaporLegend({ onMaxGap }: { onMaxGap: (maxGap: number | null) => void }): WaporLegend {
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

  return {
    show(period, status = "ready") {
      legend.hidden = !period;
      if (!period) return;
      legend.dataset.status = status;
      $("wapor-period").textContent = period.label;
      $("wapor-unit").textContent = period.unit;
      $("wapor-status").textContent = STATUS_TEXT[status];
      $("wapor-note").textContent = period.note ?? "";

      // Stops sit where their value falls between the first and the last.
      const { quantities: q, colors } = period.ramp;
      const at = (v: number) => ((v - q[0]) / (q[4] - q[0])) * 100;
      $("wapor-ramp").style.background =
        `linear-gradient(to right, ${colors.map((c, i) => `${c} ${at(q[i])}%`).join(", ")})`;
      $("wapor-ticks").innerHTML = q
        .map((v) => `<span style="left:${at(v)}%">${+(v * period.scale).toFixed(1)}</span>`)
        .join("");
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
