import { emit, listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { Keyboard, Plus, Trash2 } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
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

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section>
      {title && <h3 className="group-title">{title}</h3>}
      <div className="group-box">{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={wide ? "row wide" : "row"}>
      <div className="row-text">
        <span className="row-label">{label}</span>
        {hint && <span className="row-hint">{hint}</span>}
      </div>
      {children && <div className="row-ctl">{children}</div>}
    </div>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <input
        type="checkbox"
        className="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </Row>
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

  if (!form) return <div className="settings-pane" />;

  const set = (patch: Partial<Settings>) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await saveSettings(next);
      onSettings(next);
      setSaved(true);
      void emit("settings-saved", next);
      window.setTimeout(() => setSaved(false), 1600);
    }, 450);
  };

  return (
    <div className="settings-pane">
      {section === "general" && <General form={form} set={set} />}
      {section === "shortcuts" && <Shortcuts form={form} set={set} />}
      {section === "ai" && <AI form={form} set={set} />}
      {section === "dictionary" && <Dictionary />}
      {section === "history" && <History />}
      {section === "diagnostics" && <Diagnostics />}
      <div className={`autosave ${saved ? "visible" : ""}`}>Gespeichert</div>
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
    setUpdateStatus("Prüfe Updates…");
    const found = await check().catch(() => null);
    setUpdate(found);
    setUpdateStatus(
      found
        ? `Version ${found.version} ist verfügbar.`
        : "VoiZe ist auf dem neuesten Stand.",
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
    <>
      <Group title="Ausgabe">
        <Row
          label="Fertiger Text"
          hint="Direkt einfügen tippt den Text an der Cursorposition ein."
        >
          <select
            value={form.output_mode}
            onChange={(e) =>
              set({ output_mode: e.target.value as Settings["output_mode"] })
            }
          >
            <option value="insert">Direkt einfügen</option>
            <option value="clipboard">Zwischenablage</option>
          </select>
        </Row>
        <SwitchRow
          label="Zwischenablage wiederherstellen"
          hint="Nach dem Einfügen wird der vorherige Inhalt zurückgelegt."
          checked={form.restore_clipboard}
          onChange={(restore_clipboard) => set({ restore_clipboard })}
        />
      </Group>

      <Group title="Verhalten">
        <SwitchRow
          label="Aktivierungssound"
          checked={form.start_sound_enabled}
          onChange={(start_sound_enabled) => set({ start_sound_enabled })}
        />
        <SwitchRow
          label="Abschlusssound"
          checked={form.finish_sound_enabled}
          onChange={(finish_sound_enabled) => set({ finish_sound_enabled })}
        />
        <SwitchRow
          label="Beim Start nach Updates suchen"
          checked={form.auto_update_on_launch}
          onChange={(auto_update_on_launch) => set({ auto_update_on_launch })}
        />
        <SwitchRow
          label="Bei Anmeldung öffnen"
          hint={autostart === null ? "Im Entwicklungsmodus eventuell nicht verfügbar." : undefined}
          checked={Boolean(autostart)}
          onChange={(v) => void toggleAutostart(v)}
        />
      </Group>

      <Group title="Updates">
        <Row label="Softwareupdate" hint={updateStatus || "Sucht nach neuen Versionen auf GitHub."}>
          <div className="btn-row">
            <button type="button" className="push" onClick={() => void checkUpdate()}>
              Prüfen
            </button>
            <button
              type="button"
              className="push primary"
              onClick={() => void installUpdate()}
              disabled={!update || installing}
            >
              Installieren
            </button>
          </div>
        </Row>
      </Group>
    </>
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
    <>
      <Group title="Zum Diktieren halten">
        <Row
          wide
          label="Push-to-talk"
          hint="Taste gedrückt halten, sprechen, loslassen. Fn ist der Standard; Ctrl+Opt ist die robuste Option für externe Tastaturen."
        >
          <HotkeyCapture
            value={form.hotkey}
            onChange={(hotkey) => set({ hotkey })}
            presets={["Fn", "Ctrl+Opt", "Opt+Cmd"]}
          />
        </Row>
      </Group>
      <Group title="Einmal drücken">
        <Row
          wide
          label="Freihand-Modus"
          hint="Einmal drücken zum Starten, erneut drücken zum Stoppen. Ctrl+Opt+Space ist zusätzlich immer aktiv."
        >
          <HotkeyCapture
            value={form.hands_free_hotkey}
            onChange={(hands_free_hotkey) => set({ hands_free_hotkey })}
            presets={["Fn+Space", "Ctrl+Opt+Space", "Opt+Space"]}
          />
        </Row>
      </Group>
    </>
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
        <Keyboard size={14} />
        <span>{capturing ? "Tasten drücken…" : value}</span>
      </button>
      <div className="preset-row">
        {presets.map((preset) => (
          <button type="button" className="push" key={preset} onClick={() => onChange(preset)}>
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
    <>
      <Group title="OpenRouter">
        <Row label="API-Schlüssel" hint="Wird sicher in der macOS-Keychain gespeichert.">
          <input
            type="password"
            value={form.openrouter_api_key}
            onChange={(e) => set({ openrouter_api_key: e.target.value })}
            placeholder="sk-or-v1-…"
          />
        </Row>
        <SwitchRow
          label="Nachbearbeitung"
          hint="Formatiert Sätze, Listen und häufige Erkennungsfehler mit KI."
          checked={form.postprocess_enabled}
          onChange={(postprocess_enabled) => set({ postprocess_enabled })}
        />
        <SwitchRow
          label="App-Kontext nutzen"
          hint="Die fokussierte App fließt als Kontext in die Formatierung ein."
          checked={form.context_enabled}
          onChange={(context_enabled) => set({ context_enabled })}
        />
        <SwitchRow
          label="Intelligente Formatierung"
          hint="Absätze, Aufzählungen und Struktur, wenn das Gesprochene es nahelegt."
          checked={form.smart_formatting}
          onChange={(smart_formatting) => set({ smart_formatting })}
        />
      </Group>

      <Group title="Modell">
        <Row wide label="Nachbearbeitung">
          <ModelSelect
            value={form.postprocess_model}
            onChange={(postprocess_model) => set({ postprocess_model })}
          />
        </Row>
      </Group>

      <Group title="Eigene Anweisung">
        <Row
          wide
          label="Stil und Regeln"
          hint="Zum Beispiel: Schreibe E-Mails knapp und direkt. Erkenne gesprochene Bulletpoints."
        >
          <textarea
            rows={5}
            value={form.custom_instructions}
            onChange={(e) => set({ custom_instructions: e.target.value })}
          />
        </Row>
      </Group>
    </>
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
    });
    setTerm("");
    setReplacement("");
    setNotes("");
    refresh();
  }

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void add();
    }
  };

  return (
    <>
      <Group title="Neuer Eintrag">
        <div className="dictionary-form">
          <p className="dictionary-intro">
            Begriffe, die beim Diktieren oft falsch geschrieben werden – Namen,
            Produkte oder Fachwörter. Mit <strong>Ersetzung</strong> wird der
            Begriff direkt ausgetauscht; ohne Ersetzung achtet nur die
            Nachbearbeitung auf die richtige Schreibweise.
          </p>
          <label className="field">
            <span className="field-label">Begriff</span>
            <input
              type="text"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={onEnter}
              placeholder="z. B. VoiZe"
            />
          </label>
          <div className="field-pair">
            <label className="field">
              <span className="field-label">
                Ersetzung <em>optional</em>
              </span>
              <input
                type="text"
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                onKeyDown={onEnter}
                placeholder="Korrekte Schreibweise"
              />
            </label>
            <label className="field">
              <span className="field-label">
                Notiz <em>optional</em>
              </span>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onKeyDown={onEnter}
                placeholder="Nur zur Erinnerung"
              />
            </label>
          </div>
          <button
            type="button"
            className="push primary dictionary-add"
            onClick={() => void add()}
            disabled={!term.trim()}
          >
            <Plus size={14} />
            Hinzufügen
          </button>
        </div>
      </Group>
      {entries.length > 0 ? (
        <Group title={`${entries.length} ${entries.length === 1 ? "Eintrag" : "Einträge"}`}>
          {entries.map((entry) => (
            <div key={entry.id} className="row dictionary-entry">
              <div className="row-text">
                <span className="row-label">
                  {entry.term}
                  {entry.replacement && (
                    <span className="dictionary-arrow"> → {entry.replacement}</span>
                  )}
                </span>
                {entry.notes ? (
                  <span className="row-hint">{entry.notes}</span>
                ) : !entry.replacement ? (
                  <span className="row-hint">Achtet auf die Schreibweise</span>
                ) : null}
              </div>
              <div className="row-ctl">
                <button
                  type="button"
                  className="ghost"
                  aria-label="Eintrag löschen"
                  onClick={() => dictionaryDelete(entry.id).then(refresh)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </Group>
      ) : (
        <p className="dictionary-empty">Noch keine Einträge.</p>
      )}
    </>
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

  return (
    <>
      <Group>
        <div className="row">
          <input
            className="history-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Verlauf durchsuchen"
          />
        </div>
      </Group>
      {entries.length > 0 && (
        <Group>
          {entries.map((entry) => (
            <div key={entry.id} className="row wide history-row">
              <header>
                <span className="row-hint">
                  {new Date(entry.created_at).toLocaleString()} ·{" "}
                  {entry.focused_app || "Unbekannte App"} ·{" "}
                  {entry.post_processed ? "KI formatiert" : "Lokal"}
                </span>
                <div className="btn-row">
                  <button
                    type="button"
                    className="push"
                    onClick={() => void deliverText(entry.final_text, "clipboard", false)}
                  >
                    Kopieren
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    aria-label="Eintrag löschen"
                    onClick={() => historyDelete(entry.id).then(refresh)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </header>
              <p>{entry.final_text}</p>
            </div>
          ))}
        </Group>
      )}
    </>
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
    const poll = window.setInterval(refresh, 3000);
    // Returning from the System Settings pane should reflect a freshly granted
    // permission at once, not after the next poll tick.
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      void unProgress.then((f) => f());
      void unDone.then((f) => f());
      void unError.then((f) => f());
      window.clearInterval(poll);
      window.removeEventListener("focus", onFocus);
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

  return (
    <>
      <Group title="Lokale Transkription">
        <Row label="Engine" hint={asr?.engine ?? "wird geprüft"}>
          <span className={`status-pill ${asr?.installed ? "ok" : "warn"}`}>
            {asr?.installed ? "Installiert" : downloading ? "Lädt…" : "Nicht installiert"}
          </span>
        </Row>
        <Row
          label="Modell"
          hint={
            failed
              ? message
              : downloading && progress
                ? `${formatBytes(progress.downloaded)} von ${formatBytes(progress.total)} (${percent} %)`
                : asr?.installed
                  ? asr?.loaded
                    ? "Im Speicher, sofort bereit."
                    : "Wird bei Bedarf geladen."
                  : `Einmaliger Download, ${formatBytes(asr?.total_bytes ?? 0)}. Danach läuft alles offline.`
          }
        >
          <div className="btn-row">
            {!asr?.installed && !downloading && (
              <button type="button" className="push primary" onClick={() => void startDownload()}>
                {failed ? "Erneut versuchen" : "Laden"}
              </button>
            )}
            {downloading && (
              <button type="button" className="push" onClick={() => void asrCancelDownload()}>
                Abbrechen
              </button>
            )}
            {asr?.installed && (
              <button type="button" className="push" onClick={() => void removeModel()}>
                Entfernen
              </button>
            )}
          </div>
        </Row>
        {downloading && (
          <div className="row wide">
            <div className="progress-track">
              <span style={{ width: `${Math.max(2, percent)}%` }} />
            </div>
          </div>
        )}
      </Group>

      <Group title="macOS-Berechtigungen">
        <Row
          label="Bedienungshilfen"
          hint={
            access
              ? "Direktes Einfügen ist möglich."
              : "Ohne diese Berechtigung landet der Text in der Zwischenablage."
          }
        >
          <div className="btn-row">
            <span className={`status-pill ${access ? "ok" : "warn"}`}>
              {access ? "Erlaubt" : "Nicht erlaubt"}
            </span>
            {!access && (
              <button
                type="button"
                className="push"
                onClick={() => requestAccessibility().then(setAccess)}
              >
                Öffnen
              </button>
            )}
          </div>
        </Row>
        {access === false && (
          <div className="row wide">
            <p className="permission-note">
              <strong>VoiZe steht schon in der Liste, aber hier weiterhin auf
              „Nicht erlaubt"?</strong> Dann ist der Eintrag veraltet – nach
              einem Update ändert sich die App-Signatur, und macOS erkennt die
              alte Freigabe nicht mehr. So behebst du es dauerhaft: In
              Systemeinstellungen → Datenschutz &amp; Sicherheit →
              Bedienungshilfen den vorhandenen VoiZe-Eintrag mit „–" entfernen,
              danach mit „+" neu hinzufügen (oder den Schalter aus- und wieder
              einschalten) und VoiZe einmal neu starten. Der Status hier
              aktualisiert sich automatisch.
            </p>
          </div>
        )}
      </Group>
    </>
  );
}
