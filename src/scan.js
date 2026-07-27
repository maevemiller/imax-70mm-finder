// One scan pass: open AMC seat pages, detect available seats deterministically,
// apply the adjacency filter, diff against saved state, and alert on qualifying
// changes. No LLM at runtime — pure DOM inspection (SKILL.md section 3).
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import { filterAdjacent } from "./seats.js";
import { bestSeats } from "./rankSeats.js";
import { decideAlert, readState, writeState } from "./state.js";
import { alert, redact } from "./notify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SHOTS_DIR = path.join(ROOT, "screenshots");
const PROFILE_DIR = path.join(ROOT, "browser-profile");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- config + env -----------------------------------------------------------

export async function loadConfig() {
  const raw = await fs.readFile(path.join(ROOT, "config.json"), "utf8");
  return JSON.parse(raw);
}

export function loadEnv() {
  try {
    process.loadEnvFile(path.join(ROOT, ".env")); // Node 20.12+/24
  } catch {
    // no .env yet — fine for a dry run without alerts
  }
}

// Prefers the richer config.showtimes ([{id, datetime}], written by
// discover.js's rolling-window mode) over the legacy flat config.showtimeIds
// (manually curated, no known datetime — always treated as "near" tier by
// src/schedule.js since we can't judge how soon it is).
export function getConfiguredShowtimes(config) {
  if (Array.isArray(config.showtimes)) return config.showtimes;
  if (Array.isArray(config.showtimeIds)) return config.showtimeIds.map((id) => ({ id, datetime: null }));
  return [];
}

// Prefers config.theatres ([{name, showtimesUrl}], for watching multiple
// theatres at once) over the legacy singular config.theatreName/theatreShowtimesUrl.
export function getConfiguredTheatres(config) {
  if (Array.isArray(config.theatres) && config.theatres.length > 0) return config.theatres;
  if (config.theatreShowtimesUrl) {
    return [{ name: config.theatreName, showtimesUrl: config.theatreShowtimesUrl }];
  }
  return [];
}

// --- browser ----------------------------------------------------------------

