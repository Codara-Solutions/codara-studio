import type { AppPreferences, PrefKey } from "@shared/types";

// On/off settings stored in preferences, each read and written in one place.
// A Settings page row and its search result flip the same binding, so a
// default (a missing glassEffects means on, a missing autoOpenPreview means
// off) can never differ between the two.

type PreferenceWrite = { [K in PrefKey]: [K, AppPreferences[K]] }[PrefKey];

export interface PreferenceToggle {
  read: (preferences: AppPreferences) => boolean;
  write: (preferences: AppPreferences, next: boolean) => PreferenceWrite;
}

function defaultOn<K extends PrefKey>(key: K): PreferenceToggle {
  return {
    read: (preferences) => preferences[key] !== false,
    write: (_preferences, next) => [key, next as AppPreferences[K]] as PreferenceWrite,
  };
}

function defaultOff<K extends PrefKey>(key: K): PreferenceToggle {
  return {
    read: (preferences) => preferences[key] === true,
    write: (_preferences, next) => [key, next as AppPreferences[K]] as PreferenceWrite,
  };
}

function channel(name: keyof AppPreferences["notificationChannels"]): PreferenceToggle {
  return {
    read: (preferences) => preferences.notificationChannels[name],
    write: (preferences, next) => [
      "notificationChannels",
      { ...preferences.notificationChannels, [name]: next },
    ],
  };
}

export const PREFERENCE_TOGGLES = {
  glassEffects: defaultOn("glassEffects"),
  keepRunningInBackground: defaultOn("keepRunningInBackground"),
  autoOpenPreview: defaultOff("autoOpenPreview"),
  terminalLinkMenu: defaultOn("terminalLinkMenu"),
  agentWorktreesEnabled: defaultOn("agentWorktreesEnabled"),
  agentsMayRemoveUserWorktrees: defaultOff("agentsMayRemoveUserWorktrees"),
  closeTabsOnMiddleClick: defaultOff("closeTabsOnMiddleClick"),
  notifyInApp: channel("inApp"),
  notifyNative: channel("native"),
  notifySound: channel("sound"),
  notifyOsCues: channel("osCues"),
  gitAutoFetchEnabled: defaultOn("gitAutoFetchEnabled"),
  notifyTeammatePushes: defaultOn("notifyTeammatePushes"),
  notifyPullRequests: defaultOn("notifyPullRequests"),
  notifyCiFailures: defaultOn("notifyCiFailures"),
  watchPullRequests: defaultOn("watchPullRequests"),
  vimMode: defaultOff("vimMode"),
  autosaveEnabled: defaultOff("autosaveEnabled"),
  inlineAutocompleteEnabled: defaultOff("inlineAutocompleteEnabled"),
  quickOpenAnywhere: defaultOn("quickOpenAnywhere"),
  restoreAgentSessions: defaultOff("restoreAgentSessions"),
  restoreTerminalOutput: defaultOn("restoreTerminalOutput"),
  machinesEnabled: defaultOn("machinesEnabled"),
  keepAgentsInYourChrome: defaultOn("keepAgentsInYourChrome"),
  usageForecast: defaultOn("usageForecast"),
} satisfies Record<string, PreferenceToggle>;

export type PreferenceToggleId = keyof typeof PREFERENCE_TOGGLES;

type SetPreference = <K extends PrefKey>(key: K, value: AppPreferences[K]) => Promise<void>;

/** `checked` and `onChange` for a ToggleRow bound to one preference. */
export function bindToggle(
  id: PreferenceToggleId,
  preferences: AppPreferences,
  setPreference: SetPreference,
): { checked: boolean; onChange: (next: boolean) => void } {
  const toggle: PreferenceToggle = PREFERENCE_TOGGLES[id];
  return {
    checked: toggle.read(preferences),
    onChange: (next) => {
      const [key, value] = toggle.write(preferences, next);
      void setPreference(key, value);
    },
  };
}
