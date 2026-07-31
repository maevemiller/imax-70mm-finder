// Ranks available seats by how "central" they are in the auditorium — pure,
// no browser/network, fully unit-testable. With minAdjacent now as low as 1,
// a scan can find many available seats at once; this picks out the best ones
// to actually recommend rather than just dumping a raw list.
//
// Heuristic (the only thing derivable from a seat map alone, no external
// knowledge of "premium" seats): prefer rows near the middle of the visible
// row range, and seats near the middle of their row's seat-number range.
// Rows are assumed lettered front-to-back (standard cinema convention), so
// "middle row" is a reasonable proxy for "good sightline."
import { parseSeatId } from "./seats.js";

// allSeatIds should include EVERY seat found on the page (available, taken,
// accessible — anything), so the row/seat-number ranges reflect the real
// shape of the auditorium, not just the (possibly sparse) available ones.
export function rankAvailableSeats(availableIds, allSeatIds) {
  const allParsed = [...allSeatIds, ...availableIds].map(parseSeatId).filter(Boolean);
  if (allParsed.length === 0) return [];

  const rowRange = new Map(); // row -> {min, max}
  for (const s of allParsed) {
    const r = rowRange.get(s.row) || { min: s.num, max: s.num };
    r.min = Math.min(r.min, s.num);
    r.max = Math.max(r.max, s.num);
    rowRange.set(s.row, r);
  }

  const rowOrder = [...rowRange.keys()].sort();
  const centerRowIdx = (rowOrder.length - 1) / 2;
  const rowIndex = new Map(rowOrder.map((r, i) => [r, i]));

  const scored = availableIds
    .map(parseSeatId)
    .filter(Boolean)
    .map((seat) => {
      const idx = rowIndex.get(seat.row) ?? centerRowIdx;
      const rowSpan = Math.max(rowOrder.length - 1, 1);
      const rowScore = Math.abs(idx - centerRowIdx) / rowSpan;

      const range = rowRange.get(seat.row) || { min: seat.num, max: seat.num };
      const seatCenter = (range.min + range.max) / 2;
      const seatSpan = Math.max((range.max - range.min) / 2, 1);
      const seatScore = Math.abs(seat.num - seatCenter) / seatSpan;

      return { id: seat.raw, row: seat.row, num: seat.num, score: rowScore + seatScore };
    });

  scored.sort((a, b) => a.score - b.score || a.row.localeCompare(b.row) || a.num - b.num);
  return scored;
}

// Convenience: just the top N seat ids, best first.
export function bestSeats(availableIds, allSeatIds, count = 3) {
  return rankAvailableSeats(availableIds, allSeatIds)
    .slice(0, count)
    .map((s) => s.id);
}

// Finds the single best block of `blockSize` CONSECUTIVE seats (same row,
// adjacent numbers) — not just the top-N individually-ranked seats, which
// aren't guaranteed to sit together. Scores each candidate block the same
// way as rankAvailableSeats (row centrality + how centered the block's own
// midpoint is within its row), and returns the winning block's seat ids in
// order, or null if no run of at least `blockSize` exists anywhere.
export function bestConsecutiveBlock(availableIds, allSeatIds, blockSize = 4) {
  const allParsed = [...allSeatIds, ...availableIds].map(parseSeatId).filter(Boolean);
  if (allParsed.length === 0) return null;

  const rowRange = new Map();
  for (const s of allParsed) {
    const r = rowRange.get(s.row) || { min: s.num, max: s.num };
    r.min = Math.min(r.min, s.num);
    r.max = Math.max(r.max, s.num);
    rowRange.set(s.row, r);
  }
  const rowOrder = [...rowRange.keys()].sort();
  const centerRowIdx = (rowOrder.length - 1) / 2;
  const rowIndex = new Map(rowOrder.map((r, i) => [r, i]));
  const rowSpan = Math.max(rowOrder.length - 1, 1);

  const byRow = new Map();
  for (const seat of availableIds.map(parseSeatId).filter(Boolean)) {
    if (!byRow.has(seat.row)) byRow.set(seat.row, []);
    byRow.get(seat.row).push(seat);
  }
  for (const arr of byRow.values()) arr.sort((a, b) => a.num - b.num);

  let best = null;
  for (const [row, seats] of byRow) {
    const runs = [];
    let run = [];
    for (const s of seats) {
      if (run.length === 0 || s.num === run[run.length - 1].num + 1) run.push(s);
      else {
        runs.push(run);
        run = [s];
      }
    }
    if (run.length) runs.push(run);

    const range = rowRange.get(row) || { min: seats[0].num, max: seats[0].num };
    const rowRealCenter = (range.min + range.max) / 2;
    const seatSpan = Math.max((range.max - range.min) / 2, 1);
    const idx = rowIndex.get(row) ?? centerRowIdx;
    const rowScore = Math.abs(idx - centerRowIdx) / rowSpan;

    for (const r of runs) {
      if (r.length < blockSize) continue;
      for (let i = 0; i + blockSize <= r.length; i++) {
        const window = r.slice(i, i + blockSize);
        const windowCenter = (window[0].num + window[window.length - 1].num) / 2;
        const seatScore = Math.abs(windowCenter - rowRealCenter) / seatSpan;
        const score = rowScore + seatScore;
        if (best === null || score < best.score) {
          best = { seats: window.map((s) => s.raw), score };
        }
      }
    }
  }

  return best ? best.seats : null;
}
