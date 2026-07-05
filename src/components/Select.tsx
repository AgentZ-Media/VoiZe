import { Check, ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
}

/**
 * Custom single-select styled to the app design. The menu is rendered with
 * position: fixed and positioned from the trigger's measured rect so it
 * escapes the settings group-box (which clips overflow) and follows the
 * pane while it stays open. Closes on outside click, Escape, or scroll.
 */
export default function Select({ value, options, onChange, ariaLabel }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const current = options.find((option) => option.value === value);

  const place = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setMenuStyle({
      position: "fixed",
      top: Math.round(rect.bottom + 5),
      left: Math.round(rect.left),
      minWidth: Math.round(rect.width),
    });
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    // capture: catch scrolls on the settings pane, not just the window
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return (
    <div className="ui-select" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`select-trigger${open ? " open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current?.label ?? value}</span>
        <ChevronDown size={15} className="select-chevron" aria-hidden />
      </button>
      {open && (
        <div className="select-menu" role="listbox" ref={menuRef} style={menuStyle}>
          {options.map((option) => (
            <button
              type="button"
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? "active" : ""}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="select-option-text">
                <span className="select-option-label">{option.label}</span>
                {option.hint && <small>{option.hint}</small>}
              </span>
              {option.value === value && <Check size={14} className="select-check" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
