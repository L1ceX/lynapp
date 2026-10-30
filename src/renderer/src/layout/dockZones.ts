import type { NormalizedNav } from "./navOrder";

export type DockKind = "rail" | "sidebar" | "tabs" | "launch";

export interface DockZone {
  side: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

const RAIL_THICKNESS = 84;
const RAIL_HEIGHT = 70;
const TABS_THICKNESS = 220;
const TABS_HEIGHT = 64;
const FLOAT_WIDTH = 240;
const FLOAT_HEIGHT = 96;

function rectOf(selector: string): DOMRect | null {
  return document.querySelector(selector)?.getBoundingClientRect() ?? null;
}

function edges(area: DOMRect, thickness: number, height: number): DockZone[] {
  return [
    { side: "left", left: area.left, top: area.top, width: thickness, height: area.height },
    { side: "right", left: area.right - thickness, top: area.top, width: thickness, height: area.height },
    { side: "top", left: area.left, top: area.top, width: area.width, height },
    { side: "bottom", left: area.left, top: area.bottom - height, width: area.width, height }
  ];
}

export function dockZones(kind: DockKind, nav: NormalizedNav): DockZone[] {
  if (kind === "rail") {
    const area = rectOf(".app-body");
    return area ? edges(area, RAIL_THICKNESS, RAIL_HEIGHT) : [];
  }
  if (kind === "sidebar") {
    const area = rectOf(".instances-workspace");
    if (!area) return [];
    return [
      { side: "left", left: area.left, top: area.top, width: nav.sidebarWidth, height: area.height },
      { side: "right", left: area.right - nav.sidebarWidth, top: area.top, width: nav.sidebarWidth, height: area.height }
    ];
  }
  if (kind === "tabs") {
    const workspace = rectOf(".instance-workspace");
    const body = rectOf(".instance-body");
    if (!workspace || !body) return [];
    const top = Math.max(workspace.top, body.top);
    const area = new DOMRect(body.left, top, body.width, workspace.bottom - top);
    return edges(area, TABS_THICKNESS, TABS_HEIGHT);
  }
  const workspace = rectOf(".instance-workspace");
  const header = rectOf(".instance-workspace > .workspace-header");
  const tabs = rectOf(".instance-tabs-bar");
  const zones: DockZone[] = [];
  if (header) zones.push({ side: "header", left: header.left, top: header.top, width: header.width, height: header.height });
  if (tabs) zones.push({ side: "tabs", left: tabs.left, top: tabs.top, width: tabs.width, height: tabs.height });
  if (workspace) zones.push({ side: "floating", left: workspace.right - FLOAT_WIDTH - 22, top: workspace.bottom - FLOAT_HEIGHT - 16, width: FLOAT_WIDTH, height: FLOAT_HEIGHT });
  return zones;
}

export function dockTarget(kind: DockKind, x: number, y: number, nav: NormalizedNav): string | null {
  const zones = dockZones(kind, nav);
  if (!zones.length) return null;
  if (kind === "sidebar") {
    const area = rectOf(".instances-workspace");
    return area ? (x < area.left + area.width / 2 ? "left" : "right") : null;
  }
  if (kind === "rail" || kind === "tabs") {
    const area = zones.reduce((box, zone) => ({ left: Math.min(box.left, zone.left), top: Math.min(box.top, zone.top), right: Math.max(box.right, zone.left + zone.width), bottom: Math.max(box.bottom, zone.top + zone.height) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    const distances: Array<[string, number]> = [["left", x - area.left], ["right", area.right - x], ["top", y - area.top], ["bottom", area.bottom - y]];
    distances.sort((a, b) => a[1] - b[1]);
    return distances[0][0];
  }
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
