import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, formatStatusMessage } from "../src/status.js";

test("formatDuration: seconds only", () => {
  assert.equal(formatDuration(45 * 1000), "45s");
});

test("formatDuration: minutes and seconds", () => {
  assert.equal(formatDuration(125 * 1000), "2m 5s");
});

test("formatDuration: hours and minutes (no seconds shown)", () => {
  assert.equal(formatDuration(3 * 3600000 + 20 * 60000), "3h 20m");
});

test("formatDuration: negative/zero clamps to 0s", () => {
  assert.equal(formatDuration(-5000), "0s");
  assert.equal(formatDuration(0), "0s");
});

const baseState = {
  startedAtMs: 0,
  movieTitle: "The Odyssey",
  format: "IMAX 70MM",
  theatreName: "AMC Lincoln Square 13",
  minAdjacent: 2,
  activeShowtimesCount: 10,
  lastDiscoveryMs: 0,
  lastCheck: null,
  backoffMs: 0,
  nextAttemptAtMs: 60000,
};
const now = 3600000; // 1h after start

test("formatStatusMessage: no checks yet", () => {
  const msg = formatStatusMessage(baseState, now);
  assert.match(msg, /Watching "The Odyssey" \(IMAX 70MM\) @ AMC Lincoln Square 13/);
  assert.match(msg, /Uptime: 1h 0m/);
  assert.match(msg, /Tracking 10 showtime\(s\)/);
  assert.match(msg, /Last check: none yet/);
});

test("formatStatusMessage: reports rate-limited last check", () => {
  const state = {
    ...baseState,
    lastCheck: { atMs: now - 30000, results: [{ showtimeId: "143822231", blocked: "rate-limited (429)" }] },
    backoffMs: 240000,
    nextAttemptAtMs: now + 180000,
  };
  const msg = formatStatusMessage(state, now);
  assert.match(msg, /Last check: 30s ago — 143822231: rate-limited/);
  assert.match(msg, /⏳ Backing off after a rate-limit; next attempt in ~3m 0s/);
});

test("formatStatusMessage: reports qualifying seats found", () => {
  const state = {
    ...baseState,
    lastCheck: { atMs: now - 5000, results: [{ showtimeId: "143822231", available: ["F11", "F12"] }] },
  };
  const msg = formatStatusMessage(state, now);
  assert.match(msg, /143822231: 2 qualifying seat\(s\)!/);
});

test("formatStatusMessage: reports no qualifying seats without alarm", () => {
  const state = {
    ...baseState,
    lastCheck: { atMs: now - 5000, results: [{ showtimeId: "143822231", available: [] }] },
  };
  const msg = formatStatusMessage(state, now);
  assert.match(msg, /143822231: no qualifying seats/);
});

test("formatStatusMessage: reports a scan error distinctly from a block", () => {
  const state = {
    ...baseState,
    lastCheck: { atMs: now - 5000, results: [{ showtimeId: "143822231", error: "boom" }] },
  };
  const msg = formatStatusMessage(state, now);
  assert.match(msg, /143822231: error/);
});

test("formatStatusMessage: multiple results in one check are all summarized", () => {
  const state = {
    ...baseState,
    lastCheck: {
      atMs: now - 5000,
      results: [
        { showtimeId: "A", blocked: "rate-limited" },
        { showtimeId: "B", available: [] },
      ],
    },
  };
  const msg = formatStatusMessage(state, now);
  assert.match(msg, /A: rate-limited, B: no qualifying seats/);
});
