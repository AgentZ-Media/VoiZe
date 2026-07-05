import { listen } from "@tauri-apps/api/event";
import {
  Bot,
  Clock3,
  Keyboard,
  Library,
  Mic,
  Settings,
  Wrench,
} from "lucide-react";
import type { ComponentType } from "react";
import { useEffect, useState } from "react";
import { getSettings } from "./lib/api";
import type { Settings as SettingsType } from "./lib/types";
import SettingsPanel, { type SettingsSection } from "./components/SettingsPanel";

const NAV: { id: SettingsSection; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: "general", label: "Allgemein", icon: Settings },
  { id: "shortcuts", label: "Kurzbefehle", icon: Keyboard },
  { id: "ai", label: "KI", icon: Bot },
  { id: "dictionary", label: "Wörterbuch", icon: Library },
  { id: "history", label: "Verlauf", icon: Clock3 },
  { id: "diagnostics", label: "Diagnose", icon: Wrench },
];

export default function SettingsApp() {
  const [section, setSection] = useState<SettingsSection>("general");
  const [settings, setSettings] = useState<SettingsType | null>(null);

  useEffect(() => {
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
    <main className="settings-window">
      <aside className="settings-sidebar">
        <div className="traffic-space" data-tauri-drag-region />
        <div className="settings-brand" data-tauri-drag-region>
          <Mic size={18} />
          <span>VoiZe</span>
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
                <Icon size={15} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>
      <section className="settings-content">
        <header className="settings-header" data-tauri-drag-region>
          {NAV.find((item) => item.id === section)?.label}
        </header>
        <SettingsPanel
          section={section}
          settings={settings}
          onSettings={setSettings}
        />
      </section>
    </main>
  );
}
