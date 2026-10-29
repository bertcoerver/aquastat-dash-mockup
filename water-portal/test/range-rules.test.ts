import { beforeAll, describe, expect, it } from "vitest";
import { dayOf, dkFirstDay, dkLastDay, mk } from "../src/toolbar/dekads";
import {
  changeEnd,
  changeStart,
  enterView,
  firstRange,
  lastDay,
  limitBasinDekads,
  limitCountryYears,
  moveRange,
  pickDay,
  rangeLength,
  setLength,
  shiftYears,
  snapToPeriod,
  stepRange,
  unavailable,
} from "../src/toolbar/range-rules";

const year = (y: number) => ({ start: dayOf(y, 0, 1), end: dayOf(y + 1, 0, 1) - 1 });
const dekads = (a: number, b: number) => ({ start: dkFirstDay(a), end: dkLastDay(b) });
const LAST_DK = mk(2024, 11, 2); // the model output's last dekad in these tests

beforeAll(() => {
  limitCountryYears(2022);
  limitBasinDekads(LAST_DK);
});

describe("limits", () => {
  it("end the Country view at the latest year with data and the Basin view at the last dekad", () => {
    expect(lastDay("country")).toBe(dayOf(2022, 11, 31));
    expect(lastDay("basin")).toBe(dayOf(2024, 11, 31));
    expect(unavailable("country")).toEqual([{ from: dayOf(2023, 0, 1), to: expect.any(Number) }]);
    expect(unavailable("basin")[0]).toEqual({ from: 0, to: dayOf(2018, 0, 1) });
  });
});

describe("entering a view", () => {
  it("rounds a range to whole years in Country", () => {
    expect(enterView("country", { start: dayOf(2020, 5, 3), end: dayOf(2021, 1, 1) })).toEqual({ start: dayOf(2020, 0, 1), end: dayOf(2021, 11, 31) });
  });

  it("moves a range from before WaPOR's data on by whole years", () => {
    expect(enterView("basin", year(2016))).toEqual(year(2018));
    expect(enterView("local", { start: dayOf(2017, 2, 5), end: dayOf(2017, 2, 9) })).toEqual({ start: dayOf(2018, 2, 5), end: dayOf(2018, 2, 9) });
  });

  it("moves a Basin range ending after the model output back by whole years", () => {
    expect(enterView("basin", year(2025))).toEqual(year(2024));
  });

  it("rounds a Basin range to the dekads it lies in", () => {
    expect(enterView("basin", { start: dayOf(2024, 0, 5), end: dayOf(2024, 0, 15) })).toEqual(dekads(mk(2024, 0, 0), mk(2024, 0, 1)));
  });
});

describe("moving the handles", () => {
  it("snaps to dekad boundaries in Basin and to days in Local", () => {
    const prev = dekads(mk(2024, 0, 0), mk(2024, 1, 2));
    expect(changeStart("basin", prev, dayOf(2024, 0, 13))).toEqual({ start: dayOf(2024, 0, 11), end: prev.end });
    expect(changeEnd("basin", prev, dayOf(2024, 0, 19))).toEqual({ start: prev.start, end: dayOf(2024, 0, 20) });
    expect(changeEnd("local", { start: dayOf(2024, 0, 5), end: dayOf(2024, 0, 9) }, dayOf(2024, 0, 8))).toEqual({ start: dayOf(2024, 0, 5), end: dayOf(2024, 0, 7) });
  });

  it("keeps at least a dekad between the handles in Basin", () => {
    const prev = dekads(mk(2024, 0, 0), mk(2024, 0, 0));
    expect(changeEnd("basin", prev, prev.start)).toEqual(prev);
    expect(changeStart("basin", prev, prev.end + 12)).toEqual(dekads(mk(2024, 0, 2), mk(2024, 0, 2)));
  });

  it("snaps to whole years in Country, never past the other handle", () => {
    const prev = { ...year(2019), end: year(2020).end };
    expect(changeStart("country", prev, dayOf(2020, 3, 1))).toEqual(year(2020));
    expect(changeStart("country", prev, dayOf(2022, 3, 1))).toEqual(year(2020));
    expect(changeEnd("country", prev, dayOf(2019, 1, 1))).toEqual(year(2019));
  });

  it("drags the whole range, keeping its length", () => {
    expect(moveRange("local", { start: dayOf(2024, 0, 1), end: dayOf(2024, 0, 10) }, dayOf(2024, 2, 1))).toEqual({ start: dayOf(2024, 2, 1), end: dayOf(2024, 2, 10) });
    expect(moveRange("basin", dekads(mk(2024, 0, 0), mk(2024, 0, 2)), dayOf(2024, 5, 12))).toEqual(dekads(mk(2024, 5, 1), mk(2024, 6, 0)));
    expect(moveRange("country", year(2019), dayOf(2021, 2, 1))).toEqual(year(2021));
    // Not past the view's last day.
    expect(moveRange("country", year(2019), dayOf(2022, 6, 1))).toEqual(year(2022));
  });
});

