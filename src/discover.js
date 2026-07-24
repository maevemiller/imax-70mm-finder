// Auto-discover showtime IDs for a given date, instead of hand-copying seat
// URLs. Ports SKILL.md section 2 ("Reconnoiter AMC"): open the THEATRE's own
// showtimes page for a date and find /showtimes/{id} links belonging to the
// right movie + format.
//
// Verified against a real captured page (test/fixtures/theatre-listing-page.html):
// each showtime is an <a href="/showtimes/{id}"> whose aria-describedby
// attribute encodes movie/theatre/format as slugs, e.g.
//   aria-describedby="the-odyssey-76238 the-odyssey-76238-amc-lincoln-square-13
//                      the-odyssey-76238-amc-lincoln-square-13-imax70mm ..."
// and a child <time datetime="2026-07-25T14:00:00.000Z"> with the real start time.
// NOTE: the movie's own cross-theatre listing page (config.movieShowtimesUrl)
// does NOT work standalone — it requires a selected/geolocated theatre first
// ("please select a nearby theatre"), which is why we go through the
// theatre-specific page (config.theatreShowtimesUrl) instead.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import { loadConfig, loadEnv, openContext, ROOT } from "./scan.js";
import { applyScheduleFilter } from "./schedule.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- pure matching logic (unit-testable, no browser) ------------------------

function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// candidates: [{ id: "143822229", describedBy: "the-odyssey-76238 the-odyssey-76238-amc-lincoln-square-13 ...", datetime: "2026-07-25T14:00:00.000Z" }, ...]
// Matches by normalizing (lowercase, strip non-alphanumeric) both the needles
// and the describedBy string, so hyphenation differences between the movie
// slug ("the-odyssey-76238") and format slug ("imax70mm") don't matter.
export function matchShowtimeCards(candidates, { movieTitle, theatreName, format, requireFormatMatch }) {
  const movieNeedle = normalize(movieTitle);
  const theatreNeedle = normalize(theatreName);
  const formatNeedle = normalize(format);

  return candidates.filter((c) => {
    const desc = normalize(c.describedBy);
    if (movieNeedle && !desc.includes(movieNeedle)) return false;
    if (theatreNeedle && !desc.includes(theatreNeedle)) return false;
    if (requireFormatMatch && formatNeedle && !desc.includes(formatNeedle)) return false;
    return true;
  });
}

// De-duplicate while preserving first-seen order.
export function dedupeIds(ids) {
  return [...new Set(ids)];
}

// De-duplicate {id, datetime, ...} objects by id, keeping the first occurrence.
export function dedupeShowtimes(showtimes) {
  const seen = new Set();
  const out = [];
  for (const st of showtimes) {
    if (seen.has(st.id)) continue;
    seen.add(st.id);
    out.push(st);
  }
  return out;
}

// Pure: the calendar date strings (YYYY-MM-DD, UTC) spanning [nowMs, nowMs +
// windowHours]. One extra day is included at each end as safety padding
// against timezone-boundary imprecision (a showtime just outside the padded
// dates gets picked up on the next periodic re-discovery anyway) — exact
// filtering to the real window happens afterward using each showtime's real
// datetime, not these date strings.
export function computeDateWindow(nowMs, windowHours) {
  const dayMs = 86400000;
  const startDay = Math.floor(nowMs / dayMs) - 1;
  const endDay = Math.floor((nowMs + windowHours * 3600000) / dayMs) + 1;

  const dates = [];
  for (let d = startDay; d <= endDay; d++) {
    dates.push(new Date(d * dayMs).toISOString().slice(0, 10));
  }
  return dates;
}

// Keep only showtimes starting within [nowMs, nowMs + windowHours], dropping
// ones that have already started or that are further out than the window.
export function filterWithinWindow(showtimes, nowMs, windowHours) {
  const endMs = nowMs + windowHours * 3600000;
  return showtimes.filter((st) => {
    const startMs = Date.parse(st.datetime);
    return !Number.isNaN(startMs) && startMs > nowMs && startMs <= endMs;
  });
}

// --- in-page extraction ------------------------------------------------------

function extractShowtimeCandidatesInPage() {
  const anchors = Array.from(document.querySelectorAll('a[href^="/showtimes/"]'));
  const seen = new Set();
  const candidates = [];

  for (const a of anchors) {
    const match = (a.getAttribute("href") || "").match(/^\/showtimes\/(\d+)$/);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const describedBy = a.getAttribute("aria-describedby") || "";
    const timeEl = a.querySelector("time[datetime]");
    const datetime = timeEl ? timeEl.getAttribute("datetime") : null;

    candidates.push({ id, describedBy, datetime });
  }
  return candidates;
}

// --- live discovery ----------------------------------------------------------

