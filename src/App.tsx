import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  activationStart,
  asrDownload,
  asrPreload,
  asrStatus,
  deliverText,
  dictionaryList,
  getSettings,
  historyInsert,
  hudCollapsed,
  openrouterChat,
  playStatusSound,
  positionHud,
  saveSettings,
  screenContext,
  showSettings,
  transcribeAudio,
} from "./lib/api";
import { VoiceRecorder } from "./lib/recorder";
import type { ChatResult, DictionaryEntry, ScreenContext, Settings } from "./lib/types";

type HudState =
  | "idle"
  | "recording"
  | "transcribing"
  | "polishing"
  | "inserted"
  | "copied"
  | "error";

/// Explicit dictation lifecycle. All transitions happen in one place per
/// phase; "starting"/"recording" overlap with async work is resolved via
/// `pending`, never by racing booleans.
type Phase = "idle" | "starting" | "recording" | "processing";
type PendingAction = "none" | "stop" | "cancel";

const currentWindow = getCurrentWindow();
const MIN_RECORD_MS = 250;

function toAccelerator(hotkey: string) {
  if (/fn/i.test(hotkey)) return null;
  const parts = hotkey.split("+").map((part) => part.trim()).filter(Boolean);
  const mapped = parts.map((part) => {
    const key = part.toLowerCase();
    if (key === "ctrl" || key === "control") return "Control";
    if (key === "opt" || key === "option" || key === "alt") return "Alt";
    if (key === "cmd" || key === "command") return "Command";
    if (key === "esc") return "Escape";
    if (key === "space") return "Space";
    return part.length === 1 ? part.toUpperCase() : part;
  });
  return mapped.some((part) => !["Control", "Alt", "Command", "Shift"].includes(part))
    ? mapped.join("+")
    : null;
}

function applyDictionary(text: string, dictionary: DictionaryEntry[]) {
  let out = text;
  for (const entry of dictionary) {
    if (!entry.replacement?.trim()) continue;
    const escaped = entry.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // \b is ASCII-only — use Unicode-aware boundaries so terms with
    // umlauts (Häkchen, Öl, ...) match as whole words too
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu"),
      entry.replacement,
    );
  }
  return out;
}

