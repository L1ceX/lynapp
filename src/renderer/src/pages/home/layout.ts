import type { HomeWidgetLayout } from "@shared/types";
import { normalizeBoard, samePlacement } from "../../layout/boards";

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
  { i: "launcher", x: 8, y: 5, w: 4, h: 5 }
];

export function widgetMeta(id: string) {
  return HOME_WIDGETS.find((item) => item.id === id);
}

export function normalizeHomeLayout(saved: HomeWidgetLayout[] | undefined): HomeWidgetLayout[] {
  return normalizeBoard(HOME_WIDGETS, DEFAULT_HOME_LAYOUT, HOME_COLS, saved);
}

export function sameLayout(a: HomeWidgetLayout[], b: HomeWidgetLayout[]): boolean {
  return samePlacement(a, b, true);
}
