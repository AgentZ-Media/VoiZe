import { getVersion } from "@tauri-apps/api/app";
import { emit, listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { Check, ExternalLink, Keyboard, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
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
  insightsSummary,
  learnRunNow,
  learnStatus,
  requestAccessibility,
  saveSettings,
  getSettings,
  suggestionAccept,
  suggestionDismiss,
  suggestionsList,
  usageSummary,
} from "../lib/api";
import type {
  AsrDownloadProgress,
  AsrStatus,
  DictionaryEntry,
  DictSuggestion,
  HistoryEntry,
  InsightsSummary,
  LearnStatus,
  Settings,
  UsageSummary,
} from "../lib/types";
import ModelSelect from "./ModelSelect";
import Select from "./Select";

export type SettingsSection =
  | "insights"
  | "general"
  | "shortcuts"
  | "ai"
  | "dictionary"
  | "history"
  | "diagnostics"
  | "about";

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
      {section === "insights" && <Insights />}
      {section === "general" && <General form={form} set={set} />}
      {section === "shortcuts" && <Shortcuts form={form} set={set} />}
      {section === "ai" && <AI form={form} set={set} />}
      {section === "dictionary" && <Dictionary />}
      {section === "history" && <History />}
      {section === "diagnostics" && <Diagnostics />}
      {section === "about" && <About form={form} set={set} />}
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

  return (
    <>
      <Group title="Ausgabe">
        <Row
          label="Fertiger Text"
          hint="Direkt einfügen tippt den Text an der Cursorposition ein."
        >
          <Select
            ariaLabel="Fertiger Text"
            value={form.output_mode}
            onChange={(output_mode) =>
              set({ output_mode: output_mode as Settings["output_mode"] })
            }
            options={[
              { value: "insert", label: "Direkt einfügen" },
              { value: "clipboard", label: "Zwischenablage" },
            ]}
          />
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
          label="Bei Anmeldung öffnen"
          hint={autostart === null ? "Im Entwicklungsmodus eventuell nicht verfügbar." : undefined}
          checked={Boolean(autostart)}
          onChange={(v) => void toggleAutostart(v)}
        />
      </Group>
    </>
  );
}

interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  prerelease: boolean;
}

const RELEASES_URL = "https://api.github.com/repos/AgentZ-Media/VoiZe/releases?per_page=100";
const RELEASES_CACHE_KEY = "voize.releaseNotes.v1";

function releaseVersion(tag: string) {
  return tag.replace(/^v/i, "");
}

function formatReleaseDate(iso: string | null) {
  if (!iso) return "Unveröffentlicht";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unveröffentlicht";
  return date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function cleanReleaseLine(line: string) {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*]\s+\[[ x]\]\s+/i, "• ")
    .replace(/^[-*]\s+/, "• ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function releaseNotes(body: string | null) {
  if (!body?.trim()) return [];
  return body
    .split("\n")
    .map(cleanReleaseLine)
    .filter((line) => line && !/^<!--/.test(line));
}

