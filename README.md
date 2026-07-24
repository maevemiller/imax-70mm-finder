# imax-70mm-finder

Help find IMAX 70mm tickets. Watches an AMC showtime's seat map and sends you
a **Telegram** message with a screenshot the moment seats matching your rules
become available (e.g. *two seats together* for a specific IMAX 70mm showing).

This is a Windows port of the macOS/Hermes project
[ddinch/amc-seat-watch](https://github.com/ddinch/amc-seat-watch). The seat
detection and alert rules are the same; scheduling and alerts are adapted for
Windows and Telegram.

> **New to this?** Follow the steps in order. Each command is run in a terminal
> (Windows Terminal or PowerShell) from inside this folder.

---

## What you need once

1. **Node.js** (already installed — v20+).
2. **A Telegram bot** (free, ~5 minutes — steps below).

---

## Step 1 — Install

Open a terminal in this folder and run:

```powershell
npm install
npx playwright install chromium
```

(Both may already be done.)

## Step 2 — Create your Telegram bot

1. In Telegram, message **@BotFather**. Send `/newbot` and follow the prompts.
2. It gives you a **token** like `123456789:AAExampleTokenString`. Copy it.
3. Send any message to your new bot (search its username, tap Start, say "hi").
4. Get your **chat id**: open this URL in a browser, replacing `<TOKEN>`:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   Look for `"chat":{"id":123456789` — that number is your chat id.

Now copy `.env.example` to `.env` and fill both values:

```
TELEGRAM_BOT_TOKEN=123456789:AAExampleTokenString
TELEGRAM_CHAT_ID=123456789
```

The `.env` file is private and never committed.

## Step 3 — Fill in `config.json`

Go to amctheatres.com, find your theatre's own page (not a movie's
cross-theatre listing — see the note below), and copy its URL.

Edit `config.json`:

| Field            | What to put                                                        |
| ---------------- | ------------------------------------------------------------------ |
| `movieTitle`     | Exact title shown on the page, e.g. `"The Odyssey"`                 |
| `format`         | e.g. `"IMAX 70MM"` (or `""` if you don't care about format)        |
| `theatreName`    | Exact theatre name shown on the page                                |
| `theatreShowtimesUrl` | The theatre's own showtimes page, e.g. `https://www.amctheatres.com/movie-theatres/.../amc-lincoln-square-13/showtimes` |
| `minAdjacent`    | `1` = any seat; `2` = two together; `3` = three together, etc.      |
| `requireFormatMatch` | `true` to only accept pages whose text contains `format`.      |
| `firstRunHeadful`| `true` shows the browser window (needed to clear Cloudflare once).  |

> **Note:** the *theatre's own* page is required — a movie's cross-theatre
> listing page (e.g. `amctheatres.com/movies/.../showtimes`) doesn't work
> standalone; it needs a location/theatre selected first, which our isolated
> browser profile has no way to provide.

> **Tip:** getting the exact `movieTitle` / `theatreName` text right matters —
> the watcher checks the page really is the showing you meant. If it warns about
> a "metadata mismatch", copy the wording straight off the seat page.

> **Important — AMC's seat pages are rate-limited more aggressively than the
> rest of the site.** During testing, a handful of rapid requests to
> `/showtimes/{id}/seats` triggered a temporary ban (Cloudflare "Error 1015"),
> and repeating the mistake too soon made the ban *longer* each time. The
> cadence settings below are a conservative starting point based on limited
> testing, not a confirmed-safe rate. If you see `[block]` lines in the logs,
> you're going too fast — raise the numbers.

## How showtimes are found and checked

By default (`autoDiscover.enabled: true` in `config.json`), you don't manage
showtime IDs at all — the watcher finds them itself:

- On startup, and again every `autoDiscover.refreshHours` (default 6), it
  re-scans the theatre's page for real showtimes matching your movie/format,
  for a rolling window of `autoDiscover.windowHours` (default 72h) from now.
- Showtimes are dropped automatically once they start — no stale/expired ids
  to clean up by hand.
- **Two check tiers**, based on how soon a showtime starts:
  - `nearCadenceSeconds` (default 300 = 5 min) for anything under
    `nearWindowHours` (default 24h) away.
  - `farCadenceSeconds` (default 1800 = 30 min) for the rest of the window.
  - A cheap `heartbeatSeconds` (default 60) tick decides what's due — the
    actual AMC requests only happen when a showtime's own cadence says so.

Turn this off (`autoDiscover.enabled: false`) to instead use a fixed,
hand-maintained list — set `config.showtimeIds` to an array of ids from seat
URLs (`amctheatres.com/showtimes/71234567/seats` → `"71234567"`). Every
showtime in that list always uses the near (faster) cadence, since there's no
known start time to judge by.

You can also run discovery manually as a one-off check:

```powershell
node src/discover.js --hours=72          # dry run, prints what it would find
node src/discover.js --hours=72 --write  # saves the result into config.json
node src/discover.js 2026-07-25 --write  # or target specific date(s) instead
```

## Step 4 — Test the pieces

Run the built-in logic tests (no internet needed):

```powershell
npm test
```

Then a single live scan. The first time, a **browser window opens** — if AMC
shows a Cloudflare "verify you are human" check, complete it in that window. It
won't ask again (the session is remembered).

```powershell
npm run scan
```

Read the log line it prints — it tells you how many seats it saw, how many
qualified, and whether it sent an alert.

## Step 5 — Watch continuously

```powershell
npm run watch
```

It discovers and checks showtimes on the tiered cadence described above, and
sends a Telegram alert when qualifying seats appear. Leave the terminal open.
Press **Ctrl+C** to stop.

> Keep your PC awake while watching (it can't check while asleep). You can set
> Windows to not sleep in Settings → System → Power.

---

## How it decides to alert

- Alerts the **first time** qualifying seats appear.
- Alerts again when **new** qualifying seats show up.
- Stays quiet when seats only **disappear** or nothing changed.
- If seats vanish and later **come back**, it alerts again.

"Qualifying" means: available ordinary seats (wheelchair/companion/accessible
seats are ignored) that form a same-row run of at least `minAdjacent`.

## Files

- `config.json` — what to watch.
- `.env` — your Telegram secrets (private).
- `src/seats.js` — seat parsing + adjacency (the tested core logic).
- `src/state.js` — remembers seats between scans; decides when to alert.
- `src/scan.js` — one scan (open page, detect seats, screenshot, notify) + the global rate-limit pacer.
- `src/discover.js` — finds real showtime IDs from the theatre's listing page, including the rolling-window mode.
- `src/schedule.js` — decides which showtimes are due for a check (near/far cadence tiers).
- `src/notify.js` — sends the Telegram message + photo.
- `src/watch.js` — the long-running loop: refreshes discovery, checks due showtimes.
- `test/` — unit tests, plus `test/fixtures/` (real saved AMC pages used to verify detection/discovery logic offline).

## Troubleshooting

- **"Missing TELEGRAM_BOT_TOKEN…"** — you haven't created/filled `.env` yet.
- **"metadata mismatch"** — the `movieTitle`/`theatreName`/`format` in
  `config.json` doesn't match the page text. Copy the exact wording.
- **"blocked / rate-limited"** — AMC's Cloudflare stepped in. Run `npm run scan`
  once with the visible window to clear the check, and/or raise
  `interShowtimeDelaySeconds` / `nearCadenceSeconds` / `farCadenceSeconds`.
- **Sees 0 seats on a page that clearly has some** — AMC changed their page
  markup. The detection lives in `extractSeatsInPage()` in `src/scan.js`; that's
  the spot to adjust (or ask Claude Code to update it against a saved page).
