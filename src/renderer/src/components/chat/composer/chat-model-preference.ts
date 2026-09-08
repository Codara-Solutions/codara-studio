let cachedModel: string | undefined;
let cacheResolved = false;
let loadPromise: Promise<string | undefined> | null = null;
let selectionVersion = 0;

function normalizedModel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Return the latest in-process pick so a new draft can seed synchronously. */
export function peekPreferredChatModel(): string | undefined {
  return cachedModel;
}

/** Load the persisted pick without allowing a late read to replace a newer pick. */
export function loadPreferredChatModel(): Promise<string | undefined> {
  if (cacheResolved) return Promise.resolve(cachedModel);
  if (loadPromise) return loadPromise;
  const versionAtLoad = selectionVersion;
  loadPromise = window.spark.preferences
    .load()
    .then((preferences) => {
      if (selectionVersion === versionAtLoad) {
        cachedModel = normalizedModel(preferences.coraChatModel);
      }
      cacheResolved = true;
      return cachedModel;
    })
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
}

/** Remember an explicit picker choice before its disk write completes. */
export function persistPreferredChatModel(model: string): Promise<void> {
  const normalized = normalizedModel(model);
  if (!normalized) return Promise.resolve();
  selectionVersion += 1;
  cachedModel = normalized;
  cacheResolved = true;
  return window.spark.preferences.set("coraChatModel", normalized).then(() => undefined);
}
