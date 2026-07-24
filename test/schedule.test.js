import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickCadenceSeconds,
  isDue,
  selectDueShowtimes,
  nextDueAtMs,
  localDayHour,
  isShowtimeAllowed,
  applyScheduleFilter,
} from "../src/schedule.js";

const config = { nearWindowHours: 24, nearCadenceSeconds: 300, farCadenceSeconds: 1800 };
const now = Date.parse("2026-07-24T12:00:00.000Z");

test("pickCadenceSeconds: showtime under 24h away uses near cadence", () => {
  const in6h = "2026-07-24T18:00:00.000Z";
  assert.equal(pickCadenceSeconds(in6h, now, config), 300);
});

test("pickCadenceSeconds: showtime over 24h but within window uses far cadence", () => {
  const in48h = "2026-07-26T12:00:00.000Z";
  assert.equal(pickCadenceSeconds(in48h, now, config), 1800);
});

test("pickCadenceSeconds: exactly at the 24h boundary counts as near", () => {
  const exactly24h = "2026-07-25T12:00:00.000Z";
  assert.equal(pickCadenceSeconds(exactly24h, now, config), 300);
});

test("pickCadenceSeconds: showtime already started returns null (skip)", () => {
  const anHourAgo = "2026-07-24T11:00:00.000Z";
  assert.equal(pickCadenceSeconds(anHourAgo, now, config), null);
});

test("pickCadenceSeconds: no datetime known defaults to near cadence (safe default)", () => {
  assert.equal(pickCadenceSeconds(null, now, config), 300);
  assert.equal(pickCadenceSeconds(undefined, now, config), 300);
});

test("pickCadenceSeconds: unparseable datetime defaults to near cadence", () => {
  assert.equal(pickCadenceSeconds("not-a-date", now, config), 300);
});

test("isDue: never checked before is always due", () => {
  assert.equal(isDue(0, now, 300), true);
});

test("isDue: not enough time has passed", () => {
  const lastChecked = now - 100 * 1000; // 100s ago
  assert.equal(isDue(lastChecked, now, 300), false);
});

test("isDue: exactly the interval has passed", () => {
  const lastChecked = now - 300 * 1000;
  assert.equal(isDue(lastChecked, now, 300), true);
});

test("isDue: more than the interval has passed", () => {
  const lastChecked = now - 400 * 1000;
  assert.equal(isDue(lastChecked, now, 300), true);
});

test("selectDueShowtimes: splits due, not-due, and passed showtimes", () => {
  const showtimes = [
    { id: "soon-due", datetime: "2026-07-24T18:00:00.000Z" }, // near tier, never checked -> due
    { id: "soon-not-due", datetime: "2026-07-24T18:00:00.000Z" }, // near tier, checked recently -> not due
    { id: "far-due", datetime: "2026-07-26T12:00:00.000Z" }, // far tier, never checked -> due
    { id: "already-started", datetime: "2026-07-24T11:00:00.000Z" }, // passed -> skipped
  ];
  const lastCheckedMap = {
    "soon-not-due": now - 60 * 1000, // 1 min ago, near cadence is 300s -> not due
  };

  const { due, skippedPassed } = selectDueShowtimes(showtimes, lastCheckedMap, now, config);

  assert.deepEqual(due.map((s) => s.id), ["soon-due", "far-due"]);
  assert.deepEqual(skippedPassed.map((s) => s.id), ["already-started"]);
});

test("selectDueShowtimes: empty list returns empty results", () => {
  const { due, skippedPassed } = selectDueShowtimes([], {}, now, config);
  assert.deepEqual(due, []);
  assert.deepEqual(skippedPassed, []);
});

test("nextDueAtMs: never-checked showtime is due right now", () => {
  const showtimes = [{ id: "a", datetime: "2026-07-24T18:00:00.000Z" }];
  assert.equal(nextDueAtMs(showtimes, {}, now, config), now);
});

test("nextDueAtMs: recently-checked showtime is due after its full cadence", () => {
  const lastChecked = now - 60 * 1000; // checked 1 min ago
  const showtimes = [{ id: "a", datetime: "2026-07-24T18:00:00.000Z" }]; // near tier, 300s cadence
  const lastCheckedMap = { a: lastChecked };
  assert.equal(nextDueAtMs(showtimes, lastCheckedMap, now, config), lastChecked + 300 * 1000);
});

test("nextDueAtMs: picks the EARLIEST across multiple showtimes, not the first in the list", () => {
  const showtimes = [
    { id: "far", datetime: "2026-07-26T12:00:00.000Z" }, // far tier, 1800s cadence
    { id: "near", datetime: "2026-07-24T18:00:00.000Z" }, // near tier, 300s cadence
  ];
  const lastCheckedMap = {
    far: now - 1000, // checked 1s ago -> due at now + 1799s
    near: now - 250 * 1000, // checked 250s ago -> due at now + 50s (sooner!)
  };
  assert.equal(nextDueAtMs(showtimes, lastCheckedMap, now, config), now - 250 * 1000 + 300 * 1000);
});

