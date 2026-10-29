/*
 * Local view: a WaPOR variable (picked in the legend) for the selected range, one
 * raster or a sum of them, on the map. Waits until the range stops changing (dragging
 * the slider passes many), then checks the rasters have been published before opening
 * them. A dekad comes with its NDVI quality raster when that has been published too,
 * for the quality slider in the legend (wapor-legend.ts, owned here). Its colours span
 * the values in view, or are WaPOR's own; its playback (wapor-player.ts) shows a frame
 * per range, loaded ahead. main.ts tells it the view and the range, and what the Local
 * legend and panel pick; it tells them back through `Options`.
 */
import { checkedWaporPeriod, onWaporLevel, waporShownLevel, waporValueAt, waporViewRange, type CheckedWaporPeriod } from "../map/layers/wapor";
import { waporPeriod, waporStyleRamp, type WaporPeriod } from "../map/layers/wapor-period";
import { onWaporTile } from "../map/layers/wapor-tiles";
import { WAPOR_UNITS, WAPOR_VARIABLES, pixelArea, unitFactor, waporPixel, waporUnit, type WaporLevel, type WaporUnits, type WaporVariable } from "../map/layers/wapor-variables";
import type { WaporRamp } from "../map/layers/wapor-shader";
import type { WaterMap } from "../map/map";
import type { LngLat } from "../map/places";
import { initWaporLegend } from "../map/wapor-legend";
import { initWaporPlayer, type PlaybackState, type PlaybackStatus } from "../map/wapor-player";
import { setProgress } from "../panels/load-bar";
import type { MapTip } from "../panels/map-tip";
import type { RampChoice } from "../panels/ramp-menu";
import type { DayRange, View } from "../toolbar/range-rules";
import { rasterTip } from "./local-maps";
import { setPointSeriesYield, waporPixelArea } from "./point-series";

interface Options {
  map: WaterMap;
  /** The view shown (the raster is only in the Local view). */
  getView(): View;
  /** The variable picked in the legend (the Local panel's series follow it; null: none on the map). */
  onVariable(variable: WaporVariable | null): void;
  /** The units picked in the legend (the Local panel's chart follows). */
  onUnits(units: WaporUnits): void;
  /** Playback: a frame's range for the toolbar (`setDays`), and its state for the play button. */
  setDays(days: DayRange): void;
  onPlayback(state: PlaybackState): void;
  /** Playback locks the Local legend's ranges while it runs. */
  lockLegend(): void;
  unlockLegend(): void;
}

export interface WaporRaster {
  /** The variable shown (checked or not). */
  variable(): WaporVariable;
  /** The Local legend's checklist: a variable checked (switching to it if it's another), or none (the raster can be taken off the map). */
  pick(variable: WaporVariable | null): void;
  /** Units picked elsewhere (the Local panel's chart). */
  setUnits(units: WaporUnits): void;
  /** The toolbar's range (the Local view's, in days; null: another view): show the raster for it. */
  show(range: DayRange | null): void;
  /** The map moved to another view: its pixel's area in the legend. */
  showPixelArea(): void;
  /** The pixel under the pointer, in the legend's units (null: none shown there). */
  tip(lngLat: LngLat): MapTip | null;
  /** Whether the play button plays the raster (the Local view, with the raster checked). */
  playable(): boolean;
  togglePlay(): void;
}

