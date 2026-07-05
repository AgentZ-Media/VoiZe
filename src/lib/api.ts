import { invoke } from "@tauri-apps/api/core";
import type {
  AsrStatus,
  DictionaryEntry,
  DictionaryInput,
  HistoryEntry,
  NewHistoryEntry,
  OpenRouterModel,
  ScreenContext,
  Settings,
} from "./types";

export const getSettings = () => invoke<Settings>("get_settings");
export const saveSettings = (settings: Settings) =>
  invoke<void>("save_settings", { settings });

export const activationStart = (hotkey: string, handsFreeHotkey: string) =>
  invoke<void>("activation_start", { hotkey, handsFreeHotkey });
export const activationStop = () => invoke<void>("activation_stop");
export const positionHud = () => invoke<void>("position_hud");
export const showSettings = (section?: string) =>
  invoke<void>("show_settings", { section });

export const accessibilityStatus = () =>
  invoke<boolean>("accessibility_status");
export const requestAccessibility = () =>
  invoke<boolean>("request_accessibility");

export const screenContext = () => invoke<ScreenContext>("screen_context");

export const asrStatus = () => invoke<AsrStatus>("asr_status");
export const asrDownload = () => invoke<void>("asr_download");
export const asrCancelDownload = () => invoke<void>("asr_cancel_download");
export const asrRemoveModel = () => invoke<void>("asr_remove_model");
export const asrPreload = () => invoke<void>("asr_preload");
export const transcribeAudio = (pcmB64: string) =>
  invoke<{ text: string; engine: string; duration_ms: number | null }>(
    "transcribe_audio",
    { pcmB64 },
  );

export const deliverText = (
  text: string,
  mode: "insert" | "clipboard",
  restoreClipboard: boolean,
) => invoke<string>("deliver_text", { text, mode, restoreClipboard });

export const playStatusSound = (kind: "start" | "stop" | "success" | "error") =>
  invoke<void>("play_status_sound", { kind });

export const historyInsert = (entry: NewHistoryEntry) =>
  invoke<HistoryEntry>("history_insert", { entry });
export const historyList = (query?: string, limit?: number) =>
  invoke<HistoryEntry[]>("history_list", { query, limit });
export const historyDelete = (id: number) =>
  invoke<boolean>("history_delete", { id });

export const dictionaryList = () =>
  invoke<DictionaryEntry[]>("dictionary_list");
export const dictionaryUpsert = (entry: DictionaryInput) =>
  invoke<DictionaryEntry>("dictionary_upsert", { entry });
export const dictionaryDelete = (id: number) =>
  invoke<boolean>("dictionary_delete", { id });
export const dictionaryReplaceAll = (entries: DictionaryInput[]) =>
  invoke<DictionaryEntry[]>("dictionary_replace_all", { entries });
export const learningCandidates = () =>
  invoke<{ term: string; count: number }[]>("learning_candidates");

export const openrouterModels = async () => {
  const value = await invoke<{ data: OpenRouterModel[] }>("openrouter_models");
  return value.data ?? [];
};

export const openrouterChat = (
  model: string,
  messages: { role: string; content: string }[],
  temperature = 0.2,
) => invoke<string>("openrouter_chat", { model, messages, temperature });
