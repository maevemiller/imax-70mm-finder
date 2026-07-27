// Pure formatting for the "are you still running?" Telegram status reply —
// no network, no Date.now() calls (nowMs is always passed in), fully
// unit-testable.

export function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Accepts either an ms timestamp (number) or an ISO datetime string — both
// work directly with the Date constructor. Local (system) time, matching the
// convention already used for console log timestamps elsewhere in the app.
export function formatClock(input) {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "unknown time";
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function summarizeResult(r) {
  const when = r.datetime ? formatClock(r.datetime) : null;
  const label = [r.showtimeId, when, r.theatreName].filter(Boolean).join(" — ");
  if (r.blocked) return `${label}: rate-limited`;
  if (r.error) return `${label}: error`;
  if (r.available) {
    return r.available.length > 0
      ? `${label}: ${r.available.length} qualifying seat(s)!`
      : `${label}: no qualifying seats`;
  }
  return `${label}: unknown`;
}

// state: {
//   startedAtMs, movieTitle, theatreNames, minAdjacent,
//   activeShowtimesCount, lastDiscoveryMs,
//   lastCheck: { atMs, results } | null,
//   backoffMs, nextAttemptAtMs,
// }
export function formatStatusMessage(state, nowMs) {
  const lines = [
    `✅ Watching "${state.movieTitle}" @ ${state.theatreNames}`,
    `Uptime: ${formatDuration(nowMs - state.startedAtMs)} | Tracking ${state.activeShowtimesCount} showtime(s) | minAdjacent=${state.minAdjacent}`,
  ];

  if (state.lastCheck) {
    const when = formatClock(state.lastCheck.atMs);
    const ago = formatDuration(nowMs - state.lastCheck.atMs);
    lines.push(`Last check: ${when} (${ago} ago)`);
    for (const r of state.lastCheck.results) lines.push(`  ${summarizeResult(r)}`);
  } else {
    lines.push("Last check: none yet");
  }

  const untilNext = formatDuration(state.nextAttemptAtMs - nowMs);
  lines.push(
    state.backoffMs > 0
      ? `⏳ Backing off after a rate-limit; next attempt in ~${untilNext}`
      : `Next attempt in ~${untilNext}`
  );

  lines.push(`Discovery last refreshed: ${formatClock(state.lastDiscoveryMs)} (${formatDuration(nowMs - state.lastDiscoveryMs)} ago)`);
  lines.push("(message me anytime for this status)");

  return lines.join("\n");
}
