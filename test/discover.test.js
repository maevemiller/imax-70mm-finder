import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchShowtimeCards,
  dedupeIds,
  dedupeShowtimes,
  computeDateWindow,
  filterWithinWindow,
} from "../src/discover.js";

const config = {
  movieTitle: "The Odyssey",
  theatreName: "AMC Lincoln Square 13",
  format: "IMAX 70MM",
  requireFormatMatch: true,
};

// Real describedBy values captured from AMC's theatre showtimes page.
const odysseyImax = "the-odyssey-76238 the-odyssey-76238-amc-lincoln-square-13 the-odyssey-76238-amc-lincoln-square-13-imax70mm the-odyssey-76238-amc-lincoln-square-13-imax70mm-0-attributes";
const moanaOpenCaption = "moana-72474 moana-72474-amc-lincoln-square-13 moana-72474-amc-lincoln-square-13-opencaption moana-72474-amc-lincoln-square-13-opencaption-0-attributes";

test("matches a real Odyssey IMAX 70mm card at the right theatre", () => {
  const candidates = [{ id: "143822229", describedBy: odysseyImax, datetime: "2026-07-25T14:00:00.000Z" }];
  const result = matchShowtimeCards(candidates, config);
  assert.deepEqual(result.map((m) => m.id), ["143822229"]);
});

test("rejects a different movie at the same theatre", () => {
  const candidates = [{ id: "145327458", describedBy: moanaOpenCaption, datetime: "2026-07-25T17:30:00.000Z" }];
  assert.deepEqual(matchShowtimeCards(candidates, config), []);
});

test("rejects the right movie in the wrong format when format required", () => {
  const wrongFormat = "the-odyssey-76238 the-odyssey-76238-amc-lincoln-square-13 the-odyssey-76238-amc-lincoln-square-13-standard";
  const candidates = [{ id: "999", describedBy: wrongFormat, datetime: null }];
  assert.deepEqual(matchShowtimeCards(candidates, config), []);
});

test("rejects the right movie+format at a different theatre", () => {
  const otherTheatre = "the-odyssey-76238 the-odyssey-76238-amc-empire-25 the-odyssey-76238-amc-empire-25-imax70mm";
  const candidates = [{ id: "888", describedBy: otherTheatre, datetime: null }];
  assert.deepEqual(matchShowtimeCards(candidates, config), []);
});

test("ignores format when requireFormatMatch is false", () => {
  const loose = { ...config, requireFormatMatch: false };
  const wrongFormat = "the-odyssey-76238 the-odyssey-76238-amc-lincoln-square-13 the-odyssey-76238-amc-lincoln-square-13-standard";
  const candidates = [{ id: "777", describedBy: wrongFormat, datetime: null }];
  assert.deepEqual(matchShowtimeCards(candidates, loose).map((m) => m.id), ["777"]);
});

test("normalization ignores hyphenation differences (movie slug vs format slug)", () => {
  // movie slug uses hyphens ("the-odyssey"), format slug has none ("imax70mm") —
  // normalize() strips all non-alphanumeric so both still match their needle.
  const candidates = [{ id: "1", describedBy: odysseyImax, datetime: null }];
  assert.equal(matchShowtimeCards(candidates, config).length, 1);
});

test("multiple candidates: keeps only the exact movie+theatre+format match", () => {
  const candidates = [
    { id: "143822229", describedBy: odysseyImax, datetime: "2026-07-25T14:00:00.000Z" },
    { id: "145327458", describedBy: moanaOpenCaption, datetime: "2026-07-25T17:30:00.000Z" },
  ];
  const result = matchShowtimeCards(candidates, config);
  assert.deepEqual(result.map((m) => m.id), ["143822229"]);
});

test("dedupeIds preserves first-seen order and removes repeats", () => {
  assert.deepEqual(dedupeIds(["a", "b", "a", "c", "b"]), ["a", "b", "c"]);
});

test("dedupeShowtimes keeps first occurrence by id", () => {
  const showtimes = [
    { id: "1", datetime: "a" },
    { id: "2", datetime: "b" },
    { id: "1", datetime: "different-should-be-ignored" },
  ];
  assert.deepEqual(dedupeShowtimes(showtimes), [
    { id: "1", datetime: "a" },
    { id: "2", datetime: "b" },
  ]);
});

test("computeDateWindow spans now through now+windowHours with one day of padding each side", () => {
  const now = Date.parse("2026-07-24T12:00:00.000Z");
  const dates = computeDateWindow(now, 72); // 3 days out
  // now is 07-24, +72h lands on 07-27; padding adds a day at each end.
  assert.deepEqual(dates, ["2026-07-23", "2026-07-24", "2026-07-25", "2026-07-26", "2026-07-27", "2026-07-28"]);
});

test("computeDateWindow handles a short window within one day", () => {
  const now = Date.parse("2026-07-24T12:00:00.000Z");
  const dates = computeDateWindow(now, 2);
  assert.deepEqual(dates, ["2026-07-23", "2026-07-24", "2026-07-25"]);
});

test("filterWithinWindow keeps only showtimes strictly after now and within windowHours", () => {
  const now = Date.parse("2026-07-24T12:00:00.000Z");
  const showtimes = [
    { id: "already-started", datetime: "2026-07-24T11:00:00.000Z" },
    { id: "in-6h", datetime: "2026-07-24T18:00:00.000Z" },
    { id: "in-71h", datetime: "2026-07-27T11:00:00.000Z" },
    { id: "in-73h-too-far", datetime: "2026-07-27T13:00:00.000Z" },
  ];
  const result = filterWithinWindow(showtimes, now, 72);
  assert.deepEqual(result.map((s) => s.id), ["in-6h", "in-71h"]);
});

test("filterWithinWindow drops entries with unparseable datetime", () => {
  const now = Date.parse("2026-07-24T12:00:00.000Z");
  const showtimes = [{ id: "bad", datetime: "not-a-date" }];
  assert.deepEqual(filterWithinWindow(showtimes, now, 72), []);
});
