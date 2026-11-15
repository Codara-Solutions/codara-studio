import React, { Suspense, lazy, useEffect, useState } from "react";

// Opens Send feedback when anything dispatches "spark:open-feedback" (the
// feedback.open command, Settings > About). App loads this host after boot.

const FeedbackDialog = lazy(() => import("./FeedbackDialog"));

export default function FeedbackHost(): React.ReactElement | null {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const show = (): void => setOpen(true);
    window.addEventListener("spark:open-feedback", show);
    return () => window.removeEventListener("spark:open-feedback", show);
  }, []);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <FeedbackDialog onClose={() => setOpen(false)} />
    </Suspense>
  );
}
