import type { NormalizedNav } from "./navOrder";

export type DockKind = "rail" | "sidebar" | "tabs" | "launch";

export interface DockZone {
  side: string;
  left: number;
  top: number;
  width: number;
  height: number;
  compact?: boolean;
}

const EDGE_INSET = 10;
const RAIL_THICKNESS = 74;
const RAIL_HEIGHT = 64;
const TABS_THICKNESS = 210;
const TABS_HEIGHT = 60;
const PILL_THICKNESS = 44;
const PILL_LONG_V = 144;
const PILL_LONG_H = 168;
const FLOAT_WIDTH = 236;
const FLOAT_HEIGHT = 92;

function rectOf(selector: string): DOMRect | null {
  return document.querySelector(selector)?.getBoundingClientRect() ?? null;
}

function areaFor(kind: DockKind): DOMRect | null {
  if (kind === "rail") return rectOf(".app-body");
  if (kind === "sidebar") return rectOf(".instances-workspace");
  if (kind === "tabs") {
    const workspace = rectOf(".instance-workspace");
    const body = rectOf(".instance-body");
    if (!workspace || !body) return null;
    const top = Math.max(workspace.top, body.top);
    return new DOMRect(body.left, top, body.width, Math.max(0, workspace.bottom - top));
  }
  return null;
}

function edgeZone(area: DOMRect, side: "left" | "right" | "top" | "bottom", thickness: number, height: number, active: boolean): DockZone {
  const innerW = Math.max(0, area.width - EDGE_INSET * 2);
  const innerH = Math.max(0, area.height - EDGE_INSET * 2);
  if (active) {
    if (side === "left") return { side, left: area.left + EDGE_INSET, top: area.top + EDGE_INSET, width: Math.min(thickness, innerW), height: innerH };
    if (side === "right") return { side, left: area.right - EDGE_INSET - Math.min(thickness, innerW), top: area.top + EDGE_INSET, width: Math.min(thickness, innerW), height: innerH };
    if (side === "top") return { side, left: area.left + EDGE_INSET, top: area.top + EDGE_INSET, width: innerW, height: Math.min(height, innerH) };
    return { side, left: area.left + EDGE_INSET, top: area.bottom - EDGE_INSET - Math.min(height, innerH), width: innerW, height: Math.min(height, innerH) };
  }
  const safeH = Math.max(64, Math.min(PILL_LONG_V, innerH - (height + EDGE_INSET * 2) * 2));
  const safeW = Math.max(96, Math.min(PILL_LONG_H, innerW - (thickness + EDGE_INSET * 2) * 2));
  if (side === "left") return { side, left: area.left + EDGE_INSET, top: area.top + (area.height - safeH) / 2, width: PILL_THICKNESS, height: safeH, compact: true };
  if (side === "right") return { side, left: area.right - EDGE_INSET - PILL_THICKNESS, top: area.top + (area.height - safeH) / 2, width: PILL_THICKNESS, height: safeH, compact: true };
  if (side === "top") return { side, left: area.left + (area.width - safeW) / 2, top: area.top + EDGE_INSET, width: safeW, height: PILL_THICKNESS, compact: true };
  return { side, left: area.left + (area.width - safeW) / 2, top: area.bottom - EDGE_INSET - PILL_THICKNESS, width: safeW, height: PILL_THICKNESS, compact: true };
}

function edges(area: DOMRect, thickness: number, height: number, activeSide: string | null): DockZone[] {
  return [
    edgeZone(area, "left", thickness, height, activeSide === "left"),
    edgeZone(area, "right", thickness, height, activeSide === "right"),
    edgeZone(area, "top", thickness, height, activeSide === "top"),
    edgeZone(area, "bottom", thickness, height, activeSide === "bottom")
  ];
}

export function dockZones(kind: DockKind, nav: NormalizedNav, activeSide: string | null = null): DockZone[] {
  if (kind === "rail") {
    const area = areaFor("rail");
    return area ? edges(area, RAIL_THICKNESS, RAIL_HEIGHT, activeSide) : [];
  }
  if (kind === "sidebar") {
    const area = areaFor("sidebar");
    if (!area) return [];
    const innerH = Math.max(0, area.height - EDGE_INSET * 2);
    const fullW = Math.min(nav.sidebarWidth - EDGE_INSET, Math.max(120, area.width / 2 - EDGE_INSET * 2));
    const pillH = Math.max(88, Math.min(180, innerH - 40));
    const leftActive = activeSide === "left";
    const rightActive = activeSide === "right";
    return [
      leftActive
        ? { side: "left", left: area.left + EDGE_INSET, top: area.top + EDGE_INSET, width: fullW, height: innerH }
        : { side: "left", left: area.left + EDGE_INSET, top: area.top + (area.height - pillH) / 2, width: PILL_THICKNESS, height: pillH, compact: true },
      rightActive
        ? { side: "right", left: area.right - EDGE_INSET - fullW, top: area.top + EDGE_INSET, width: fullW, height: innerH }
        : { side: "right", left: area.right - EDGE_INSET - PILL_THICKNESS, top: area.top + (area.height - pillH) / 2, width: PILL_THICKNESS, height: pillH, compact: true }
    ];
  }
  if (kind === "tabs") {
    const area = areaFor("tabs");
    return area ? edges(area, TABS_THICKNESS, TABS_HEIGHT, activeSide) : [];
  }
  const workspace = rectOf(".instance-workspace");
  const header = rectOf(".instance-workspace > .workspace-header");
  const tabs = rectOf(".instance-tabs-bar");
  const zones: DockZone[] = [];
  if (header) zones.push({ side: "header", left: header.left, top: header.top, width: header.width, height: header.height, compact: activeSide !== "header" });
  if (tabs) zones.push({ side: "tabs", left: tabs.left, top: tabs.top, width: tabs.width, height: tabs.height, compact: activeSide !== "tabs" });
  if (workspace) zones.push({ side: "floating", left: workspace.right - FLOAT_WIDTH - 22, top: workspace.bottom - FLOAT_HEIGHT - 16, width: FLOAT_WIDTH, height: FLOAT_HEIGHT, compact: activeSide !== "floating" });
  return zones;
}

export function dockTarget(kind: DockKind, x: number, y: number, nav: NormalizedNav): string | null {
  if (kind === "sidebar") {
    const area = areaFor("sidebar");
    return area ? (x < area.left + area.width / 2 ? "left" : "right") : null;
  }
  if (kind === "rail" || kind === "tabs") {
    const area = areaFor(kind);
    if (!area) return null;
    const distances: Array<[string, number]> = [
      ["left", Math.max(0, x - area.left)],
      ["right", Math.max(0, area.right - x)],
      ["top", Math.max(0, y - area.top)],
      ["bottom", Math.max(0, area.bottom - y)]
    ];
    distances.sort((a, b) => a[1] - b[1]);
    return distances[0][0];
  }
  const zones = dockZones(kind, nav);
  if (!zones.length) return null;
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const zone of zones) {
    const dx = Math.max(zone.left - x, 0, x - (zone.left + zone.width));
    const dy = Math.max(zone.top - y, 0, y - (zone.top + zone.height));
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = zone.side;
    }
  }
  return best;
}
