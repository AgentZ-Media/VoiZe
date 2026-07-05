import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { openrouterModels } from "../lib/api";
import type { OpenRouterModel } from "../lib/types";

interface ModelSelectProps {
  value: string;
  onChange: (value: string) => void;
  output?: "text" | "image";
}

const FALLBACK_TEXT: OpenRouterModel[] = [
  { id: "google/gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
  { id: "google/gemini-3.1-flash", name: "Gemini 3.1 Flash" },
  { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
  { id: "openai/gpt-5.4", name: "GPT-5.4" },
];

export default function ModelSelect({
  value,
  onChange,
  output = "text",
}: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<OpenRouterModel[]>(FALLBACK_TEXT);

  useEffect(() => {
    openrouterModels()
      .then((items) => setModels(items.length ? items : FALLBACK_TEXT))
      .catch(() => setModels(FALLBACK_TEXT));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models
      .filter((model) => {
        const modalities = model.architecture?.output_modalities ?? ["text"];
        if (output === "text" && !modalities.includes("text")) return false;
        if (output === "image" && !modalities.includes("image")) return false;
        const haystack = `${model.id} ${model.name ?? ""}`.toLowerCase();
        return !q || haystack.includes(q);
      })
      .slice(0, 80);
  }, [models, output, query]);

  const current = models.find((model) => model.id === value);

  return (
    <div className="model-select">
      <button type="button" className="select-button" onClick={() => setOpen((v) => !v)}>
        <span>{current?.name || value}</span>
        <small>{value}</small>
      </button>
      {open && (
        <div className="select-popover">
          <label className="search-field">
            <Search size={14} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Modell suchen"
            />
          </label>
          <div className="model-list">
            {filtered.map((model) => (
              <button
                type="button"
                key={model.id}
                className={model.id === value ? "active" : ""}
                onClick={() => {
                  onChange(model.id);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <span>{model.name || model.id}</span>
                <small>{model.id}</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
