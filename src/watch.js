// Long-running watcher. Two modes, controlled by config.autoDiscover.enabled:
//
// - Auto-discover (recommended): periodically re-discovers real showtimes for
//   a rolling window (config.autoDiscover.windowHours, e.g. 72h) from the
//   theatre's own listing page, instead of a hand-maintained id list. Each
//   showtime is checked on its own cadence depending on how soon it starts —
//   config.nearCadenceSeconds if under config.nearWindowHours away, else
//   config.farCadenceSeconds — via src/schedule.js's pure due-selection logic.
// - Manual: uses the fixed config.showtimes / config.showtimeIds list as-is,
//   every showtime always on the near (faster) cadence.
//
// In both modes, a single global pacer (src/scan.js createPacer) enforces a
// minimum gap between every live seat-page request, regardless of which
// showtime or which tick it came from — see scan.js for why that matters.
// Ctrl+C quits cleanly.
import { pathToFileURL } from "node:url";
import {
  loadConfig,
  loadEnv,
  openContext,
  scanAll,
  createPacer,
  getConfiguredShowtimes,
  getConfiguredTheatres,
  ROOT,
} from "./scan.js";
import { discoverWindow } from "./discover.js";
import { readLastCheckedMs } from "./state.js";
import { selectDueShowtimes, nextDueAtMs } from "./schedule.js";
import { redact, getUpdates, isFromConfiguredChat, sendMessage } from "./notify.js";
import { formatStatusMessage } from "./status.js";
import path from "node:path";

const DATA_DIR = path.join(ROOT, "data");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How often to check Telegram for a new "are you still running?" message —
// independent of the AMC heartbeat/backoff, so a status reply stays fast (a
// backoff can grow to 10 minutes; nobody should wait that long to hear back).
const TELEGRAM_POLL_MS = 20000;

async function runDiscovery(context, config) {
  const windowHours = config.autoDiscover?.windowHours ?? 72;
  const { showtimes } = await discoverWindow(context, config, { windowHours, nowMs: Date.now() });
  return showtimes;
}

function diffShowtimes(oldList, newList) {
  const oldIds = new Set(oldList.map((s) => s.id));
  const newIds = new Set(newList.map((s) => s.id));
  const added = newList.filter((s) => !oldIds.has(s.id));
  const removed = oldList.filter((s) => !newIds.has(s.id));
  return { added, removed };
}

// Record when this process first became aware of each showtime, so a
// showtime that has never actually been scanned (no state file yet) doesn't
// read as "due immediately" — without this, EVERY showtime found by a fresh
// discovery (near AND far tier alike) would show as due on the very first
// heartbeat, since isDue() treats "never checked" as always due. Seeding with
// discovery time means a showtime's first real check happens after one full
// cadence interval, same as every check after it — which also naturally
// staggers near-tier checks (soon) from far-tier ones (much later) instead of
// firing all of them in one batch.
function markFirstSeen(firstSeenMs, showtimes, nowMs) {
  for (const s of showtimes) {
    if (!firstSeenMs.has(s.id)) firstSeenMs.set(s.id, nowMs);
  }
}

