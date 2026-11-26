import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import ReactGridLayout, { useContainerWidth, type Compactor, type Layout, type LayoutItem } from "react-grid-layout";
import { GridBackground } from "react-grid-layout/extras";
import { EyeOff } from "lucide-react";
import { SmartGuidesOverlay } from "../components/SmartGuidesOverlay";
import { snapGridWidth } from "../layout/boards";
import { computeSmartGuides, type GridBox, type SmartGuidesResult } from "../layout/smartGuides";
import { useApp } from "../state/context";
import { HOME_COLS, HOME_MARGIN, HOME_ROW_HEIGHT, widgetMeta, type HomeWidgetId } from "./home/layout";
import { HomeWidget } from "./home/widgets";

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

export function HomePage() {
  const { section } = useApp();
  return section === "home" ? <HomeContent /> : null;
}

function HomeContent() {
  const { changeHomeLayout, hideHomeWidget, layoutEditing, homeLayout, sectionExiting, t } = useApp();
  const { width, containerRef, mounted } = useContainerWidth();
  const gridWidth = snapGridWidth(width, HOME_COLS, HOME_MARGIN[0]);
  const [resizingSize, setResizingSize] = useState<{ id: string; w: number; h: number } | null>(null);
  const [guideState, setGuideState] = useState<SmartGuidesResult | null>(null);
  const shiftRef = useRef(false);
  const resizeStartRef = useRef<GridBox | null>(null);
  const visible = useMemo(() => homeLayout.filter((item) => !item.hidden), [homeLayout]);
  const colWidth = gridWidth > 0 ? (gridWidth - HOME_MARGIN[0] * (HOME_COLS - 1)) / HOME_COLS : 0;
  const metrics = useMemo(() => ({
    cols: HOME_COLS,
    colWidth,
    rowHeight: HOME_ROW_HEIGHT,
    gapX: HOME_MARGIN[0],
    gapY: HOME_MARGIN[1]
  }), [colWidth]);

  useEffect(() => {
    if (!layoutEditing) {
      shiftRef.current = false;
      setGuideState(null);
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      shiftRef.current = event.shiftKey;
      if (event.shiftKey) setGuideState(null);
    };
    const onBlur = (): void => {
      shiftRef.current = false;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [layoutEditing]);

  const gridLayout = useMemo(() => resolveCollisions(visible.map((item) => {
    const meta = widgetMeta(item.i);
    const minW = meta?.minW ?? 2;
    const minH = meta?.minH ?? 2;
    return { i: item.i, x: item.x, y: item.y, w: Math.max(item.w, minW), h: Math.max(item.h, minH), minW, minH };
  }), null), [visible]);
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
    resizeStartRef.current = null;
    setGuideState(null);
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
        <div><span className="eyebrow">{t("Home", "Главная")}</span><h2>{t("Welcome back", "С возвращением")}</h2></div>
      </header>
      <div ref={containerRef} className={layoutEditing ? "home-board editing" : "home-board"}>
        {mounted && gridWidth > 0 ? <div className="home-grid-stage" style={{ width: gridWidth } as CSSProperties}>
          {layoutEditing ? <GridBackground className="home-grid-bg" width={gridWidth} cols={HOME_COLS} rowHeight={HOME_ROW_HEIGHT} margin={HOME_MARGIN} containerPadding={[0, 0]} rows={rows} color="transparent" borderRadius={12} /> : null}
          <ReactGridLayout
            className="home-grid"
            width={gridWidth}
            layout={gridLayout}
            compactor={compactor}
            gridConfig={{ cols: HOME_COLS, rowHeight: HOME_ROW_HEIGHT, margin: HOME_MARGIN, containerPadding: [0, 0] }}
            dragConfig={{ enabled: layoutEditing, threshold: 4, cancel: ".widget-hide" }}
            resizeConfig={{ enabled: layoutEditing, handles: ["n", "s", "e", "w", "ne", "nw", "se", "sw"] }}
            onDragStart={(layout, item, _next, _placeholder, event) => beginMove(layout, item, false, event)}
            onDrag={(nextLayout, _old, newItem) => {
              if (!newItem) return;
              const others = nextLayout.filter((entry) => entry.i !== newItem.i);
              setGuideState(computeSmartGuides(newItem, others, "drag", 0, shiftRef.current, metrics));
            }}
            onDragStop={(layout) => endMove(layout)}
            onResizeStart={(layout, item, _next, _placeholder, event) => {
              beginMove(layout, item, true, event);
              if (item) {
                resizeStartRef.current = { i: item.i, x: item.x, y: item.y, w: item.w, h: item.h };
                setResizingSize({ id: item.i, w: item.w, h: item.h });
              }
            }}
            onResize={(nextLayout, oldItem, next, placeholder) => {
              if (!next) return;
              const others = nextLayout.filter((entry) => entry.i !== next.i);
              const result = computeSmartGuides(next, others, "resize", 0, shiftRef.current, metrics, resizeStartRef.current ?? oldItem, 2, 2);
              if (!shiftRef.current && result.snappedW) {
                next.w = result.snapped.w;
                next.x = result.snapped.x;
                if (placeholder) {
                  placeholder.w = result.snapped.w;
                  placeholder.x = result.snapped.x;
                }
              }
              setResizingSize({ id: next.i, w: result.snapped.w, h: result.snapped.h });
              setGuideState(result);
            }}
            onResizeStop={(layout) => { setResizingSize(null); endMove(layout); }}
          >
            {visible.map((item) => {
              const matched = Boolean(guideState?.matchedIds.includes(item.i));
              const isResizingThis = layoutEditing && resizingSize?.id === item.i;
              const snapH = isResizingThis && guideState?.snapHeightPx ? guideState.snapHeightPx : null;
              const snapW = isResizingThis && guideState?.snapWidthPx ? guideState.snapWidthPx : null;
              const widgetStyle: CSSProperties = {
                ...(snapH ? { "--snap-h": `${snapH}px` } : {}),
                ...(snapW ? { "--snap-w": `${snapW}px` } : {})
              } as CSSProperties;
              const widgetClasses = [
                "home-widget",
                matched ? "guide-matched" : "",
                snapH ? "snap-lock-h" : "",
                snapW ? "snap-lock-w" : ""
              ].filter(Boolean).join(" ");
              return <div key={item.i} className={widgetClasses} data-widget={item.i} style={widgetStyle}>
                <HomeWidget id={item.i as HomeWidgetId} />
                {isResizingThis && resizingSize ? <span className="widget-size-badge">{resizingSize.w} × {resizingSize.h}</span> : null}
                {layoutEditing ? <button type="button" className="widget-hide" onClick={() => hideHomeWidget(item.i)} title={t("Hide this block", "Скрыть блок")} aria-label={t("Hide this block", "Скрыть блок")}><EyeOff size={14} /></button> : null}
              </div>;
            })}
          </ReactGridLayout>
          {layoutEditing && guideState ? <SmartGuidesOverlay guides={guideState.guides} /> : null}
        </div> : null}
      </div>
    </main>
  );
}
