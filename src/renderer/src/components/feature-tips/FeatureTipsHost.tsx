import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isCalmMoment,
  pendingTips,
  pickNextTip,
  renderTipText,
  tipConditions,
  tipDue,
  type FeatureCatalogEntry,
  type FeatureTipOutcome,
  type FeatureTipsBoot,
  type FeatureTipsState,
} from "@shared/feature-tips";
import { usePreferences } from "../../preferences/usePreferences";
import { buildBindingTable } from "../../shortcuts/bindings";
import { chordToHint } from "../../shortcuts/chord";
import { emitLocalToast } from "../../notifications/local-toast";
import { blockingSurfaceOpen, conditionMet, draftInProgress } from "./feature-tips-dom";
import { useFeatureUsage } from "./useFeatureUsage";
import { FeatureTipCard, type TipText } from "./FeatureTipCard";
import { FeatureTour, type TourStepText } from "./FeatureTour";
import "./feature-tips.css";

// Feature tips, mounted once by App. It records what this person uses (see
// useFeatureUsage) and, at most once a session and not more than once a day,
// offers one tip about a feature they have not tried: only once the app has
// settled, nobody is typing or clicking, nothing is open, and the feature's
// control is on screen. Under the e2e runner tips never appear on their own
// (featureTipsMode); a spec opts in with CODARA_E2E_FEATURE_TIPS=1.

interface Props {
  /** The first-run guide is open: no tips in a session that showed it. */
  onboardingOpen: boolean;
  hasWorkspaces: boolean;
}

interface RenderedTip {
  entry: FeatureCatalogEntry;
  text: TipText;
  tour: TourStepText[];
}

export default function FeatureTipsHost({ onboardingOpen, hasWorkspaces }: Props) {
  const [boot, setBoot] = useState<FeatureTipsBoot | null>(null);
  const stateRef = useRef<FeatureTipsState | null>(null);
  const { preferences, hydrated } = usePreferences();
  const usage = useFeatureUsage(boot !== null, stateRef, preferences, hydrated);
  const [tip, setTip] = useState<RenderedTip | null>(null);
  const [tour, setTour] = useState<RenderedTip | null>(null);
  const shownThisSession = useRef(false);
  const onboardingSeen = useRef(false);
  const startedAt = useRef(Date.now());
  const lastKeyAt = useRef(0);
  const lastPointerAt = useRef(0);

  if (onboardingOpen) onboardingSeen.current = true;

  useEffect(() => {
    const api = window.spark.featureTips;
    if (!api) return;
    let alive = true;
    void api
      .load()
      .then((loaded) => {
        if (!alive) return;
        stateRef.current = loaded.state;
        setBoot(loaded);
      })
      .catch((error) => console.warn("[feature-tips] Could not load", error));
    const off = api.onChanged((state) => {
      stateRef.current = state;
      setBoot((current) => (current ? { ...current, state } : current));
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    const onKey = () => {
      lastKeyAt.current = Date.now();
    };
    const onPointer = () => {
      lastPointerAt.current = Date.now();
    };
    window.addEventListener("keydown", onKey, { capture: true, passive: true });
    window.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("pointerdown", onPointer, { capture: true });
    };
  }, []);

  const bindings = useMemo(
    () => buildBindingTable(preferences.keybindings),
    [preferences.keybindings],
  );
  const chordFor = useCallback(
    (command: string) => {
      const chord = bindings.find((binding) => binding.command.id === command)?.chords[0];
      return chord ? chordToHint(chord) : null;
    },
    [bindings],
  );

  const render = useCallback(
    (entry: FeatureCatalogEntry): RenderedTip | null => {
      const source = entry.tip;
      if (!source) return null;
      const title = renderTipText(source.title, chordFor);
      const body = renderTipText(source.body, chordFor);
      if (title === null || body === null) return null;
      const tour: TourStepText[] = [];
      for (const step of source.tour ?? []) {
        const stepBody = renderTipText(step.body, chordFor);
        if (stepBody === null) return null;
        tour.push({ ...step, body: stepBody });
      }
      return { entry, text: { title, body }, tour };
    },
    [chordFor],
  );

  const state = boot?.state ?? null;
  const anyPending = useMemo(() => (state ? pendingTips(state).length > 0 : false), [state]);
  const scheduling =
    !!boot &&
    boot.autoTips &&
    !!state?.enabled &&
    anyPending &&
    hasWorkspaces &&
    !onboardingOpen &&
    !onboardingSeen.current &&
    !tip &&
    !tour &&
    !shownThisSession.current;

  useEffect(() => {
    if (!scheduling || !boot) return;
    const timing = boot.timing;
    const tryOffer = () => {
      const current = stateRef.current;
      const now = Date.now();
      if (!current || !tipDue(current, now, timing, shownThisSession.current)) return;
      if (document.visibilityState !== "visible") return;
      if (!isCalmMoment({ now, startedAt: startedAt.current, lastKeyAt: lastKeyAt.current, lastPointerAt: lastPointerAt.current, timing })) return;
      if (blockingSurfaceOpen() || draftInProgress()) return;
      const inUse = usage.inUseNow();
      const found: { tip: RenderedTip | null } = { tip: null };
      const entry = pickNextTip(current, (candidate) => {
        if (inUse.has(candidate.id) || usage.pending.current.has(candidate.id)) return false;
        if (!tipConditions(candidate).every(({ selector, atLeast }) => conditionMet(selector, atLeast))) return false;
        found.tip = render(candidate);
        return found.tip !== null;
      });
      if (!entry || !found.tip) return;
      shownThisSession.current = true;
      setTip(found.tip);
      void window.spark.featureTips.tipShown(entry.id).catch(() => undefined);
    };
    const timer = window.setInterval(tryOffer, timing.pollMs);
    return () => window.clearInterval(timer);
  }, [scheduling, boot, render, usage]);

  // Tips turned off elsewhere (Settings) take the one on screen with them.
  useEffect(() => {
    if (state && !state.enabled) setTip(null);
  }, [state]);

  const settle = useCallback((id: string, outcome: FeatureTipOutcome) => {
    setTip(null);
    void window.spark.featureTips.tipOutcome(id, outcome).catch(() => undefined);
  }, []);

  if (tour) {
    return <FeatureTour name={tour.entry.name} steps={tour.tour} onClose={() => setTour(null)} />;
  }
  if (!tip) return null;
  const { entry, text } = tip;
  const open = entry.tip?.open;
  return (
    <FeatureTipCard
      key={entry.id}
      id={entry.id}
      text={text}
      onTour={
        tip.tour.length > 0
          ? () => {
              settle(entry.id, "toured");
              setTour(tip);
            }
          : undefined
      }
      openLabel={open?.label}
      onOpen={
        open
          ? () => {
              settle(entry.id, "opened");
              window.dispatchEvent(new CustomEvent(open.event, { detail: open.detail }));
            }
          : undefined
      }
      onDismiss={() => settle(entry.id, "dismissed")}
      onTurnOff={() => {
        settle(entry.id, "turned-off");
        emitLocalToast("Tips are off", "Turn them back on in Settings, General.");
      }}
    />
  );
}
