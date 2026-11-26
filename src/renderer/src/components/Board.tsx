import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import ReactGridLayout, { useContainerWidth, type Layout } from "react-grid-layout";
import { EyeOff, Lock } from "lucide-react";
import type { PageBoardId } from "@shared/types";
import { BLOCK_MIN_PX, BOARD_COLS, BOARD_GAP, BOARD_ROW, blockMeta, snapGridWidth } from "../layout/boards";
import { computeSmartGuides, type GridBox, type SmartGuidesResult } from "../layout/smartGuides";
import { useApp } from "../state/context";
import { SmartGuidesOverlay } from "./SmartGuidesOverlay";

const BOARD_MIN_H = 24;
const SNAP_TOL_ROWS = 6;

function rowsFor(height: number): number {
  return Math.max(BOARD_MIN_H, Math.ceil((Math.ceil(height) + 4 + BOARD_GAP) / BOARD_ROW));
}

export function Board({ id, blocks, className }: { id: PageBoardId; blocks: Record<string, ReactNode>; className?: string }) {
  const { changePageLayout, hidePageBlock, layoutEditing, pageLayouts, t } = useApp();
  const { width, containerRef, mounted } = useContainerWidth();
  const gridWidth = snapGridWidth(width, BOARD_COLS, BOARD_GAP);
  const [fits, setFits] = useState<Record<string, number>>({});
  const [contentHeights, setContentHeights] = useState<Record<string, number>>({});
  const [settled, setSettled] = useState(false);
  const [resizingSize, setResizingSize] = useState<{ id: string; w: number; h: number } | null>(null);
  const [guideState, setGuideState] = useState<SmartGuidesResult | null>(null);
  const shiftRef = useRef(false);
  const resizeStartRef = useRef<GridBox | null>(null);
  const baseHeightsRef = useRef<Record<string, number>>({});
  const fitNodes = useRef(new Map<string, HTMLElement>());
  const rafRef = useRef<number | null>(null);
  const layout = pageLayouts[id];
  const visible = useMemo(() => layout.filter((item) => !item.hidden && blocks[item.i] !== undefined), [layout, blocks]);

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

  const measure = useCallback(() => {
    const nextFits: Record<string, number> = {};
    const nextHeights: Record<string, number> = {};
    fitNodes.current.forEach((node, key) => {
      const hPx = Math.ceil(node.getBoundingClientRect().height);
      nextHeights[key] = hPx;
      const compact = node.parentElement?.classList.contains("is-compact") ?? false;
      if (!compact) baseHeightsRef.current[key] = hPx;
      nextFits[key] = rowsFor(baseHeightsRef.current[key] ?? hPx);
    });
    setFits((current) => {
      const keys = Object.keys(nextFits);
      if (keys.length === Object.keys(current).length && keys.every((key) => current[key] === nextFits[key])) return current;
      return nextFits;
    });
    setContentHeights((current) => {
      const keys = Object.keys(nextHeights);
      if (keys.length === Object.keys(current).length && keys.every((key) => current[key] === nextHeights[key])) return current;
      return nextHeights;
    });
  }, []);

  const scheduleMeasure = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      measure();
    });
  }, [measure]);

  const observer = useRef<ResizeObserver | null>(null);
  if (observer.current === null && typeof ResizeObserver !== "undefined") observer.current = new ResizeObserver(() => scheduleMeasure());

  useEffect(() => () => {
    observer.current?.disconnect();
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  useLayoutEffect(() => {
    measure();
  });

  const attachFit = useCallback((key: string, node: HTMLElement | null) => {
    const previous = fitNodes.current.get(key);
    if (previous && previous !== node) observer.current?.unobserve(previous);
    if (node) {
      fitNodes.current.set(key, node);
      observer.current?.observe(node);
    } else fitNodes.current.delete(key);
  }, []);

  useLayoutEffect(() => {
    if (settled || !mounted || !Object.keys(fits).length) return;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setSettled(true)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [fits, mounted, settled]);

  const colWidth = gridWidth > 0 ? (gridWidth - BOARD_GAP * (BOARD_COLS - 1)) / BOARD_COLS : 0;
  const metrics = useMemo(() => ({
    cols: BOARD_COLS,
    colWidth,
    rowHeight: BOARD_ROW,
    gapX: BOARD_GAP,
    gapY: 0,
    bottomInset: BOARD_GAP
  }), [colWidth]);

  const gridLayout = useMemo(() => {
    const pixelCols = colWidth > 0 ? Math.ceil((BLOCK_MIN_PX + BOARD_GAP) / (colWidth + BOARD_GAP)) : 1;
    const items = visible.map((item) => {
      const meta = blockMeta(id, item.i);
      const minH = Math.max(meta?.minH ?? BOARD_MIN_H, BOARD_MIN_H);
      const h = item.customH ? Math.max(item.h, minH) : (fits[item.i] ?? Math.max(item.h, minH));
      const minW = Math.min(BOARD_COLS, Math.max(meta?.minW ?? 1, pixelCols));
      const w = Math.max(item.w, minW);
      return { i: item.i, x: Math.min(item.x, BOARD_COLS - w), y: item.y, w, h, minW, minH };
    });
    const byX = [...items].sort((a, b) => a.x - b.x);
    for (const right of byX) {
      for (const left of byX) {
        if (left === right || left.x >= right.x || left.y >= right.y + right.h || right.y >= left.y + left.h) continue;
        if (left.x + left.w > right.x) left.w = Math.max(left.minW, right.x - left.x);
      }
    }
    return items;
  }, [visible, fits, id, colWidth]);

  const commit = (next: Layout, resizedHeightId?: string): void => changePageLayout(id, next, resizedHeightId);
  const classes = ["board", layoutEditing ? "editing" : "", resizingSize ? "is-resizing" : "", settled ? "" : "settling", className ?? ""].filter(Boolean).join(" ");

  return (
    <div ref={containerRef} className={classes} style={{ "--board-col": `${colWidth}px`, "--board-gap": `${BOARD_GAP}px` } as CSSProperties}>
      {mounted && gridWidth > 0 ? <div className="board-stage" style={{ width: gridWidth } as CSSProperties}>
        {layoutEditing ? <div className="board-columns" aria-hidden="true" /> : null}
        <ReactGridLayout
          className="board-grid"
          width={gridWidth}
          layout={gridLayout}
          gridConfig={{ cols: BOARD_COLS, rowHeight: BOARD_ROW, margin: [BOARD_GAP, 0], containerPadding: [0, 0] }}
          dragConfig={{ enabled: layoutEditing, threshold: 4, cancel: ".board-hide" }}
          resizeConfig={{ enabled: layoutEditing, handles: ["n", "s", "e", "w", "ne", "nw", "se", "sw"] }}
          onDrag={(nextLayout, _old, newItem) => {
            if (!newItem) return;
            const others = nextLayout.filter((entry) => entry.i !== newItem.i);
            setGuideState(computeSmartGuides(newItem, others, "drag", 0, shiftRef.current, metrics));
          }}
          onDragStop={(next) => {
            setGuideState(null);
            commit(next);
          }}
          onResizeStart={(_layout, item) => {
            if (!item) return;
            resizeStartRef.current = { i: item.i, x: item.x, y: item.y, w: item.w, h: item.h };
            setResizingSize({ id: item.i, w: item.w, h: item.h });
          }}
          onResize={(nextLayout, oldItem, newItem, placeholder) => {
            if (!newItem) return;
            const others = nextLayout.filter((entry) => entry.i !== newItem.i);
            const result = computeSmartGuides(newItem, others, "resize", SNAP_TOL_ROWS, shiftRef.current, metrics, resizeStartRef.current ?? oldItem, BOARD_MIN_H);
            if (!shiftRef.current) {
              if (result.snappedH) {
                newItem.h = result.snapped.h;
                newItem.y = result.snapped.y;
                if (placeholder) {
                  placeholder.h = result.snapped.h;
                  placeholder.y = result.snapped.y;
                }
              }
              if (result.snappedW) {
                newItem.w = result.snapped.w;
                newItem.x = result.snapped.x;
                if (placeholder) {
                  placeholder.w = result.snapped.w;
                  placeholder.x = result.snapped.x;
                }
              }
            }
            setGuideState(result);
            setResizingSize({ id: newItem.i, w: result.snapped.w, h: result.snapped.h });
          }}
          onResizeStop={(next, oldItem, newItem) => {
            let finalLayout = next;
            let heightChanged = oldItem && newItem && oldItem.h !== newItem.h ? newItem.i : undefined;
            if (newItem && !shiftRef.current) {
              const others = next.filter((entry) => entry.i !== newItem.i);
              const result = computeSmartGuides(newItem, others, "resize", SNAP_TOL_ROWS, false, metrics, resizeStartRef.current ?? oldItem, BOARD_MIN_H);
              if (result.snappedH || result.snappedW) {
                finalLayout = next.map((entry) => (entry.i === newItem.i ? { ...entry, x: result.snapped.x, y: result.snapped.y, w: result.snapped.w, h: result.snapped.h } : entry));
                if ((resizeStartRef.current?.h ?? oldItem?.h) !== result.snapped.h) heightChanged = newItem.i;
              }
            }
            resizeStartRef.current = null;
            setResizingSize(null);
            setGuideState(null);
            commit(finalLayout, heightChanged);
          }}
        >
          {visible.map((item, index) => {
            const meta = blockMeta(id, item.i);
            const matched = Boolean(guideState?.matchedIds.includes(item.i));
            const isResizingThis = layoutEditing && resizingSize?.id === item.i;
            const liveH = isResizingThis && resizingSize ? resizingSize.h : (gridLayout.find((entry) => entry.i === item.i)?.h ?? item.h);
            const cardInnerPx = liveH * BOARD_ROW - BOARD_GAP - 2;
            const actualPx = contentHeights[item.i] ?? 0;
            const basePx = baseHeightsRef.current[item.i] ?? actualPx;
            const isCompact = (item.customH || isResizingThis) && basePx > 0 && cardInnerPx < basePx - 4;
            const needsScroll = Boolean(item.customH) && !layoutEditing && actualPx > 0 && cardInnerPx < actualPx - 4;
            const snapH = isResizingThis && guideState?.snapHeightPx ? guideState.snapHeightPx : null;
            const snapW = isResizingThis && guideState?.snapWidthPx ? guideState.snapWidthPx : null;
            const blockStyle: CSSProperties = {
              "--board-index": index,
              ...(snapH ? { "--snap-h": `${snapH}px` } : {}),
              ...(snapW ? { "--snap-w": `${snapW}px` } : {})
            } as CSSProperties;
            const blockClasses = [
              "board-block",
              matched ? "guide-matched" : "",
              snapH ? "snap-lock-h" : "",
              snapW ? "snap-lock-w" : ""
            ].filter(Boolean).join(" ");
            const cardClasses = [
              "board-card",
              isCompact ? "is-compact" : "",
              needsScroll ? "needs-scroll" : ""
            ].filter(Boolean).join(" ");
            return <div key={item.i} className={blockClasses} style={blockStyle}>
              <div className={cardClasses}>
                <div className="board-fit" ref={(node) => attachFit(item.i, node)}>{blocks[item.i]}</div>
              </div>
              {isResizingThis && resizingSize ? <span className="widget-size-badge">{resizingSize.w} × {Math.round(resizingSize.h * BOARD_ROW - BOARD_GAP)}px</span> : null}
              {layoutEditing ? meta?.locked
                ? <span className="board-hide board-locked" title={t("This block cannot be hidden", "Этот блок нельзя скрыть")}><Lock size={13} /></span>
                : <button type="button" className="board-hide" onClick={() => hidePageBlock(id, item.i)} title={t("Hide this block", "Скрыть блок")} aria-label={t("Hide this block", "Скрыть блок")}><EyeOff size={14} /></button> : null}
            </div>;
          })}
        </ReactGridLayout>
        {layoutEditing && guideState ? <SmartGuidesOverlay guides={guideState.guides} /> : null}
      </div> : null}
    </div>
  );
}
