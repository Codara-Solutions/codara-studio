import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { placeBeside, placeInCorner, type Box, type FeatureTipPlacement } from "@shared/feature-tips";
import { OnboardingCoach } from "../onboarding/OnboardingCoach";
import {
  TIPS_LAYER_ATTRIBUTE,
  TOUR_TARGET_ATTRIBUTE,
  avoidedBoxes,
  chromeInsets,
  elementBox,
  firstOnScreen,
} from "./feature-tips-dom";

// A short tour from a tip: the onboarding coach, placed beside the real
// control with a ring around it. The control is the real one: clicking it
// does what it always does and ends the tour (or moves to the next step).

export interface TourStepText {
  target: string;
  title: string;
  body: string;
  placement?: FeatureTipPlacement;
}

interface Props {
  name: string;
  steps: TourStepText[];
  onClose: () => void;
}

const RING_PAD = 4;
const GAP = 14;
const MARGIN = 12;
const FOLLOW_MS = 250;

function sameBox(a: Box | null, b: Box | null): boolean {
  return (
    a === b ||
    (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height)
  );
}

export function FeatureTour({ name, steps, onClose }: Props) {
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const last = index === steps.length - 1;
  const coachRef = useRef<HTMLElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [targetBox, setTargetBox] = useState<Box | null>(null);
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null);
  const advance = useRef<() => void>(() => undefined);

  advance.current = () => {
    if (last) onClose();
    else setIndex((current) => current + 1);
  };

  // Resolve the step's control once; follow its box while the step lasts.
  useLayoutEffect(() => {
    setTarget(firstOnScreen(step.target));
  }, [step.target]);

  useEffect(() => {
    if (!target) {
      setTargetBox(null);
      return;
    }
    target.setAttribute(TOUR_TARGET_ATTRIBUTE, "");
    let frame = 0;
    const follow = () => {
      frame = 0;
      if (!target.isConnected) {
        setTarget(firstOnScreen(step.target));
        return;
      }
      const box = elementBox(target);
      setTargetBox((current) => (sameBox(current, box) ? current : box));
    };
    const soon = () => {
      if (!frame) frame = window.requestAnimationFrame(follow);
    };
    follow();
    // Controls move when a panel resizes or a sidebar slides; a slow timer
    // catches the moves no event announces.
    const timer = window.setInterval(soon, FOLLOW_MS);
    window.addEventListener("resize", soon);
    window.addEventListener("scroll", soon, true);
    window.addEventListener("transitionend", soon, true);
    const onPress = (event: MouseEvent) => {
      if (event.target instanceof Node && target.contains(event.target)) advance.current();
    };
    document.addEventListener("click", onPress, true);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.clearInterval(timer);
      window.removeEventListener("resize", soon);
      window.removeEventListener("scroll", soon, true);
      window.removeEventListener("transitionend", soon, true);
      document.removeEventListener("click", onPress, true);
      target.removeAttribute(TOUR_TARGET_ATTRIBUTE);
    };
  }, [target, step.target]);

  const place = useCallback(() => {
    const coach = coachRef.current;
    if (!coach) return;
    const size = { width: coach.offsetWidth, height: coach.offsetHeight };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const avoid = avoidedBoxes();
    const insets = chromeInsets();
    const beside = targetBox
      ? placeBeside({
          target: targetBox,
          size,
          viewport,
          avoid,
          preferred: step.placement,
          gap: GAP,
          margin: MARGIN,
          topInset: insets.top,
          bottomInset: insets.bottom,
        })
      : null;
    // A window too small for a clear spot: the top right, under the title
    // bar, is the corner farthest from the composer at the bottom.
    const next =
      beside ??
      placeInCorner({ viewport, size, avoid, margin: MARGIN, topInset: insets.top, bottomInset: insets.bottom }) ?? {
        left: Math.max(MARGIN, viewport.width - MARGIN - size.width),
        top: insets.top + MARGIN,
      };
    setSpot((current) => (current && current.left === next.left && current.top === next.top ? current : next));
  }, [targetBox, step.placement]);

  useLayoutEffect(place, [place, index]);

  useEffect(() => {
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [place]);

  // A hidden card cannot take focus, so this waits until it is placed.
  const placed = spot !== null;
  useEffect(() => {
    if (placed) primaryRef.current?.focus({ preventScroll: true });
  }, [index, placed]);

  // Focus goes back where it was when the tour ends, unless the person
  // moved on to the control the tour showed.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      const now = document.activeElement;
      if ((!now || now === document.body) && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div {...{ [TIPS_LAYER_ATTRIBUTE]: "" }} className="feature-tips-layer">
      {targetBox && (
        <div
          className="feature-tour__ring"
          aria-hidden
          style={{
            left: targetBox.left - RING_PAD,
            top: targetBox.top - RING_PAD,
            width: targetBox.width + RING_PAD * 2,
            height: targetBox.height + RING_PAD * 2,
          }}
        />
      )}
      <OnboardingCoach
        ref={coachRef}
        label={`${name} tour`}
        className="feature-tour spark-glass--strong spark-overlay-surface"
        style={spot ? { left: spot.left, top: spot.top } : { visibility: "hidden", left: 0, top: 0 }}
        eyebrow={steps.length > 1 ? `TOUR · ${index + 1} / ${steps.length}` : "TOUR"}
        title={step.title}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onClose();
        }}
        actions={
          <>
            {index > 0 && (
              <button type="button" className="spark-btn" onClick={() => setIndex(index - 1)}>
                Back
              </button>
            )}
            <button
              ref={primaryRef}
              type="button"
              className="spark-btn onboarding-primary"
              onClick={() => advance.current()}
            >
              {last ? "Done" : "Next"}
            </button>
            {!last && (
              <button type="button" className="spark-btn" onClick={onClose}>
                End tour
              </button>
            )}
          </>
        }
      >
        <p>{step.body}</p>
        {!target && <p className="feature-tour__missing">This control is not on screen right now.</p>}
      </OnboardingCoach>
    </div>
  );
}
