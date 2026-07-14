import { ChevronDown, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
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
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    openrouterModels()
      .then((items) => setModels(items.length ? items : FALLBACK_TEXT))
      .catch(() => setModels(FALLBACK_TEXT));
  }, []);

  useLayoutEffect(() => {
    if (!open) return;

    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    const viewportMargin = 16;
    const gap = 6;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(480, window.innerWidth - viewportMargin * 2);
    const roomBelow = window.innerHeight - rect.bottom - gap - viewportMargin;
    const roomAbove = rect.top - gap - viewportMargin;
    const naturalHeight = Math.min(popover.scrollHeight, 360);
    const openAbove = roomBelow < naturalHeight && roomAbove > roomBelow;
    const height = Math.min(
      naturalHeight,
      Math.max(96, openAbove ? roomAbove : roomBelow),
    );

    setPopoverStyle({
      top: Math.round(
        openAbove ? Math.max(viewportMargin, rect.top - gap - height) : rect.bottom + gap,
      ),
      left: Math.round(
        Math.min(
          Math.max(viewportMargin, rect.left),
          window.innerWidth - width - viewportMargin,
        ),
      ),
      width: Math.round(width),
      maxHeight: Math.round(height),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models
      .filter((model) => {
        const inputModalities = model.architecture?.input_modalities ?? ["text"];
        const outputModalities = model.architecture?.output_modalities ?? ["text"];
        if (!inputModalities.includes("text")) return false;
        if (output === "text" && !outputModalities.includes("text")) return false;
        if (output === "image" && !outputModalities.includes("image")) return false;
        const haystack = `${model.id} ${model.name ?? ""}`.toLowerCase();
        return !q || haystack.includes(q);
      })
      .slice(0, 80);
  }, [models, output, query]);

  const current = models.find((model) => model.id === value);

  return (
    <div className="model-select" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`select-button${open ? " open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="postprocess-model-list"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="select-button-text">
          <span>{current?.name || value}</span>
          <small>{value}</small>
        </span>
        <ChevronDown size={15} className="select-chevron" aria-hidden />
      </button>
      {open && createPortal(
        <div className="select-popover" ref={popoverRef} style={popoverStyle}>
          <label className="search-field">
            <Search size={14} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Modell suchen"
              aria-label="OpenRouter-Modell suchen"
            />
          </label>
          <div className="model-list" id="postprocess-model-list" role="listbox">
            {filtered.map((model) => (
              <button
                type="button"
                key={model.id}
                role="option"
                aria-selected={model.id === value}
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
        </div>,
        document.body,
      )}
    </div>
  );
}
