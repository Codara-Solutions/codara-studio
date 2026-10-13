// Settings > Accounts > Startup flags: extra flags Codara adds when it starts
// an agent CLI in a terminal. They are kept in Codara's own home and added to
// that one launch, never written into a CLI's config, so the same CLI started
// outside Codara is unchanged. The main process validates every save
// (src/main/servers/launch-args.ts); the field here only shows its verdict.

import { useEffect, useRef, useState } from "react";

import type { LaunchArgRuntime, LaunchArgsSettings } from "@shared/servers";

import { InlineMessage, SettingRow, SettingsSection, ToggleRow } from "../SettingsPrimitives";

const RUNTIME_ROWS: ReadonlyArray<{ runtime: LaunchArgRuntime; title: string; placeholder: string }> = [
  { runtime: "claude", title: "Claude Code flags", placeholder: "For example --model opus --verbose" },
  { runtime: "codex", title: "Codex flags", placeholder: "For example --search -m gpt-5.5" },
  { runtime: "grok", title: "Grok flags", placeholder: "For example --disable-web-search" },
  { runtime: "pi", title: "Pi flags", placeholder: "For example --thinking high" },
];

function RuntimeFlagsField({
  runtime,
  title,
  placeholder,
  stored,
  onSave,
}: {
  runtime: LaunchArgRuntime;
  title: string;
  placeholder: string;
  stored: string;
  onSave: (runtime: LaunchArgRuntime, text: string) => Promise<string | null>;
}) {
  const [text, setText] = useState(stored);
  const [error, setError] = useState<string | null>(null);
  const checkSeq = useRef(0);

  useEffect(() => setText(stored), [stored]);

  const check = (next: string) => {
    const seq = ++checkSeq.current;
    void window.spark.servers.launchArgs
      .check(runtime, next)
      .then((verdict) => {
        if (seq === checkSeq.current) setError(verdict.ok ? null : verdict.error);
      })
      .catch(() => undefined);
  };

  const commit = async () => {
    if (text.trim() === stored.trim()) return;
    setError(await onSave(runtime, text));
  };

  return (
    <SettingRow
      title={title}
      desc={
        runtime === "claude" || runtime === "codex"
          ? "Added after Codara's own flags each time this CLI starts in a terminal. Flags only, no shell syntax."
          : "Added each time this CLI starts in a terminal. Flags only, no shell syntax."
      }
      stacked
    >
      <input
        className="spark-input spark-mono"
        aria-label={title}
        aria-invalid={error ? true : undefined}
        type="text"
        value={text}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.currentTarget.value);
          check(event.currentTarget.value);
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {error ? (
        <InlineMessage tone="danger" role="alert">
          {error}
        </InlineMessage>
      ) : null}
    </SettingRow>
  );
}

export function LaunchArgsSection() {
  const [settings, setSettings] = useState<LaunchArgsSettings | null>(null);

  useEffect(() => {
    let live = true;
    void window.spark.servers.launchArgs
      .get()
      .then((loaded) => {
        if (live) setSettings(loaded);
      })
      .catch(() => {
        if (live) setSettings({ args: {}, claudeChrome: false });
      });
    return () => {
      live = false;
    };
  }, []);

  if (!settings) return null;

  const save = async (next: LaunchArgsSettings): Promise<string | null> => {
    try {
      setSettings(await window.spark.servers.launchArgs.set(next));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "") : String(error);
    }
  };

  return (
    <SettingsSection
      title="Startup flags"
      description="Applied to each launch from Codara only. Nothing is written to a CLI's own settings. Sessions already running keep the flags they started with."
    >
      <ToggleRow
        title="Connect to Chrome"
        desc="Starts Claude Code with --chrome, its own link to your Chrome. Codex, Grok and Pi have no such flag; they use Codara's browser tools and the Chrome extension."
        checked={settings.claudeChrome}
        onChange={(claudeChrome) => void save({ ...settings, claudeChrome })}
      />
      {RUNTIME_ROWS.map((row) => (
        <RuntimeFlagsField
          key={row.runtime}
          runtime={row.runtime}
          title={row.title}
          placeholder={row.placeholder}
          stored={settings.args[row.runtime] ?? ""}
          onSave={(runtime, text) => save({ ...settings, args: { ...settings.args, [runtime]: text } })}
        />
      ))}
    </SettingsSection>
  );
}
