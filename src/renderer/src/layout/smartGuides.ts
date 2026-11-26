export interface GridBox {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GridMetrics {
  cols: number;
  colWidth: number;
  rowHeight: number;
  gapX: number;
  gapY: number;
  bottomInset?: number;
}

export interface GuideLine {
  key: string;
  axis: "v" | "h";
  pos: number;
  start: number;
  end: number;
  center?: boolean;
}

export interface SmartGuidesResult {
  snapped: GridBox;
  guides: GuideLine[];
  matchedIds: string[];
  snappedH: boolean;
  snappedW: boolean;
  snapHeightPx: number | null;
  snapWidthPx: number | null;
}

function boxRect(box: GridBox, m: GridMetrics) {
  const left = box.x * (m.colWidth + m.gapX);
  const width = box.w * m.colWidth + Math.max(0, box.w - 1) * m.gapX;
  const top = box.y * (m.rowHeight + m.gapY);
  const height = box.h * m.rowHeight + Math.max(0, box.h - 1) * m.gapY - (m.bottomInset ?? 0);
  return {
    left,
    right: left + width,
    cx: left + width / 2,
    top,
    bottom: top + Math.max(0, height),
    cy: top + Math.max(0, height) / 2
  };
}

export function boxOuterWidthPx(w: number, m: GridMetrics): number {
  return Math.round(w * m.colWidth + Math.max(0, w - 1) * m.gapX);
}

export function boxOuterHeightPx(h: number, m: GridMetrics): number {
  return Math.round(h * m.rowHeight + Math.max(0, h - 1) * m.gapY);
}

export function computeSmartGuides(
  active: GridBox,
  others: GridBox[],
  mode: "drag" | "resize",
  snapTolY: number,
  freeMode: boolean,
  metrics: GridMetrics,
  oldBox?: GridBox | null,
  minH = 2,
  minW = 1
): SmartGuidesResult {
  const snapped: GridBox = { ...active };
  let snappedH = false;
  let snappedW = false;

  if (freeMode) {
    return { snapped, guides: [], matchedIds: [], snappedH: false, snappedW: false, snapHeightPx: null, snapWidthPx: null };
  }

  if (mode === "resize" && others.length > 0) {
    const topMoved = oldBox ? active.y !== oldBox.y : false;
    const heightChanged = oldBox ? active.h !== oldBox.h : true;
    const leftMoved = oldBox ? active.x !== oldBox.x : false;
    const widthChanged = oldBox ? active.w !== oldBox.w : true;

    if (heightChanged && snapTolY > 0) {
      if (topMoved && oldBox) {
        const fixedBottom = oldBox.y + oldBox.h;
        let bestDelta = snapTolY + 1;
        let bestY = snapped.y;
        for (const other of others) {
          const dTop = Math.abs(snapped.y - other.y);
          if (dTop <= snapTolY && dTop < bestDelta) {
            bestDelta = dTop;
            bestY = other.y;
          }
          const hTargetY = fixedBottom - other.h;
          const dHeight = Math.abs(snapped.y - hTargetY);
          if (hTargetY >= 0 && dHeight <= snapTolY && dHeight < bestDelta) {
            bestDelta = dHeight;
            bestY = hTargetY;
          }
        }
        if (bestDelta <= snapTolY && fixedBottom - bestY >= minH) {
          snapped.y = bestY;
          snapped.h = fixedBottom - bestY;
          snappedH = true;
        }
      } else {
        const curBottom = snapped.y + snapped.h;
        let bestDelta = snapTolY + 1;
        let bestH = snapped.h;
        for (const other of others) {
          const otherBottom = other.y + other.h;
          const dBottom = Math.abs(curBottom - otherBottom);
          if (dBottom <= snapTolY && otherBottom - snapped.y >= minH && dBottom < bestDelta) {
            bestDelta = dBottom;
            bestH = otherBottom - snapped.y;
          }
          const dHeight = Math.abs(snapped.h - other.h);
          if (dHeight <= snapTolY && other.h >= minH && dHeight < bestDelta) {
            bestDelta = dHeight;
            bestH = other.h;
          }
        }
        if (bestDelta <= snapTolY) {
          snapped.h = bestH;
          snappedH = true;
        }
      }
    } else if (heightChanged) {
      for (const other of others) {
        if (snapped.h === other.h || snapped.y + snapped.h === other.y + other.h || snapped.y === other.y) {
          snappedH = true;
          break;
        }
      }
    }

    if (widthChanged) {
      if (leftMoved && oldBox) {
        for (const other of others) {
          if (snapped.x === other.x || snapped.w === other.w) {
            snappedW = true;
            break;
          }
        }
      } else {
        for (const other of others) {
          if (snapped.w === other.w || snapped.x + snapped.w === other.x + other.w) {
            snappedW = true;
            break;
          }
        }
      }
    }
  }

  const aRect = boxRect(snapped, metrics);
  const guides: GuideLine[] = [];
  const seen = new Set<string>();
  const matchedSet = new Set<string>();

  const pushGuide = (axis: "v" | "h", pos: number, start: number, end: number, center = false): void => {
    const rPos = Math.round(pos);
    const key = `${axis}:${rPos}:${center ? 1 : 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    guides.push({ key, axis, pos: rPos, start: Math.min(start, end), end: Math.max(start, end), center });
  };

  for (const other of others) {
    if (other.i === snapped.i) continue;
    const oRect = boxRect(other, metrics);
    if (mode === "resize" && (snapped.w === other.w || snapped.h === other.h)) {
      matchedSet.add(other.i);
    }

    const vStart = Math.min(aRect.top, oRect.top);
    const vEnd = Math.max(aRect.bottom, oRect.bottom);
    if (snapped.x === other.x) pushGuide("v", aRect.left, vStart, vEnd);
    if (snapped.x + snapped.w === other.x + other.w) pushGuide("v", aRect.right, vStart, vEnd);
    if (snapped.x === other.x + other.w) pushGuide("v", aRect.left, vStart, vEnd);
    if (snapped.x + snapped.w === other.x) pushGuide("v", aRect.right, vStart, vEnd);
    if (Math.abs(aRect.cx - oRect.cx) <= 2 && snapped.x !== other.x) pushGuide("v", aRect.cx, vStart, vEnd, true);

    const hStart = Math.min(aRect.left, oRect.left);
    const hEnd = Math.max(aRect.right, oRect.right);
    if (snapped.y === other.y) pushGuide("h", aRect.top, hStart, hEnd);
    if (snapped.y + snapped.h === other.y + other.h) pushGuide("h", aRect.bottom, hStart, hEnd);
    if (snapped.y === other.y + other.h) pushGuide("h", aRect.top, hStart, hEnd);
    if (snapped.y + snapped.h === other.y) pushGuide("h", aRect.bottom, hStart, hEnd);
    if (Math.abs(aRect.cy - oRect.cy) <= 2 && snapped.y !== other.y) pushGuide("h", aRect.cy, hStart, hEnd, true);
  }

  return {
    snapped,
    guides,
    matchedIds: Array.from(matchedSet),
    snappedH,
    snappedW,
    snapHeightPx: snappedH ? boxOuterHeightPx(snapped.h, metrics) : null,
    snapWidthPx: snappedW ? boxOuterWidthPx(snapped.w, metrics) : null
  };
}