// A persistent context keeps cookies on disk, so any one-time Cloudflare
// "are you human" check stays solved across runs. First run shows a real
// window (config.firstRunHeadful) so you can clear it once.
export async function openContext(config) {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: config.firstRunHeadful === false,
    viewport: { width: 1400, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
}

const seatUrl = (id) => `https://www.amctheatres.com/showtimes/${id}/seats`;

// Detect Cloudflare / rate-limit / block signals so we can back off cleanly.
function blockReason(status, bodyText) {
  const t = (bodyText || "").toLowerCase();
  if (status === 429 || t.includes("error 1015") || t.includes("rate limited"))
    return "rate-limited (429 / Cloudflare 1015)";
  if (status === 403 || t.includes("attention required") || t.includes("cf-error-details"))
    return "blocked / challenged (403 / Cloudflare)";
  return null;
}

// --- seat extraction (runs inside the page) ---------------------------------
// Verified against a real captured seat page (test/fixtures/seat-page-144696901.html,
// 480 seat checkboxes). Each seat is:
//   <input type="checkbox" name="A33" aria-label="Occupied AMC Club Rocker A33" disabled>
// - `name` is the seat id directly (no parsing needed).
// - `aria-label` starts with "Occupied " when taken; no such prefix when available.
// - `disabled` is present exactly when the seat is unavailable (redundant with
//   the "Occupied" text — checked both ways for safety).
// - Accessible seats say "Wheelchair Space" / "Wheelchair Companion ..." in the
//   label; excluded per SKILL.md regardless of availability.
function extractSeatsInPage() {
  const ACCESSIBLE = /(wheelchair|companion|accessible|\bada\b)/i;
  const OCCUPIED = /occupied/i;

  const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"][name]'));

  const available = [];
  const allSeatIds = []; // every seat found, any status — used to rank available seats by centrality
  let occupied = 0;
  let excludedAccessible = 0;
  const seen = new Set();

  for (const el of checkboxes) {
    const id = (el.getAttribute("name") || "").toUpperCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    allSeatIds.push(id);

    const label = el.getAttribute("aria-label") || "";

    if (ACCESSIBLE.test(label)) {
      excludedAccessible++;
      continue;
    }

    const disabled = el.disabled === true || el.hasAttribute("disabled");
    const looksOccupied = OCCUPIED.test(label);

    if (!disabled && !looksOccupied) {
      available.push(id);
    } else {
      occupied++;
    }
  }
  return { available, allSeatIds, occupied, excludedAccessible, totalCandidates: seen.size };
}

// --- metadata validation ----------------------------------------------------

function validateMetadata(pageText, config, showtimeId, theatreName) {
  const text = (pageText || "").toLowerCase();
  const checks = [
    ["movie", config.movieTitle],
    ["theatre", theatreName ?? config.theatreName],
    ["format", config.requireFormatMatch ? config.format : null],
  ];
  const mismatches = [];
  for (const [name, expected] of checks) {
    if (!expected) continue;
    if (!text.includes(String(expected).toLowerCase())) mismatches.push({ name, expected });
  }
  if (mismatches.length) {
    console.warn(
      `  [warn] metadata mismatch for showtime ${showtimeId}: page did not contain ` +
        mismatches.map((m) => `${m.name}="${m.expected}"`).join(", ")
    );
  }
  return mismatches.length === 0;
}

// --- pacing -------------------------------------------------------------
// The seat-selection endpoint (/showtimes/{id}/seats) is far more
// aggressively rate-limited by AMC/Cloudflare than listing pages — hitting
// several of them back-to-back (even different showtime ids) is what
// triggered escalating Cloudflare 1015 bans during testing (retry-after grew
// from 234s to 362s after only a handful of rapid requests). A pacer
// guarantees a minimum gap between EVERY live seat-page request, regardless
// of which showtime it's for or which scan cycle/tick it came from — that
// cross-boundary case (different showtimes, different ticks) is exactly what
// a per-cycle-only delay would miss. The value is a conservative starting
// point based on limited data, NOT a proven-safe rate — tune it
// (config.interShowtimeDelaySeconds) if bans keep happening.
export function createPacer(minGapMs) {
  let lastMs = 0;
  return {
    async wait() {
      const now = Date.now();
      if (lastMs > 0) {
        const remaining = minGapMs - (now - lastMs);
        if (remaining > 0) {
          console.log(`  waiting ${Math.round(remaining / 1000)}s before next seat-page request (rate-limit spacing)...`);
          await sleep(remaining);
        }
      }
      lastMs = Date.now();
    },
  };
}

// --- one showtime -----------------------------------------------------------

// `showtime` is either a plain id string (legacy/manual config) or an object
// {id, datetime, theatreName} (from multi-theatre discovery) — theatreName
// flows through to metadata validation and the alert message so a mixed list
// of showtimes across several theatres is reported accurately per-showtime,
// not against one single global config.theatreName.
export async function scanShowtime(context, config, showtime, pacer) {
  const showtimeId = typeof showtime === "string" ? showtime : showtime.id;
  const theatreName = (typeof showtime === "object" && showtime.theatreName) || config.theatreName;

  if (pacer) await pacer.wait();
  const url = seatUrl(showtimeId);
  const page = await context.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    const status = resp ? resp.status() : 0;
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText : "");

    const blocked = blockReason(status, bodyText);
    if (blocked) {
      console.warn(`  [block] showtime ${showtimeId}: ${blocked}`);
      return { showtimeId, blocked, available: [] };
    }

    // Give client-rendered seats a chance to appear.
    await page.waitForTimeout(4000);

    const metaOk = validateMetadata(bodyText, config, showtimeId, theatreName);
    const raw = await page.evaluate(extractSeatsInPage);
    const qualifying = filterAdjacent(raw.available, config.minAdjacent || 1);

    console.log(
      `  showtime ${showtimeId} (${theatreName}): candidates=${raw.totalCandidates} available=${raw.available.length} ` +
        `occupied=${raw.occupied} accessible-excluded=${raw.excludedAccessible} ` +
        `qualifying(min ${config.minAdjacent || 1})=${qualifying.length} metaOk=${metaOk}`
    );

    const prev = await readState(DATA_DIR, showtimeId);
    const decision = decideAlert(prev, qualifying);
    await writeState(DATA_DIR, showtimeId, qualifying);

    if (decision.shouldAlert) {
      // With minAdjacent as low as 1, a scan can turn up many qualifying
      // seats at once — rank them by centrality (row + seat position) and
      // lead with the best pick(s) rather than dumping a raw list.
      const ranked = bestSeats(qualifying, raw.allSeatIds, 3);
      const caption =
        `🎬 Seats available!\n` +
        `${config.movieTitle}\n` +
        `${theatreName}\n` +
        `Best pick(s): ${ranked.join(", ")}\n` +
        `All qualifying seats (${qualifying.length}): ${qualifying.join(", ")}\n` +
        `New this scan: ${decision.newlyAdded.join(", ")}\n` +
        `${url}`;

      // Screenshotting the seat-grid element (rather than fullPage) avoids
      // the common case of this crash, but the grid itself can STILL render
      // at an absurd height on some pages (a real Skia allocation crash seen
      // live: w:1400 h:683521). A failed screenshot must never cost the user
      // the alert itself — fall back to a text-only message so "seats are
      // available right now" always gets through even if the image can't.
      let shot = null;
      try {
        await fs.mkdir(SHOTS_DIR, { recursive: true });
        const shotPath = path.join(SHOTS_DIR, `showtime-${showtimeId}-${Date.now()}.png`);
        const grid = page.locator('[role="grid"][aria-label="Seat Selection Map"]');
        if (await grid.count() > 0) {
          await grid.first().screenshot({ path: shotPath, timeout: 15000 });
        } else {
          await page.screenshot({ path: shotPath, timeout: 15000 });
        }
        shot = shotPath;
      } catch (err) {
        console.error(`  [screenshot failed] ${redact(err.message)} — sending text-only alert instead`);
      }

      try {
        await alert({ caption, imagePath: shot });
        console.log(`  [ALERT SENT] showtime ${showtimeId}: ${qualifying.join(", ")}${shot ? "" : " (text-only, screenshot failed)"}`);
      } catch (err) {
        console.error(`  [alert failed] ${redact(err.message)}`);
      }
    }
    return { showtimeId, theatreName, available: qualifying, decision };
  } finally {
    await page.close();
  }
}

