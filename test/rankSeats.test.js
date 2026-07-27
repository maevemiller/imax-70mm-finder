import { test } from "node:test";
import assert from "node:assert/strict";
import { rankAvailableSeats, bestSeats } from "../src/rankSeats.js";

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
