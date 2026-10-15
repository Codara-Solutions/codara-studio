import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { placeInCorner } from "@shared/feature-tips";
import { OnboardingCoach } from "../onboarding/OnboardingCoach";
import { CloseIcon } from "../icons";
import { avoidedBoxes, blockingSurfaceOpen, chromeInsets, TIPS_LAYER_ATTRIBUTE } from "./feature-tips-dom";

// The one tip on screen: the onboarding coach card, small, in a corner that
// covers neither the composer, a toast nor anything open. While a dialog or
// menu is open it steps aside, and comes back when that closes.

const MARGIN = 16;
const RECHECK_MS = 1_000;

export interface TipText {
  title: string;
  body: string;
}

interface Props {
  id: string;
  text: TipText;
  /** "Show me": the tip has a tour. */
  onTour?: () => void;
  /** A button that opens where the feature lives. */
  openLabel?: string;
  onOpen?: () => void;
  onDismiss: () => void;
  onTurnOff: () => void;
}

export function FeatureTipCard({ id, text, onTour, openLabel, onOpen, onDismiss, onTurnOff }: Props) {
  const cardRef = useRef<HTMLElement>(null);
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null);

  const place = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;
    if (blockingSurfaceOpen()) {
      setSpot(null);
      return;
    }
    const insets = chromeInsets();
    const next = placeInCorner({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      size: { width: card.offsetWidth, height: card.offsetHeight },
      avoid: avoidedBoxes(),
      margin: MARGIN,
      topInset: insets.top,
      bottomInset: insets.bottom,
    });
    setSpot((current) =>
      current && next && current.left === next.left && current.top === next.top ? current : next,
    );
  }, []);

  useLayoutEffect(place, [place, text]);

  useEffect(() => {
    let frame = 0;
    const soon = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    // Whatever might open a dialog or grow the composer is followed at once;
    // the slow timer catches what opens on its own.
    const events = ["resize", "keyup", "input", "pointerup", "focusin", "transitionend"] as const;
    for (const name of events) window.addEventListener(name, soon, true);
    const timer = window.setInterval(place, RECHECK_MS);
    return () => {
      for (const name of events) window.removeEventListener(name, soon, true);
      window.clearInterval(timer);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [place]);

  const hidden = spot === null;
  return (
    <div {...{ [TIPS_LAYER_ATTRIBUTE]: "" }} className="feature-tips-layer">
      <OnboardingCoach
        ref={cardRef}
        label={`Tip: ${text.title}`}
        className="feature-tip spark-glass--strong spark-overlay-surface"
        style={
          hidden
            ? { visibility: "hidden", left: 0, top: 0 }
            : { left: spot.left, top: spot.top }
        }
        eyebrow="TIP"
        title={text.title}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onDismiss();
        }}
        actions={
          <>
            {onTour && (
              <button type="button" className="spark-btn onboarding-primary" onClick={onTour}>
                Show me
              </button>
            )}
            {!onTour && onOpen && openLabel && (
              <button type="button" className="spark-btn onboarding-primary" onClick={onOpen}>
                {openLabel}
              </button>
            )}
            <button type="button" className="spark-btn" onClick={onDismiss}>
              Got it
            </button>
            <button type="button" className="feature-tip__off" onClick={onTurnOff}>
              Don't show tips
            </button>
          </>
        }
      >
        <p>{text.body}</p>
        <button
          type="button"
          className="feature-tip__close"
          aria-label="Close tip"
          title="Close tip"
          data-tip-id={id}
          onClick={onDismiss}
        >
          <CloseIcon size={11} />
        </button>
      </OnboardingCoach>
    </div>
  );
}
