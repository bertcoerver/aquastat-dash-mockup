import { describe, expect, it } from "vitest";
import { dekadRates, monthlyStats, periodStats, windowRates, type WaporSeries } from "../src/basin/stats-data";
import { endDay, mk, startDay } from "../src/toolbar/dekads";

// Two sub-basins of major basin 7 over Jan–Feb 2024 (six dekads). Sub-basin 1 rains
// 1 mm/day throughout; sub-basin 2 rains 2 mm/day but has no data for the 2nd dekad of
// January. AETI is half the rain.
const FIRST = mk(2024, 0, 0);
const DEKADS = 6;
const days = Uint8Array.from({ length: DEKADS }, (_, i) => endDay(FIRST + i) - startDay(FIRST + i) + 1);
const pcp = Float32Array.from([1, 1, 1, 1, 1, 1, 2, NaN, 2, 2, 2, 2]);
const series: WaporSeries = {
  first: FIRST,
  dekads: DEKADS,
  ids: Int32Array.from([1, 2]),
  majorBasins: Int32Array.from([7, 7]),
  areas: Float32Array.from([100, 300]),
  pcp,
  aeti: pcp.map((v) => v / 2),
  days,
};
const JAN = { start: FIRST, end: FIRST + 2 };

describe("periodStats", () => {
  it("totals the mean rate over the days, skipping gaps", () => {
    const { covered, days, sub } = periodStats(series, JAN);
    expect(covered).toEqual(JAN);
    expect(days).toBe(31);
    expect(sub.get(1)).toEqual({ majorBasin: 7, area: 100, pcp: 31, aeti: 15.5 });
    expect(sub.get(2)?.pcp).toBeCloseTo(62); // (the gap isn't counted short)
  });

  it("clips the range to the series, or covers none of it", () => {
    expect(periodStats(series, { start: FIRST - 3, end: FIRST + 8 }).covered).toEqual({ start: FIRST, end: FIRST + 5 });
    expect(periodStats(series, { start: FIRST + 36, end: FIRST + 38 }).covered).toBeNull();
  });
});

describe("monthlyStats", () => {
  it("sums each month's part of the range, area-weighted", () => {
    const m = monthlyStats(series, { start: FIRST + 1, end: FIRST + 5 }, null);
    expect(m.months).toEqual([(2024 - 2016) * 12, (2024 - 2016) * 12 + 1]);
    // January (21 days left of it): 1 mm/day over 100 km², 2 mm/day over 300 km².
    expect(m.pcp[0]).toBeCloseTo((1 * 21 * 100 + 2 * 21 * 300) / 400);
    expect(m.pcp[1]).toBeCloseTo((1 * 29 * 100 + 2 * 29 * 300) / 400);
    expect(m.aeti[1]).toBeCloseTo(m.pcp[1] / 2);
  });

  it("averages over one sub-basin or a major basin's", () => {
    expect(monthlyStats(series, JAN, { kind: "sub", id: 1 }).pcp).toEqual([31]);
    expect(monthlyStats(series, JAN, { kind: "major", id: 7 }).pcp[0]).toBeCloseTo((31 * 100 + 62 * 300) / 400);
    expect(monthlyStats(series, JAN, { kind: "major", id: 8 }).months).toEqual([]);
  });
});

describe("windowRates and dekadRates", () => {
  it("give the mean daily rate per sub-basin in each window", () => {
    const { sub } = windowRates(series, [JAN, { start: FIRST + 3, end: FIRST + 5 }]);
    expect([...sub.get(1)!.pcp]).toEqual([1, 1]);
    expect([...sub.get(2)!.aeti]).toEqual([1, 1]);
    expect(windowRates(series, [{ start: FIRST + 36, end: FIRST + 38 }]).sub.get(1)!.pcp[0]).toBeNaN();
  });

  it("give each dekad's area-weighted rate, leaving out sub-basins without a value", () => {
    const rates = dekadRates(series, JAN, null);
    expect(rates.pcp.get(FIRST)).toBeCloseTo((1 * 100 + 2 * 300) / 400);
    expect(rates.pcp.get(FIRST + 1)).toBe(1); // (only sub-basin 1 has the dekad)
    expect(dekadRates(series, JAN, null)).toBe(rates); // (kept per series and range)
  });
});
