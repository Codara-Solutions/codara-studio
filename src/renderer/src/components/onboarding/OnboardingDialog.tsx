import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ONBOARDING_STEPS,
  SETUP_TOOLS,
  STUDIO_TOUR,
  isOnboardingServiceUnavailable,
  type OnboardingProgress,
  type OnboardingStep,
  type SetupSnapshot,
  type SetupToolId,
  type StudioTourFeature,
} from "@shared/onboarding";
import "./onboarding.css";
import { CodaraMark } from "../BrandMarks";

const Accounts = lazy(() =>
  import("../SettingsDialog").then((module) => ({
    default: module.AccountsSettings,
  })),
);
const LABELS = [
  "Welcome",
  "Your tools",
  "Connect an account",
  "Your workspace",
  "Explore Studio",
  "Your first idea",
];

interface Props {
  progress: OnboardingProgress;
  workspaceName?: string;
  onProgress: (value: OnboardingProgress) => void;
  onClose: () => void;
  onCreateWorkspace: () => Promise<void>;
  onExplore: (feature: StudioTourFeature) => void;
}

export default function OnboardingDialog({
  progress,
  workspaceName,
  onProgress,
  onClose,
  onCreateWorkspace,
  onExplore,
}: Props) {
  const [step, setStep] = useState<OnboardingStep>(progress.step);
  const [snapshot, setSnapshot] = useState<SetupSnapshot | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [reviewTool, setReviewTool] = useState<SetupToolId | null>(null);
  const [saving, setSaving] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountReady, setAccountReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serviceUnavailable, setServiceUnavailable] = useState(false);
  const [feature, setFeature] = useState(0);
  const [exploring, setExploring] = useState(false);
  const [visited, setVisited] = useState<StudioTourFeature[]>([]);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const saveQueue = useRef(Promise.resolve());
  const reviewRef = useRef<HTMLDivElement>(null);
  const installRef = useRef<HTMLDivElement>(null);
  const index = ONBOARDING_STEPS.indexOf(step);
  const currentFeature = STUDIO_TOUR[feature];
  const busy = saving || accountBusy || pickingWorkspace;

  const check = useCallback(async () => {
    if (!window.spark.onboarding) {
      setServiceUnavailable(true);
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const next = await window.spark.onboarding.check();
      setSnapshot(next);
      setInstalling(next.install?.state === "running");
    } catch (err) {
      if (isOnboardingServiceUnavailable(err)) setServiceUnavailable(true);
      else setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);
  useEffect(() => {
    if (reviewTool) reviewRef.current?.focus();
  }, [reviewTool]);
  useEffect(() => {
    if (installing) installRef.current?.scrollIntoView({ block: "nearest" });
  }, [installing]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void window.spark.piSubscriptions
        .status()
        .then((status) => {
          if (active)
            setAccountReady(
              status.runtimeInstalled &&
                status.connections.some(
                  (connection) =>
                    connection.connected &&
                    (!connection.expired || connection.canRefresh),
                ),
            );
        })
        .catch(() => {
          if (active) setAccountReady(false);
        });
    };
    refresh();
    const off = window.spark.piSubscriptions.onEvent(refresh);
    return () => {
      active = false;
      off();
    };
  }, []);

  useEffect(() => {
    if (!installing) return;
    let active = true;
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      pending = true;
      void window.spark.onboarding
        .installStatus()
        .then((install) => {
          if (!active) return;
          setSnapshot((current) =>
            current ? { ...current, install } : current,
          );
          if (install?.state !== "running") {
            setInstalling(false);
            void check();
          }
        })
        .catch((err) => {
          if (active) setError((err as Error).message);
        })
        .finally(() => {
          pending = false;
        });
    }, 800);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [installing, check]);

  useEffect(() => {
    if (exploring) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [exploring]);

  async function move(next: OnboardingStep, dismiss = false) {
    if (busy) return;
    if (serviceUnavailable || !window.spark.onboarding) {
      if (dismiss) onClose();
      else setServiceUnavailable(true);
      return;
    }
    setSaving(true);
    setError(null);
    const value: OnboardingProgress = {
      version: 1,
      step: next,
      dismissed: dismiss,
    };
    try {
      // Step writes must keep their order even when navigation is clicked twice.
      const write = saveQueue.current
        .then(() => window.spark.onboarding.save(value))
        .then(() => {});
      saveQueue.current = write.catch(() => {});
      await write;
      onProgress(value);
      setStep(next);
      setExploring(false);
      if (dismiss) onClose();
    } catch (err) {
      if (isOnboardingServiceUnavailable(err)) setServiceUnavailable(true);
      else setError(`Could not save your progress: ${(err as Error).message}`);
      // Leaving the guide must remain possible when persistence is unavailable.
      if (dismiss) onClose();
    } finally {
      setSaving(false);
    }
  }

  async function install() {
    if (!reviewTool || installing) return;
    const tool = reviewTool;
    setReviewTool(null);
    setInstalling(true);
    setSnapshot((current) =>
      current
        ? {
            ...current,
            install: { tool, state: "running", output: "Starting installer…" },
          }
        : current,
    );
    setError(null);
    try {
      const result = await window.spark.onboarding.install(tool);
      setSnapshot((current) =>
        current ? { ...current, install: result } : current,
      );
      await check();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInstalling(false);
    }
  }

  function explore() {
    onExplore(currentFeature.id);
    setVisited((items) =>
      items.includes(currentFeature.id) ? items : [...items, currentFeature.id],
    );
    setExploring(true);
  }

  const nextFeature = () => {
    if (feature < STUDIO_TOUR.length - 1) {
      setFeature(feature + 1);
      setExploring(false);
    } else void move("ready");
  };

  if (exploring)
    return (
      <aside
        className="onboarding-coach"
        aria-label="Studio tour guide"
        aria-live="polite"
      >
        <span className="onboarding-eyebrow">
          YOUR STUDIO · {feature + 1} / {STUDIO_TOUR.length}
        </span>
        <h2>{currentFeature.title}</h2>
        <p>{currentFeature.task}</p>
        <div className="onboarding-actions">
          <button className="spark-btn" onClick={() => setExploring(false)}>
            Back to guide
          </button>
          <button
            className="spark-btn onboarding-primary"
            disabled={busy}
            onClick={nextFeature}
          >
            Next stop
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
      </aside>
    );

  return (
    <div
      className="onboarding-backdrop"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (!busy) void move(step, true);
        }
        if (event.key !== "Tab") return;
        const elements = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]',
          ) ?? [],
        ).filter((element) => element.getClientRects().length > 0);
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialogRef.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="onboarding-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
      >
        <nav className="onboarding-nav" aria-label="Setup steps">
          <div className="onboarding-wordmark">
            <span className="onboarding-mark"><CodaraMark size={22} /></span> Codara Studio
          </div>
          <p className="onboarding-eyebrow">MAKE YOURSELF AT HOME</p>
          {ONBOARDING_STEPS.map((id, position) => (
            <button
              key={id}
              className="onboarding-step"
              aria-current={step === id ? "step" : undefined}
              disabled={busy || serviceUnavailable}
              onClick={() => void move(id)}
            >
              <span>{String(position + 1).padStart(2, "0")}</span>
              {LABELS[position]}
            </button>
          ))}
          <div className="onboarding-nav-note">
            Your tools. Your accounts.
            <br />A place to work together.
          </div>
        </nav>
        <div className="onboarding-main">
          <header className="onboarding-header">
            <span className="onboarding-eyebrow">
              GETTING STARTED · {index + 1} OF {ONBOARDING_STEPS.length}
            </span>
            <button
              className="spark-btn"
              disabled={busy}
              onClick={() => void move(step, true)}
            >
              {serviceUnavailable ? "Close guide" : "Finish later"}
            </button>
          </header>
          <div className="onboarding-body" key={step}>
            {serviceUnavailable && (
              <div className="onboarding-callout" role="alert">
                <strong>Restart Codara Studio to continue setup</strong>
                <p>
                  This window has updated, but the running app does not yet have
                  the setup service. Fully quit and reopen Codara Studio.
                  Reloading this window is not enough.
                </p>
                <p>Your progress has not been saved. You can close this guide.</p>
              </div>
            )}
            <h1 id="onboarding-title">
              {step === "welcome" ? (
                <>
                  Your next idea.
                  <br />
                  <span>A whole studio behind it.</span>
                </>
              ) : step === "tools" ? (
                "Give your studio its tools."
              ) : step === "account" ? (
                "Bring the account you already use."
              ) : step === "workspace" ? (
                "Give your idea a home."
              ) : step === "tour" ? (
                "This is your studio."
              ) : (
                "Start with one small idea."
              )}
            </h1>

            {step === "welcome" && (
              <>
                <p className="onboarding-lead">
                  Bring your agents, code, and ideas into one workspace. We will
                  help you set things up, connect an account, and try the parts
                  of Studio you will use every day.
                </p>
                <div className="onboarding-welcome-grid">
                  {[
                    [
                      "01",
                      "Set up together",
                      "Check this computer and install the tools you need.",
                    ],
                    [
                      "02",
                      "Bring your account",
                      "Sign in to Claude or ChatGPT in your browser.",
                    ],
                    [
                      "03",
                      "Make it yours",
                      "Open a folder and take a hands-on tour of Studio.",
                    ],
                  ].map(([number, title, detail]) => (
                    <div className="onboarding-card" key={number}>
                      <span className="onboarding-eyebrow">{number}</span>
                      <h3>{title}</h3>
                      <p>{detail}</p>
                    </div>
                  ))}
                </div>
                <p className="onboarding-note">
                  No terminal experience needed to get started. You can skip a
                  step and return from Settings &gt; General.
                </p>
              </>
            )}

            {step === "tools" && (
              <>
                <p className="onboarding-lead">
                  These are local programs that support your projects and
                  agents. Choose the tools you need. You only need the agent you
                  plan to use.
                </p>
                <div className="onboarding-actions">
                  <button
                    className="spark-btn"
                    disabled={checking || installing}
                    onClick={() => void check()}
                  >
                    {checking ? "Checking your computer…" : "Recheck tools"}
                  </button>
                  <span className="onboarding-note">
                    {snapshot
                      ? `${snapshot.tools.filter((tool) => tool.installed).length} of ${SETUP_TOOLS.length} tools available`
                      : "Looking for installed tools"}
                  </span>
                </div>
                <div className="onboarding-tools">
                  {SETUP_TOOLS.map((tool) => {
                    const status = snapshot?.tools.find(
                      (item) => item.id === tool.id,
                    );
                    return (
                      <article className="onboarding-tool" key={tool.id}>
                        <div>
                          <h3>
                            {tool.label}{" "}
                            <span
                              className={
                                status?.installed
                                  ? "onboarding-badge ready"
                                  : "onboarding-badge"
                              }
                            >
                              {status
                                ? status.installed
                                  ? "Ready"
                                  : "Not detected"
                                : "Checking"}
                            </span>
                          </h3>
                          <p>{tool.detail}</p>
                          {status?.installed ? (
                            <small>{status.version}</small>
                          ) : (
                            status && <small>{status.help}</small>
                          )}
                        </div>
                        {!status?.installed && (
                          <div className="onboarding-tool-actions">
                            {status?.installCommand && (
                              <button
                                className="spark-btn onboarding-primary"
                                disabled={installing || checking}
                                onClick={() => setReviewTool(tool.id)}
                              >
                                Set up {tool.label}
                              </button>
                            )}
                            <button
                              className="spark-btn"
                              onClick={() =>
                                void window.spark
                                  .openExternal(tool.url)
                                  .catch((err) =>
                                    setError((err as Error).message),
                                  )
                              }
                            >
                              Official guide
                            </button>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
                {reviewTool && (
                  <div
                    ref={reviewRef}
                    tabIndex={-1}
                    className="onboarding-callout"
                    role="region"
                    aria-label="Review installation"
                  >
                    <h3>
                      Install{" "}
                      {
                        SETUP_TOOLS.find((tool) => tool.id === reviewTool)
                          ?.label
                      }
                    </h3>
                    <p>
                      Studio will run this installer. It downloads software and
                      may ask for system permission. Package-manager
                      installation accepts the package and source agreements.
                    </p>
                    <code>
                      {
                        snapshot?.tools.find((tool) => tool.id === reviewTool)
                          ?.installCommand
                      }
                    </code>
                    <div className="onboarding-actions">
                      <button
                        className="spark-btn"
                        onClick={() => setReviewTool(null)}
                      >
                        Cancel
                      </button>
                      <button
                        className="spark-btn onboarding-primary"
                        disabled={installing}
                        onClick={() => void install()}
                      >
                        Install now
                      </button>
                    </div>
                  </div>
                )}
                {snapshot?.install && (
                  <div
                    ref={installRef}
                    className="onboarding-callout"
                    role="status"
                  >
                    <strong>
                      {snapshot.install.state === "running"
                        ? "Installation in progress"
                        : snapshot.install.state === "succeeded"
                          ? "Tool ready"
                          : "Installation needs attention"}
                    </strong>
                    <pre>{snapshot.install.output}</pre>
                    {snapshot.install.state === "failed" && (
                      <p>
                        Use the official guide above or recheck and try again.
                      </p>
                    )}
                  </div>
                )}
                <p className="onboarding-note">
                  A missing tool does not prevent you from exploring Studio.
                  Project-specific dependencies come later, when you open a
                  project.
                </p>
              </>
            )}

            {step === "account" && (
              <>
                <p className="onboarding-lead">
                  Choose Claude or ChatGPT below. Your provider opens a browser
                  so you can sign in with your own account. Studio uses that
                  account for Cora and the matching terminal agent.
                </p>
                <ol className="onboarding-instructions">
                  <li>Choose the provider whose account you want to use.</li>
                  <li>
                    Complete sign-in in your browser. If asked, copy the
                    authorization code back into the field below.
                  </li>
                  <li>
                    Return here and check that your account is connected. You
                    can add another account later.
                  </li>
                </ol>
                <p className="onboarding-note">
                  Access, limits, and any extra usage charges depend on your
                  provider plan. Installing a CLI and signing in are separate
                  steps. If the Cora runtime is missing, install it below first.
                </p>
                <Suspense
                  fallback={<p role="status">Loading secure sign-in…</p>}
                >
                  <Accounts guided onBusyChange={setAccountBusy} />
                </Suspense>
                {accountReady && (
                  <div className="onboarding-callout" role="status">
                    An account is connected. Continue to your workspace when you
                    are ready.
                  </div>
                )}
              </>
            )}

            {step === "workspace" && (
              <>
                <p className="onboarding-lead">
                  A workspace is a folder on your computer, together with its
                  Studio tabs and conversations. Pick an existing project or
                  create an empty folder in the folder picker.
                </p>
                <div className="onboarding-folder">
                  <span className="onboarding-eyebrow">YOUR PROJECT</span>
                  <h2>{workspaceName || "Choose a place to begin"}</h2>
                  <p>
                    {workspaceName
                      ? "This workspace is open. Its files stay in their original folder."
                      : "Your files stay on your computer. Opening a folder does not move them or upload them."}
                  </p>
                  <button
                    className="spark-btn onboarding-primary"
                    disabled={pickingWorkspace}
                    onClick={async () => {
                      setPickingWorkspace(true);
                      setError(null);
                      try {
                        await onCreateWorkspace();
                      } catch (err) {
                        setError((err as Error).message);
                      } finally {
                        setPickingWorkspace(false);
                      }
                    }}
                  >
                    {pickingWorkspace
                      ? "Choosing folder…"
                      : workspaceName
                        ? "Open another folder"
                        : "Choose a project folder"}
                  </button>
                </div>
                <div className="onboarding-welcome-grid">
                  <div className="onboarding-card">
                    <h3>One project, one home</h3>
                    <p>
                      Keep its files, conversations, terminals, and previews
                      together.
                    </p>
                  </div>
                  <div className="onboarding-card">
                    <h3>Switch without losing your place</h3>
                    <p>
                      Use the workspace rail to move between projects. Each
                      keeps its own tabs.
                    </p>
                  </div>
                  <div className="onboarding-card">
                    <h3>Local first</h3>
                    <p>
                      Start with a local folder. You can connect an SSH
                      workspace later.
                    </p>
                  </div>
                </div>
              </>
            )}

            {step === "tour" && (
              <>
                <p className="onboarding-lead">
                  Click a part of the studio to learn what it does, then open it
                  in your workspace. Your guide stays nearby while you try it.
                </p>
                <div
                  className="onboarding-studio"
                  aria-label="Interactive studio map"
                >
                  <div className="onboarding-studio-rail">
                    <span className="onboarding-mark"><CodaraMark size={22} /></span>
                    <small>{workspaceName || "Your project"}</small>
                    <button
                      aria-pressed={currentFeature.id === "files"}
                      onClick={() => setFeature(3)}
                    >
                      Files &amp; Git
                    </button>
                  </div>
                  <div className="onboarding-studio-content">
                    <div className="onboarding-studio-tabs">
                      {STUDIO_TOUR.filter((item) => item.id !== "files").map(
                        (item) => (
                          <button
                            key={item.id}
                            aria-pressed={currentFeature.id === item.id}
                            onClick={() =>
                              setFeature(STUDIO_TOUR.indexOf(item))
                            }
                          >
                            {item.label}
                            {visited.includes(item.id) && (
                              <span
                                className="onboarding-dot"
                                aria-label="Opened"
                              />
                            )}
                          </button>
                        ),
                      )}
                    </div>
                    <div className="onboarding-feature">
                      <span className="onboarding-eyebrow">
                        {String(feature + 1).padStart(2, "0")} / EXPLORE
                      </span>
                      <h2>{currentFeature.title}</h2>
                      <p>{currentFeature.detail}</p>
                      <div className="onboarding-callout">
                        <strong>Try it yourself</strong>
                        <p>{currentFeature.task}</p>
                      </div>
                      <div className="onboarding-actions">
                        <button
                          className="spark-btn onboarding-primary"
                          disabled={!workspaceName}
                          onClick={explore}
                        >
                          Open {currentFeature.label} in Studio
                        </button>
                        <button className="spark-btn" onClick={nextFeature}>
                          Next stop
                        </button>
                      </div>
                      {!workspaceName && (
                        <button
                          className="onboarding-link"
                          onClick={() => void move("workspace")}
                        >
                          Choose a workspace to try this
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                <p className="onboarding-note">
                  {visited.length} of {STUDIO_TOUR.length} areas opened. Explore
                  at your own pace.
                </p>
              </>
            )}

            {step === "ready" && (
              <>
                <p className="onboarding-lead">
                  You do not need to learn everything at once. Start with a
                  small task, follow what happens, and review the result.
                </p>
                <div className="onboarding-checklist">
                  {[
                    {
                      title: "Local tools",
                      detail: snapshot
                        ? `${snapshot.tools.filter((tool) => tool.installed).length} of ${SETUP_TOOLS.length} available. Only install what you need.`
                        : "Your tools have not been checked yet.",
                      step: "tools" as const,
                    },
                    {
                      title: "Agent account",
                      detail: accountReady
                        ? "An account is connected."
                        : "Connect an account before asking Cora or a terminal agent to work.",
                      step: "account" as const,
                    },
                    {
                      title: "Workspace",
                      detail:
                        workspaceName ||
                        "Choose a folder when you are ready to start.",
                      step: "workspace" as const,
                    },
                  ].map((item) => (
                    <button
                      key={item.title}
                      onClick={() => void move(item.step)}
                    >
                      <strong>{item.title}</strong>
                      <span>{item.detail}</span>
                      <span>Review</span>
                    </button>
                  ))}
                </div>
                <div className="onboarding-callout">
                  <h3>Your first brief</h3>
                  <p>
                    “Explain this project and suggest a small first
                    improvement.”
                  </p>
                  <p>
                    Open Cora, check the model and mode, and send your brief
                    when you are ready. You control when the agent starts.
                  </p>
                </div>
                <p className="onboarding-note">
                  Find this guide again in Settings &gt; General &gt; Getting
                  started.
                </p>
              </>
            )}
            {error && !serviceUnavailable && (
              <p className="onboarding-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer className="onboarding-footer">
            <button
              className="spark-btn"
              disabled={busy || serviceUnavailable || index === 0}
              onClick={() => void move(ONBOARDING_STEPS[index - 1])}
            >
              Back
            </button>
            <span className="onboarding-note">
              {serviceUnavailable
                ? "Restart the app to enable setup."
                : accountBusy
                ? "Finish or cancel sign-in before continuing."
                : installing
                  ? "The installer will keep running if you continue."
                  : "Your progress is saved as you go."}
            </span>
            <button
              className="spark-btn onboarding-primary"
              disabled={busy || serviceUnavailable}
              onClick={async () => {
                if (step === "ready") {
                  await move("ready", true);
                } else {
                  await move(ONBOARDING_STEPS[index + 1]);
                }
              }}
            >
              {step === "ready"
                ? "Enter my studio"
                : step === "welcome"
                  ? "Let's get started"
                  : step === "account" && !accountReady
                    ? "Connect later"
                    : step === "workspace" && !workspaceName
                      ? "Choose later"
                      : "Continue"}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
