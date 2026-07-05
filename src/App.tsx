import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  activationStart,
  asrStatus,
  deliverText,
  dictionaryList,
  dictionaryUpsert,
  getSettings,
  historyInsert,
  learningCandidates,
  openrouterChat,
  playStatusSound,
  positionHud,
  prepareAsrModel,
  saveSettings,
  screenContext,
  showSettings,
  transcribeAudio,
} from "./lib/api";
import { VoiceRecorder } from "./lib/recorder";
import type { DictionaryEntry, ScreenContext, Settings } from "./lib/types";
import { blobToBase64 } from "./lib/wav";

type HudState =
  | "idle"
  | "recording"
  | "transcribing"
  | "polishing"
  | "inserted"
  | "copied"
  | "error";

const currentWindow = getCurrentWindow();

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
    out = out.replace(new RegExp(`\\b${escaped}\\b`, "gi"), entry.replacement);
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
          ? "Add punctuation, paragraphs, bullets, and list structure when the spoken text clearly implies it."
          : "Only fix obvious transcription errors and punctuation.",
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
  const [state, setState] = useState<HudState>("idle");
  const [level, setLevel] = useState(0);
  const [visualTick, setVisualTick] = useState(0);
  const [caption, setCaption] = useState("Bereit");
  const [error, setError] = useState("");
  const settingsRef = useRef<Settings | null>(null);
  const recorder = useRef(new VoiceRecorder());
  const contextRef = useRef<ScreenContext | null>(null);
  const contextPromiseRef = useRef<Promise<ScreenContext | null> | null>(null);
  const starting = useRef(false);
  const stopping = useRef(false);
  const stopAfterStart = useRef(false);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const toggleRecording = useCallback(() => {
    if (recorder.current.running || starting.current) void stopRecording();
    else void startRecording();
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

  const hideSoon = useCallback((delay = 1400) => {
    window.setTimeout(() => {
      if (!recorder.current.running) void currentWindow.hide();
    }, delay);
  }, []);

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

  const runLearning = useCallback(async (s: Settings) => {
    if (!s.learning_enabled || !s.openrouter_api_key.trim()) return;
    const last = s.last_learning_at ? Date.parse(s.last_learning_at) : 0;
    const dueMs = s.learning_interval_hours * 60 * 60 * 1000;
    if (last && Date.now() - last < dueMs) return;
    const candidates = await learningCandidates().catch(() => []);
    if (!candidates.length) {
      await saveSettings({ ...s, last_learning_at: new Date().toISOString() }).catch(() => {});
      return;
    }
    const existing = await dictionaryList().catch(() => []);
    const prompt = [
      "Suggest personal dictionary additions from these recurring dictation terms.",
      "Return strict JSON array only. Each item: {\"term\":\"...\",\"notes\":\"...\"}.",
      "Only include proper nouns, product names, unusual spellings, acronyms, or recurring words likely to be mistranscribed.",
      "Do not include generic words.",
      `Existing dictionary: ${existing.map((e) => e.term).join(", ")}`,
      `Candidates: ${candidates.map((c) => `${c.term} (${c.count})`).join(", ")}`,
    ].join("\n");
    const raw = await openrouterChat(
      s.learning_model,
      [
        { role: "system", content: "You maintain a concise speech dictation dictionary." },
        { role: "user", content: prompt },
      ],
      0.1,
    ).catch(() => "[]");
    try {
      const parsed = JSON.parse(raw) as { term?: string; notes?: string }[];
      for (const item of parsed.slice(0, 12)) {
        if (!item.term?.trim()) continue;
      await dictionaryUpsert({
          term: item.term.trim(),
          notes: item.notes ?? "Automatically learned from recent dictations.",
          replacement: null,
          priority: false,
          learned: true,
        }).catch(() => {});
      }
      const next = { ...s, last_learning_at: new Date().toISOString() };
      await saveSettings(next);
      settingsRef.current = next;
      setSettings(next);
    } catch {
      await saveSettings({ ...s, last_learning_at: new Date().toISOString() }).catch(() => {});
    }
  }, []);

  const startRuntime = useCallback((s: Settings) => {
    void activationStart(s.hotkey, s.hands_free_hotkey);
    void registerFallbacks(s);
    void runLearning(s);
    if (s.auto_update_on_launch) {
      void check()
        .then((update) => update?.downloadAndInstall().then(() => relaunch()))
        .catch(() => {});
    }
  }, [registerFallbacks, runLearning]);

  const ensureAsrReady = useCallback(async (s: Settings) => {
    const status = await asrStatus().catch(() => null);
    if (s.asr_model_ready && status?.parakeet_mlx) {
      startRuntime(s);
      return;
    }

    await showSettings("diagnostics").catch(() => {});
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    await emit("asr-prepare-status", {
      state: "running",
      message: "Parakeet wird vorbereitet. Der erste Start kann einige Minuten dauern.",
    }).catch(() => {});

    try {
      await prepareAsrModel();
      const next = { ...s, asr_model_ready: true };
      settingsRef.current = next;
      setSettings(next);
      await saveSettings(next);
      await emit("asr-prepare-status", {
        state: "ready",
        message: "Lokale Transkription ist bereit.",
      }).catch(() => {});
      startRuntime(next);
    } catch (e) {
      const message = String(e);
      setError(message);
      setCaption("Transkription nicht bereit");
      setState("error");
      await emit("asr-prepare-status", {
        state: "error",
        message,
      }).catch(() => {});
      void playStatusSound("error");
    }
  }, [startRuntime]);

  useEffect(() => {
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
      listen("handsfree-toggle", () => {
        if (recorder.current.running || starting.current) void stopRecording();
        else void startRecording();
      }),
      listen("activation-cancel", () => void cancelRecording()),
      listen("tray-dictate", () => {
        if (recorder.current.running || starting.current) void stopRecording();
        else void startRecording();
      }),
      listen<Settings>("settings-saved", (event) => {
        settingsRef.current = event.payload;
        setSettings(event.payload);
        if (event.payload.asr_model_ready) startRuntime(event.payload);
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
    if (!activeSettings || recorder.current.running || starting.current || stopping.current) return;
    starting.current = true;
    stopAfterStart.current = false;
    setError("");
    setCaption("Hört zu");
    setState("recording");
    contextRef.current = null;
    contextPromiseRef.current = activeSettings.context_enabled
      ? screenContext().catch(() => null)
      : Promise.resolve(null);
    try {
      await positionHud().catch(() => {});
      await currentWindow.show().catch(() => {});
      if (activeSettings.start_sound_enabled) void playStatusSound("start");
      await recorder.current.start(setLevel);
      starting.current = false;
      if (stopAfterStart.current) {
        stopAfterStart.current = false;
        void stopRecording();
      }
    } catch (e) {
      starting.current = false;
      stopAfterStart.current = false;
      setError(String(e));
      setCaption("Mikrofon nicht verfügbar");
      setState("error");
      void playStatusSound("error");
      hideSoon(2600);
    }
  }

  async function stopRecording() {
    const activeSettings = settingsRef.current;
    if (!activeSettings || stopping.current) return;
    if (starting.current) {
      stopAfterStart.current = true;
      return;
    }
    if (!recorder.current.running) return;
    stopping.current = true;
    setLevel(0);
    setCaption("Transkribiert lokal");
    setState("transcribing");
    if (activeSettings.finish_sound_enabled) void playStatusSound("stop");
    try {
      const recording = await recorder.current.stop();
      const activeContext =
        (await contextPromiseRef.current?.catch(() => null)) ?? contextRef.current;
      contextRef.current = activeContext;
      if (recording.durationMs < 250) {
        setCaption("Zu kurz");
        setState("idle");
        hideSoon(600);
        return;
      }
      const wavB64 = await blobToBase64(recording.blob);
      const asr = await transcribeAudio(wavB64);
      const dictionary = await dictionaryList().catch(() => []);
      let finalText = applyDictionary(asr.text, dictionary);
      let postProcessed = false;

      if (activeSettings.postprocess_enabled && activeSettings.openrouter_api_key.trim()) {
        setCaption("Formatiert mit KI");
        setState("polishing");
        finalText = await openrouterChat(
          activeSettings.postprocess_model,
          buildPolishMessages(finalText, activeContext, dictionary, activeSettings),
          0.15,
        );
        postProcessed = true;
      }

      finalText = finalText.trim();
      if (!finalText) {
        throw new Error("Leere Transkription.");
      }
      setCaption(activeSettings.output_mode === "clipboard" ? "Kopiert" : "Fügt ein");
      const delivery = await deliverText(
        finalText,
        activeSettings.output_mode,
        activeSettings.restore_clipboard,
      );
      setState(delivery === "clipboard" ? "copied" : "inserted");
      if (activeSettings.finish_sound_enabled) void playStatusSound("success");
      await historyInsert({
        focused_app: contextRef.current?.app_name ?? null,
        bundle_id: contextRef.current?.bundle_id ?? null,
        window_title: contextRef.current?.window_title ?? null,
        raw_text: asr.text,
        final_text: finalText,
        delivery_mode: delivery,
        model: postProcessed ? activeSettings.postprocess_model : asr.engine,
        post_processed: postProcessed,
        duration_ms: recording.durationMs,
        dictionary_snapshot: JSON.stringify(dictionary),
      }).catch(() => {});
      setCaption(delivery === "clipboard" ? "In der Zwischenablage" : "Eingefügt");
      hideSoon();
    } catch (e) {
      setError(String(e));
      setCaption("Fehler");
      setState("error");
      void playStatusSound("error");
      if (/asr|parakeet|python|transkription|script/i.test(String(e))) {
        await showSettings("diagnostics").catch(() => {});
        await emit("asr-prepare-status", {
          state: "error",
          message: String(e),
        }).catch(() => {});
      }
      hideSoon(4200);
    } finally {
      contextPromiseRef.current = null;
      stopping.current = false;
    }
  }

  async function cancelRecording() {
    if (starting.current) {
      stopAfterStart.current = true;
      return;
    }
    if (!recorder.current.running) return;
    await recorder.current.stop().catch(() => null);
    contextPromiseRef.current = null;
    setLevel(0);
    setCaption("Abgebrochen");
    setState("idle");
    hideSoon(700);
  }

  const bars = Array.from({ length: 16 }, (_, i) => {
    const phase = Math.sin(i * 0.72 + visualTick / 110);
    const value =
      state === "recording"
        ? Math.max(0.12, level * (0.72 + phase * 0.24))
        : state === "transcribing" || state === "polishing"
          ? 0.36 + Math.max(0, phase) * 0.38
          : 0.14;
    return <span key={i} style={{ height: `${Math.round(6 + value * 24)}px` }} />;
  });

  return (
    <main className="hud-shell" data-state={state} aria-label={error || caption}>
      <section className="flow-pill">
        <span className="status-dot" aria-hidden />
        <div className="waveform" aria-hidden>
          {bars}
        </div>
      </section>
    </main>
  );
}
