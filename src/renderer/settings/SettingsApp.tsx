import { useState, type ComponentType } from "react";
import GeneralSection from "./sections/GeneralSection";
import EditorSection from "./sections/EditorSection";
import AgentsSection from "./sections/AgentsSection";
import AboutSection from "./sections/AboutSection";

// Tab list. Future agents add a new entry here + a section component to
// extend Settings with new categories — no other wiring required.
type TabId = "general" | "editor" | "agents" | "about";

interface TabDef {
  id: TabId;
  label: string;
  component: ComponentType;
}

const TABS: readonly TabDef[] = [
  { id: "general", label: "General", component: GeneralSection },
  { id: "editor", label: "Editor", component: EditorSection },
  { id: "agents", label: "Agents", component: AgentsSection },
  { id: "about", label: "About", component: AboutSection },
];

function readInitialTab(): TabId {
  if (typeof window === "undefined") return "general";
  const params = new URLSearchParams(window.location.search);
  const t = params.get("tab");
  if (t && TABS.some((tab) => tab.id === t)) return t as TabId;
  return "general";
}

export default function SettingsApp() {
  const [active, setActive] = useState<TabId>(readInitialTab);
  const ActiveSection = TABS.find((t) => t.id === active)?.component ?? GeneralSection;

  return (
    <div className="settings-shell">
      <header className="settings-header">
        <nav className="settings-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="settings-tab"
              data-active={active === t.id ? "true" : "false"}
              onClick={() => setActive(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="settings-body">
        <ActiveSection />
      </main>
    </div>
  );
}