describe("the calendar and the length field", () => {
  it("picks a dekad in Basin and moves the other end along if passed", () => {
    const prev = dekads(mk(2024, 0, 0), mk(2024, 0, 1));
    expect(pickDay("basin", prev, "end", dayOf(2024, 2, 15))).toEqual(dekads(mk(2024, 0, 0), mk(2024, 2, 1)));
    expect(pickDay("basin", prev, "start", dayOf(2024, 2, 15))).toEqual(dekads(mk(2024, 2, 1), mk(2024, 2, 1)));
    expect(pickDay("country", year(2020), "start", dayOf(2021, 5, 1))).toEqual(year(2021));
  });

  it("sets the length from the start, or ends at the last day when it doesn't fit", () => {
    expect(setLength("local", { start: dayOf(2024, 0, 1), end: dayOf(2024, 0, 1) }, 10)).toEqual({ start: dayOf(2024, 0, 1), end: dayOf(2024, 0, 10) });
    expect(setLength("country", year(2019), 2)).toEqual({ start: year(2019).start, end: year(2020).end });
    expect(setLength("country", year(2022), 3)).toEqual({ start: year(2020).start, end: year(2022).end });
    const late = setLength("basin", dekads(LAST_DK - 1, LAST_DK), 60);
    expect(late.end).toBe(lastDay("basin"));
    expect(rangeLength("basin", late)).toBeGreaterThanOrEqual(51);
  });

  it("counts the length in years in Country and days elsewhere", () => {
    expect(rangeLength("country", { start: year(2019).start, end: year(2021).end })).toBe(3);
    expect(rangeLength("basin", dekads(mk(2024, 0, 0), mk(2024, 0, 2)))).toBe(31);
  });
});

describe("whole years, playback and periods", () => {
  it("shifts by whole years only where that fits", () => {
    expect(shiftYears("basin", dekads(mk(2023, 0, 0), mk(2023, 0, 2)), 1)).toEqual(dekads(mk(2024, 0, 0), mk(2024, 0, 2)));
    expect(shiftYears("basin", dekads(mk(2024, 0, 0), mk(2024, 0, 2)), 1)).toBeNull();
    expect(shiftYears("country", year(2022), -1)).toEqual(year(2021));
  });

  it("steps a dekad or a year on, and starts over at the first", () => {
    expect(stepRange("basin", dekads(mk(2024, 0, 0), mk(2024, 0, 1)))).toEqual(dekads(mk(2024, 0, 1), mk(2024, 0, 2)));
    expect(stepRange("basin", dekads(LAST_DK - 1, LAST_DK))).toBeNull();
    expect(stepRange("country", year(2022))).toBeNull();
    expect(firstRange("basin", dekads(LAST_DK - 1, LAST_DK))).toEqual(dekads(mk(2018, 0, 0), mk(2018, 0, 1)));
    expect(firstRange("country", { start: year(2021).start, end: year(2022).end })).toEqual({ start: year(2016).start, end: year(2017).end });
  });

  it("snaps to the calendar period the middle of the range lies in", () => {
    expect(snapToPeriod("basin", { start: dayOf(2024, 2, 20), end: dayOf(2024, 3, 25) }, "month")).toEqual(dekads(mk(2024, 3, 0), mk(2024, 3, 2)));
    expect(snapToPeriod("local", { start: dayOf(2024, 2, 20), end: dayOf(2024, 3, 25) }, "dekad")).toEqual(dekads(mk(2024, 3, 0), mk(2024, 3, 0)));
    expect(snapToPeriod("country", year(2020), "dekad")).toEqual(year(2020));
  });
});