function readCachedReleases() {
  try {
    const raw = window.localStorage.getItem(RELEASES_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GitHubRelease[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cacheReleases(releases: GitHubRelease[]) {
  try {
    window.localStorage.setItem(RELEASES_CACHE_KEY, JSON.stringify(releases));
  } catch {
    // localStorage is a convenience cache only.
  }
}

async function fetchAllReleases() {
  const releases: GitHubRelease[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`${RELEASES_URL}&page=${page}`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`GitHub antwortet mit ${response.status}.`);
    const data = (await response.json()) as GitHubRelease[];
    if (!Array.isArray(data)) throw new Error("GitHub hat keine Release-Liste gesendet.");
    releases.push(...data);
    if (data.length < 100) break;
  }
  return releases;
}

function About({
  form,
  set,
}: {
  form: Settings;
  set: (patch: Partial<Settings>) => void;
}) {
  const [version, setVersion] = useState("");
  const [releases, setReleases] = useState<GitHubRelease[]>(() => readCachedReleases() ?? []);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateStatus, setUpdateStatus] = useState("");
  const [installing, setInstalling] = useState(false);
  // download progress 0..1, or null while indeterminate (server sent no length)
  const [progress, setProgress] = useState<number | null>(null);

  async function loadReleases(silent = false) {
    if (!silent) setStatus("");
    setLoading(true);
    try {
      const data = await fetchAllReleases();
      const published = data.filter((release) => !release.prerelease || release.published_at);
      setReleases(published);
      cacheReleases(published);
      setStatus(
        published.length > 0
          ? `${published.length} ${published.length === 1 ? "Release" : "Releases"} geladen.`
          : "Noch keine GitHub-Releases veröffentlicht.",
      );
    } catch (e) {
      setStatus(
        releases.length > 0
          ? "Offline oder GitHub nicht erreichbar. Zeige zuletzt geladene Release Notes."
          : String(e),
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
    void loadReleases(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setProgress(null);
    let total = 0;
    let downloaded = 0;
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            downloaded = 0;
            setProgress(total > 0 ? 0 : null);
            setUpdateStatus("Lädt herunter…");
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setProgress(total > 0 ? Math.min(1, downloaded / total) : null);
            break;
          case "Finished":
            setProgress(1);
            setUpdateStatus("Installiert – wird neu gestartet…");
            break;
        }
      });
      await relaunch();
    } catch (e) {
      setInstalling(false);
      setProgress(null);
      setUpdateStatus(String(e));
    }
  }

  const normalizedVersion = releaseVersion(version);
  const latest = releases[0] ?? null;
  const current = releases.find(
    (release) => releaseVersion(release.tag_name) === normalizedVersion,
  );
  const percent = progress != null ? Math.round(progress * 100) : null;

  return (
    <>
      <Group title="VoiZe">
        <Row label="Aktuelle Version" hint="Installierte App-Version aus Tauri.">
          <span className="version-tag">{version ? `v${version}` : "…"}</span>
        </Row>
        <Row
          label="Neueste Veröffentlichung"
          hint={
            latest
              ? `${latest.tag_name} · ${formatReleaseDate(latest.published_at)}`
              : status || "Wird von GitHub geladen."
          }
        >
          <div className="btn-row">
            <button
              type="button"
              className="push square"
              aria-label="Release Notes neu laden"
              onClick={() => void loadReleases()}
              disabled={loading}
            >
              <RefreshCw size={13} />
            </button>
            <button
              type="button"
              className="push"
              onClick={() => void openUrl("https://github.com/AgentZ-Media/VoiZe/releases")}
            >
              <ExternalLink size={13} />
              GitHub
            </button>
          </div>
        </Row>
        {status && (
          <div className="row wide">
            <span className="row-hint">{loading ? "Lädt Release Notes…" : status}</span>
          </div>
        )}
      </Group>

      <Group title="Updates">
        <SwitchRow
          label="Beim Start nach Updates suchen"
          checked={form.auto_update_on_launch}
          onChange={(auto_update_on_launch) => set({ auto_update_on_launch })}
        />
        <Row label="Softwareupdate" hint={updateStatus || "Sucht nach neuen Versionen auf GitHub."}>
          <div className="btn-row">
            <button
              type="button"
              className="push"
              onClick={() => void checkUpdate()}
              disabled={installing}
            >
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
        {installing && (
          <Row
            wide
            label={
              percent != null
                ? `Lädt herunter… ${percent} %`
                : progress === 1
                  ? "Fertig"
                  : "Lädt herunter…"
            }
          >
            <div className="progress-track">
              <span
                className={percent == null ? "indeterminate" : ""}
                style={percent != null ? { width: `${percent}%` } : undefined}
              />
            </div>
          </Row>
        )}
      </Group>

      <Group title="Release Notes">
        {releases.length === 0 ? (
          <div className="release-empty">
            {loading ? "Release Notes werden geladen…" : "Noch keine Release Notes gefunden."}
          </div>
        ) : (
          releases.map((release) => {
            const notes = releaseNotes(release.body);
            const visibleNotes = notes.slice(0, 24);
            const isCurrent = current?.id === release.id;
            return (
              <article key={release.id} className="release-row">
                <header className="release-head">
                  <div>
                    <h4>{release.name || release.tag_name}</h4>
                    <span>
                      {release.tag_name} · {formatReleaseDate(release.published_at)}
                    </span>
                  </div>
                  <div className="release-actions">
                    {isCurrent && <span className="status-pill ok">Installiert</span>}
                    {release.prerelease && <span className="status-pill warn">Vorab</span>}
                    <button
                      type="button"
                      className="ghost"
                      aria-label={`${release.tag_name} auf GitHub öffnen`}
                      onClick={() => void openUrl(release.html_url)}
                    >
                      <ExternalLink size={13} />
                    </button>
                  </div>
                </header>
                {visibleNotes.length > 0 ? (
                  <ul className="release-notes">
                    {visibleNotes.map((line, index) => (
                      <li key={`${release.id}-${index}`}>{line.replace(/^•\s*/, "")}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="release-fallback">Keine Notizen für dieses Release.</p>
                )}
                {notes.length > visibleNotes.length && (
                  <button
                    type="button"
                    className="release-more"
                    onClick={() => void openUrl(release.html_url)}
                  >
                    Vollständige Notizen auf GitHub öffnen
                  </button>
                )}
              </article>
            );
          })
        )}
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
  const setMinWords = (value: string) => {
    const parsed = Number.parseInt(value, 10);
    const postprocess_min_words = Number.isFinite(parsed)
      ? Math.max(0, Math.min(200, parsed))
      : 0;
    set({ postprocess_min_words });
  };

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
        <Row
          label="Nachbearbeitung ab"
          hint="Standard: 35 Wörter. 0 bedeutet: auch kurze Diktate mit KI nachbearbeiten."
        >
          <input
            type="number"
            min={0}
            max={200}
            step={5}
            value={form.postprocess_min_words}
            disabled={!form.postprocess_enabled}
            aria-label="Mindestanzahl Wörter für KI-Nachbearbeitung"
            onChange={(e) => setMinWords(e.target.value)}
          />
          <span className="unit-label">Wörter</span>
        </Row>
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
        <SwitchRow
          label="Lernvorschläge fürs Wörterbuch"
          hint="Analysiert neue Diktate alle 4 Stunden im Hintergrund und schlägt Korrekturen im Wörterbuch vor."
          checked={form.learning_enabled}
          onChange={(learning_enabled) => set({ learning_enabled })}
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

function formatLastRun(iso: string | null) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Suggestions({ onAccepted }: { onAccepted: () => void }) {
  const [suggestions, setSuggestions] = useState<DictSuggestion[]>([]);
  const [status, setStatus] = useState<LearnStatus | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = () => {
    suggestionsList().then(setSuggestions).catch(() => {});
    learnStatus().then(setStatus).catch(() => {});
  };

  useEffect(() => {
    refresh();
    const un = listen("learn://suggestions", refresh);
    return () => {
      void un.then((f) => f());
    };
  }, []);

  async function runNow() {
    setAnalyzing(true);
    setMessage("");
    try {
      const result = await learnRunNow();
      setMessage(
        result.skipped ??
          (result.analyzed === 0
            ? "Keine neuen Diktate seit der letzten Analyse."
            : result.new_suggestions === 0
              ? `${result.analyzed} Diktate analysiert – nichts Neues gefunden.`
              : `${result.analyzed} Diktate analysiert, ${result.new_suggestions} ${result.new_suggestions === 1 ? "neuer Vorschlag" : "neue Vorschläge"}.`),
      );
    } catch (e) {
      setMessage(String(e));
    }
    setAnalyzing(false);
    refresh();
  }

  async function accept(suggestion: DictSuggestion) {
    await suggestionAccept(suggestion.id).catch(() => {});
    refresh();
    onAccepted();
  }

  async function dismiss(suggestion: DictSuggestion) {
    await suggestionDismiss(suggestion.id).catch(() => {});
    refresh();
  }

  const lastRun = formatLastRun(status?.last_run_at ?? null);
  const statusHint =
    message ||
    [
      lastRun ? `Zuletzt analysiert: ${lastRun} Uhr` : "Noch nicht analysiert",
      status && status.unanalyzed > 0
        ? `${status.unanalyzed} ${status.unanalyzed === 1 ? "neues Diktat" : "neue Diktate"} in der Warteschlange`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <Group title="Vorschläge">
      <Row
        label="Aus Diktaten lernen"
        hint={statusHint || "Läuft automatisch alle 4 Stunden im Hintergrund."}
      >
        <button
          type="button"
          className="push"
          disabled={analyzing || Boolean(status?.running)}
          onClick={() => void runNow()}
        >
          {analyzing || status?.running ? "Analysiert…" : "Jetzt analysieren"}
        </button>
      </Row>
      {suggestions.map((suggestion) => (
        <div key={suggestion.id} className="row suggestion-row">
          <div className="row-text">
            <span className="row-label">
              {suggestion.term}
              <span className="dictionary-arrow"> → {suggestion.replacement}</span>
              {suggestion.occurrences > 1 && (
                <span className="suggestion-count">{suggestion.occurrences}×</span>
              )}
            </span>
            {suggestion.reason && (
              <span className="row-hint">{suggestion.reason}</span>
            )}
            {suggestion.evidence && (
              <span className="row-hint suggestion-evidence">
                „{suggestion.evidence}"
              </span>
            )}
          </div>
          <div className="row-ctl">
            <button
              type="button"
              className="push primary"
              onClick={() => void accept(suggestion)}
            >
              <Check size={13} />
              Übernehmen
            </button>
            <button
              type="button"
              className="ghost"
              aria-label="Vorschlag ablehnen"
              onClick={() => void dismiss(suggestion)}
            >
              <X size={13} />
            </button>
          </div>
        </div>
      ))}
    </Group>
  );
}

function Dictionary() {
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [term, setTerm] = useState("");
  const [replacement, setReplacement] = useState("");
  const [notes, setNotes] = useState("");
  const [editing, setEditing] = useState<DictionaryEntry | null>(null);
  const [eTerm, setETerm] = useState("");
  const [eReplacement, setEReplacement] = useState("");
  const [eNotes, setENotes] = useState("");

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

  function startEdit(entry: DictionaryEntry) {
    setEditing(entry);
    setETerm(entry.term);
    setEReplacement(entry.replacement ?? "");
    setENotes(entry.notes ?? "");
  }

  async function saveEdit() {
    if (!editing || !eTerm.trim()) return;
    await dictionaryUpsert({
      id: editing.id,
      term: eTerm.trim(),
      replacement: eReplacement.trim() || null,
      notes: eNotes.trim() || null,
      priority: editing.priority,
    });
    setEditing(null);
    refresh();
  }

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void add();
    }
  };

  const onEditKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void saveEdit();
    } else if (e.key === "Escape") {
      setEditing(null);
    }
  };

  return (
    <>
      <Suggestions onAccepted={refresh} />
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
          {entries.map((entry) =>
            editing?.id === entry.id ? (
              <div key={entry.id} className="dictionary-edit">
                <label className="field">
                  <span className="field-label">Begriff</span>
                  <input
                    type="text"
                    autoFocus
                    value={eTerm}
                    onChange={(e) => setETerm(e.target.value)}
                    onKeyDown={onEditKey}
                  />
                </label>
                <div className="field-pair">
                  <label className="field">
                    <span className="field-label">
                      Ersetzung <em>optional</em>
                    </span>
                    <input
                      type="text"
                      value={eReplacement}
                      onChange={(e) => setEReplacement(e.target.value)}
                      onKeyDown={onEditKey}
                      placeholder="Korrekte Schreibweise"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">
                      Notiz <em>optional</em>
                    </span>
                    <input
                      type="text"
                      value={eNotes}
                      onChange={(e) => setENotes(e.target.value)}
                      onKeyDown={onEditKey}
                      placeholder="Nur zur Erinnerung"
                    />
                  </label>
                </div>
                <div className="dictionary-edit-actions">
                  <button type="button" className="push" onClick={() => setEditing(null)}>
                    Abbrechen
                  </button>
                  <button
                    type="button"
                    className="push primary"
                    onClick={() => void saveEdit()}
                    disabled={!eTerm.trim()}
                  >
                    Speichern
                  </button>
                </div>
              </div>
            ) : (
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
                    aria-label="Eintrag bearbeiten"
                    onClick={() => startEdit(entry)}
                  >
                    <Pencil size={13} />
                  </button>
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
            ),
          )}
        </Group>
      ) : (
        <p className="dictionary-empty">Noch keine Einträge.</p>
      )}
    </>
  );
}

