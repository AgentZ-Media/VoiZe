export interface Settings {
  openrouter_api_key: string;
  postprocess_enabled: boolean;
  postprocess_model: string;
  hotkey: string;
  hands_free_hotkey: string;
  output_mode: "insert" | "clipboard";
  restore_clipboard: boolean;
  start_sound_enabled: boolean;
  finish_sound_enabled: boolean;
  auto_update_on_launch: boolean;
  context_enabled: boolean;
  smart_formatting: boolean;
  asr_model_ready: boolean;
  custom_instructions: string;
}

export interface ScreenContext {
  app_name: string | null;
  bundle_id: string | null;
  window_title: string | null;
  selected_text: string | null;
  accessibility: boolean;
}

export interface HistoryEntry {
  id: number;
  created_at: string;
  focused_app: string | null;
  bundle_id: string | null;
  window_title: string | null;
  raw_text: string;
  final_text: string;
  delivery_mode: string;
  model: string | null;
  post_processed: boolean;
  duration_ms: number | null;
  dictionary_snapshot: string;
}

export interface NewHistoryEntry {
  focused_app?: string | null;
  bundle_id?: string | null;
  window_title?: string | null;
  raw_text: string;
  final_text: string;
  delivery_mode: string;
  model?: string | null;
  post_processed: boolean;
  duration_ms?: number | null;
  dictionary_snapshot?: string | null;
}

export interface DictionaryEntry {
  id: number;
  term: string;
  replacement: string | null;
  notes: string | null;
  priority: boolean;
  created_at: string;
  updated_at: string;
}

export interface DictionaryInput {
  id?: number | null;
  term: string;
  replacement?: string | null;
  notes?: string | null;
  priority: boolean;
}

export interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: Record<string, string>;
  context_length?: number;
}

export interface AsrStatus {
  installed: boolean;
  downloading: boolean;
  loaded: boolean;
  total_bytes: number;
  engine: string;
}

export interface AsrDownloadProgress {
  downloaded: number;
  total: number;
}
