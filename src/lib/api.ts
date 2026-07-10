import { invoke } from "@tauri-apps/api/core";
import type {
  AsrStatus,
  ChatResult,
  DictionaryEntry,
  DictionaryInput,
  DictSuggestion,
  HistoryEntry,
  InsightsSummary,
  LearnRunResult,
  LearnStatus,
  NewHistoryEntry,
  OpenRouterModel,
  ScreenContext,
  Settings,
  TranscriptionResult,
  UsageSummary,
} from "./types";

export const getSettings = () => invoke<Settings>("get_settings");
export const saveSettings = (settings: Settings) =>
  invoke<void>("save_settings", { settings });

export const activationStart = (hotkey: string, handsFreeHotkey: string) =>
  invoke<void>("activation_start", { hotkey, handsFreeHotkey });
export const activationStop = () => invoke<void>("activation_stop");
export const positionHud = () => invoke<void>("position_hud");
export const hudCollapsed = (collapsed: boolean) =>
  invoke<void>("hud_collapsed", { collapsed });
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
export const transcribeAudio = (
  pcmB64: string,
  settings: Pick<
    Settings,
    | "transcription_backend"
    | "transcription_model"
    | "transcription_language"
    | "cloud_fallback_to_local"
  >,
) =>
  invoke<TranscriptionResult>("transcribe_audio", {
    pcmB64,
    backend: settings.transcription_backend,
    model: settings.transcription_model,
    language: settings.transcription_language,
    fallbackToLocal: settings.cloud_fallback_to_local,
  });

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
export const usageSummary = (from?: string | null, to?: string | null) =>
  invoke<UsageSummary>("usage_summary", { from: from ?? null, to: to ?? null });

export const insightsSummary = (from?: string | null, to?: string | null) =>
  invoke<InsightsSummary>("insights_summary", {
    from: from ?? null,
    to: to ?? null,
  });

export const suggestionsList = () =>
  invoke<DictSuggestion[]>("suggestions_list");
export const suggestionAccept = (id: number) =>
  invoke<DictionaryEntry>("suggestion_accept", { id });
export const suggestionDismiss = (id: number) =>
  invoke<boolean>("suggestion_dismiss", { id });
export const learnRunNow = () => invoke<LearnRunResult>("learn_run_now");
export const learnStatus = () => invoke<LearnStatus>("learn_status");

export const dictionaryList = () =>
  invoke<DictionaryEntry[]>("dictionary_list");
export const dictionaryUpsert = (entry: DictionaryInput) =>
  invoke<DictionaryEntry>("dictionary_upsert", { entry });
export const dictionaryDelete = (id: number) =>
  invoke<boolean>("dictionary_delete", { id });
export const dictionaryReplaceAll = (entries: DictionaryInput[]) =>
  invoke<DictionaryEntry[]>("dictionary_replace_all", { entries });

export const openrouterModels = async () => {
  const value = await invoke<{ data: OpenRouterModel[] }>("openrouter_models");
  return value.data ?? [];
};

export const openrouterChat = (
  model: string,
  messages: { role: string; content: string }[],
  temperature = 0.2,
) => invoke<ChatResult>("openrouter_chat", { model, messages, temperature });
