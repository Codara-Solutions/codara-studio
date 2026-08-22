/** Normalized fill for the composer context gauge. */
export function contextMeterRatio(used: number, budget: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(budget) || used <= 0 || budget <= 0) {
    return 0;
  }
  return Math.min(1, used / budget);
}
