import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

interface DragState {
  index: number;
  delta: number;
  target: number;
  step: number;
}

interface Session {
  index: number;
  start: number;
  rects: Array<{ start: number; end: number }>;
  active: boolean;
  target: number;
  step: number;
}

const THRESHOLD = 4;
const SHIFT_TRANSITION = "transform 220ms cubic-bezier(.2, .8, .2, 1)";

export function useReorder<T extends HTMLElement>(options: { axis: "x" | "y"; enabled: boolean; onMove: (from: number, to: number) => void }) {
  const { axis, enabled, onMove } = options;
  const containerRef = useRef<T | null>(null);
  const session = useRef<Session | null>(null);
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const [drag, setDrag] = useState<DragState | null>(null);
  const [settling, setSettling] = useState(false);

  useEffect(() => () => {
    cleanupDragRef.current?.();
  }, []);

  useEffect(() => {
    if (!settling) return;
    const frame = window.requestAnimationFrame(() => setSettling(false));
    return () => window.cancelAnimationFrame(frame);
  }, [settling]);

  useEffect(() => {
    if (!enabled) {
      cleanupDragRef.current?.();
      session.current = null;
      setDrag(null);
    }
  }, [enabled]);

  function startDrag(index: number, event: ReactPointerEvent<HTMLElement>): void {
    if (!enabled || event.button !== 0 || !containerRef.current) return;
    if ((event.target as Element).closest("[data-reorder-ignore]")) return;
    cleanupDragRef.current?.();
    const items = [...containerRef.current.querySelectorAll<HTMLElement>(":scope > [data-reorder-index]")];
    const rects = items.map((element) => {
      const rect = element.getBoundingClientRect();
      return axis === "x" ? { start: rect.left, end: rect.right } : { start: rect.top, end: rect.bottom };
    });
    if (!rects[index]) return;
    const gap = rects.length > 1 ? Math.max(0, rects[1].start - rects[0].end) : 0;
    session.current = {
      index,
      start: axis === "x" ? event.clientX : event.clientY,
      rects,
      active: false,
      target: index,
      step: rects[index].end - rects[index].start + gap
    };
    const handleMove = (moveEvent: PointerEvent): void => {
      const current = session.current;
      if (!current) return;
      const position = axis === "x" ? moveEvent.clientX : moveEvent.clientY;
      let delta = position - current.start;
      if (!current.active) {
        if (Math.abs(delta) < THRESHOLD) return;
        current.active = true;
      }
      const own = current.rects[current.index];
      const first = current.rects[0];
      const last = current.rects[current.rects.length - 1];
      delta = Math.max(first.start - own.start, Math.min(last.end - own.end, delta));
      const center = own.start + delta + (own.end - own.start) / 2;
      let target = current.index;
      for (let i = 0; i < current.index; i++) {
        if (center < current.rects[i].end) {
          target = i;
          break;
        }
      }
      for (let i = current.index + 1; i < current.rects.length; i++) {
        if (center > current.rects[i].start) target = i;
      }
      current.target = target;
      setDrag({ index: current.index, delta, target, step: current.step });
    };
    const detach = (): void => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      if (cleanupDragRef.current === detach) cleanupDragRef.current = null;
    };
    const handleUp = (): void => {
      detach();
      const current = session.current;
      session.current = null;
      if (!current || !current.active) return;
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
      setSettling(true);
      setDrag(null);
      if (current.target !== current.index) onMoveRef.current(current.index, current.target);
    };
    cleanupDragRef.current = detach;
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
  }

  function itemStyle(index: number): CSSProperties | undefined {
    if (settling) return { transition: "none" };
    if (!drag) return undefined;
    const translate = (value: number) => (axis === "x" ? `translateX(${value}px)` : `translateY(${value}px)`);
    if (index === drag.index) return { transform: translate(drag.delta), transition: "none", position: "relative", zIndex: 5 };
    if (drag.target > drag.index && index > drag.index && index <= drag.target) return { transform: translate(-drag.step), transition: SHIFT_TRANSITION };
    if (drag.target < drag.index && index >= drag.target && index < drag.index) return { transform: translate(drag.step), transition: SHIFT_TRANSITION };
    return { transform: "none", transition: SHIFT_TRANSITION };
  }

  function itemProps(index: number) {
    return {
      "data-reorder-index": index,
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => startDrag(index, event),
      onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
        if (!suppressClick.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClick.current = false;
      },
      style: itemStyle(index)
    };
  }

  return { containerRef, itemProps, draggingIndex: drag ? drag.index : null };
}