type RangeKey = "today" | "week" | "month" | "all" | "date";

function localDateStr(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local-time window → UTC ISO bounds that match the RFC3339 `created_at`. */
function rangeBounds(key: RangeKey, dateStr: string): { from: string | null; to: string | null } {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (key) {
    case "all":
      return { from: null, to: null };
    case "today":
      return { from: startOfDay.toISOString(), to: null };
    case "week": {
      const monday = new Date(startOfDay);
      monday.setDate(monday.getDate() - ((startOfDay.getDay() + 6) % 7));
      return { from: monday.toISOString(), to: null };
    }
    case "month":
      return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to: null };
    case "date": {
      if (!dateStr) return { from: null, to: null };
      const [y, m, d] = dateStr.split("-").map(Number);
      return {
        from: new Date(y, m - 1, d).toISOString(),
        to: new Date(y, m - 1, d + 1).toISOString(),
      };
    }
  }
}

function formatUsd(usd: number) {
  if (!usd || usd <= 0) return "$0.00";
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

const fmtInt = (n: number) => n.toLocaleString("de-DE");

const RANGE_PRESETS: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Heute" },
  { key: "week", label: "Woche" },
  { key: "month", label: "Monat" },
  { key: "all", label: "Gesamt" },
];

function UsageOverview({ reloadKey }: { reloadKey: number }) {
  const [range, setRange] = useState<RangeKey>("month");
  const [date, setDate] = useState("");
  const [summary, setSummary] = useState<UsageSummary | null>(null);

  useEffect(() => {
    const { from, to } = rangeBounds(range, date);
    usageSummary(from, to).then(setSummary).catch(() => setSummary(null));
  }, [range, date, reloadKey]);

  return (
    <Group title="Kosten & Nutzung">
      <div className="usage-overview">
        <div className="usage-filters">
          {RANGE_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              className={`usage-pill${range === preset.key ? " active" : ""}`}
              onClick={() => setRange(preset.key)}
            >
              {preset.label}
            </button>
          ))}
          <input
            type="date"
            className={`usage-date${range === "date" ? " active" : ""}`}
            value={date}
            max={localDateStr(new Date())}
            onChange={(e) => {
              setDate(e.target.value);
              setRange(e.target.value ? "date" : "month");
            }}
          />
        </div>
        <div className="usage-stats">
          <div className="usage-stat">
            <span className="usage-stat-value">{formatUsd(summary?.cost ?? 0)}</span>
            <span className="usage-stat-label">Gesamtkosten</span>
          </div>
          <div className="usage-stat">
            <span className="usage-stat-value">{fmtInt(summary?.post_processed_count ?? 0)}</span>
            <span className="usage-stat-label">KI-Diktate</span>
          </div>
          <div className="usage-stat">
            <span className="usage-stat-value">{fmtInt(summary?.prompt_tokens ?? 0)}</span>
            <span className="usage-stat-label">Input-Tokens</span>
          </div>
          <div className="usage-stat">
            <span className="usage-stat-value">{fmtInt(summary?.completion_tokens ?? 0)}</span>
            <span className="usage-stat-label">Output-Tokens</span>
          </div>
        </div>
      </div>
    </Group>
  );
}