export function initWaporRaster({ map: waterMap, getView, onVariable, onUnits, setDays, onPlayback, lockLegend, unlockLegend }: Options): WaporRaster {
  const { map, setWapor, setWaporMaxGap } = waterMap;
  let waporVariable = WAPOR_VARIABLES[0];
  let waporOn = true; // checked in the Local legend (it can be taken off the map)
  // The WaPOR raster's colours, as the map has them (for a pixel's tooltip).
  let waporRampShown: WaporRamp = WAPOR_VARIABLES[0].ramp;
  function setWaporRamp(ramp: WaporRamp) {
    waporRampShown = ramp;
    waterMap.setWaporRamp(ramp);
  }
  let waporMaxGap: number | null = null;
  let waporStretch: RampChoice = 1;
  let waporUnits: WaporUnits = WAPOR_UNITS[0]; // (WaPOR's own colour map is the one for them)
  let waporLocked = false; // the legend's lock (while playing): the colour map stays as it is
  let stretchTimer = 0; // (before initWaporLegend, which calls onStretch)
  const waporLegend = initWaporLegend({
    variable: waporVariable,
    onMaxGap(maxGap) {
      waporMaxGap = maxGap;
      setWaporMaxGap(maxGap);
      stretchWapor();
    },
    onStretch(cut) {
      waporStretch = cut;
      stretchWapor();
    },
    onVariable(variable) {
      waporVariable = variable;
      onVariable(waporOn ? variable : null);
      showPixelArea();
      player.stop();
      hideWapor(); // not the last variable's values in this one's colours
      // Its own colours until its values in view are known.
      setWaporRamp(variable.ramp);
      waporLegend.ramp(variable.ramp);
      showWapor(getView() === "local" ? waporRange : null);
    },
    onUnits(units) {
      waporUnits = units;
      onUnits(units);
      stretchWapor();
    },
    onLock(locked) {
      waporLocked = locked;
      stretchWapor();
    },
  });
  waporLegend.ramp(waporVariable.ramp);

  let waporWanted: string | null = null; // the variable and range, as "AETI start-end" (days)
  let waporShown: WaporPeriod | null = null;
  let levelShown: WaporLevel = "L1"; // (of waporShown, in the legend)
  let waporTimer = 0;
  const waporKey = (range: DayRange) => `${waporVariable.id} ${range.start}-${range.end}`;
  function showWapor(shown: DayRange | null) {
    const range = waporOn ? shown : null;
    const wanted = range && waporKey(range);
    const variable = waporVariable;
    waporWanted = wanted;
    clearTimeout(waporTimer);
    // Before the checks, as if everything were published (always possible: the range
    // doesn't go past the current dekad).
    const draft = range && waporPeriod(variable, range);
    waporLegend.show(draft, "checking");
    waporLegend.quality(draft?.qualityUrl ? "checking" : null);
    if (!range || !draft) return hideWapor();
    waporTimer = window.setTimeout(() => void (async () => {
      let checked: CheckedWaporPeriod | null = null;
      let failed = false; // couldn't reach the bucket
      try {
        checked = await checkedWaporPeriod(variable, range);
      } catch {
        failed = true;
      }
      if (waporWanted !== wanted) return;
      if (!checked) {
        hideWapor();
        waporLegend.quality(null);
        return waporLegend.show(draft, failed ? "error" : "missing");
      }
      showCheckedWapor(checked, false);
    })(), 250);
  }

  /** Show a checked period; `seamless` (a playback frame): it's loaded already. */
  function showCheckedWapor({ period, quality }: CheckedWaporPeriod, seamless: boolean) {
    const wanted = waporWanted;
    waporLegend.show(period, seamless ? "ready" : "loading");
    waporLegend.quality(quality);
    waporShown = period;
    setWapor(period, () => waporWanted === wanted && waporLegend.show(period, "ready"), seamless);
    showWaporLevel();
    stretchWapor();
  }

  function hideWapor() {
    setWapor(null);
    waporShown = null;
    showWaporLevel();
  }

  /**
   * The colour map spans the values on screen (see the stretch button in the legend), or
   * is WaPOR's own for the period and units:
   * worked out again when the view moves, a tile loads, or the period, quality filter or
   * stretch changes, at most every so often. While playing it's kept, so frames compare,
   * and while the legend's lock is on.
   * Until there's a value in view, the last colour map stays.
   */
  function stretchWapor() {
    clearTimeout(stretchTimer);
    stretchTimer = window.setTimeout(() => {
      if (!waporShown || playback !== "stopped" || waporLocked) return;
      if (waporStretch === "wapor") {
        const ramp = waporStyleRamp(waporShown, waporUnits.per);
        if (ramp) {
          setWaporRamp(ramp);
          waporLegend.ramp(ramp);
        }
        return;
      }
      const range = waporViewRange(waporShown, waporMaxGap, waporStretch);
      if (!range) return;
      let lo = range[0];
      let hi = Math.max(range[1], lo + 0.01);
      // A signed variable's colours are centred on 0, as far either way.
      if (waporShown.variable.signed) [lo, hi] = [-1, 1].map((s) => s * Math.max(-lo, hi, 0.01));
      const ramp: WaporRamp = {
        quantities: [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) * i) / 4),
        colors: waporShown.variable.ramp.colors,
      };
      setWaporRamp(ramp);
      waporLegend.ramp(ramp);
    }, 150);
  }
  onWaporTile(stretchWapor);
  map.on("moveend", stretchWapor);

  // Values over a pixel in the legend: a pixel's area at the centre of the view (it
  // changes with latitude, and is L2's when zoomed in where it has it). Only the latest
  // lookup counts.
  let areaWanted = "";
  const shownLevel = () => (waporShown ? waporShownLevel(waporShown) : "L1");
  function showPixelArea() {
    if (getView() !== "local") return;
    const lat = map.getCenter().lat;
    const level = shownLevel();
    const wanted = (areaWanted = `${waporVariable.id} ${lat} ${level}`);
    void waporPixelArea(waporVariable, lat, level).then((area) => areaWanted === wanted && waporLegend.pixelArea(area, lat));
  }
  map.on("moveend", showPixelArea);

  // The legend's pixel size follows the level the map shows.
  function showWaporLevel() {
    const level = shownLevel();
    waporLegend.level(level);
    if (level === levelShown) return;
    levelShown = level;
    showPixelArea();
  }
  // (The level changes while deck.gl picks tiles.)
  onWaporLevel(() => queueMicrotask(showWaporLevel));

  // Playback: each frame sets the range on the toolbar, and its period, loaded ahead, on
  // the map. Any other change of range or view stops it.
  let waporRange: DayRange | null = null;
  let playing = false; // a frame is being shown
  let playback: PlaybackStatus = "stopped";
  const player = initWaporPlayer({
    getRange: () => waporRange!,
    getVariable: () => waporVariable,
    show(range, checked, ms) {
      playing = true;
      setDays(range);
      playing = false;
      clearTimeout(waporTimer);
      waporWanted = waporKey(range);
      // (Its period fades in over the frame's time.)
      waterMap.setPlayback(ms);
      showCheckedWapor(checked, true);
    },
    onState(state) {
      // (Locked as play is pressed: the colours of the range shown are the ones held, until it stops.)
      if (playback === "stopped" && state.status !== "stopped") {
        waporLegend.lock();
        lockLegend();
      }
      if (state.status === "stopped") {
        waporLegend.unlock();
        unlockLegend();
      }
      playback = state.status;
      if (playback === "stopped") stretchWapor();
      onPlayback(state);
      // The frames load first, and the load bar shows theirs (not the point's series').
      setPointSeriesYield(playback !== "stopped");
      setProgress("local-playback", state.loading, true);
      if (playback === "stopped") waterMap.setPlayback(null);
    },
  });

  return {
    variable: () => waporVariable,
    pick(variable) {
      waporOn = Boolean(variable);
      if (variable && variable !== waporVariable) return waporLegend.setVariable(variable);
      player.stop();
      showWapor(getView() === "local" ? waporRange : null);
    },
    setUnits(units) {
      waporUnits = units;
      waporLegend.setUnits(units);
      stretchWapor();
    },
    show(range) {
      showPixelArea();
      if (range) waporRange = range;
      if (playing) return; // (a frame of the playback: shown already)
      player.stop();
      showWapor(range);
    },
    showPixelArea,
    tip(lngLat) {
      const period = waporOn ? waporShown : null;
      const at = period && waporValueAt(period, lngLat, waporMaxGap);
      if (!period || !at) return null;
      const { variable } = period;
      const k = unitFactor(variable, waporUnits, period.days, pixelArea(at.fullPixel, lngLat[1]));
      return rasterTip(at, {
        title: variable.label,
        short: variable.short,
        ramp: waporRampShown,
        k,
        unit: waporUnit(variable, waporUnits),
        source: `WaPOR ${at.level}`,
        pixel: waporPixel(variable, at.level),
      });
    },
    playable: () => getView() === "local" && waporOn,
    togglePlay: () => player.toggle(),
  };
}
