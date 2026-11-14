import { useEffect, useState } from "react";
import {
  GPU_DRAWING_ENV,
  gpuDrawingTurnedOffLine,
  type GpuDrawingStatus,
} from "@shared/gpu-drawing";
import type { AppPreferences, PrefKey } from "@shared/types";
import { InlineMessage, ToggleRow, ValueRow } from "./SettingsPrimitives";

// Settings, General, Window: drawing with the graphics card. Only native
// Wayland has a switch; everywhere else Codara already uses the graphics card
// and the row says so, so there is never a switch that does nothing.

const GPU_DRAWING_DESC =
  "Makes Codara smoother on slower computers. Needs a restart. If the graphics driver crashes, Codara turns it off again.";

type SetPreference = <K extends PrefKey>(key: K, value: AppPreferences[K]) => Promise<void>;

export function useGpuDrawingStatus(): GpuDrawingStatus | null {
  const [status, setStatus] = useState<GpuDrawingStatus | null>(null);
  useEffect(() => {
    let live = true;
    void window.spark.gpuDrawing
      .status()
      .then((next) => {
        if (live) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return status;
}

export function GpuDrawingRow({
  preferences,
  setPreference,
}: {
  preferences: AppPreferences;
  setPreference: SetPreference;
}) {
  const status = useGpuDrawingStatus();
  if (!status) return null;
  if (status.availability === "always-on") {
    return (
      <ValueRow
        title="Draw with the graphics card (hardware acceleration)"
        desc="Codara already uses the graphics card on this computer. It is off by default only on Linux with native Wayland."
        value="On"
      />
    );
  }
  const checked = preferences.waylandHardwareAcceleration === true;
  if (status.envOverride) {
    return (
      <ToggleRow
        title="Draw with the graphics card (hardware acceleration)"
        desc={`${GPU_DRAWING_ENV} is set to ${status.envOverride} for this run, and it wins over this switch.`}
        checked={status.envOverride === "on"}
        disabled
        onChange={() => undefined}
      />
    );
  }
  // A preference Codara turned off and nobody turned on again keeps its reason.
  const turnedOff = !checked && status.turnedOff ? gpuDrawingTurnedOffLine(status.turnedOff.reason) : null;
  const pending = checked !== status.activeNow;
  return (
    <ToggleRow
      title="Draw with the graphics card (hardware acceleration)"
      desc={GPU_DRAWING_DESC}
      checked={checked}
      onChange={(next) => void setPreference("waylandHardwareAcceleration", next)}
    >
      {pending ? (
        <div data-gpu-drawing-status="restart">
          <InlineMessage tone="info" role="status">
            {`Restart Codara to ${checked ? "draw with" : "stop using"} the graphics card.`}
          </InlineMessage>
        </div>
      ) : turnedOff ? (
        <div data-gpu-drawing-status="turned-off">
          <InlineMessage tone="warn" role="status">
            {turnedOff}
          </InlineMessage>
        </div>
      ) : null}
    </ToggleRow>
  );
}
