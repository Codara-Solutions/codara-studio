// Pi 1.5.1 changed its default cache warming from "streaming" to "idle": it
// also re-sends a cached prompt between runs, for up to 30 minutes after each
// one. The cora CLI keeps "streaming" (nothing between runs, cost-aware warms
// only during a run), like Studio's Pi (src/main/orchestration/pi-runtime.ts).
// A value set by hand in ~/.cora/settings.json still wins.

export const CORA_CACHE_WARMING = "streaming";

export function useStreamingCacheWarming(SettingsManager) {
  const read = SettingsManager.prototype.getCacheWarmingMode;
  if (typeof read !== "function") {
    throw new Error("this version of Pi no longer reads its cache warming setting: update cache-warming.mjs");
  }
  SettingsManager.prototype.getCacheWarmingMode = function getCacheWarmingMode() {
    return this.globalSettings?.cacheWarming === undefined ? CORA_CACHE_WARMING : read.call(this);
  };
}
