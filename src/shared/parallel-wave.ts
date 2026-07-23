/**
 * Select the largest pairwise-compatible subset of a ready worker frontier.
 *
 * A first-fit greedy selector can make orchestration slower than a direct
 * agent: if the first ready task conflicts with three mutually-compatible
 * siblings, it launches one worker instead of three. Cora batches are normally
 * small (2-9 tasks), so an exact bounded search is cheap and deterministic.
 * Pathological frontiers use a degree-ordered greedy fallback rather than an
 * exponential search.
 */

export interface CompatibleWaveOptions<T> {
  cap?: number | null;
  conflicts: (left: T, right: T) => boolean;
}

const EXACT_SEARCH_LIMIT = 20;

export function selectLargestCompatibleWave<T>(
  candidates: readonly T[],
  options: CompatibleWaveOptions<T>,
): T[] {
  if (candidates.length === 0) return [];
  const cap = normalizeCap(options.cap, candidates.length);
  if (cap === 0) return [];
  if (candidates.length > EXACT_SEARCH_LIMIT) {
    return degreeOrderedGreedy(candidates, cap, options.conflicts);
  }

  let bestIndexes: number[] = [];
  let bestIndexSum = Number.POSITIVE_INFINITY;
  const chosen: number[] = [];

  const consider = (): void => {
    const indexSum = chosen.reduce((sum, index) => sum + index, 0);
    if (
      chosen.length > bestIndexes.length ||
      (chosen.length === bestIndexes.length && indexSum < bestIndexSum) ||
      (chosen.length === bestIndexes.length &&
        indexSum === bestIndexSum &&
        lexicographicallyEarlier(chosen, bestIndexes))
    ) {
      bestIndexes = [...chosen];
      bestIndexSum = indexSum;
    }
  };

  const visit = (index: number): void => {
    consider();
    if (chosen.length >= cap || index >= candidates.length) return;
    const remainingCapacity = Math.min(cap - chosen.length, candidates.length - index);
    if (chosen.length + remainingCapacity < bestIndexes.length) return;

    const candidate = candidates[index];
    const compatible = chosen.every(
      (selectedIndex) => !options.conflicts(candidates[selectedIndex], candidate),
    );
    if (compatible) {
      chosen.push(index);
      visit(index + 1);
      chosen.pop();
    }
    visit(index + 1);
  };

  visit(0);
  return bestIndexes.map((index) => candidates[index]);
}

function normalizeCap(rawCap: number | null | undefined, length: number): number {
  if (rawCap === null || rawCap === undefined) return length;
  if (!Number.isFinite(rawCap)) return length;
  return Math.max(0, Math.min(length, Math.floor(rawCap)));
}

function lexicographicallyEarlier(left: readonly number[], right: readonly number[]): boolean {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return left.length < right.length;
}

function degreeOrderedGreedy<T>(
  candidates: readonly T[],
  cap: number,
  conflicts: (left: T, right: T) => boolean,
): T[] {
  const ranked = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      degree: candidates.reduce(
        (count, other, otherIndex) =>
          count + (index !== otherIndex && conflicts(candidate, other) ? 1 : 0),
        0,
      ),
    }))
    .sort((left, right) => left.degree - right.degree || left.index - right.index);
  const selected: Array<{ candidate: T; index: number }> = [];
  for (const entry of ranked) {
    if (selected.some((other) => conflicts(other.candidate, entry.candidate))) continue;
    selected.push(entry);
    if (selected.length >= cap) break;
  }
  return selected.sort((left, right) => left.index - right.index).map((entry) => entry.candidate);
}
