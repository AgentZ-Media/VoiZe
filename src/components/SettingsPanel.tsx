import { emit, listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import {
  Check,
  Copy,
  Download,
  Keyboard,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  accessibilityStatus,
  asrCancelDownload,
  asrDownload,
  asrRemoveModel,
  asrStatus,
  deliverText,
  dictionaryDelete,
  dictionaryList,
  dictionaryUpsert,
  historyDelete,
  historyList,
  requestAccessibility,
  saveSettings,
  getSettings,
} from "../lib/api";
import type {
  AsrDownloadProgress,
  AsrStatus,
  DictionaryEntry,
  HistoryEntry,
  Settings,
} from "../lib/types";
import ModelSelect from "./ModelSelect";

export type SettingsSection =
  | "general"
  | "shortcuts"
  | "ai"
  | "dictionary"
  | "history"
  | "diagnostics";

interface Props {
  section: SettingsSection;
  settings: Settings | null;
  onSettings: (settings: Settings) => void;
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

export default function SettingsPanel({ section, settings, onSettings }: Props) {
  const [form, setForm] = useState<Settings | null>(settings);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setForm(settings), [settings]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (!form) return <div className="settings-scroll" />;

  const set = (patch: Partial<Settings>) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await saveSettings(next);
      onSettings(next);
      setSaved(true);
      void emit("settings-saved", next);
      window.setTimeout(() => setSaved(false), 1200);
    }, 450);
  };

  return (
    <div className="settings-scroll">
      {section === "general" && <General form={form} set={set} />}
      {section === "shortcuts" && <Shortcuts form={form} set={set} />}
      {section === "ai" && <AI form={form} set={set} />}
      {section === "dictionary" && <Dictionary />}
      {section === "history" && <History />}
      {section === "diagnostics" && <Diagnostics />}
      <div className={`autosave ${saved ? "visible" : ""}`}>
        <Check size={13} />
        Gespeichert
      </div>
    </div>
  );
}

function General({
  form,
  set,
}: {
  form: Settings;
  set: (patch: Partial<Settings>) => void;
}) {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateStatus, setUpdateStatus] = useState("");
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    isEnabled().then(setAutostart).catch(() => setAutostart(null));
  }, []);

  async function toggleAutostart(next: boolean) {
    try {
      if (next) await enable();
      else await disable();
      setAutostart(next);
    } catch {
      setAutostart(null);
    }
  }

  async function checkUpdate() {
    setUpdateStatus("Prüfe Updates...");
    const found = await check().catch(() => null);
    setUpdate(found);
    setUpdateStatus(
      found
        ? `Version ${found.version} ist verfügbar.`
        : "Keine Aktualisierung gefunden oder im Dev-Modus nicht verfügbar.",
    );
  }

  async function installUpdate() {
    if (!update) return;
    setInstalling(true);
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setInstalling(false);
      setUpdateStatus(String(e));
    }
  }

  return (
    <div className="pane-stack">
      <section className="group">
        <h2>Ausgabe</h2>
        <div className="segmented">
          <button
            type="button"
            className={form.output_mode === "insert" ? "active" : ""}
            onClick={() => set({ output_mode: "insert" })}
          >
            Direkt einfügen
          </button>
          <button
            type="button"
            className={form.output_mode === "clipboard" ? "active" : ""}
            onClick={() => set({ output_mode: "clipboard" })}
          >
            Zwischenablage
          </button>
        </div>
        <Toggle
          checked={form.restore_clipboard}
          onChange={(restore_clipboard) => set({ restore_clipboard })}
          label="Vorherige Zwischenablage wiederherstellen"
          hint="Nach erfolgreichem Einfügen wird der alte Clipboard-Inhalt zurückgelegt."
        />
      </section>

      <section className="group">
        <h2>Verhalten</h2>
        <Toggle
          checked={form.start_sound_enabled}
          onChange={(start_sound_enabled) => set({ start_sound_enabled })}
          label="Aktivierungssound"
        />
        <Toggle
          checked={form.finish_sound_enabled}
          onChange={(finish_sound_enabled) => set({ finish_sound_enabled })}
          label="Abschlusssound"
        />
        <Toggle
          checked={form.auto_update_on_launch}
          onChange={(auto_update_on_launch) => set({ auto_update_on_launch })}
          label="Beim Start automatisch nach Updates suchen"
        />
        <Toggle
          checked={Boolean(autostart)}
          onChange={(v) => void toggleAutostart(v)}
          label="Bei Systemstart öffnen"
          hint={autostart === null ? "Im Entwicklungsmodus eventuell nicht verfügbar." : undefined}
        />
      </section>

      <section className="group">
        <h2>Updates</h2>
        <div className="button-row">
          <button type="button" className="soft-btn" onClick={() => void checkUpdate()}>
            <RefreshCw size={14} />
            Nach Updates suchen
          </button>
          <button
            type="button"
            className="primary-btn"
            onClick={() => void installUpdate()}
            disabled={!update || installing}
          >
            <Download size={14} />
            Installieren
          </button>
        </div>
        {updateStatus && <p className="hint-line">{updateStatus}</p>}
      </section>
    </div>
  );
}

