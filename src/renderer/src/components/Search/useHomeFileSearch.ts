// Quick Open's "Elsewhere on this computer": asks main for files under the
// home folder whose name matches the (already debounced) query. Main runs one
// search per window and cancels the previous one; this keeps only the answer
// to the latest query, so a slow early search never replaces a newer list.

import { useEffect, useRef, useState } from "react";
import type { HomeFileHit } from "@shared/types";

/** Same floor as main's planHomeQuery: one letter matches half the disk. */
export const HOME_QUERY_MIN = 2;

export function homeQueryQualifies(query: string): boolean {
  return query.trim().length >= HOME_QUERY_MIN;
}

export interface HomeFileSearchState {
  /** The query `hits` answer; "" before any answer. */
  query: string;
  status: "idle" | "searching" | "done" | "error";
  hits: HomeFileHit[];
  truncated: boolean;
  error: string | null;
}

const IDLE: HomeFileSearchState = { query: "", status: "idle", hits: [], truncated: false, error: null };

export function useHomeFileSearch(
  open: boolean,
  enabled: boolean,
  query: string,
  excludeRoot: string | null,
): HomeFileSearchState {
  const [state, setState] = useState<HomeFileSearchState>(IDLE);
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    if (!open || !enabled || !homeQueryQualifies(query)) {
      setState(IDLE);
      return;
    }
    // The previous list stays on screen until the new one lands, as in
    // Spotlight; only the status says a search is running.
    setState((prev) => ({ ...prev, status: "searching", error: null }));
    window.spark.fs.searchHome(query, excludeRoot).then(
      (result) => {
        if (seqRef.current !== seq || result.cancelled) return;
        if (result.disabled) {
          setState(IDLE);
          return;
        }
        setState({ query, status: "done", hits: result.hits, truncated: result.truncated, error: null });
      },
      (error) => {
        if (seqRef.current !== seq) return;
        setState({ query, status: "error", hits: [], truncated: false, error: (error as Error)?.message || String(error) });
      },
    );
  }, [open, enabled, query, excludeRoot]);

  useEffect(() => {
    if (open) return;
    seqRef.current += 1;
    void window.spark.fs.cancelHomeSearch().catch(() => undefined);
  }, [open]);

  return state;
}