const dateUrl = (baseUrl, date) => {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}date=${date}`;
};

export async function discoverForDate(context, config, date) {
  const url = dateUrl(config.theatreShowtimesUrl, date);
  const page = await context.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    const status = resp ? resp.status() : 0;
    if (status !== 200) {
      const bodyText = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 500) : ""));
      return { date, url, status, blocked: true, bodyText, matches: [] };
    }
    await page.waitForTimeout(5000); // client-rendered content

    const candidates = await page.evaluate(extractShowtimeCandidatesInPage);
    const matched = matchShowtimeCards(candidates, {
      movieTitle: config.movieTitle,
      theatreName: config.theatreName,
      format: config.format,
      requireFormatMatch: config.requireFormatMatch,
    });
    return { date, url, status, blocked: false, candidateCount: candidates.length, matches: matched };
  } finally {
    await page.close();
  }
}

// Discover across a rolling window (e.g. "next 72 hours") instead of explicit
// dates: computes the calendar dates spanning the window, discovers each,
// merges + dedupes, then filters precisely to showtimes that both haven't
// started yet AND fall within windowHours from now.
export async function discoverWindow(context, config, { windowHours, nowMs }) {
  const dates = computeDateWindow(nowMs, windowHours);
  const perDate = [];
  const allMatches = [];
  for (const date of dates) {
    const result = await discoverForDate(context, config, date);
    perDate.push(result);
    if (!result.blocked) allMatches.push(...result.matches);
  }
  const deduped = dedupeShowtimes(allMatches);
  const withinWindow = filterWithinWindow(deduped, nowMs, windowHours).map((m) => ({
    id: m.id,
    datetime: m.datetime,
  }));
  // config.scheduleFilter narrows real AMC availability down to the days/times
  // the user actually wants (e.g. "no 2am/6am, weekdays only 6pm, Friday
  // 6pm+10pm too") — a no-op when no filter is configured.
  const showtimes = applyScheduleFilter(withinWindow, config.scheduleFilter);
  return { perDate, showtimes };
}

// Merge discovered ids for one or more explicit dates and, if write=true,
// replace config.json's showtimes with the result (SKILL.md: "resolve at the
// start of the day"). Returns the combined showtimes list either way.
export async function discoverAndUpdateConfig(context, config, dates, { write = false } = {}) {
  const allMatches = [];
  const perDate = [];
  for (const date of dates) {
    const result = await discoverForDate(context, config, date);
    perDate.push(result);
    if (!result.blocked) allMatches.push(...result.matches);
  }
  const combined = dedupeShowtimes(allMatches).map((m) => ({ id: m.id, datetime: m.datetime }));

  if (write && combined.length > 0) {
    await writeShowtimesToConfig(combined);
  }

  return { perDate, combined };
}

export async function writeShowtimesToConfig(showtimes) {
  const configPath = path.join(ROOT, "config.json");
  const fresh = JSON.parse(await fs.readFile(configPath, "utf8"));
  fresh.showtimes = showtimes;
  delete fresh.showtimeIds; // superseded by the richer {id, datetime} shape
  await fs.writeFile(configPath, JSON.stringify(fresh, null, 2) + "\n", "utf8");
}

// --- CLI ---------------------------------------------------------------------
// Usage:
//   node src/discover.js 2026-07-25 [2026-07-26 ...] [--write]   (explicit dates)
//   node src/discover.js --hours=72 [--write]                    (rolling window)

async function main() {
  loadEnv();
  const config = await loadConfig();
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const hoursArg = args.find((a) => a.startsWith("--hours="));
  const dates = args.filter((a) => a !== "--write" && !a.startsWith("--hours="));

  const context = await openContext(config);
  try {
    if (hoursArg) {
      const windowHours = Number(hoursArg.split("=")[1]);
      const nowMs = Date.now();
      const { perDate, showtimes } = await discoverWindow(context, config, { windowHours, nowMs });
      for (const r of perDate) {
        if (r.blocked) {
          console.log(`  ${r.date}: BLOCKED (status ${r.status}) — ${r.url}`);
          console.log(`    ${r.bodyText.split("\n")[0]}`);
        } else {
          console.log(`  ${r.date}: ${r.matches.length} matching showtime(s) of ${r.candidateCount} candidates (before window filtering)`);
        }
      }
      console.log(`\n${showtimes.length} showtime(s) within the next ${windowHours}h:`);
      for (const s of showtimes) console.log(`  - ${s.id}  (${s.datetime})`);
      if (write) {
        await writeShowtimesToConfig(showtimes);
        console.log("\nconfig.json updated (config.showtimes).");
      } else {
        console.log("\nDry run — config.json NOT modified (pass --write to save).");
      }
      return;
    }

    if (dates.length === 0) {
      console.error(
        "Usage: node src/discover.js YYYY-MM-DD [YYYY-MM-DD ...] [--write]\n" +
          "   or: node src/discover.js --hours=72 [--write]"
      );
      process.exit(1);
    }

    const { perDate, combined } = await discoverAndUpdateConfig(context, config, dates, { write });
    for (const r of perDate) {
      if (r.blocked) {
        console.log(`  ${r.date}: BLOCKED (status ${r.status}) — ${r.url}`);
        console.log(`    ${r.bodyText.split("\n")[0]}`);
      } else {
        console.log(`  ${r.date}: found ${r.matches.length} matching showtime(s) of ${r.candidateCount} candidates`);
        for (const m of r.matches) console.log(`    - ${m.id}  (${m.datetime || "unknown time"})`);
      }
    }
    console.log(`\nCombined unique showtimes: ${combined.map((s) => s.id).join(", ") || "(none)"}`);
    console.log(write ? "config.json updated." : "Dry run — config.json NOT modified (pass --write to save).");
  } finally {
    await context.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
}
