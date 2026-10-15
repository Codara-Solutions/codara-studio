import {
  DEFAULT_KEEP_AWAKE_MODE,
  KEEP_AWAKE_DISPLAY_NOTE,
  KEEP_AWAKE_LID_HINT,
  KEEP_AWAKE_LID_SUSPEND_NOTE,
  KEEP_AWAKE_MODE_OPTIONS,
  keepAwakeSummary,
  type KeepAwakeMode,
} from "@shared/keep-awake";
import {
  InlineMessage,
  Segmented,
  SettingRow,
  SettingsSection,
  ToggleRow,
} from "../settings/SettingsPrimitives";
import { useKeepAwake } from "./useKeepAwake";

// The Sleep section of Settings, General. The same status and writes as the
// title-bar control (KeepAwakeControl.tsx), laid out as Settings rows. The
// lid row exists only where main says a closed lid can be held awake.

export default function KeepAwakeSettings() {
  const { status, setMode, setLidClosed } = useKeepAwake();
  const mode: KeepAwakeMode = status?.mode ?? DEFAULT_KEEP_AWAKE_MODE;
  const selected = KEEP_AWAKE_MODE_OPTIONS.find((option) => option.value === mode);
  return (
    <SettingsSection
      title="Sleep"
      description={`Long agent runs stop when the computer goes to sleep. Codara can keep it awake while they work. ${KEEP_AWAKE_DISPLAY_NOTE}`}
    >
      <SettingRow
        title="Keep awake"
        desc={selected?.hint}
        control={
          <Segmented
            ariaLabel="Keep awake"
            options={KEEP_AWAKE_MODE_OPTIONS}
            value={mode}
            onChange={setMode}
          />
        }
      >
        {status ? (
          <div data-keep-awake-settings-status={status.holding ? "holding" : "idle"}>
            <InlineMessage tone={status.error ? "warn" : status.holding ? "ok" : "muted"} role="status">
              {keepAwakeSummary(status)}
            </InlineMessage>
          </div>
        ) : null}
      </SettingRow>
      {status?.lid.supported ? (
        <ToggleRow
          title="Keep awake with the lid closed"
          desc={
            status.lid.enabled && status.lid.error
              ? `${status.lid.error} ${KEEP_AWAKE_LID_HINT}`
              : `${KEEP_AWAKE_LID_HINT} ${KEEP_AWAKE_LID_SUSPEND_NOTE} No system setting changes.`
          }
          checked={status.lid.enabled}
          onChange={setLidClosed}
        />
      ) : null}
    </SettingsSection>
  );
}
