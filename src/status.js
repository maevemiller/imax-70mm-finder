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

function summarizeResult(r) {
  const label = r.theatreName ? `${r.showtimeId} (${r.theatreName})` : r.showtimeId;
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
    const ago = formatDuration(nowMs - state.lastCheck.atMs);
    const summary = state.lastCheck.results.map(summarizeResult).join(", ");
    lines.push(`Last check: ${ago} ago — ${summary}`);
  } else {
    lines.push("Last check: none yet");
  }

  const untilNext = formatDuration(state.nextAttemptAtMs - nowMs);
  lines.push(
    state.backoffMs > 0
      ? `⏳ Backing off after a rate-limit; next attempt in ~${untilNext}`
      : `Next attempt in ~${untilNext}`
  );

  lines.push(`Discovery last refreshed ${formatDuration(nowMs - state.lastDiscoveryMs)} ago`);
  lines.push("(message me anytime for this status)");

  return lines.join("\n");
}
