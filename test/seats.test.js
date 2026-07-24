import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSeatId, sortSeats, filterAdjacent } from "../src/seats.js";
import { decideAlert } from "../src/state.js";

test("parseSeatId parses row letters and number", () => {
  assert.deepEqual(parseSeatId("F12"), { row: "F", num: 12, raw: "F12" });
  assert.deepEqual(parseSeatId("aa3"), { row: "AA", num: 3, raw: "aa3" });
  assert.equal(parseSeatId("F12").num, 12);
  assert.equal(parseSeatId("garbage"), null);
});

test("parseSeatId strips leading zeros in the number", () => {
  assert.equal(parseSeatId("G07").num, 7);
});

test("sortSeats orders by row then number", () => {
  const out = sortSeats(["B5", "A10", "A2", "B1"]).map((s) => s.raw);
  assert.deepEqual(out, ["A2", "A10", "B1", "B5"]);
});

test("minAdjacent=1 keeps every seat", () => {
  assert.deepEqual(filterAdjacent(["A3", "C1", "A9"], 1), ["A3", "A9", "C1"]);
});

test("same-row consecutive seats qualify as a pair", () => {
  assert.deepEqual(filterAdjacent(["F11", "F12"], 2), ["F11", "F12"]);
});

test("a gap in the same row breaks the run", () => {
  // F11 and F13 are NOT adjacent (F12 missing) -> no pair
  assert.deepEqual(filterAdjacent(["F11", "F13"], 2), []);
});

test("seats in different rows are not adjacent", () => {
  assert.deepEqual(filterAdjacent(["F11", "G11"], 2), []);
});

test("solo seat does not trigger a pair; a real run does", () => {
  // D5 is solo; D8,D9 form a pair
  assert.deepEqual(filterAdjacent(["D5", "D8", "D9"], 2), ["D8", "D9"]);
});

test("minAdjacent=3 needs a run of three", () => {
  assert.deepEqual(filterAdjacent(["H1", "H2", "H3", "H5", "H6"], 3), ["H1", "H2", "H3"]);
});

test("longer run splits correctly and keeps qualifying part", () => {
  assert.deepEqual(filterAdjacent(["A1", "A2", "A3", "A4"], 2), ["A1", "A2", "A3", "A4"]);
});

// --- alert-decision rules (SKILL.md section 4) ---

test("alerts on first qualifying nonempty observation", () => {
  const r = decideAlert([], ["F11", "F12"]);
  assert.equal(r.shouldAlert, true);
  assert.deepEqual(r.newlyAdded, ["F11", "F12"]);
});

test("alerts when new seats are added", () => {
  const r = decideAlert(["F11", "F12"], ["F11", "F12", "F13"]);
  assert.equal(r.shouldAlert, true);
  assert.deepEqual(r.newlyAdded, ["F13"]);
});

test("does NOT alert on removals-only change", () => {
  const r = decideAlert(["F11", "F12", "F13"], ["F11", "F12"]);
  assert.equal(r.shouldAlert, false);
});

test("does NOT alert when nothing changed", () => {
  assert.equal(decideAlert(["F11", "F12"], ["F11", "F12"]).shouldAlert, false);
});

test("does NOT alert when there are no qualifying seats now", () => {
  assert.equal(decideAlert(["F11", "F12"], []).shouldAlert, false);
});

test("re-alerts after seats disappear then return", () => {
  // scan 1: pair present -> stored
  // scan 2: gone -> state becomes [] (watcher writes current each scan)
  // scan 3: pair returns -> prev is [] so we alert again
  const returned = decideAlert([], ["F11", "F12"]);
  assert.equal(returned.shouldAlert, true);
});
