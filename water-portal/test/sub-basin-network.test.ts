import { describe, expect, it } from "vitest";
import { downstreamFinder, upstreamFinder, type SubBasin } from "../src/map/sub-basin-network";

// 1 and 2 drain into 3, 3 into 4, 4 into the sea; 5 and 6 drain into each other (a loop
// as in the data); 7 drains into itself.
const sub = (id: number, downstream: number): SubBasin => ({ id, name: String(id), majorBasin: 1, downstream, area: null, bbox: [0, 0, 1, 1] });
const basins = [sub(1, 3), sub(2, 3), sub(3, 4), sub(4, -999), sub(5, 6), sub(6, 5), sub(7, 7)];

describe("the sub-basin network", () => {
  it("finds everything upstream, not the basin itself", () => {
    const upstreamOf = upstreamFinder(basins);
    expect([...upstreamOf(4)].sort()).toEqual([1, 2, 3]);
    expect([...upstreamOf(3)].sort()).toEqual([1, 2]);
    expect(upstreamOf(1).size).toBe(0);
    expect(upstreamOf(99).size).toBe(0);
  });

  it("finds everything downstream, to the sea", () => {
    const downstreamOf = downstreamFinder(basins);
    expect([...downstreamOf(1)]).toEqual([3, 4]);
    expect(downstreamOf(4).size).toBe(0);
  });

  it("survives the data's loops", () => {
    expect([...upstreamFinder(basins)(5)]).toEqual([6]);
    expect([...downstreamFinder(basins)(5)]).toEqual([6]);
    expect(upstreamFinder(basins)(7).size).toBe(0);
    expect(downstreamFinder(basins)(7).size).toBe(0);
  });
});
