import React, { useEffect, useState } from "react";

import type { SeparateBrowserTool } from "@shared/chrome-link";
import { usePreferences } from "../../preferences/usePreferences";
import { bindToggle } from "../settings/setting-toggles";
import { ToggleRow } from "../settings/SettingsPrimitives";

const KIND_LABEL: Record<SeparateBrowserTool["kind"], string> = {
  "claude-plugin": "Claude Code plugin",
  "claude-mcp": "Claude Code MCP server",
  "codex-mcp": "Codex MCP server",
};

/**
 * "Keep agents in your Chrome": one self-contained row, so it can move with
 * the Chrome extension settings. It names every tool it turns off, read from
 * the user's own Claude Code and Codex configs.
 */
export default function KeepAgentsInChromeRow(): React.ReactElement {
  const { preferences, setPreference } = usePreferences();
  const toggle = bindToggle("keepAgentsInYourChrome", preferences, setPreference);
  const [tools, setTools] = useState<SeparateBrowserTool[] | null>(null);

  useEffect(() => {
    let live = true;
    window.spark.chromeLink
      .separateBrowserTools()
      .then((found) => live && setTools(found))
      .catch(() => live && setTools(null));
    return () => {
      live = false;
    };
  }, [toggle.checked]);

  const names = (tools ?? []).map((tool) => (
    <span key={`${tool.kind}:${tool.name}`} className="spark-mono" title={tool.source}>
      {tool.name} ({KIND_LABEL[tool.kind]})
    </span>
  ));
  const list =
    tools === null ? null : names.length === 0 ? (
      "None of your Claude Code or Codex tools open a separate Chrome window."
    ) : (
      <>
        {toggle.checked ? "Off in Codara: " : "Turning this on turns off: "}
        {names.flatMap((name, index) => (index === 0 ? [name] : [", ", name]))}.
      </>
    );

  return (
    <ToggleRow
      title="Keep agents in your Chrome"
      desc="Agents open pages in your own Chrome, in a tab group, through the Codara extension. Browser tools that open a separate Chrome window are turned off in Codara. Applies to new sessions."
      {...toggle}
    >
      {list ? <div className="chrome-off-tools">{list}</div> : null}
    </ToggleRow>
  );
}
