import { describe, expect, it } from "vitest";
import { MIN_YEAR, addYears, dayDk, dayOf, dkD, dkFirstDay, dkLastDay, dkM, dkY, endDay, fmtDay, fmtEnd, fmtStart, mk, startDay, ymd } from "../src/toolbar/dekads";

describe("dekad indices", () => {
  it("count 36 a year from MIN_YEAR", () => {
    expect(mk(MIN_YEAR, 0, 0)).toBe(0);
    expect(mk(MIN_YEAR + 1, 0, 0)).toBe(36);
    const dk = mk(2024, 1, 2);
    expect([dkY(dk), dkM(dk), dkD(dk)]).toEqual([2024, 1, 2]);
  });

  it("start on the 1st, 11th and 21st and end at the month's end", () => {
    expect([startDay(mk(2024, 1, 0)), startDay(mk(2024, 1, 1)), startDay(mk(2024, 1, 2))]).toEqual([1, 11, 21]);
    expect([endDay(mk(2024, 1, 0)), endDay(mk(2024, 1, 1)), endDay(mk(2024, 1, 2))]).toEqual([10, 20, 29]);
    expect(endDay(mk(2023, 1, 2))).toBe(28);
    expect(fmtStart(mk(2024, 1, 2))).toBe("21 Feb 2024");
    expect(fmtEnd(mk(2024, 1, 2))).toBe("29 Feb 2024");
  });
});

describe("day indices", () => {
  it("count from 1 Jan of MIN_YEAR", () => {
    expect(dayOf(MIN_YEAR, 0, 1)).toBe(0);
    expect(ymd(366)).toEqual({ y: MIN_YEAR + 1, m: 0, d: 1 }); // (MIN_YEAR is a leap year)
    expect(fmtDay(dayOf(2024, 1, 29))).toBe("29 Feb 2024");
  });

  it("map to and from dekads", () => {
    const dk = mk(2024, 1, 2);
    expect(dkFirstDay(dk)).toBe(dayOf(2024, 1, 21));
    expect(dkLastDay(dk)).toBe(dayOf(2024, 1, 29));
    expect(dayDk(dayOf(2024, 1, 10))).toBe(mk(2024, 1, 0));
    expect(dayDk(dayOf(2024, 1, 11))).toBe(mk(2024, 1, 1));
    expect(dayDk(dayOf(2024, 1, 21))).toBe(mk(2024, 1, 2));
  });

  it("move by whole years, 29 Feb rolling on to 1 Mar", () => {
    expect(addYears(dayOf(2023, 5, 15), 1)).toBe(dayOf(2024, 5, 15));
    expect(addYears(dayOf(2024, 1, 29), 1)).toBe(dayOf(2025, 2, 1));
  });
});