function formatDurationMs(ms: number) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec} s`;
  const totalMin = totalSec / 60;
  if (totalMin < 60) return `${Math.round(totalMin)} min`;
  const hours = Math.floor(totalMin / 60);
  const minutes = Math.round(totalMin % 60);
  return `${hours} h ${minutes} min`;
}

/** Average typing speed the "time saved" estimate is measured against. */
const TYPING_WPM = 40;

function Insights() {
  const [range, setRange] = useState<RangeKey>("month");
  const [date, setDate] = useState("");
  const [summary, setSummary] = useState<InsightsSummary | null>(null);

  useEffect(() => {
    const { from, to } = rangeBounds(range, date);
    insightsSummary(from, to).then(setSummary).catch(() => setSummary(null));
  }, [range, date]);

  const words = summary?.words ?? 0;
  const durationMs = summary?.duration_ms ?? 0;
  const minutes = durationMs / 60_000;
  const wpm = minutes > 0 ? Math.round(words / minutes) : 0;
  const savedMs = Math.max(0, (words / TYPING_WPM) * 60_000 - durationMs);
  const maxAppWords = Math.max(
    1,
    ...(summary?.top_apps.map((entry) => entry.words) ?? [1]),
  );

  return (
    <>
      <Group title="Diktate">
        <div className="usage-overview">
          <div className="usage-filters">
            {RANGE_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className={`usage-pill${range === preset.key ? " active" : ""}`}
                onClick={() => setRange(preset.key)}
              >
                {preset.label}
              </button>
            ))}
            <input
              type="date"
              className={`usage-date${range === "date" ? " active" : ""}`}
              value={date}
              max={localDateStr(new Date())}
              onChange={(e) => {
                setDate(e.target.value);
                setRange(e.target.value ? "date" : "month");
              }}
            />
          </div>
          <div className="usage-stats insights-stats">
            <div className="usage-stat">
              <span className="usage-stat-value">{fmtInt(summary?.count ?? 0)}</span>
              <span className="usage-stat-label">Diktate</span>
            </div>
            <div className="usage-stat">
              <span className="usage-stat-value">{fmtInt(words)}</span>
              <span className="usage-stat-label">Wörter</span>
            </div>
            <div className="usage-stat">
              <span className="usage-stat-value">{formatDurationMs(durationMs)}</span>
              <span className="usage-stat-label">Sprechzeit</span>
            </div>
            <div className="usage-stat">
              <span className="usage-stat-value">{wpm > 0 ? fmtInt(wpm) : "–"}</span>
              <span className="usage-stat-label">Wörter/Min.</span>
            </div>
            <div className="usage-stat">
              <span className="usage-stat-value">{formatDurationMs(savedMs)}</span>
              <span className="usage-stat-label">Zeit gespart*</span>
            </div>
          </div>
          <p className="insights-note">
            *gegenüber Tippen mit {TYPING_WPM} Wörtern pro Minute.
          </p>
        </div>
      </Group>
      {summary && summary.top_apps.length > 0 && (
        <Group title="Top-Apps">
          {summary.top_apps.map((entry) => (
            <div key={entry.app} className="row wide top-app-row">
              <div className="top-app-head">
                <span className="row-label">{entry.app}</span>
                <span className="row-hint">
                  {fmtInt(entry.words)} Wörter · {fmtInt(entry.count)}{" "}
                  {entry.count === 1 ? "Diktat" : "Diktate"}
                </span>
              </div>
              <div className="top-app-bar">
                <span
                  style={{
                    width: `${Math.max(3, Math.round((entry.words / maxAppWords) * 100))}%`,
                  }}
                />
              </div>
            </div>
          ))}
        </Group>
      )}
      <UsageOverview reloadKey={0} />
    </>
  );
}

function History() {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const refresh = () => {
    historyList(query, 160).then(setEntries).catch(() => {});
  };

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
                  {entry.cost != null ? ` · ${formatUsd(entry.cost)}` : ""}
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
              {entry.post_processed && entry.raw_text.trim() !== entry.final_text.trim() ? (
                <div className="history-versions">
                  <div className="history-version">
                    <span className="row-hint">Original</span>
                    <p className="history-raw">{entry.raw_text}</p>
                  </div>
                  <div className="history-version">
                    <span className="row-hint">KI</span>
                    <p>{entry.final_text}</p>
                  </div>
                </div>
              ) : (
                <p>{entry.final_text}</p>
              )}
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
