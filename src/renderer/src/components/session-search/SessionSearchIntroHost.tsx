import { Suspense, lazy, useState } from "react";
import { useSessionSearchStatus } from "./useSessionSearchStatus";

// Shows the one-time intro once main says it is due, and only when nothing
// else is asking for the person's attention first.

const SessionSearchIntro = lazy(() => import("./SessionSearchIntro"));

export default function SessionSearchIntroHost({
  onboardingOpen,
  hasWorkspaces,
}: {
  onboardingOpen: boolean;
  hasWorkspaces: boolean;
}) {
  const { status } = useSessionSearchStatus();
  const [open, setOpen] = useState(false);
  const [closed, setClosed] = useState(false);
  if (!open && !closed && status.introPending && !onboardingOpen && hasWorkspaces) setOpen(true);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <SessionSearchIntro
        onClosed={() => {
          setOpen(false);
          setClosed(true);
        }}
      />
    </Suspense>
  );
}
