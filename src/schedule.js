// Pure scheduling logic for the rolling-discovery watch loop — no browser, no
// network, fully unit-testable. Decides which showtimes are "due" for a check
// based on how soon they start: showtimes under `nearWindowHours` away are
// checked every `nearCadenceSeconds`; the rest (out to the discovery window)
// every `farCadenceSeconds`. Showtimes that have already started are skipped.

// Returns the check interval in seconds for a showtime starting at
// `datetimeIso`, or null if it should be skipped (already started/unknown-past).
// A showtime with no known datetime (manually configured, no discovery data)
// always uses the near (faster) cadence — safest default.
export function pickCadenceSeconds(datetimeIso, nowMs, config) {
  const near = config.nearCadenceSeconds ?? 300;
  const far = config.farCadenceSeconds ?? 1800;
  const nearWindowMs = (config.nearWindowHours ?? 24) * 3600000;

  if (!datetimeIso) return near;

  const startMs = Date.parse(datetimeIso);
  if (Number.isNaN(startMs)) return near;
  if (startMs <= nowMs) return null; // already started — skip

  return startMs - nowMs <= nearWindowMs ? near : far;
}

// A showtime is due if it's never been checked, or enough time has passed
// since its last check (per its own tier's cadence).
export function isDue(lastCheckedMs, nowMs, intervalSeconds) {
  if (!lastCheckedMs) return true;
  return nowMs - lastCheckedMs >= intervalSeconds * 1000;
}

// showtimes: [{ id, datetime }]; lastCheckedMap: { [id]: msTimestamp }
// Returns { due: [{id, datetime}], skippedPassed: [{id, datetime}] }.
export function selectDueShowtimes(showtimes, lastCheckedMap, nowMs, config) {
  const due = [];
  const skippedPassed = [];

  for (const st of showtimes) {
    const cadence = pickCadenceSeconds(st.datetime, nowMs, config);
    if (cadence === null) {
      skippedPassed.push(st);
      continue;
    }
    const lastChecked = lastCheckedMap[st.id] || 0;
    if (isDue(lastChecked, nowMs, cadence)) due.push(st);
  }
  return { due, skippedPassed };
}

// --- schedule filter (which showings the user actually cares about) --------
// Discovery finds every real showtime; this filters that down to a preferred
// weekly schedule, e.g. "no 2am/6am ever, weekdays only 6pm, Friday 6pm+10pm,
// weekends anything else." Timezone-aware via Intl (correctly handles DST —
// no hardcoded UTC offset).

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// { dayOfWeek: 0-6 (Sun-Sat), hour: 0-23 } for a UTC ISO datetime, in `timeZone`.
export function localDayHour(datetimeIso, timeZone) {
  const date = new Date(datetimeIso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const weekdayStr = parts.find((p) => p.type === "weekday").value;
  let hour = Number(parts.find((p) => p.type === "hour").value);
  if (hour === 24) hour = 0; // some environments report midnight as 24 under h23
  return { dayOfWeek: WEEKDAY_INDEX[weekdayStr], hour };
}

// scheduleFilter: { timeZone: "America/New_York", allowedHoursByDay: { "0": [10,14,18,22], ... } }
// (keys are day-of-week 0=Sun..6=Sat, values are allowed local hours-of-day).
// No filter configured, or a day missing from the table, allows everything —
// a filter should be explicit about every day it means to restrict.
export function isShowtimeAllowed(datetimeIso, scheduleFilter) {
  if (!scheduleFilter?.allowedHoursByDay) return true;
  const { dayOfWeek, hour } = localDayHour(datetimeIso, scheduleFilter.timeZone);
  const allowed = scheduleFilter.allowedHoursByDay[String(dayOfWeek)];
  if (!allowed) return true;
  return allowed.includes(hour);
}

export function applyScheduleFilter(showtimes, scheduleFilter) {
  if (!scheduleFilter?.allowedHoursByDay) return showtimes;
  return showtimes.filter((st) => isShowtimeAllowed(st.datetime, scheduleFilter));
}
