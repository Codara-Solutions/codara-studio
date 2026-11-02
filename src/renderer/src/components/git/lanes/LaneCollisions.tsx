import { useEffect, useMemo, useState } from "react";
import { collisionText, type LaneCollisions } from "@shared/lane-collisions";
import { isRemotePath } from "@shared/remote";
import type { SourceLane, SourceLanes } from "@shared/source-lanes";

const POLL_MS = 30_000;

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

  useEffect(() => {
    const wanted = paths ? paths.split("\n") : [];
    if (wanted.length < 2) {
      setCollisions({});
      return;
    }
    let cancelled = false;
    const read = () => {
      if (document.hidden) return;
      void window.spark.git.laneCollisions(wanted).then(
        (next) => {
          if (!cancelled) setCollisions(next);
        },
        () => undefined,
      );
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    window.addEventListener("focus", read);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [paths, work]);

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