async function main() {
  loadEnv();
  const config = await loadConfig();
  const autoDiscover = config.autoDiscover?.enabled === true;
  const heartbeatMs = (config.heartbeatSeconds ?? 60) * 1000;
  const refreshMs = (config.autoDiscover?.refreshHours ?? 6) * 3600000;
  const pacer = createPacer((config.interShowtimeDelaySeconds ?? 90) * 1000);

  const theatreNames = getConfiguredTheatres(config).map((t) => t.name).join(" OR ") || config.theatreName;
  console.log(
    `Watching "${config.movieTitle}" @ ${theatreNames} | minAdjacent=${config.minAdjacent}\n` +
      (autoDiscover
        ? `Auto-discovery: next ${config.autoDiscover.windowHours ?? 72}h, refreshed every ${config.autoDiscover.refreshHours ?? 6}h\n` +
          `Cadence: <${config.nearWindowHours ?? 24}h away every ${config.nearCadenceSeconds ?? 300}s, further out every ${config.farCadenceSeconds ?? 1800}s\n`
        : `showtimes: ${getConfiguredShowtimes(config).map((s) => s.id).join(", ")}\n`) +
      `Press Ctrl+C to stop.\n`
  );

  let context = await openContext(config);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\nStopping — closing browser...");
    try {
      await context.close();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let activeShowtimes = autoDiscover ? [] : getConfiguredShowtimes(config);
  let lastDiscoveryMs = 0;
  const firstSeenMs = new Map();
  markFirstSeen(firstSeenMs, activeShowtimes, Date.now());

  const startedAtMs = Date.now();
  let lastCheck = null; // { atMs, results } — set after the first real due-check batch

  // Skip any backlog (messages sent before this process started) so startup
  // doesn't reply to stale messages.
  let telegramOffset = 0;
  try {
    const backlog = await getUpdates(0);
    if (backlog.length) telegramOffset = backlog[backlog.length - 1].update_id + 1;
  } catch (err) {
    console.warn(`[telegram] could not check for a status-poll backlog: ${redact(err.message)} — status replies may be unavailable`);
  }

  // `nextTickAtMs` is when the CURRENT sleep finishes — even a showtime whose
  // own cadence says "due already" can't actually be checked before then,
  // since the loop only re-evaluates due-ness once it wakes up. Updated right
  // before each wait below. `backoff` is read directly from the closure
  // (declared further down but only ever read once the loop is running).
  let nextTickAtMs = Date.now();

  async function checkTelegramCommands() {
    let updates;
    try {
      updates = await getUpdates(telegramOffset);
    } catch (err) {
      console.warn(`[telegram] status-poll failed: ${redact(err.message)}`);
      return;
    }
    for (const u of updates) {
      telegramOffset = u.update_id + 1;
      if (!isFromConfiguredChat(u)) continue;

      const nowMs = Date.now();
      const lastCheckedMap = {};
      for (const s of activeShowtimes) {
        const persisted = await readLastCheckedMs(DATA_DIR, s.id);
        lastCheckedMap[s.id] = persisted || firstSeenMs.get(s.id) || nowMs;
      }
      // The real earliest a showtime could next be checked, vs. when the
      // loop will actually next wake up to look — whichever is later wins.
      const scheduleEstimate = nextDueAtMs(activeShowtimes, lastCheckedMap, nowMs, config);
      const nextAttemptAtMs = Math.max(scheduleEstimate ?? nextTickAtMs, nextTickAtMs);

      const state = {
        startedAtMs,
        movieTitle: config.movieTitle,
        theatreNames,
        minAdjacent: config.minAdjacent,
        activeShowtimesCount: activeShowtimes.length,
        lastDiscoveryMs,
        lastCheck,
        backoffMs: backoff,
        nextAttemptAtMs,
      };
      try {
        await sendMessage(formatStatusMessage(state, nowMs));
      } catch (err) {
        console.warn(`[telegram] status reply failed: ${redact(err.message)}`);
      }
    }
  }

  // Waits `totalMs`, polling Telegram every TELEGRAM_POLL_MS along the way
  // instead of one long sleep — so a status reply doesn't wait out a full
  // (up to 10-minute) rate-limit backoff.
  async function waitAndPollTelegram(totalMs) {
    nextTickAtMs = Date.now() + totalMs;
    let remaining = totalMs;
    while (remaining > 0 && !stopping) {
      const chunk = Math.min(TELEGRAM_POLL_MS, remaining);
      await sleep(chunk);
      remaining -= chunk;
      await checkTelegramCommands();
    }
  }

  if (autoDiscover) {
    console.log("Running initial discovery...");
    activeShowtimes = await runDiscovery(context, config);
    lastDiscoveryMs = Date.now();
    markFirstSeen(firstSeenMs, activeShowtimes, lastDiscoveryMs);
    console.log(`Found ${activeShowtimes.length} showtime(s) in the window.`);
    for (const s of activeShowtimes) console.log(`  - ${s.id}  ${s.theatreName || ""}  (${s.datetime})`);
  }

  let backoff = 0; // extra ms added to the next heartbeat after a rate-limit

  while (!stopping) {
    const nowMs = Date.now();

    if (autoDiscover && nowMs - lastDiscoveryMs >= refreshMs) {
      console.log(`--- refreshing discovery @ ${new Date().toLocaleTimeString()} ---`);
      try {
        const fresh = await runDiscovery(context, config);
        const { added, removed } = diffShowtimes(activeShowtimes, fresh);
        activeShowtimes = fresh;
        lastDiscoveryMs = Date.now();
        markFirstSeen(firstSeenMs, added, lastDiscoveryMs);
        if (added.length) console.log(`  +${added.length} new: ${added.map((s) => s.id).join(", ")}`);
        if (removed.length) console.log(`  -${removed.length} dropped: ${removed.map((s) => s.id).join(", ")}`);
        if (!added.length && !removed.length) console.log("  no changes");
      } catch (err) {
        console.error(`  [discovery error] ${redact(err.message)} — keeping previous showtime list`);
      }
    }

    const lastCheckedMap = {};
    for (const s of activeShowtimes) {
      const persisted = await readLastCheckedMs(DATA_DIR, s.id);
      // Never actually scanned yet -> treat as "first seen now", not "due
      // immediately" (see markFirstSeen above).
      lastCheckedMap[s.id] = persisted || firstSeenMs.get(s.id) || nowMs;
    }
    const { due, skippedPassed } = selectDueShowtimes(activeShowtimes, lastCheckedMap, nowMs, config);

    if (skippedPassed.length) {
      activeShowtimes = activeShowtimes.filter((s) => !skippedPassed.some((p) => p.id === s.id));
      console.log(`  ${skippedPassed.length} showtime(s) already started, dropped: ${skippedPassed.map((s) => s.id).join(", ")}`);
    }

    let rateLimited = false;
    if (due.length > 0) {
      console.log(`--- checking ${due.length} due showtime(s) @ ${new Date().toLocaleTimeString()}: ${due.map((s) => s.id).join(", ")} ---`);
      try {
        const results = await scanAll(context, config, due, pacer);
        lastCheck = { atMs: Date.now(), results };
        rateLimited = results.some((r) => r.blocked && r.blocked.startsWith("rate-limited"));

        // The browser/context can die mid-run (crash, or Windows suspending a
        // visible window during sleep — keep the PC awake while watching).
        // Every further request on a dead context fails the same way, so
        // reopen a fresh one rather than spinning uselessly forever.
        if (results.some((r) => r.contextClosed)) {
          console.warn("[recover] browser context died — reopening a fresh one");
          try {
            await context.close();
          } catch {}
          context = await openContext(config);
          console.log("[recover] browser context reopened.");
        }
      } catch (err) {
        console.error(`[scan error] ${redact(err.message)}`);
      }
      backoff = rateLimited ? Math.min((backoff || heartbeatMs) * 2, 600000) : 0;
      if (rateLimited) console.warn(`[backoff] rate-limited; adding ${Math.round(backoff / 1000)}s to next heartbeat`);
    }

    if (!stopping) {
      await waitAndPollTelegram(heartbeatMs + backoff);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(redact(err.stack || String(err)));
    process.exit(1);
  });
}