function buildPolishMessages(
  rawText: string,
  context: ScreenContext | null,
  dictionary: DictionaryEntry[],
  settings: Settings,
) {
  const dictionaryText = dictionary
    .map((entry) => {
      const replacement = entry.replacement?.trim();
      return replacement ? `${entry.term} -> ${replacement}` : entry.term;
    })
    .join("\n");
  const app = [context?.app_name, context?.window_title].filter(Boolean).join(" / ");
  return [
    {
      role: "system",
      content: [
        "You clean up ASR dictation for direct insertion into the user's current app.",
        "Return only the final text. Do not explain. Do not wrap in quotes.",
        "Preserve meaning, language, names, numbers, code-like tokens, and the user's voice.",
        settings.smart_formatting
          ? [
              "Add punctuation and structure the result for readability using real newline characters (not the literal characters backslash-n).",
              "Separate distinct thoughts into paragraphs with a blank line between them.",
              "When the user enumerates things, dictates a list, or says cues like 'erstens/zweitens', 'first/second', 'point one', 'next', put each item on its own line. Use '- ' for unordered items and '1.', '2.', '3.' for items the user explicitly numbers.",
              "Keep single short utterances as a single line — do not invent structure that was not spoken.",
            ].join(" ")
          : "Only fix obvious transcription errors and punctuation. Keep the original line structure.",
        "Remove filler words and self-corrections when they are clearly not intended.",
        app ? `Current app/window context: ${app}.` : "",
        dictionaryText ? `Personal dictionary:\n${dictionaryText}` : "",
        settings.custom_instructions.trim()
          ? `User instructions:\n${settings.custom_instructions.trim()}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    { role: "user", content: rawText },
  ];
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [hudVisible, setHudVisible] = useState(false);
  const [state, setState] = useState<HudState>("idle");
  const [level, setLevel] = useState(0);
  const [visualTick, setVisualTick] = useState(0);
  const [caption, setCaption] = useState("Bereit");
  const [error, setError] = useState("");
  const settingsRef = useRef<Settings | null>(null);
  const recorder = useRef(new VoiceRecorder());
  const contextPromiseRef = useRef<Promise<ScreenContext | null> | null>(null);
  const phase = useRef<Phase>("idle");
  const pending = useRef<PendingAction>("none");
  const modelReady = useRef(false);
  const runtimeStarted = useRef(false);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const toggleRecording = useCallback(() => {
    if (phase.current === "recording" || phase.current === "starting") {
      void stopRecording();
    } else if (phase.current === "idle") {
      void startRecording();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const registerFallbacks = useCallback(async (s: Settings) => {
    await unregisterAll().catch(() => {});
    const handsFreeShortcuts = new Set<string>(["Control+Alt+Space"]);
    const configuredHandsFree = toAccelerator(s.hands_free_hotkey);
    if (configuredHandsFree) handsFreeShortcuts.add(configuredHandsFree);

    const pushToTalk = toAccelerator(s.hotkey);
    if (pushToTalk) {
      await register(pushToTalk, (event) => {
        if (event.state === "Pressed") void startRecording();
        if (event.state === "Released") void stopRecording();
      }).catch(() => {});
      handsFreeShortcuts.delete(pushToTalk);
    }

    if (handsFreeShortcuts.size) {
      await register(Array.from(handsFreeShortcuts), (event) => {
        if (event.state === "Pressed") toggleRecording();
      }).catch(() => {});
    }
  }, [toggleRecording]);

  // The window itself is NEVER hidden: WKWebView pauses rAF/timers for
  // hidden windows and takes seconds to resume after show(), which froze
  // the waveform. Instead the pill fades via CSS and the window then
  // collapses natively (AppKit setFrame) to a 1×1 px dot — a window that
  // physically isn't there can't swallow clicks.
  const shrinkTimer = useRef<number | null>(null);

  const showPill = useCallback(() => {
    if (shrinkTimer.current) {
      window.clearTimeout(shrinkTimer.current);
      shrinkTimer.current = null;
    }
    void hudCollapsed(false).catch(() => {});
    setHudVisible(true);
  }, []);

  const hidePill = useCallback(() => {
    setHudVisible(false);
    if (shrinkTimer.current) window.clearTimeout(shrinkTimer.current);
    // collapse only after the fade-out finished
    shrinkTimer.current = window.setTimeout(() => {
      shrinkTimer.current = null;
      void hudCollapsed(true).catch(() => {});
    }, 220);
  }, []);

  const hideSoon = useCallback((delay = 1400) => {
    window.setTimeout(() => {
      if (phase.current === "idle") hidePill();
    }, delay);
  }, [hidePill]);

  useEffect(() => {
    if (state === "idle") return undefined;
    let frame = 0;
    const loop = (time: number) => {
      setVisualTick(time);
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(frame);
  }, [state]);

  const startRuntime = useCallback((s: Settings) => {
    runtimeStarted.current = true;
    void activationStart(s.hotkey, s.hands_free_hotkey);
    void registerFallbacks(s);
    if (s.auto_update_on_launch) {
      void check()
        .then((update) => update?.downloadAndInstall().then(() => relaunch()))
        .catch(() => {});
    }
  }, [registerFallbacks]);

  /// Model install gate: hotkeys only go live once the local model is on
  /// disk. If it's missing, the settings window opens on the diagnostics
  /// pane and the download starts automatically (with resume); the pane
  /// itself renders progress from the asr:// events.
  const ensureAsrReady = useCallback(async (s: Settings) => {
    const status = await asrStatus().catch(() => null);
    if (status?.installed) {
      modelReady.current = true;
      if (!s.asr_model_ready) {
        const next = { ...s, asr_model_ready: true };
        settingsRef.current = next;
        setSettings(next);
        await saveSettings(next).catch(() => {});
      }
      startRuntime(settingsRef.current ?? s);
      void asrPreload().catch(() => {});
      return;
    }
    await showSettings("diagnostics").catch(() => {});
    try {
      if (!status?.downloading) {
        await asrDownload();
      } else {
        await new Promise<void>((resolve, reject) => {
          const done = listen("asr://done", () => {
            void done.then((f) => f());
            void fail.then((f) => f());
            resolve();
          });
          const fail = listen<string>("asr://error", (event) => {
            void done.then((f) => f());
            void fail.then((f) => f());
            reject(new Error(event.payload));
          });
        });
      }
      modelReady.current = true;
      const current = settingsRef.current ?? s;
      const next = { ...current, asr_model_ready: true };
      settingsRef.current = next;
      setSettings(next);
      await saveSettings(next).catch(() => {});
      startRuntime(next);
      void asrPreload().catch(() => {});
    } catch (e) {
      // the diagnostics pane shows the error and offers a retry; hotkeys
      // stay off until the model is actually there
      console.warn("model download failed:", e);
    }
  }, [startRuntime]);

  useEffect(() => {
    // position once at launch — afterwards the pill stays wherever the
    // user drags it (for this session). The window becomes visible now
    // (pill transparent) and stays visible so the webview never sleeps;
    // hidePill immediately shrinks it out of the way.
    void positionHud()
      .catch(() => {})
      .then(() => currentWindow.show())
      .then(() => hidePill())
      .catch(() => {});
    getSettings()
      .then((s) => {
        settingsRef.current = s;
        setSettings(s);
        void ensureAsrReady(s);
      })
      .catch((e) => {
        setError(String(e));
        setState("error");
      });

    const unlisten = [
      listen("activation-start", () => void startRecording()),
      listen("activation-stop", () => void stopRecording()),
      listen("handsfree-toggle", () => toggleRecording()),
      listen("activation-cancel", () => void cancelRecording()),
      listen("tray-dictate", () => toggleRecording()),
      listen("asr://done", () => {
        // download finished via the settings pane — arm the runtime if the
        // startup path didn't already
        modelReady.current = true;
        const s = settingsRef.current;
        if (s && !runtimeStarted.current) {
          startRuntime(s);
          void asrPreload().catch(() => {});
        }
      }),
      listen<Settings>("settings-saved", (event) => {
        settingsRef.current = event.payload;
        setSettings(event.payload);
        if (modelReady.current) startRuntime(event.payload);
      }),
    ];
    return () => {
      unlisten.forEach((promise) => void promise.then((f) => f()));
      void unregisterAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureAsrReady, startRuntime]);

  async function startRecording() {
    const activeSettings = settingsRef.current;
    if (!activeSettings || !modelReady.current || phase.current !== "idle") return;
    phase.current = "starting";
    pending.current = "none";
    setError("");
    setCaption("Hört zu");
    setState("recording");
    contextPromiseRef.current = activeSettings.context_enabled
      ? screenContext().catch(() => null)
      : Promise.resolve(null);
    try {
      showPill();
      if (activeSettings.start_sound_enabled) void playStatusSound("start");
      await recorder.current.start(setLevel);
      phase.current = "recording";
      // the release/cancel may have arrived while getUserMedia was opening
      const queued = pending.current as PendingAction;
      pending.current = "none";
      if (queued === "stop") void stopRecording();
      else if (queued === "cancel") void cancelRecording();
    } catch (e) {
      phase.current = "idle";
      pending.current = "none";
      setError(String(e));
      setCaption("Mikrofon nicht verfügbar");
      setState("error");
      void playStatusSound("error");
      hideSoon(2600);
    }
  }

  async function stopRecording() {
    const activeSettings = settingsRef.current;
    if (!activeSettings) return;
    if (phase.current === "starting") {
      pending.current = "stop";
      return;
    }
    if (phase.current !== "recording") return;
    phase.current = "processing";
    setLevel(0);
    setCaption("Transkribiert lokal");
    setState("transcribing");
    if (activeSettings.finish_sound_enabled) void playStatusSound("stop");
    try {
      const recording = await recorder.current.stop();
      const activeContext = (await contextPromiseRef.current?.catch(() => null)) ?? null;
      if (recording.durationMs < MIN_RECORD_MS || !recording.pcmB64) {
        setCaption("Zu kurz");
        setState("idle");
        hidePill();
        return;
      }
      const asr = await transcribeAudio(recording.pcmB64);
      const dictionary = await dictionaryList().catch(() => []);
      let finalText = applyDictionary(asr.text, dictionary);
      let postProcessed = false;
      let usage: ChatResult | null = null;

      if (activeSettings.postprocess_enabled && activeSettings.openrouter_api_key.trim()) {
        setCaption("Formatiert mit KI");
        setState("polishing");
        try {
          const chat = await openrouterChat(
            activeSettings.postprocess_model,
            buildPolishMessages(finalText, activeContext, dictionary, activeSettings),
            0.15,
          );
          finalText = chat.content;
          usage = chat;
          postProcessed = true;
        } catch {
          // network/API failure must never cost the dictation — deliver
          // the raw local transcript instead
        }
      }

      finalText = finalText.trim();
      if (!finalText) {
        setCaption("Nichts erkannt");
        setState("idle");
        hidePill();
        return;
      }
      setCaption(activeSettings.output_mode === "clipboard" ? "Kopiert" : "Fügt ein");
      const delivery = await deliverText(
        finalText,
        activeSettings.output_mode,
        activeSettings.restore_clipboard,
      );
      if (activeSettings.finish_sound_enabled) void playStatusSound("success");
      // done — the pill disappears the moment the text is delivered
      setState("idle");
      hidePill();
      await historyInsert({
        focused_app: activeContext?.app_name ?? null,
        bundle_id: activeContext?.bundle_id ?? null,
        window_title: activeContext?.window_title ?? null,
        raw_text: asr.text,
        final_text: finalText,
        delivery_mode: delivery,
        model: postProcessed ? activeSettings.postprocess_model : asr.engine,
        post_processed: postProcessed,
        duration_ms: recording.durationMs,
        dictionary_snapshot: JSON.stringify(dictionary),
        prompt_tokens: usage?.prompt_tokens ?? null,
        completion_tokens: usage?.completion_tokens ?? null,
        reasoning_tokens: usage?.reasoning_tokens ?? null,
        total_tokens: usage?.total_tokens ?? null,
        cost: usage?.cost ?? null,
      }).catch(() => {});
      setCaption(
        delivery === "insert"
          ? "Eingefügt"
          : delivery === "clipboard_fallback"
            ? "Kopiert – für direktes Einfügen Bedienungshilfen erlauben"
            : "In der Zwischenablage",
      );
    } catch (e) {
      setError(String(e));
      setCaption("Fehler");
      setState("error");
      void playStatusSound("error");
      if (/modell|model|installiert/i.test(String(e))) {
        await showSettings("diagnostics").catch(() => {});
      }
      hideSoon(4200);
    } finally {
      contextPromiseRef.current = null;
      phase.current = "idle";
      pending.current = "none";
    }
  }

  async function cancelRecording() {
    if (phase.current === "starting") {
      pending.current = "cancel";
      return;
    }
    if (phase.current !== "recording") return;
    phase.current = "processing";
    await recorder.current.stop().catch(() => null);
    contextPromiseRef.current = null;
    phase.current = "idle";
    pending.current = "none";
    setLevel(0);
    setCaption("Abgebrochen");
    setState("idle");
    hidePill();
  }

  const bars = Array.from({ length: 16 }, (_, i) => {
    const phaseValue = Math.sin(i * 0.72 + visualTick / 110);
    const value =
      state === "recording"
        ? Math.max(0.1, level * (0.95 + phaseValue * 0.45))
        : state === "transcribing" || state === "polishing"
          ? 0.36 + Math.max(0, phaseValue) * 0.38
          : 0.14;
    return <span key={i} style={{ height: `${Math.round(4 + Math.min(1, value) * 26)}px` }} />;
  });

  return (
    <main
      className="hud-shell"
      data-state={state}
      data-visible={hudVisible ? "true" : "false"}
      data-tauri-drag-region
      aria-label={error || caption}
    >
      <section className="flow-pill" data-tauri-drag-region>
        <span className="status-dot" aria-hidden />
        <div className="waveform" aria-hidden>
          {bars}
        </div>
      </section>
    </main>
  );
}
