import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import {
  COMMAND_RAN_EVENT,
  FEATURE_CATALOG,
  FEATURE_USED_EVENT,
  clickSelectors,
  isCatalogFeatureId,
  type FeatureCatalogEntry,
  type FeatureTipsState,
} from "@shared/feature-tips";
import type { AppPreferences } from "@shared/types";
import { anyLaidOut } from "./feature-tips-dom";

// Turns the catalog's signals into recorded first uses. Everything is driven
// by events the person causes (a click, a command, an app event), so an idle
// window costs nothing; the on-screen check runs a moment after them.

const FLUSH_MS = 600;
const SCAN_AFTER_INPUT_MS = 1_200;

function validSelector(selector: string): boolean {
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

interface Indexes {
  clicks: { id: string; selector: string }[];
  commands: Map<string, string[]>;
  events: Map<string, string[]>;
  visible: { id: string; selector: string }[];
}

function buildIndexes(entries: readonly FeatureCatalogEntry[]): Indexes {
  const commands = new Map<string, string[]>();
  const events = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, id: string) => map.set(key, [...(map.get(key) ?? []), id]);
  const clicks: Indexes["clicks"] = [];
  const visible: Indexes["visible"] = [];
  for (const entry of entries) {
    const click = clickSelectors(entry).filter(validSelector).join(", ");
    if (click) clicks.push({ id: entry.id, selector: click });
    const shown = (entry.signals.visible ?? []).filter(validSelector).join(", ");
    if (shown) visible.push({ id: entry.id, selector: shown });
    for (const command of entry.signals.commands ?? []) add(commands, command, entry.id);
    for (const name of entry.signals.events ?? []) add(events, name, entry.id);
  }
  return { clicks, commands, events, visible };
}

export interface FeatureUsage {
  /** Ids recorded in this session but maybe not yet confirmed by main. */
  pending: MutableRefObject<Set<string>>;
  /** Features whose own surface is on screen right now. */
  inUseNow: () => Set<string>;
}

export function useFeatureUsage(
  active: boolean,
  stateRef: MutableRefObject<FeatureTipsState | null>,
  preferences: AppPreferences,
  preferencesHydrated: boolean,
): FeatureUsage {
  const pending = useRef(new Set<string>());
  const indexes = useRef<Indexes | null>(null);

  const inUseNow = useCallback(() => {
    const now = new Set<string>();
    for (const { id, selector } of indexes.current?.visible ?? []) {
      if (anyLaidOut(selector)) now.add(id);
    }
    return now;
  }, []);

  useEffect(() => {
    if (!active || !window.spark.featureTips) return;
    indexes.current ??= buildIndexes(FEATURE_CATALOG);
    const index = indexes.current;
    const sent = new Set<string>();
    let flushTimer: number | null = null;
    let scanTimer: number | null = null;

    const flush = () => {
      flushTimer = null;
      const ids = [...pending.current].filter((id) => !sent.has(id));
      if (ids.length === 0) return;
      for (const id of ids) sent.add(id);
      void window.spark.featureTips.recordUse(ids).catch(() => {
        for (const id of ids) sent.delete(id);
      });
    };
    const record = (id: unknown) => {
      if (!isCatalogFeatureId(id)) return;
      if (stateRef.current?.used[id] !== undefined || pending.current.has(id)) return;
      pending.current.add(id);
      flushTimer ??= window.setTimeout(flush, FLUSH_MS);
    };
    const scan = () => {
      scanTimer = null;
      for (const id of inUseNow()) record(id);
    };
    const scanSoon = () => {
      if (scanTimer !== null) window.clearTimeout(scanTimer);
      scanTimer = window.setTimeout(scan, SCAN_AFTER_INPUT_MS);
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target) {
        for (const { id, selector } of index.clicks) {
          if (target.closest(selector)) record(id);
        }
      }
      scanSoon();
    };
    const onCommand = (event: Event) => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      if (typeof id === "string") for (const feature of index.commands.get(id) ?? []) record(feature);
      scanSoon();
    };
    const onFeatureUsed = (event: Event) => record((event as CustomEvent<{ id?: unknown }>).detail?.id);
    const eventListeners = [...index.events].map(([name, ids]) => {
      const listener = () => {
        for (const id of ids) record(id);
        scanSoon();
      };
      window.addEventListener(name, listener);
      return () => window.removeEventListener(name, listener);
    });

    document.addEventListener("click", onClick, { capture: true, passive: true });
    window.addEventListener(COMMAND_RAN_EVENT, onCommand);
    window.addEventListener(FEATURE_USED_EVENT, onFeatureUsed);
    scanSoon();
    return () => {
      document.removeEventListener("click", onClick, { capture: true });
      window.removeEventListener(COMMAND_RAN_EVENT, onCommand);
      window.removeEventListener(FEATURE_USED_EVENT, onFeatureUsed);
      for (const off of eventListeners) off();
      if (scanTimer !== null) window.clearTimeout(scanTimer);
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      flush();
    };
  }, [active, stateRef, inUseNow]);

  useEffect(() => {
    if (!active || !preferencesHydrated || !window.spark.featureTips) return;
    const ids = FEATURE_CATALOG.filter((entry) =>
      (entry.signals.preferences ?? []).some((key) => preferences[key] === true),
    )
      .map((entry) => entry.id)
      .filter((id) => stateRef.current?.used[id] === undefined && !pending.current.has(id));
    if (ids.length === 0) return;
    for (const id of ids) pending.current.add(id);
    void window.spark.featureTips.recordUse(ids).catch(() => undefined);
  }, [active, preferences, preferencesHydrated, stateRef]);

  return useMemo(() => ({ pending, inUseNow }), [inUseNow]);
}
