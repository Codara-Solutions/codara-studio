import { useEffect, useRef, useState } from "react";
import type { SelectionPayload } from "../../routing/SelectionRoutingContext";

export function useSelectionCopy() {
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async (prepare: () => SelectionPayload | null | Promise<SelectionPayload | null>) => {
    if (pending.current) return;
    pending.current = true;
    setCopying(true);
    setCopied(false);
    setCopyError(null);
    if (timer.current) clearTimeout(timer.current);
    try {
      const payload = await prepare();
      if (!payload) throw new Error("Could not prepare the selection. Please try again.");
      await window.spark.clipboard.writeText(payload.text);
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : "Could not copy the selection.");
    } finally {
      pending.current = false;
      setCopying(false);
    }
  };
  return { copy, copying, copied, copyError };
}