// Playwright throws messages like "Target page, context or browser has been
// closed" (or "Target closed") when the underlying browser/context has died —
// e.g. a crash, or Windows suspending/killing the visible Chromium window
// during sleep. Every subsequent page.goto in the SAME context will fail the
// same way, so this needs the same "stop the batch immediately" treatment as
// a rate-limit block, plus a signal to reopen a fresh context.
function isContextClosedError(message) {
  return /has been closed|target closed/i.test(String(message || ""));
}

// `showtimes` defaults to every configured showtime (config.showtimes /
// legacy config.showtimeIds) — pass an explicit subset (e.g. from watch.js's
// selectDueShowtimes) to only check the ones that are actually due. Each
// entry may be a plain id string (legacy) or a {id, datetime, theatreName}
// object — scanShowtime() accepts both. `pacer` defaults to a fresh one
// scoped to this call (fine for a one-off CLI scan); watch.js passes in ONE
// long-lived pacer shared across every tick so the minimum gap is enforced
// globally, not just within a single scanAll() call.
export async function scanAll(context, config, showtimes, pacer) {
  const targets = showtimes ?? getConfiguredShowtimes(config);
  const activePacer = pacer ?? createPacer((config.interShowtimeDelaySeconds ?? 90) * 1000);
  const results = [];
  for (const target of targets) {
    const id = typeof target === "string" ? target : target.id;
    let result;
    try {
      result = await scanShowtime(context, config, target, activePacer);
    } catch (err) {
      if (isContextClosedError(err.message)) {
        console.error(`  [context-closed] browser/context died — aborting batch, will reopen`);
        result = { showtimeId: id, error: err.message, contextClosed: true };
        results.push(result);
        break;
      }
      console.error(`  [error] showtime ${id}: ${redact(err.message)}`);
      result = { showtimeId: id, error: err.message };
    }
    results.push(result);

    // Retrying into an active ban makes it WORSE, not better — Cloudflare's
    // retry-after grew from 234s to 362s across repeated hits during testing.
    // Stop the rest of this batch immediately rather than grinding every
    // remaining id into the same wall; the watch loop's backoff handles the
    // next attempt.
    if (result.blocked && result.blocked.startsWith("rate-limited")) {
      const remaining = targets.length - results.length;
      if (remaining > 0) {
        console.warn(`  [abort] rate-limited — skipping ${remaining} remaining showtime(s) this batch`);
      }
      break;
    }
  }
  return results;
}

// --- CLI: one-off scan ------------------------------------------------------

async function main() {
  loadEnv();
  const config = await loadConfig();
  const context = await openContext(config);
  try {
    let showtimes;
    if (config.autoDiscover?.enabled) {
      // Dynamic import avoids a circular top-level import — discover.js
      // itself imports from this file (loadConfig/loadEnv/openContext/ROOT).
      const { discoverWindow } = await import("./discover.js");
      const windowHours = config.autoDiscover.windowHours ?? 72;
      console.log(`Discovering showtimes for the next ${windowHours}h...`);
      ({ showtimes } = await discoverWindow(context, config, { windowHours, nowMs: Date.now() }));
    } else {
      showtimes = getConfiguredShowtimes(config);
    }
    const theatreNames = getConfiguredTheatres(config).map((t) => t.name).join(", ") || config.theatreName;
    console.log(
      `Dry scan: "${config.movieTitle}" @ ${theatreNames} — ` +
        `${showtimes.length} showtime(s), minAdjacent=${config.minAdjacent}`
    );
    await scanAll(context, config, showtimes);
  } finally {
    await context.close();
  }
  console.log("Scan complete.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(redact(err.stack || String(err)));
    process.exit(1);
  });
}
