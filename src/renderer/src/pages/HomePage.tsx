import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactGridLayout, { useContainerWidth, type Compactor, type Layout, type LayoutItem } from "react-grid-layout";
import { GridBackground } from "react-grid-layout/extras";
import { EyeOff } from "lucide-react";
import { useApp } from "../state/context";
import { HOME_COLS, HOME_MARGIN, HOME_ROW_HEIGHT, widgetMeta, type HomeWidgetId } from "./home/layout";
import { HomeWidget } from "./home/widgets";

function naturalHeight(node: HTMLElement): number {
  const style = getComputedStyle(node);
  const children = Array.from(node.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.offsetParent !== null);
  const gap = parseFloat(style.rowGap) || 0;
  const content = children.reduce((sum, child) => {
    const scrolls = /(auto|scroll)/.test(getComputedStyle(child).overflowY);
    return sum + (scrolls ? child.offsetHeight : Math.max(child.offsetHeight, child.scrollHeight));
  }, 0) + gap * Math.max(0, children.length - 1);
  return content + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
}

const PUSH_DELAY_MS = 450;

interface ActiveMove {
  id: string;
  base: Map<string, { x: number; y: number }>;
  cell: string;
  ready: boolean;
  timer: number | null;
  pointer: { x: number; y: number };
  cleanup: () => void;
}

function overlaps(a: LayoutItem, b: LayoutItem): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function resolveCollisions<T extends LayoutItem>(items: T[], fixedId: string | null): T[] {
  const order = [...items].sort((a, b) => (a.i === fixedId ? -1 : b.i === fixedId ? 1 : a.y - b.y || a.x - b.x));
  const placed: T[] = [];
  for (const item of order) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const other of placed) {
        if (overlaps(item, other)) {
          item.y = other.y + other.h;
          moved = true;
        }
      }
    }
    placed.push(item);
  }
  return items;
}

function rowsForHeight(height: number): number {
  return Math.ceil((height + 2 + HOME_MARGIN[1]) / (HOME_ROW_HEIGHT + HOME_MARGIN[1]));
}

export function HomePage() {
  const { section } = useApp();
  return section === "home" ? <HomeContent /> : null;
}

