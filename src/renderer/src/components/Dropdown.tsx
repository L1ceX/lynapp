import { ChevronDown, Search } from "lucide-react";
import { type UIEvent, useEffect, useRef, useState } from "react";
import { motionMs } from "../lib/motion";

export interface DropdownProps {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  searchPlaceholder?: string;
  stretch?: "right" | "left";
  openUp?: boolean;
}

export const DROPDOWN_SEARCH_FROM = 30;

export const DROPDOWN_PAGE = 80;

export function Dropdown({ value, options, onChange, disabled, ariaLabel, searchPlaceholder, stretch, openUp }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(DROPDOWN_PAGE);
  const popupRef = useRef<HTMLDivElement>(null);
  const searchable = options.length > DROPDOWN_SEARCH_FROM;
  const needle = query.trim().toLowerCase();
  const filtered = needle ? options.filter((option) => option.toLowerCase().includes(needle)) : options;
  const visible = filtered.length > limit ? filtered.slice(0, limit) : filtered;
  const [closing, setClosing] = useState(false);
  const [up, setUp] = useState(false);
  const closeTimer = useRef<number | null>(null);

  function closeDropdown(): void {
    if (!open || closing) return;
    setClosing(true);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
      closeTimer.current = null;
    }, motionMs(195));
  }

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) closeDropdown();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDropdown();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open ]);

  function toggle(): void {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (open) {
      if (closing) {
        setClosing(false);
        return;
      }
      setClosing(true);
      closeTimer.current = window.setTimeout(() => {
        setOpen(false);
        setClosing(false);
        closeTimer.current = null;
      }, motionMs(195));
      return;
    }
    setClosing(false);
    setQuery("");
    setLimit(Math.max(DROPDOWN_PAGE, options.indexOf(value) + 40));
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const need = Math.min(options.length * 36 + 14 + (searchable ? 44 : 0), 264) + 8;
      let bottomEdge = window.innerHeight;
      let topEdge = 0;
      for (let node = buttonRef.current.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/(auto|scroll|hidden|clip)/.test(`${style.overflowY}${style.overflow}`)) {
          const box = node.getBoundingClientRect();
          bottomEdge = Math.min(bottomEdge, box.bottom);
          topEdge = Math.max(topEdge, box.top);
        }
      }
      const below = bottomEdge - rect.bottom;
      const above = rect.top - topEdge;
      setUp(openUp || (below < need && above > below));
    }
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const active = popupRef.current?.querySelector(".dropdown-option.active");
    if (active instanceof HTMLElement && popupRef.current) {
      popupRef.current.scrollTop = Math.max(0, active.offsetTop - popupRef.current.clientHeight / 2 + active.offsetHeight / 2);
    }
  }, [open]);

  function onPopupScroll(event: UIEvent<HTMLDivElement>): void {
    const element = event.currentTarget;
    if (limit < filtered.length && element.scrollTop + element.clientHeight > element.scrollHeight - 240) {
      setLimit((current) => current + DROPDOWN_PAGE * 2);
    }
  }

  function pick(option: string): void {
    onChange(option);
    closeDropdown();
  }

  return (
    <div className="dropdown" ref={rootRef}>
      <button type="button" ref={buttonRef} className={open ? "dropdown-button open" : "dropdown-button"} disabled={disabled} aria-label={ariaLabel} onClick={toggle}>
        <span>{value}</span><ChevronDown size={15} />
      </button>
      {open && !disabled ? <div ref={popupRef} className={[ "dropdown-popup", up ? "up" : "", closing ? "closing" : "", searchable ? "searchable" : "", stretch ? `stretch-${stretch}` : "" ].filter(Boolean).join(" ")} role="listbox" onScroll={onPopupScroll}>{searchable ? <label className="dropdown-search"><Search size={14} /><input autoFocus value={query} placeholder={searchPlaceholder ?? ""} aria-label={searchPlaceholder ?? ariaLabel} onChange={(event) => { setQuery(event.target.value); setLimit(DROPDOWN_PAGE); }} onKeyDown={(event) => { if (event.key === "Enter" && filtered[0]) { event.preventDefault(); pick(filtered[0]); } }} /></label> : null}{visible.map((option) => <button type="button" key={option} role="option" aria-selected={option === value} className={option === value ? "dropdown-option active" : "dropdown-option"} onClick={() => pick(option)}>{option}</button>)}{searchable && !filtered.length ? <span className="dropdown-empty">—</span> : null}</div> : null}
    </div>
  );
}
