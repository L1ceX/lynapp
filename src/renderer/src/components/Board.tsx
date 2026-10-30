import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import ReactGridLayout, { useContainerWidth, type Layout } from "react-grid-layout";
import { EyeOff, Lock } from "lucide-react";
import type { PageBoardId } from "@shared/types";
import { BLOCK_MIN_PX, BOARD_COLS, BOARD_GAP, BOARD_ROW, blockMeta } from "../layout/boards";
import { useApp } from "../state/context";

function rowsFor(height: number): number {
  return Math.max(1, Math.ceil((height + 2 + BOARD_GAP) / BOARD_ROW));
}

export function Board({ id, blocks, className }: { id: PageBoardId; blocks: Record<string, ReactNode>; className?: string }) {
  const { changePageLayout, hidePageBlock, layoutEditing, pageLayouts, t } = useApp();
  const { width, containerRef, mounted } = useContainerWidth();
  const [fits, setFits] = useState<Record<string, number>>({});
  const [settled, setSettled] = useState(false);
  const fitNodes = useRef(new Map<string, HTMLElement>());
  const layout = pageLayouts[id];
  const visible = useMemo(() => layout.filter((item) => !item.hidden && blocks[item.i] !== undefined), [layout, blocks]);

  const measure = useCallback(() => {
    const next: Record<string, number> = {};
    fitNodes.current.forEach((node, key) => { next[key] = rowsFor(node.offsetHeight); });
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

  const colWidth = width > 0 ? (width - BOARD_GAP * (BOARD_COLS - 1)) / BOARD_COLS : 0;
  const gridLayout = useMemo(() => {
    const pixelCols = colWidth > 0 ? Math.ceil((BLOCK_MIN_PX + BOARD_GAP) / (colWidth + BOARD_GAP)) : 1;
    const items = visible.map((item) => {
      const meta = blockMeta(id, item.i);
      const h = fits[item.i] ?? item.h;
      const minW = Math.min(BOARD_COLS, Math.max(meta?.minW ?? 1, pixelCols));
      const w = Math.max(item.w, minW);
      return { i: item.i, x: Math.min(item.x, BOARD_COLS - w), y: item.y, w, h, minW, minH: h, maxH: h };
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

  const commit = (next: Layout): void => changePageLayout(id, next);
  const classes = ["board", layoutEditing ? "editing" : "", settled ? "" : "settling", className ?? ""].filter(Boolean).join(" ");

  return (
    <div ref={containerRef} className={classes} style={{ "--board-col": `${colWidth}px`, "--board-gap": `${BOARD_GAP}px` } as CSSProperties}>
      {mounted ? <>
        {layoutEditing ? <div className="board-columns" aria-hidden="true" /> : null}
        <ReactGridLayout
          className="board-grid"
          width={width}
          layout={gridLayout}
          gridConfig={{ cols: BOARD_COLS, rowHeight: BOARD_ROW, margin: [BOARD_GAP, 0], containerPadding: [0, 0] }}
          dragConfig={{ enabled: layoutEditing, threshold: 4, cancel: ".board-hide" }}
          resizeConfig={{ enabled: layoutEditing, handles: ["e", "w"] }}
          onDragStop={(next) => commit(next)}
          onResizeStop={(next) => commit(next)}
        >
          {visible.map((item, index) => {
            const meta = blockMeta(id, item.i);
            return <div key={item.i} className="board-block" style={{ "--board-index": index } as CSSProperties}>
              <div className="board-card">
                <div className="board-fit" ref={(node) => attachFit(item.i, node)}>{blocks[item.i]}</div>
              </div>
              {layoutEditing ? meta?.locked
                ? <span className="board-hide board-locked" title={t("This block cannot be hidden", "Этот блок нельзя скрыть")}><Lock size={13} /></span>
                : <button type="button" className="board-hide" onClick={() => hidePageBlock(id, item.i)} title={t("Hide this block", "Скрыть блок")} aria-label={t("Hide this block", "Скрыть блок")}><EyeOff size={14} /></button> : null}
            </div>;
          })}
        </ReactGridLayout>
      </> : null}
    </div>
  );
}
