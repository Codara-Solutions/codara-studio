import { useEffect, useMemo, useRef, useState } from "react";
import { collisionText, type LaneCollisions } from "@shared/lane-collisions";
import { isRemotePath } from "@shared/remote";
import type { SourceLane, SourceLanes } from "@shared/source-lanes";
import { gitReadsSettled, useGitRefresh } from "../../../git/gitRefreshClock";

// Read when the running lanes or their work change (the lanes re-read on
// focus), when a lane's git state moves (the shared clock), and otherwise at
// most this often.
const SAFETY_MS = 5 * 60_000;

function running(lane: SourceLane): boolean {
  return !lane.merged && !lane.missing && (lane.changes?.fileCount ?? 0) > 0 && !isRemotePath(lane.path);
}

/** The warning line of each running lane, by folder; empty until two have work. */
export function useLaneCollisions(lanes: SourceLanes): Record<string, string> {
  const inPlay = useMemo(() => [...lanes.others, ...(lanes.own ? [lanes.own] : [])].filter(running), [lanes.others, lanes.own]);
  const paths = inPlay.map((lane) => lane.path).join("\n");
  // A commit usually changes these, so a new clash shows without waiting for the poll.
  const work = inPlay.map((lane) => `${lane.changes?.additions}/${lane.changes?.deletions}`).join(",");
  const [collisions, setCollisions] = useState<LaneCollisions>({});
  const lastReadAt = useRef(0);
  const readRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const wanted = paths ? paths.split("\n") : [];
    if (wanted.length < 2) {
      setCollisions({});
      return;
    }
    let cancelled = false;
    const read = () => {
      if (document.hidden) return;
      lastReadAt.current = Date.now();
      void window.spark.git.laneCollisions(wanted).then(
        (next) => {
          if (!cancelled) setCollisions(next);
        },
        () => undefined,
      );
    };
    readRef.current = read;
    read();
    return () => {
      cancelled = true;
      if (readRef.current === read) readRef.current = null;
    };
  }, [paths, work]);

  useGitRefresh(paths ? paths.split("\n") : [], true, (changed, reason) => {
    if (changed.length > 0 || (reason === "tick" && Date.now() - lastReadAt.current >= SAFETY_MS && gitReadsSettled())) readRef.current?.();
  });

  return useMemo(() => {
    const nameOf = (path: string) => inPlay.find((lane) => lane.path === path)?.branch ?? "another lane";
    const out: Record<string, string> = {};
    for (const lane of inPlay) {
      const text = collisionText(collisions[lane.path], nameOf);
      if (text) out[lane.path] = text;
    }
    return out;
  }, [collisions, inPlay]);
}