function Shortcuts({
  form,
  set,
}: {
  form: Settings;
  set: (patch: Partial<Settings>) => void;
}) {
  return (
    <div className="pane-stack">
      <section className="group">
        <h2>Zum Diktieren halten</h2>
        <HotkeyCapture
          value={form.hotkey}
          onChange={(hotkey) => set({ hotkey })}
          presets={["Fn", "Ctrl+Opt", "Opt+Cmd"]}
        />
        <p className="hint-line">
          Wispr Flow nutzt auf Macs standardmäßig Fn. Für externe Tastaturen ist Ctrl+Opt die robuste Ausweichoption.
        </p>
      </section>
      <section className="group">
        <h2>Einmal drücken</h2>
        <HotkeyCapture
          value={form.hands_free_hotkey}
          onChange={(hands_free_hotkey) => set({ hands_free_hotkey })}
          presets={["Fn+Space", "Ctrl+Opt+Space", "Opt+Space"]}
        />
        <p className="hint-line">
          Standard ist Fn+Space. Ctrl+Opt+Space wird zusätzlich als robuste Ausweichoption registriert.
        </p>
      </section>
    </div>
  );
}

function keyName(event: React.KeyboardEvent<HTMLButtonElement>) {
  if (event.code === "Space" || event.key === " ") return "Space";
  if (event.key === "Escape") return "Esc";
  if (event.key === "Meta") return "Cmd";
  if (event.key === "Alt") return "Opt";
  if (event.key === "Control") return "Ctrl";
  if (event.key === "Shift") return "Shift";
  if (event.key === "Fn" || event.getModifierState("Fn")) return "Fn";
  if (/^Key[A-Z]$/.test(event.code)) return event.code.replace("Key", "");
  if (/^Digit[0-9]$/.test(event.code)) return event.code.replace("Digit", "");
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

function capturedHotkey(event: React.KeyboardEvent<HTMLButtonElement>) {
  const parts: string[] = [];
  if (event.getModifierState("Fn")) parts.push("Fn");
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Opt");
  if (event.metaKey) parts.push("Cmd");
  if (event.shiftKey) parts.push("Shift");
  const key = keyName(event);
  if (!["Fn", "Ctrl", "Opt", "Cmd", "Shift"].includes(key)) parts.push(key);
  return Array.from(new Set(parts)).join("+");
}

function HotkeyCapture({
  value,
  onChange,
  presets,
}: {
  value: string;
  onChange: (value: string) => void;
  presets: string[];
}) {
  const [capturing, setCapturing] = useState(false);
  return (
    <div className="hotkey-field">
      <button
        type="button"
        className={`hotkey-capture ${capturing ? "capturing" : ""}`}
        onClick={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
        onKeyDown={(event) => {
          if (!capturing) return;
          event.preventDefault();
          event.stopPropagation();
          const next = capturedHotkey(event);
          if (next) onChange(next);
          setCapturing(false);
        }}
      >
        <Keyboard size={15} />
        <span>{capturing ? "Tasten drücken..." : value}</span>
      </button>
      <div className="preset-row">
        {presets.map((preset) => (
          <button type="button" key={preset} onClick={() => onChange(preset)}>
            {preset}
          </button>
        ))}
      </div>
    </div>
  );
}

function AI({
  form,
  set,
}: {
  form: Settings;
  set: (patch: Partial<Settings>) => void;
}) {
  return (
    <div className="pane-stack">
      <section className="group">
        <h2>OpenRouter</h2>
        <label className="field">
          <span>API-Schlüssel</span>
          <input
            type="password"
            value={form.openrouter_api_key}
            onChange={(e) => set({ openrouter_api_key: e.target.value })}
            placeholder="sk-or-v1-..."
          />
        </label>
        <Toggle
          checked={form.postprocess_enabled}
          onChange={(postprocess_enabled) => set({ postprocess_enabled })}
          label="Nachbearbeitung aktivieren"
          hint="Formatiert Sätze, Listen, Abschnitte und häufige ASR-Fehler."
        />
        <Toggle
          checked={form.context_enabled}
          onChange={(context_enabled) => set({ context_enabled })}
          label="Fokussierte App als Kontext nutzen"
        />
        <Toggle
          checked={form.smart_formatting}
          onChange={(smart_formatting) => set({ smart_formatting })}
          label="Intelligente Formatierung"
        />
      </section>
      <section className="group">
        <h2>Modelle</h2>
        <label className="field">
          <span>Nachbearbeitung</span>
          <ModelSelect
            value={form.postprocess_model}
            onChange={(postprocess_model) => set({ postprocess_model })}
          />
        </label>
        <label className="field">
          <span>Lernen</span>
          <ModelSelect
            value={form.learning_model}
            onChange={(learning_model) => set({ learning_model })}
          />
        </label>
      </section>
      <section className="group">
        <h2>Lernendes Wörterbuch</h2>
        <Toggle
          checked={form.learning_enabled}
          onChange={(learning_enabled) => set({ learning_enabled })}
          label="Alle paar Stunden Vorschläge lernen"
          hint="Analysiert lokale Verlaufseinträge und ergänzt plausible Eigennamen."
        />
        <label className="field inline">
          <span>Intervall in Stunden</span>
          <input
            type="number"
            min={1}
            max={48}
            value={form.learning_interval_hours}
            onChange={(e) => set({ learning_interval_hours: Number(e.target.value) })}
          />
        </label>
      </section>
      <section className="group">
        <h2>Eigene Anweisung</h2>
        <textarea
          value={form.custom_instructions}
          onChange={(e) => set({ custom_instructions: e.target.value })}
          placeholder="Zum Beispiel: Schreibe E-Mails knapp und direkt. Erkenne gesprochene Bulletpoints."
        />
      </section>
    </div>
  );
}

function Dictionary() {
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [term, setTerm] = useState("");
  const [replacement, setReplacement] = useState("");
  const [notes, setNotes] = useState("");

  const refresh = () => dictionaryList().then(setEntries).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  async function add() {
    if (!term.trim()) return;
    await dictionaryUpsert({
      term: term.trim(),
      replacement: replacement.trim() || null,
      notes: notes.trim() || null,
      priority: false,
      learned: false,
    });
    setTerm("");
    setReplacement("");
    setNotes("");
    refresh();
  }

  return (
    <div className="pane-stack">
      <section className="group">
        <h2>Neuer Eintrag</h2>
        <div className="dictionary-editor">
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Begriff" />
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="Ersetzung optional"
          />
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notiz" />
          <button type="button" className="primary-btn square" onClick={() => void add()}>
            <Plus size={15} />
          </button>
        </div>
      </section>
      <section className="list group">
        {entries.map((entry) => (
          <article key={entry.id} className="list-row">
            <div>
              <strong>{entry.term}</strong>
              <span>
                {entry.replacement ? `-> ${entry.replacement}` : "Priorisierter Begriff"}
                {entry.learned ? " · gelernt" : ""}
              </span>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="Eintrag löschen"
              onClick={() => dictionaryDelete(entry.id).then(refresh)}
            >
              <Trash2 size={14} />
            </button>
          </article>
        ))}
      </section>
    </div>
  );
}

function History() {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const refresh = () => historyList(query, 160).then(setEntries).catch(() => {});

  useEffect(() => {
    const t = window.setTimeout(refresh, 180);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const grouped = useMemo(() => entries, [entries]);

  return (
    <div className="pane-stack">
      <section className="group">
        <label className="field">
          <span>Suchen</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </section>
      <section className="list group history-list">
        {grouped.map((entry) => (
          <article key={entry.id} className="history-row">
            <header>
              <strong>{new Date(entry.created_at).toLocaleString()}</strong>
              <span>{entry.focused_app || "Unbekannte App"}</span>
            </header>
            <p>{entry.final_text}</p>
            <footer>
              <span>{entry.post_processed ? "KI formatiert" : "Lokal"}</span>
              <div className="button-row compact">
                <button
                  type="button"
                  className="soft-btn"
                  onClick={() => void deliverText(entry.final_text, "clipboard", false)}
                >
                  <Copy size={13} />
                  Kopieren
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Eintrag löschen"
                  onClick={() => historyDelete(entry.id).then(refresh)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </footer>
          </article>
        ))}
      </section>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function Diagnostics() {
  const [asr, setAsr] = useState<AsrStatus | null>(null);
  const [access, setAccess] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<AsrDownloadProgress | null>(null);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  const refresh = () => {
    asrStatus().then(setAsr).catch(() => {});
    accessibilityStatus().then(setAccess).catch(() => setAccess(null));
  };
  useEffect(refresh, []);

  useEffect(() => {
    const unProgress = listen<AsrDownloadProgress>("asr://progress", (event) => {
      setFailed(false);
      setProgress(event.payload);
    });
    const unDone = listen("asr://done", async () => {
      setProgress(null);
      setFailed(false);
      setMessage("Lokale Transkription ist bereit.");
      refresh();
      const current = await getSettings().catch(() => null);
      if (current && !current.asr_model_ready) {
        const next = { ...current, asr_model_ready: true };
        await saveSettings(next).catch(() => {});
        await emit("settings-saved", next).catch(() => {});
      }
    });
    const unError = listen<string>("asr://error", (event) => {
      setProgress(null);
      setFailed(true);
      setMessage(event.payload);
      refresh();
    });
    // keep the pane live while a download started elsewhere is running
    const poll = window.setInterval(refresh, 3000);
    return () => {
      void unProgress.then((f) => f());
      void unDone.then((f) => f());
      void unError.then((f) => f());
      window.clearInterval(poll);
    };
  }, []);

  async function startDownload() {
    setFailed(false);
    setMessage("");
    setProgress({ downloaded: 0, total: asr?.total_bytes ?? 0 });
    refresh();
    await asrDownload().catch(() => {
      // asr://error carries the message
    });
    refresh();
  }

  async function removeModel() {
    await asrRemoveModel().catch(() => {});
    setMessage("");
    setProgress(null);
    refresh();
  }

  const downloading = progress !== null || Boolean(asr?.downloading);
  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : 0;
  const stateClass = failed
    ? "error"
    : asr?.installed
      ? "ready"
      : downloading
        ? "determinate"
        : "idle";

  return (
    <div className="pane-stack">
      <section className="group">
        <h2>Lokale Transkription</h2>
        <dl className="diagnostics">
          <dt>Engine</dt>
          <dd>{asr?.engine ?? "wird geprüft"}</dd>
          <dt>Modell</dt>
          <dd>
            {asr?.installed
              ? "installiert"
              : downloading
                ? "wird geladen"
                : `nicht installiert (${formatBytes(asr?.total_bytes ?? 0)})`}
          </dd>
          <dt>Status</dt>
          <dd>{asr?.loaded ? "im Speicher, sofort bereit" : "wird bei Bedarf geladen"}</dd>
        </dl>
        <div className={`setup-progress ${stateClass}`}>
          <div className="setup-progress-bar">
            <span style={downloading ? { width: `${Math.max(2, percent)}%` } : undefined} />
          </div>
          <p>
            {failed
              ? message
              : downloading && progress
                ? `${formatBytes(progress.downloaded)} von ${formatBytes(progress.total)} (${percent} %)`
                : asr?.installed
                  ? message || "Alles bereit. Die Transkription läuft vollständig lokal."
                  : "Das Sprachmodell wird einmalig heruntergeladen (~670 MB). Danach ist keine Internetverbindung mehr nötig."}
          </p>
        </div>
        <div className="button-row">
          {!asr?.installed && !downloading && (
            <button type="button" className="primary-btn" onClick={() => void startDownload()}>
              <Download size={14} />
              {failed ? "Erneut versuchen" : "Modell laden"}
            </button>
          )}
          {downloading && (
            <button type="button" className="soft-btn" onClick={() => void asrCancelDownload()}>
              Abbrechen
            </button>
          )}
          {asr?.installed && (
            <button type="button" className="soft-btn" onClick={() => void removeModel()}>
              <Trash2 size={14} />
              Modell entfernen
            </button>
          )}
        </div>
      </section>
      <section className="group">
        <h2>macOS Berechtigungen</h2>
        <dl className="diagnostics">
          <dt>Bedienungshilfen</dt>
          <dd>{access ? "erlaubt" : "nicht erlaubt — direktes Einfügen fällt auf die Zwischenablage zurück"}</dd>
        </dl>
        <button
          type="button"
          className="soft-btn"
          onClick={() => requestAccessibility().then(setAccess)}
        >
          <RefreshCw size={14} />
          Berechtigung öffnen
        </button>
      </section>
    </div>
  );
}
