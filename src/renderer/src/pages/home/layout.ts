import type { HomeWidgetLayout } from "@shared/types";

export type HomeWidgetId = "continue" | "account" | "statInstances" | "statMods" | "statRunning" | "statActivity" | "recent" | "launcher";

export const HOME_COLS = 12;
export const HOME_ROW_HEIGHT = 52;
export const HOME_MARGIN: [number, number] = [14, 14];

export const HOME_WIDGETS: Array<{ id: HomeWidgetId; label: string; labelRu: string; minW: number; minH: number }> = [
  { id: "continue", label: "Continue playing", labelRu: "Продолжить игру", minW: 4, minH: 3 },
  { id: "account", label: "Account", labelRu: "Аккаунт", minW: 3, minH: 3 },
  { id: "statInstances", label: "Instances", labelRu: "Инстанции", minW: 2, minH: 2 },
  { id: "statMods", label: "Mods installed", labelRu: "Установлено модов", minW: 2, minH: 2 },
  { id: "statRunning", label: "Running now", labelRu: "Сейчас запущено", minW: 2, minH: 2 },
  { id: "statActivity", label: "Last activity", labelRu: "Последняя активность", minW: 2, minH: 2 },
  { id: "recent", label: "Recent instances", labelRu: "Недавние инстанции", minW: 4, minH: 4 },
  { id: "launcher", label: "lynapp", labelRu: "lynapp", minW: 3, minH: 3 }
];

export const DEFAULT_HOME_LAYOUT: HomeWidgetLayout[] = [
  { i: "continue", x: 0, y: 0, w: 8, h: 3 },
  { i: "account", x: 8, y: 0, w: 4, h: 3 },
  { i: "statInstances", x: 0, y: 3, w: 3, h: 2 },
  { i: "statMods", x: 3, y: 3, w: 3, h: 2 },
  { i: "statRunning", x: 6, y: 3, w: 3, h: 2 },
  { i: "statActivity", x: 9, y: 3, w: 3, h: 2 },
  { i: "recent", x: 0, y: 5, w: 8, h: 5 },
  { i: "launcher", x: 8, y: 5, w: 4, h: 4 }
];

export function widgetMeta(id: string) {
  return HOME_WIDGETS.find((item) => item.id === id);
}

export function normalizeHomeLayout(saved: HomeWidgetLayout[] | undefined): HomeWidgetLayout[] {
  const known = new Set(HOME_WIDGETS.map((item) => item.id as string));
  const result: HomeWidgetLayout[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(saved) ? saved : DEFAULT_HOME_LAYOUT) {
    if (!item || typeof item.i !== "string" || !known.has(item.i) || seen.has(item.i)) continue;
    const meta = widgetMeta(item.i);
    const w = Math.min(HOME_COLS, Math.max(meta?.minW ?? 1, Math.round(Number(item.w) || 0)));
    const h = Math.max(meta?.minH ?? 1, Math.round(Number(item.h) || 0));
    const x = Math.min(HOME_COLS - w, Math.max(0, Math.round(Number(item.x) || 0)));
    const y = Math.max(0, Math.round(Number(item.y) || 0));
    result.push({ i: item.i, x, y, w, h, ...(item.hidden ? { hidden: true } : {}) });
    seen.add(item.i);
  }
  let bottom = result.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  for (const fallback of DEFAULT_HOME_LAYOUT) {
    if (seen.has(fallback.i)) continue;
    result.push({ ...fallback, x: 0, y: bottom });
    bottom += fallback.h;
  }
  return result;
}

export function sameLayout(a: HomeWidgetLayout[], b: HomeWidgetLayout[]): boolean {
  if (a.length !== b.length) return false;
  const key = (item: HomeWidgetLayout) => `${item.i}:${item.x}:${item.y}:${item.w}:${item.h}:${item.hidden ? 1 : 0}`;
  const left = a.map(key).sort().join("|");
  const right = b.map(key).sort().join("|");
  return left === right;
}
