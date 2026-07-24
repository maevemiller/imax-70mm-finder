// Per-showtime dedupe state + the alert-decision rules from SKILL.md section 4.
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// Pure decision: given the previously-stored qualifying seat ids and the ones
// seen right now, decide whether to alert. Rules (from the original SKILL.md):
//   - Alert on the first qualifying nonempty observation.
//   - Alert when one or more qualifying seats are newly added.
//   - Do NOT alert on removals-only (or unchanged) observations.
//   - If all qualifying seats disappear (prev becomes empty) and later return,
//     alert again — handled naturally because prev is then empty.
export function decideAlert(prevSeatIds, currentSeatIds) {
  const prev = new Set(prevSeatIds);
  const current = currentSeatIds.slice();

  if (current.length === 0) {
    return { shouldAlert: false, newlyAdded: [], reason: "no-qualifying-seats" };
  }
  const newlyAdded = current.filter((id) => !prev.has(id));
  if (prev.size === 0) {
    return { shouldAlert: true, newlyAdded: current, reason: "first-qualifying" };
  }
  if (newlyAdded.length > 0) {
    return { shouldAlert: true, newlyAdded, reason: "newly-added" };
  }
  return { shouldAlert: false, newlyAdded: [], reason: "no-new-seats" };
}

function stateFile(dataDir, showtimeId) {
  return path.join(dataDir, `showtime-${showtimeId}.json`);
}

export async function readState(dataDir, showtimeId) {
  try {
    const raw = await fs.readFile(stateFile(dataDir, showtimeId), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.seatIds) ? parsed.seatIds : [];
  } catch (err) {
    if (err.code === "ENOENT") return []; // first run for this showtime
    throw err;
  }
}

// Timestamp (ms since epoch) of the last time this showtime was actually
// checked, or 0 if it's never been checked — used by the watch loop to decide
// whether a showtime is "due" for its next check.
export async function readLastCheckedMs(dataDir, showtimeId) {
  try {
    const raw = await fs.readFile(stateFile(dataDir, showtimeId), "utf8");
    const parsed = JSON.parse(raw);
    const ms = Date.parse(parsed.updatedAt);
    return Number.isNaN(ms) ? 0 : ms;
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
}

// Atomic write: write a temp file then rename over the target, so a crash
// mid-write can never leave a half-written state file.
export async function writeState(dataDir, showtimeId, seatIds) {
  await fs.mkdir(dataDir, { recursive: true });
  const target = stateFile(dataDir, showtimeId);
  const tmp = path.join(
    dataDir,
    `.tmp-${showtimeId}-${process.pid}-${os.hostname()}.json`
  );
  const body = JSON.stringify({ seatIds, updatedAt: new Date().toISOString() }, null, 2);
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, target);
}
