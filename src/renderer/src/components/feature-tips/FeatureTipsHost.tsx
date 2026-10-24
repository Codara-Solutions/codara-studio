import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  COMMAND_RAN_EVENT,
  isCalmMoment,
  pendingTips,
  pickNextTip,
  renderTipText,
  tipCheckDelay,
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
import { blockingSurfaceOpen, conditionMet, mayBeTyping } from "./feature-tips-dom";
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
  // The input a calm period follows, once the window was read in it.
  const lookedAfter = useRef<number | null>(null);

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

  // What the person is doing: keys, clicks, pointer moves and scrolls. Only
  // followed while a tip may still come this session; it starts out busy, so
  // a tip never lands on input that came before the listening began.
  useEffect(() => {
    if (!scheduling) return;
    const start = Date.now();
    lastKeyAt.current = start;
    lastPointerAt.current = start;
    const onKey = () => {
      lastKeyAt.current = Date.now();
    };
    const onPointer = () => {
      lastPointerAt.current = Date.now();
    };
    const pointerEvents = ["pointerdown", "pointermove", "wheel"] as const;
    window.addEventListener("keydown", onKey, { capture: true, passive: true });
    // The shortcut dispatcher stops a chord before this listener sees it.
    window.addEventListener(COMMAND_RAN_EVENT, onKey);
    // Coming back to the window (Alt+Tab, Cmd+Tab) is about to be typing:
    // the key that switched windows never reaches this one.
    window.addEventListener("focus", onKey);
    for (const name of pointerEvents) window.addEventListener(name, onPointer, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener(COMMAND_RAN_EVENT, onKey);
      window.removeEventListener("focus", onKey);
      for (const name of pointerEvents) window.removeEventListener(name, onPointer, { capture: true });
    };
  }, [scheduling]);

  useEffect(() => {
    if (!scheduling || !boot) return;
    const timing = boot.timing;
    const tryOffer = () => {
      const current = stateRef.current;
      const now = Date.now();
      if (!current || !tipDue(current, now, timing, shownThisSession.current)) return;
      // A window behind another app is not being looked at: a tip there
      // would only be found later, already counted as shown.
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      if (!isCalmMoment({ now, startedAt: startedAt.current, lastKeyAt: lastKeyAt.current, lastPointerAt: lastPointerAt.current, timing })) return;
      // The window is read once per calm period. What a tip waits for (its
      // control on screen, a dialog closed, focus out of a page) changes when
      // the person acts, so after a look that found nothing the next one
      // waits for new input. A tip whose control is never on screen stays
      // pending for good, so without this a session would query the DOM
      // every few seconds for as long as it sits idle.
      const activity = Math.max(lastKeyAt.current, lastPointerAt.current);
      if (lookedAfter.current === activity) return;
      lookedAfter.current = activity;
      if (blockingSurfaceOpen() || mayBeTyping()) return;
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
    // No tip can be due before the app settles and the gap since the last one
    // passes, so the calm-moment poll sleeps until then.
    let poll = 0;
    const wait = window.setTimeout(
      () => {
        poll = window.setInterval(tryOffer, timing.pollMs);
      },
      tipCheckDelay(boot.state, Date.now(), startedAt.current, timing),
    );
    return () => {
      window.clearTimeout(wait);
      window.clearInterval(poll);
    };
  }, [scheduling, boot, render, usage]);

  // Tips turned off elsewhere (Settings) take the one on screen with them,
  // and so does using the feature the tip is about: it has done its job.
  const tipId = tip?.entry.id;
  useEffect(() => {
    if (!state) return;
    if (!state.enabled || (tipId !== undefined && state.used[tipId] !== undefined)) setTip(null);
  }, [state, tipId]);

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
