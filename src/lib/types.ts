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
  learning_enabled: boolean;
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
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  cost: number | null;
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
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  reasoning_tokens?: number | null;
  total_tokens?: number | null;
  cost?: number | null;
}

/** Result of an OpenRouter chat completion, with optional usage accounting. */
export interface ChatResult {
  content: string;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  cost: number | null;
}

/** Aggregated token usage and cost over a time window. */
export interface UsageSummary {
  count: number;
  post_processed_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  cost: number;
}

/** Dictation statistics over a time window. */
export interface AppInsight {
  app: string;
  count: number;
  words: number;
}

export interface InsightsSummary {
  count: number;
  words: number;
  duration_ms: number;
  top_apps: AppInsight[];
}

/** A dictionary correction proposed by the background learning pass. */
export interface DictSuggestion {
  id: number;
  created_at: string;
  term: string;
  replacement: string;
  reason: string | null;
  evidence: string | null;
  occurrences: number;
  status: string;
}

export interface LearnStatus {
  last_run_at: string | null;
  pending: number;
  unanalyzed: number;
  running: boolean;
}

export interface LearnRunResult {
  analyzed: number;
  new_suggestions: number;
  skipped: string | null;
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
