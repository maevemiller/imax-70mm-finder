import { test } from "node:test";
import assert from "node:assert/strict";
import { rankAvailableSeats, bestSeats, bestConsecutiveBlock } from "../src/rankSeats.js";

test("prefers a seat at the dead center of a single row", () => {
  const allSeats = ["A1", "A2", "A3", "A4", "A5"];
  const available = ["A1", "A3", "A5"];
  const ranked = rankAvailableSeats(available, allSeats);
  assert.equal(ranked[0].id, "A3"); // center of A1..A5
});

test("prefers a middle row over front/back rows, same seat position", () => {
  const allSeats = ["A5", "B5", "C5", "D5", "E5"];
  const available = ["A5", "C5", "E5"];
  const ranked = rankAvailableSeats(available, allSeats);
  assert.equal(ranked[0].id, "C5"); // middle row
});

test("combines row-centrality and seat-centrality", () => {
  // C is the middle row; within C, seat 3 is the center of a 1-5 range.
  const allSeats = [];
  for (const row of ["A", "B", "C", "D", "E"]) {
    for (let n = 1; n <= 5; n++) allSeats.push(`${row}${n}`);
  }
  const available = ["A1", "C3", "E5"];
  const ranked = rankAvailableSeats(available, allSeats);
  assert.equal(ranked[0].id, "C3");
  // A1 (front row, edge seat) and E5 (back row, edge seat) are symmetric —
  // both should score worse than C3, in some order.
  assert.equal(ranked[2].score > ranked[0].score, true);
});

test("bestSeats returns only the requested count, best first", () => {
  const allSeats = ["A1", "A2", "A3", "A4", "A5"];
  const available = ["A1", "A2", "A3", "A4", "A5"];
  const top2 = bestSeats(available, allSeats, 2);
  assert.equal(top2.length, 2);
  assert.equal(top2[0], "A3"); // most central first
});

test("single available seat with no other seats on the page still ranks", () => {
  const ranked = rankAvailableSeats(["F12"], []);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, "F12");
});

test("ignores unparseable ids gracefully", () => {
  const ranked = rankAvailableSeats(["not-a-seat", "A1"], ["A1", "A2", "A3"]);
  assert.deepEqual(ranked.map((s) => s.id), ["A1"]);
});

test("empty available list returns empty ranking", () => {
  assert.deepEqual(rankAvailableSeats([], ["A1", "A2"]), []);
});

test("a row not present in allSeatIds (edge case) still gets a reasonable score, not a crash", () => {
  const allSeats = ["A1", "A2", "A3"];
  const available = ["Z9"]; // Z not in allSeats at all
  const ranked = rankAvailableSeats(available, allSeats);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, "Z9");
  assert.equal(Number.isFinite(ranked[0].score), true);
});

// --- bestConsecutiveBlock (a real run of N adjacent seats, not just top-N individually) ---

test("bestConsecutiveBlock: finds a simple 4-seat run in a single row", () => {
  const allSeats = ["A1", "A2", "A3", "A4", "A5", "A6", "A7"];
  const block = bestConsecutiveBlock(allSeats, allSeats, 4);
  assert.equal(block.length, 4);
  // consecutive and centered in the 1-7 range
  const nums = block.map((s) => Number(s.slice(1)));
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
  for (let i = 1; i < nums.length; i++) assert.equal(nums[i], nums[i - 1] + 1);
});

test("bestConsecutiveBlock: skips a run shorter than blockSize, uses a longer one elsewhere", () => {
  const allSeats = ["A1", "A2", "A3", "B1", "B2", "B3", "B4", "B5"];
  // Row A only has a run of 3 (too short); row B has a run of 5.
  const block = bestConsecutiveBlock(allSeats, allSeats, 4);
  assert.equal(block.length, 4);
  assert.ok(block.every((s) => s.startsWith("B")));
});

test("bestConsecutiveBlock: prefers the more centrally-located row when both qualify", () => {
  const allSeats = [];
  for (const row of ["A", "B", "C", "D", "E"]) {
    for (let n = 1; n <= 8; n++) allSeats.push(`${row}${n}`);
  }
  // Every row has a full run of 8 -> C (middle row) should win.
  const block = bestConsecutiveBlock(allSeats, allSeats, 4);
  assert.ok(block.every((s) => s.startsWith("C")));
});

test("bestConsecutiveBlock: within a long run, picks the sub-window closest to row center", () => {
  const allSeats = Array.from({ length: 20 }, (_, i) => `A${i + 1}`); // A1..A20, center ~10.5
  const block = bestConsecutiveBlock(allSeats, allSeats, 4);
  const nums = block.map((s) => Number(s.slice(1))).sort((a, b) => a - b);
  const windowCenter = (nums[0] + nums[nums.length - 1]) / 2;
  assert.ok(Math.abs(windowCenter - 10.5) <= 2, `expected a centered window, got ${block.join(",")}`);
});

test("bestConsecutiveBlock: returns null when nothing has a long enough run", () => {
  const allSeats = ["A1", "A2", "A3", "B1", "B2"];
  assert.equal(bestConsecutiveBlock(allSeats, allSeats, 4), null);
});

test("bestConsecutiveBlock: real-world sparse availability (from an actual sweep result)", () => {
  // Real captured list: row C is one unbroken block C1-C38.
  const available = [
    "A1", "A2", "A3",
    "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10",
    "D1", "D2", "D32", "D33",
  ];
  const block = bestConsecutiveBlock(available, available, 4);
  assert.equal(block.length, 4);
  assert.ok(block.every((s) => s.startsWith("C")), `expected a block in row C, got ${block.join(",")}`);
});
