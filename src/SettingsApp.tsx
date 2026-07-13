import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import {
  BarChart3,
  AppWindow,
  Bot,
  Clock3,
  Info,
  Keyboard,
  Library,
  Settings,
  Wrench,
} from "lucide-react";
import type { ComponentType } from "react";
import { useEffect, useState } from "react";
import { getSettings } from "./lib/api";
import type { Settings as SettingsType } from "./lib/types";
import SettingsPanel, { type SettingsSection } from "./components/SettingsPanel";

const NAV: { id: SettingsSection; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: "insights", label: "Insights", icon: BarChart3 },
  { id: "general", label: "Allgemein", icon: Settings },
  { id: "shortcuts", label: "Kurzbefehle", icon: Keyboard },
  { id: "ai", label: "KI", icon: Bot },
  { id: "apps", label: "Apps", icon: AppWindow },
  { id: "dictionary", label: "Wörterbuch", icon: Library },
  { id: "history", label: "Verlauf", icon: Clock3 },
  { id: "diagnostics", label: "Diagnose", icon: Wrench },
  { id: "about", label: "Über", icon: Info },
];

export default function SettingsApp() {
  const [section, setSection] = useState<SettingsSection>("insights");
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
    getSettings().then(setSettings).catch(() => {});
    const un = listen<string>("settings-open", (event) => {
      const next = event.payload as SettingsSection;
      if (NAV.some((item) => item.id === next)) setSection(next);
      getSettings().then(setSettings).catch(() => {});
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  return (
    <div className="settings-window">
      <aside className="settings-sidebar" data-tauri-drag-region>
        <div className="settings-traffic" data-tauri-drag-region />
        <div className="settings-app" data-tauri-drag-region>
          VoiZe
        </div>
        <nav className="settings-nav">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                key={item.id}
                className={section === item.id ? "active" : ""}
                onClick={() => setSection(item.id)}
              >
                <span className="glyph">
                  <Icon size={12} />
                </span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="settings-version" data-tauri-drag-region>
          {version ? `Version ${version}` : ""}
        </div>
      </aside>
      <main className="settings-content">
        <header className="settings-header" data-tauri-drag-region>
          {NAV.find((item) => item.id === section)?.label}
        </header>
        <div className="settings-scroll">
          <SettingsPanel
            section={section}
            settings={settings}
            onSettings={setSettings}
          />
        </div>
      </main>
    </div>
  );
}
