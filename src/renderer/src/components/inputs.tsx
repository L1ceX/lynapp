import { useEffect, useState } from "react";

export function MemorySlider({ value, onChange, onCommit, label = "Allocated RAM" }: { value: number; onChange: (value: number) => void; onCommit?: (value: number) => void; label?: string }) {
  const safe = Math.min(32768, Math.max(512, Math.round(value / 256) * 256 || 2048));
  const [local, setLocal] = useState(safe);
  useEffect(() => {
    setLocal(safe);
  }, [safe]);
  const gb = (local / 1024).toFixed(local % 1024 === 0 ? 0 : 1);
  const commit = (next: number): void => {
    onChange(next);
    onCommit?.(next);
  };
  return (
    <div className="memory-slider">
      <input type="range" min={512} max={32768} step={256} value={local} onChange={(event) => setLocal(Number(event.target.value))} onPointerUp={() => commit(local)} onKeyUp={() => commit(local)} onBlur={() => { if (local !== safe) commit(local); }} aria-label={label} />
      <span className="muted">{local} MB · {gb} GB</span>
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
