// Quick Open's path mode: asks main for the entries of the folder a typed path
// names. As with the home search, main runs one listing per window and this
// keeps only the answer to the latest query.

import { useEffect, useRef, useState } from "react";
import type { PathQueryHit } from "@shared/types";

export interface PathQueryState {
  /** The query `hits` answer; "" before any answer. */
  query: string;
  status: "idle" | "searching" | "done" | "error";
  hits: PathQueryHit[];
  truncated: boolean;
  missing: boolean;
  message: string | null;
  error: string | null;
}

const IDLE: PathQueryState = { query: "", status: "idle", hits: [], truncated: false, missing: false, message: null, error: null };

export function usePathQuery(open: boolean, enabled: boolean, query: string, cwd: string | null): PathQueryState {
  const [state, setState] = useState<PathQueryState>(IDLE);
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    if (!open || !enabled) {
      setState(IDLE);
      return;
    }
    setState((prev) => ({ ...prev, status: "searching", error: null }));
    window.spark.fs.searchPath(query, cwd).then(
      (result) => {
        if (seqRef.current !== seq || result.cancelled) return;
        if (result.disabled) {
          setState(IDLE);
          return;
        }
        setState({
          query,
          status: "done",
          hits: result.hits,
          truncated: result.truncated,
          missing: result.missing === true,
          message: result.message ?? null,
          error: null,
        });
      },
      (error) => {
        if (seqRef.current !== seq) return;
        setState({ ...IDLE, query, status: "error", error: (error as Error)?.message || String(error) });
      },
    );
  }, [open, enabled, query, cwd]);

  useEffect(() => {
    if (open) return;
    seqRef.current += 1;
    // Runs on mount, and the panel is always mounted: a preload that predates
    // this call under `npm run dev` must not take the window down.
    void window.spark.fs.cancelPathSearch?.().catch(() => undefined);
  }, [open]);

  return state;
}