test("nextDueAtMs: ignores already-started showtimes", () => {
  const showtimes = [{ id: "passed", datetime: "2026-07-24T11:00:00.000Z" }];
  assert.equal(nextDueAtMs(showtimes, {}, now, config), null);
});

test("nextDueAtMs: null when there are no active showtimes at all", () => {
  assert.equal(nextDueAtMs([], {}, now, config), null);
});

// --- schedule filter (real showtimes from a live discovery run) ------------

const NY = "America/New_York";

test("localDayHour converts a UTC datetime to NY day-of-week and hour (EDT, UTC-4 in July)", () => {
  // 2026-07-24 is a Friday; 22:00 UTC - 4h = 18:00 (6pm) EDT.
  assert.deepEqual(localDayHour("2026-07-24T22:00:00.000Z", NY), { dayOfWeek: 5, hour: 18 });
});

test("localDayHour rolls back to the previous local day correctly", () => {
  // 02:00 UTC - 4h = 22:00 (10pm) the PREVIOUS day, Friday not Saturday.
  assert.deepEqual(localDayHour("2026-07-25T02:00:00.000Z", NY), { dayOfWeek: 5, hour: 22 });
});

const userFilter = {
  timeZone: NY,
  allowedHoursByDay: {
    0: [10, 14, 18, 22], // Sun — weekend, anything except 2am/6am
    1: [18], // Mon — weekday, 6pm only
    2: [18], // Tue
    3: [18], // Wed
    4: [18], // Thu
    5: [18, 22], // Fri — 6pm and 10pm
    6: [10, 14, 18, 22], // Sat — weekend
  },
};

test("isShowtimeAllowed: no filter configured allows everything", () => {
  assert.equal(isShowtimeAllowed("2026-07-25T06:00:00.000Z", undefined), true);
  assert.equal(isShowtimeAllowed("2026-07-25T06:00:00.000Z", {}), true);
});

test("real showtime list: filters down to exactly the requested schedule", () => {
  // The actual 16 showtimes discovered live for The Odyssey @ AMC Lincoln
  // Square 13, spanning Fri 7/24 through Mon 7/27.
  const showtimes = [
    { id: "143822231", datetime: "2026-07-24T22:00:00.000Z" }, // Fri 6pm -> keep
    { id: "143822228", datetime: "2026-07-25T02:00:00.000Z" }, // Fri 10pm -> keep
    { id: "144073418", datetime: "2026-07-25T06:00:00.000Z" }, // Sat 2am -> drop
    { id: "145266764", datetime: "2026-07-25T10:00:00.000Z" }, // Sat 6am -> drop
    { id: "143822229", datetime: "2026-07-25T14:00:00.000Z" }, // Sat 10am -> keep
    { id: "143822226", datetime: "2026-07-25T18:00:00.000Z" }, // Sat 2pm -> keep
    { id: "143822227", datetime: "2026-07-25T22:00:00.000Z" }, // Sat 6pm -> keep
    { id: "143822223", datetime: "2026-07-26T02:00:00.000Z" }, // Sat 10pm -> keep
    { id: "144542786", datetime: "2026-07-26T06:00:00.000Z" }, // Sun 2am -> drop
    { id: "145268295", datetime: "2026-07-26T10:00:00.000Z" }, // Sun 6am -> drop
    { id: "143822224", datetime: "2026-07-26T14:00:00.000Z" }, // Sun 10am -> keep
    { id: "143822225", datetime: "2026-07-26T18:00:00.000Z" }, // Sun 2pm -> keep
    { id: "143822220", datetime: "2026-07-26T22:00:00.000Z" }, // Sun 6pm -> keep
    { id: "143822221", datetime: "2026-07-27T02:00:00.000Z" }, // Sun 10pm -> keep
    { id: "143822222", datetime: "2026-07-27T14:00:00.000Z" }, // Mon 10am -> drop (weekday, not 6pm)
    { id: "143822218", datetime: "2026-07-27T18:00:00.000Z" }, // Mon 2pm -> drop (weekday, not 6pm)
  ];

  const kept = applyScheduleFilter(showtimes, userFilter).map((s) => s.id);
  assert.deepEqual(kept, [
    "143822231",
    "143822228",
    "143822229",
    "143822226",
    "143822227",
    "143822223",
    "143822224",
    "143822225",
    "143822220",
    "143822221",
  ]);
  assert.equal(kept.length, 10);
});
