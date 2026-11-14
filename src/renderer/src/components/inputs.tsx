import { useEffect, useRef, useState } from "react";

export function MemorySlider({ value, max = 32768, totalMb, totalOfLabel = "of", onChange, onCommit, label = "Allocated RAM" }: { value: number; max?: number; totalMb?: number; totalOfLabel?: string; onChange: (value: number) => void; onCommit?: (value: number) => void; label?: string }) {
  const limit = Math.max(512, Math.floor((max || 32768) / 256) * 256);
  const safe = Math.min(limit, Math.max(512, Math.round(value / 256) * 256 || 2048));
  const [local, setLocal] = useState(safe);
  const lastCommittedRef = useRef(safe);
  useEffect(() => {
    setLocal(safe);
    lastCommittedRef.current = safe;
  }, [safe]);
  const gb = (local / 1024).toFixed(local % 1024 === 0 ? 0 : 1);
  const totalGb = totalMb ? Math.max(1, Math.round(totalMb / 1024)) : null;
  const commit = (next: number): void => {
    const clamped = Math.min(limit, Math.max(512, Math.round(next / 256) * 256));
    setLocal(clamped);
    if (clamped === lastCommittedRef.current) return;
    lastCommittedRef.current = clamped;
    onChange(clamped);
    onCommit?.(clamped);
  };
  return (
    <div className="memory-slider">
      <input type="range" min={512} max={limit} step={256} value={local} onChange={(event) => setLocal(Number(event.target.value))} onPointerUp={(event) => commit(Number(event.currentTarget.value))} onKeyUp={(event) => commit(Number(event.currentTarget.value))} onBlur={(event) => commit(Number(event.currentTarget.value))} aria-label={label} />
      <span className="muted">{local} MB · {gb} GB{totalGb ? ` (${totalOfLabel} ${totalGb} GB)` : ""}</span>
    </div>
  );
}

export function CommitInput({ value, onCommit, placeholder }: { value: string; onCommit: (value: string) => void; placeholder?: string }) {
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);
  const commit = (): void => {
    if (local.trim() && local !== value) onCommit(local);
    else if (!local.trim()) setLocal(value);
  };
  return <input value={local} placeholder={placeholder} onChange={(event) => setLocal(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); if (event.key === "Escape") { setLocal(value); } }} />;
}
