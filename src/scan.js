// One scan pass: open AMC seat pages, detect available seats deterministically,
// apply the adjacency filter, diff against saved state, and alert on qualifying
// changes. No LLM at runtime — pure DOM inspection (SKILL.md section 3).
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import { filterAdjacent } from "./seats.js";
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
  let occupied = 0;
  let excludedAccessible = 0;
  const seen = new Set();

  for (const el of checkboxes) {
    const id = (el.getAttribute("name") || "").toUpperCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);

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
  return { available, occupied, excludedAccessible, totalCandidates: seen.size };
}

// --- metadata validation ----------------------------------------------------

function validateMetadata(pageText, config, showtimeId) {
  const text = (pageText || "").toLowerCase();
  const checks = [
    ["movie", config.movieTitle],
    ["theatre", config.theatreName],
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

export async function scanShowtime(context, config, showtimeId, pacer) {
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

    const metaOk = validateMetadata(bodyText, config, showtimeId);
    const raw = await page.evaluate(extractSeatsInPage);
    const qualifying = filterAdjacent(raw.available, config.minAdjacent || 1);

    console.log(
      `  showtime ${showtimeId}: candidates=${raw.totalCandidates} available=${raw.available.length} ` +
        `occupied=${raw.occupied} accessible-excluded=${raw.excludedAccessible} ` +
        `qualifying(min ${config.minAdjacent || 1})=${qualifying.length} metaOk=${metaOk}`
    );

    const prev = await readState(DATA_DIR, showtimeId);
    const decision = decideAlert(prev, qualifying);
    await writeState(DATA_DIR, showtimeId, qualifying);

    if (decision.shouldAlert) {
      await fs.mkdir(SHOTS_DIR, { recursive: true });
      const shot = path.join(SHOTS_DIR, `showtime-${showtimeId}-${Date.now()}.png`);
      // A fullPage screenshot crashed Playwright on a real seat page (the grid
      // container renders at an absurd height — a Skia allocation error).
      // Screenshotting just the seat-grid element avoids that and is a more
      // useful image anyway (no surrounding page chrome).
      const grid = page.locator('[role="grid"][aria-label="Seat Selection Map"]');
      if (await grid.count() > 0) {
        await grid.first().screenshot({ path: shot });
      } else {
        await page.screenshot({ path: shot }); // fallback: viewport only, not fullPage
      }

      const caption =
        `🎬 Seats available!\n` +
        `${config.movieTitle} (${config.format})\n` +
        `${config.theatreName}\n` +
        `Qualifying seats: ${qualifying.join(", ")}\n` +
        `New this scan: ${decision.newlyAdded.join(", ")}\n` +
        `${url}`;

      try {
        await alert({ caption, imagePath: shot });
        console.log(`  [ALERT SENT] showtime ${showtimeId}: ${qualifying.join(", ")}`);
      } catch (err) {
        console.error(`  [alert failed] ${redact(err.message)}`);
      }
    }
    return { showtimeId, available: qualifying, decision };
  } finally {
    await page.close();
  }
}

// `ids` defaults to every configured showtime (config.showtimes / legacy
// config.showtimeIds) — pass an explicit subset (e.g. from watch.js's
// selectDueShowtimes) to only check the ones that are actually due. `pacer`
// defaults to a fresh one scoped to this call (fine for a one-off CLI scan);
// watch.js passes in ONE long-lived pacer shared across every tick so the
// minimum gap is enforced globally, not just within a single scanAll() call.
export async function scanAll(context, config, ids, pacer) {
  const targetIds = ids ?? getConfiguredShowtimes(config).map((s) => s.id);
  const activePacer = pacer ?? createPacer((config.interShowtimeDelaySeconds ?? 90) * 1000);
  const results = [];
  for (const id of targetIds) {
    let result;
    try {
      result = await scanShowtime(context, config, id, activePacer);
    } catch (err) {
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
      const remaining = targetIds.length - results.length;
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
    let ids;
    if (config.autoDiscover?.enabled) {
      // Dynamic import avoids a circular top-level import — discover.js
      // itself imports from this file (loadConfig/loadEnv/openContext/ROOT).
      const { discoverWindow } = await import("./discover.js");
      const windowHours = config.autoDiscover.windowHours ?? 72;
      console.log(`Discovering showtimes for the next ${windowHours}h...`);
      const { showtimes } = await discoverWindow(context, config, { windowHours, nowMs: Date.now() });
      ids = showtimes.map((s) => s.id);
    } else {
      ids = getConfiguredShowtimes(config).map((s) => s.id);
    }
    console.log(
      `Dry scan: "${config.movieTitle}" (${config.format}) @ ${config.theatreName} — ` +
        `${ids.length} showtime(s), minAdjacent=${config.minAdjacent}`
    );
    await scanAll(context, config, ids);
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
