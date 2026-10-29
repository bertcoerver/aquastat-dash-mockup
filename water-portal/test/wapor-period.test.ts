import { describe, expect, it } from "vitest";
import { waporPeriod } from "../src/map/layers/wapor-period";
import { waporVariable } from "../src/map/layers/wapor-variables";
import { dayOf } from "../src/toolbar/dekads";

const AETI = waporVariable("AETI");

describe("waporPeriod", () => {
  it("shows one dekadal raster for a dekad, with its quality raster", () => {
    const p = waporPeriod(AETI, { start: dayOf(2024, 0, 1), end: dayOf(2024, 0, 10) })!;
    expect(p.resolution).toBe("dekadal");
    expect(p.label).toBe("1st dekad of Jan 2024");
    expect(p.terms).toHaveLength(1);
    expect(p.terms[0].url).toMatch(/L1-AETI-D\.2024-01-D1\.tif$/);
    expect(p.terms[0].factor).toBeCloseTo(AETI.scale);
    expect(p.qualityUrl).toMatch(/QUAL-NDVI-D\.2024-01-D1\.tif$/);
    expect(p.days).toBe(10);
  });

  it("shows the monthly and annual rasters for a month and a year, over their days", () => {
    const m = waporPeriod(AETI, { start: dayOf(2024, 1, 1), end: dayOf(2024, 1, 29) })!;
    expect([m.resolution, m.label, m.terms.length]).toEqual(["monthly", "Feb 2024", 1]);
    expect(m.equation).toMatch(/\/ 29$/);
    expect(m.qualityUrl).toBeNull();
    const a = waporPeriod(AETI, { start: dayOf(2024, 0, 1), end: dayOf(2024, 11, 31) })!;
    expect([a.resolution, a.label, a.terms.length]).toEqual(["annual", "2024", 1]);
    expect(a.terms[0].factor).toBeCloseTo(AETI.scale / 366);
  });

  it("adds up rasters for any other range, weighting each by its days", () => {
    const p = waporPeriod(AETI, { start: dayOf(2024, 0, 11), end: dayOf(2024, 2, 20) })!;
    expect(p.resolution).toBe("custom");
    expect(p.terms.length).toBeGreaterThan(1);
    expect(p.label).toBe("11 Jan – 20 Mar 2024");
    // The weights of dekadal rasters (per day) add up to one over the range.
    const daily = p.terms.filter((t) => /-D\./.test(t.url));
    expect(daily.reduce((sum, t) => sum + t.factor, 0) / AETI.scale).toBeCloseTo(daily.length * 10 / p.days, 1);
  });

  it("goes around a raster that isn't published, and makes nothing of the future", () => {
    const range = { start: dayOf(2024, 1, 1), end: dayOf(2024, 1, 29) };
    const monthly = waporPeriod(AETI, range)!.terms[0].url;
    const without = waporPeriod(AETI, range, new Set([monthly]))!;
    expect(without.terms.every((t) => t.url !== monthly)).toBe(true);
    expect(without.unpublished).toEqual([monthly.slice(monthly.lastIndexOf("/") + 1)]);
    const dekad = waporPeriod(AETI, { start: dayOf(2024, 1, 1), end: dayOf(2024, 1, 10) })!.terms[0].url;
    const around = waporPeriod(AETI, { start: dayOf(2024, 1, 1), end: dayOf(2024, 1, 10) }, new Set([dekad]))!;
    expect(around.terms.every((t) => t.url !== dekad)).toBe(true);
    expect(around.terms.length).toBeGreaterThan(1);
    expect(waporPeriod(AETI, { start: dayOf(2099, 0, 1), end: dayOf(2099, 0, 10) })).toBeNull();
  });
});