function HomeContent() {
  const { changeHomeLayout, hideHomeWidget, layoutEditing, homeLayout, instanceStatus, sectionExiting, selected, status, t } = useApp();
  const { width, containerRef, mounted } = useContainerWidth();
  const visible = useMemo(() => homeLayout.filter((item) => !item.hidden), [homeLayout]);
  const [fits, setFits] = useState<Record<string, number>>({});
  const observed = useRef(new Set<Element>());
  const measure = useCallback(() => {
    const next: Record<string, number> = {};
    document.querySelectorAll<HTMLElement>(".home-widget[data-widget]").forEach((widget) => {
      const body = widget.firstElementChild;
      if (body instanceof HTMLElement && widget.dataset.widget) next[widget.dataset.widget] = rowsForHeight(naturalHeight(body));
    });
    setFits((current) => {
      const keys = Object.keys(next);
      if (keys.length === Object.keys(current).length && keys.every((key) => current[key] === next[key])) return current;
      return next;
    });
  }, []);
  const observer = useRef<ResizeObserver | null>(null);
  if (observer.current === null && typeof ResizeObserver !== "undefined") observer.current = new ResizeObserver(() => measure());
  useEffect(() => () => observer.current?.disconnect(), []);
  useLayoutEffect(() => {
    const current = new Set<Element>();
    document.querySelectorAll(".home-widget[data-widget] > .widget-body").forEach((body) => current.add(body));
    observed.current.forEach((body) => { if (!current.has(body)) observer.current?.unobserve(body); });
    current.forEach((body) => { if (!observed.current.has(body)) observer.current?.observe(body); });
    observed.current = current;
    measure();
  });
  const gridLayout = useMemo(() => resolveCollisions(visible.map((item) => {
    const meta = widgetMeta(item.i);
    const fit = fits[item.i] ?? 0;
    return { i: item.i, x: item.x, y: item.y, w: item.w, h: Math.max(item.h, fit), minW: meta?.minW, minH: Math.max(meta?.minH ?? 1, fit) };
  }), null), [visible, fits]);
  const active = useRef<ActiveMove | null>(null);
  const compactor = useMemo<Compactor>(() => ({
    type: null,
    allowOverlap: true,
    compact(layout: Layout): Layout {
      const items = layout.map((item) => ({ ...item }));
      const move = active.current;
      if (!move) return resolveCollisions(items, null);
      const restored = items.map((item) => (item.i === move.id ? item : { ...item, ...(move.base.get(item.i) ?? {}) }));
      const moving = restored.find((item) => item.i === move.id);
      if (moving) {
        const cell = `${moving.x}:${moving.y}:${moving.w}:${moving.h}`;
        if (cell !== move.cell) {
          move.cell = cell;
          if (move.timer !== null) window.clearTimeout(move.timer);
          move.ready = false;
          move.timer = window.setTimeout(() => {
            if (active.current !== move) return;
            move.ready = true;
            move.timer = null;
            const { x, y } = move.pointer;
            document.dispatchEvent(new MouseEvent("mousemove", { clientX: x + 1, clientY: y, bubbles: true }));
            document.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));
          }, PUSH_DELAY_MS);
        }
      }
      return move.ready ? resolveCollisions(restored, move.id) : restored;
    }
  }), []);

  function beginMove(layout: Layout, item: LayoutItem | null, immediate: boolean, event: Event): void {
    if (!item) return;
    active.current?.cleanup();
    const pointer = event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : { x: 0, y: 0 };
    const onMove = (moveEvent: MouseEvent): void => {
      if (moveEvent.isTrusted && active.current) active.current.pointer = { x: moveEvent.clientX, y: moveEvent.clientY };
    };
    const onUp = (): void => {
      if (active.current) active.current.ready = true;
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    active.current = {
      id: item.i,
      base: new Map(layout.map((entry) => [entry.i, { x: entry.x, y: entry.y }])),
      cell: `${item.x}:${item.y}:${item.w}:${item.h}`,
      ready: immediate,
      timer: null,
      pointer,
      cleanup: () => {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
      }
    };
  }

  function endMove(layout: Layout): void {
    const move = active.current;
    if (move) {
      if (move.timer !== null) window.clearTimeout(move.timer);
      move.cleanup();
    }
    active.current = null;
    changeHomeLayout(layout);
  }

  useEffect(() => () => {
    const move = active.current;
    if (move?.timer != null) window.clearTimeout(move.timer);
    move?.cleanup();
    active.current = null;
  }, []);
  const rows = visible.reduce((max, item) => Math.max(max, item.y + item.h), 0) + 3;

  return (
    <main className={sectionExiting ? "page-workspace section-exiting" : "page-workspace"}>
      <header className="workspace-header">
        <div><span className="eyebrow">{t("Home", "Главная")}</span><h2>{t("Welcome back", "С возвращением")}</h2><span className="status-line">{selected !== null ? instanceStatus[selected.id] ?? status : status}</span></div>
      </header>
      <div ref={containerRef} className={layoutEditing ? "home-board editing" : "home-board"}>
        {mounted ? <>
          {layoutEditing ? <GridBackground className="home-grid-bg" width={width} cols={HOME_COLS} rowHeight={HOME_ROW_HEIGHT} margin={HOME_MARGIN} containerPadding={[0, 0]} rows={rows} color="transparent" borderRadius={12} /> : null}
          <ReactGridLayout
            className="home-grid"
            width={width}
            layout={gridLayout}
            compactor={compactor}
            gridConfig={{ cols: HOME_COLS, rowHeight: HOME_ROW_HEIGHT, margin: HOME_MARGIN, containerPadding: [0, 0] }}
            dragConfig={{ enabled: layoutEditing, threshold: 4, cancel: ".widget-hide" }}
            resizeConfig={{ enabled: layoutEditing, handles: ["se"] }}
            onDragStart={(layout, item, _next, _placeholder, event) => beginMove(layout, item, false, event)}
            onDragStop={(layout) => endMove(layout)}
            onResizeStart={(layout, item, _next, _placeholder, event) => beginMove(layout, item, true, event)}
            onResizeStop={(layout) => endMove(layout)}
          >
            {visible.map((item) => <div key={item.i} className="home-widget" data-widget={item.i}>
              <HomeWidget id={item.i as HomeWidgetId} />
              {layoutEditing ? <button type="button" className="widget-hide" onClick={() => hideHomeWidget(item.i)} title={t("Hide this block", "Скрыть блок")} aria-label={t("Hide this block", "Скрыть блок")}><EyeOff size={14} /></button> : null}
            </div>)}
          </ReactGridLayout>
        </> : null}
      </div>
    </main>
  );
}
