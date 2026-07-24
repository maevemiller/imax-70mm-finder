// Pure, deterministic seat logic — no browser, no network, fully unit-testable.
// Ports the detection/adjacency rules from the original amc-seat-watch SKILL.md (section 3).

// Parse an AMC seat id like "F12" or "AA3" into { row, num, raw }.
// Row is the leading letters, num is the trailing integer.
export function parseSeatId(id) {
  const match = String(id).trim().match(/^([A-Za-z]+)\s*0*(\d+)$/);
  if (!match) return null;
  return { row: match[1].toUpperCase(), num: parseInt(match[2], 10), raw: id };
}

// Canonical sort: by row (alphabetical), then seat number (ascending).
export function sortSeats(seatIds) {
  return seatIds
    .map(parseSeatId)
    .filter(Boolean)
    .sort((a, b) => (a.row < b.row ? -1 : a.row > b.row ? 1 : a.num - b.num));
}

// Group parsed seats by row into arrays, each sorted by number.
function groupByRow(parsedSeats) {
  const rows = new Map();
  for (const seat of parsedSeats) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }
  for (const seats of rows.values()) seats.sort((a, b) => a.num - b.num);
  return rows;
}

// Split a row (array of parsed seats, sorted by num) into runs of consecutive
// seat numbers. Example: [1,2,3,7,8] -> [[1,2,3],[7,8]].
function consecutiveRuns(rowSeats) {
  const runs = [];
  let current = [];
  for (const seat of rowSeats) {
    if (current.length === 0 || seat.num === current[current.length - 1].num + 1) {
      current.push(seat);
    } else {
      runs.push(current);
      current = [seat];
    }
  }
  if (current.length) runs.push(current);
  return runs;
}

// Keep only seats that belong to a same-row consecutive run of at least
// `minSize` seats. With minSize=1 every available seat qualifies; with
// minSize=2 a solo seat with no neighbour is dropped. Returns raw seat ids,
// canonically sorted.
export function filterAdjacent(seatIds, minSize = 1) {
  const parsed = sortSeats(seatIds);
  if (minSize <= 1) return parsed.map((s) => s.raw);

  const rows = groupByRow(parsed);
  const kept = [];
  for (const rowSeats of rows.values()) {
    for (const run of consecutiveRuns(rowSeats)) {
      if (run.length >= minSize) kept.push(...run);
    }
  }
  return sortSeats(kept.map((s) => s.raw)).map((s) => s.raw);
}
