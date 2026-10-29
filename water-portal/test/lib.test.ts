import { describe, expect, it } from "vitest";
import { csvText } from "../src/lib/csv";
import { clamp, lerp } from "../src/lib/math";
import { niceExtent, niceMax, niceStep, niceTicks, ticksWithin } from "../src/lib/scale";

describe("round numbers for axes", () => {
  it("step by 1, 2, 5 or 10 times a power of ten", () => {
    expect(niceStep(100, 5)).toBe(20);
    expect(niceStep(97, 4)).toBe(50);
    expect(niceStep(0.3, 3)).toBeCloseTo(0.1);
  });

  it("cover or stay within a range", () => {
    expect(niceTicks(0, 97, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(5, 5, 5)).toHaveLength(2);
    expect(ticksWithin(3, 97, 5)).toEqual([20, 40, 60, 80]);
    expect(niceExtent([3, 97])).toEqual([0, 100]);
    expect(niceExtent([5, 5])).toEqual([4, 6]);
    expect(niceMax(97)).toEqual([100, 50]);
  });
});

describe("csvText", () => {
  it("quotes text that needs it and leaves out NaN", () => {
    expect(csvText([["name", "value"], ["plain", 1.5], ['say "hi", now', NaN]])).toBe('name,value\nplain,1.5\n"say ""hi"", now",');
  });
});

describe("math", () => {
  it("clamps and interpolates", () => {
    expect([clamp(5, 0, 3), clamp(-1, 0, 3), clamp(2, 0, 3)]).toEqual([3, 0, 2]);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
  });
});
