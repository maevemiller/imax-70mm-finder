---
name: imax-70mm-finder
description: Build and operate a Windows + Telegram AMC seat-availability watcher for a specific movie, theatre, and format, with adjacent-seat filtering, automatic showtime discovery, and an optional day/time schedule filter. Based on the proven, live-tested implementation at github.com/maevemiller/imax-70mm-finder.
version: 1.0.0
---

# IMAX 70mm Finder (AMC Seat Watch)

Build a local, deterministic Node.js watcher that checks AMC seat maps and
sends a Telegram alert only when the user's exact seat-availability criteria
are met (e.g. two seats together for a specific IMAX 70mm showing). This is a
Windows-native port of the original macOS/Hermes concept
([ddinch/amc-seat-watch](https://github.com/ddinch/amc-seat-watch)), rebuilt
and live-tested against real AMC pages.

**Base repository:** https://github.com/maevemiller/imax-70mm-finder — clone
this as the starting point rather than writing the watcher from scratch. It
already contains a working, unit-tested implementation (seat detection,
adjacency filtering, rolling showtime discovery, Telegram alerts, rate-limit
pacing) plus real captured AMC page fixtures for offline testing.

## 1. Capture the monitoring specification

Ask the user for:

- Movie title (exact wording as shown on AMC's site)
- Format, e.g. `IMAX 70MM` (or blank if format doesn't matter)
- The theatre — get its **own** showtimes page URL, not a movie's
  cross-theatre listing page (see gotcha below)
- Minimum adjacent ordinary seats (`minAdjacent`, default 1; 2 = "two together")
- Discovery window (default 72h) and how far ahead to look
- Optional day/time schedule filter (e.g. "only 6pm on weeknights, more on
  weekends") — see `config.scheduleFilter` below
- Telegram alert destination (a bot they create, or reuse an existing one)

## 2. Set up a fresh watcher instance

**Important:** each watcher instance is single-target (one config.json, one
`data/` dir). For a NEW movie/theatre, clone into a **new folder** (e.g.
`~/amc-watch-<slug>`) rather than overwriting an existing working instance —
never repurpose a folder that already has a running/working watcher without
the user's explicit OK.

```powershell
git clone https://github.com/maevemiller/imax-70mm-finder.git <target-folder>
cd <target-folder>
npm install
npx playwright install chromium
```

Copy `.env.example` to `.env` and fill in `TELEGRAM_BOT_TOKEN` /
`TELEGRAM_CHAT_ID` (bot created via @BotFather; chat id from
`https://api.telegram.org/bot<TOKEN>/getUpdates` after messaging the bot once).

Edit `config.json` for the new target: `movieTitle`, `format`, `theatreName`,
`theatreShowtimesUrl`, `minAdjacent`, `scheduleFilter` (optional). Leave
`autoDiscover.enabled: true` unless the user specifically wants a hand-curated
`showtimeIds` list instead.

## 3. Known AMC behavior — read before touching AMC live

These were learned through real live testing, not guessed — treat them as
established facts, not things to re-derive from scratch:

- **The seat-selection endpoint (`/showtimes/{id}/seats`) is far more
  aggressively rate-limited than the rest of the site.** A handful of rapid
  requests triggers a temporary ban (Cloudflare "Error 1015" / HTTP 429).
  Listing/theatre pages are comparatively reliable and low-risk.
- **Retrying into an active ban makes it WORSE, not better** — observed
  `retry-after` growing from 234s to 362s across repeated hits. Never
  immediately retry a blocked seat-page request; back off and wait.
- **The movie's own cross-theatre listing page does NOT work standalone** —
  it needs a geolocated/selected theatre first ("please select a nearby
  theatre"), which an isolated browser profile can't provide. Always use the
  **theatre's own** showtimes page (`config.theatreShowtimesUrl`).
- **Real seat markup** (verified against a captured page with 480 real
  seats): each seat is
  `<input type="checkbox" name="A33" aria-label="Occupied AMC Club Rocker A33">`.
  `name` is the seat id directly. `aria-label` starts with `"Occupied "` when
  taken (absent when available). `"Wheelchair"` / `"Companion"` in the label
  marks an accessible seat — exclude regardless of availability. A `disabled`
  attribute redundantly confirms unavailability.
- **Real showtime-listing markup**: each showtime is an
  `<a href="/showtimes/{id}">` whose `aria-describedby` attribute encodes
  movie+theatre+format as slugs (e.g.
  `the-odyssey-76238-amc-lincoln-square-13-imax70mm`), with a child
  `<time datetime="...">` giving the real ISO start time.
- **Full-page screenshots can crash Playwright** on the real seat grid (an
  absurd rendered height triggers a Skia allocation error). Screenshot just
  the `[role="grid"][aria-label="Seat Selection Map"]` element instead.
- Because of all of the above, **be conservative with cadence.** The base
  repo already implements: a global pacer enforcing a minimum gap between
  every live seat-page request regardless of showtime/tick
  (`interShowtimeDelaySeconds`, default 90s), two check tiers by how soon a
  showtime starts (`nearCadenceSeconds`/`farCadenceSeconds`), a "never
  checked yet" showtime waiting one full cadence interval before its first
  check (not instantly due — avoids flooding a fresh discovery's full list),
  and an abort-the-rest-of-the-batch reaction the moment a rate-limit is
  detected. Don't remove or bypass these without a strong reason.
- **AMC-wide degradation happens** — on at least one occasion the entire
  seat-booking flow appeared broadly rate-limited/degraded for genuine human
  traffic too (confirmed across multiple IPs/devices/browsers), not just
  automated requests. If blocks persist across a properly-spaced watcher,
  properly-spaced manual browsing, AND a different network, that's likely
  AMC-side load — the fix is patience (hours), not more aggressive retrying
  or fingerprint/IP evasion. Do not attempt to evade bot-detection
  fingerprinting; that crosses from "well-behaved automated visitor" into
  territory this skill should not go.

## 4. Verification contract

Before declaring the watcher ready:

- `npm test` — the offline unit tests must pass (seat adjacency, alert
  decision rules, discovery matching, schedule filter, due-cadence logic).
- `npm run scan` once — first run opens a **visible** browser window; if AMC
  shows a Cloudflare human-check, the user completes it once and the session
  persists. Confirm real seat counts appear (not 0 candidates — that means
  the DOM selectors need re-verification against a fresh captured page).
- Confirm discovered showtimes match the user's intended movie/theatre/format
  and (if configured) schedule filter, before starting `npm run watch`.
- Send one test Telegram message/alert path to confirm delivery.
- Watch at least one real heartbeat cycle in the logs and confirm no `[block]`
  lines appear in immediate succession (a sign cadence is too aggressive for
  current conditions).
- Report partial coverage honestly — e.g. if AMC is actively rate-limiting
  during setup, say so plainly rather than declaring success prematurely.

## 5. Sharing

This skill and the base repository contain no embedded account credentials,
theatre-specific secrets, or fixed chat IDs — `.env` (Telegram credentials)
and `config.json` (the specific movie/theatre being watched) are per-instance
and never committed. A recipient clones the base repo fresh and customizes
both for their own target.
