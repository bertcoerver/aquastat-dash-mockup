// Types for calc_runoff.js.

export declare const DEFAULT_F: number;

/** Long-format input, one entry per basin per dekad. */
export interface RunoffInput {
  /** SDG6_SB_ID. */
  basin: ArrayLike<number>;
  /** start_datetime, milliseconds since the epoch (UTC). */
  start: ArrayLike<number>;
  /** mm/day; NaN or null where missing. */
  pcp: ArrayLike<number | null>;
  aeti: ArrayLike<number | null>;
}

/** Output rows sorted by basin, then start, in "mixed_flux" units. */
export interface RunoffOutput {
  basin: number[];
  start: number[];
  /** mm/day. */
  pcp: Float64Array;
  aeti: Float64Array;
  /** m³/s. */
  q: Float64Array;
  dS: Float64Array;
}

/** basin id -> [downstream_id, area_km2, ...]; -888/-999 = terminal. */
export type Routes = Record<string, unknown[]>;

export declare function calcRunoff(
  data: RunoffInput,
  routes: Routes,
  options?: { fValues?: Record<number, number> | Map<number, number>; spinup?: number },
): RunoffOutput;
