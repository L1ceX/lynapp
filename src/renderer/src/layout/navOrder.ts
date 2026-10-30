import type { LaunchPlace, NavLayout, RailSide } from "@shared/types";
import type { AppSection, InstanceTab } from "../constants";

export const DEFAULT_RAIL_ORDER: AppSection[] = ["home", "instances", "launcher", "visuals", "skins", "accounts"];
export const DEFAULT_TAB_ORDER: InstanceTab[] = ["general", "versions", "content", "files", "runtime", "logs"];
export const LOCKED_TAB: InstanceTab = "general";
export const RAIL_SIDES: RailSide[] = ["left", "right", "top", "bottom"];
export const LAUNCH_PLACES: LaunchPlace[] = ["header", "tabs", "floating"];
export const SIDEBAR_WIDTH_DEFAULT = 296;
export const SIDEBAR_WIDTH_MIN = 230;
export const SIDEBAR_WIDTH_MAX = 520;

export interface NormalizedNav {
  rail: AppSection[];
  tabs: InstanceTab[];
  hiddenTabs: InstanceTab[];
  railSide: RailSide;
  sidebarSide: "left" | "right";
  sidebarWidth: number;
  tabsSide: RailSide;
  launchPlace: LaunchPlace;
}

function normalizeOrder<T extends string>(saved: unknown, defaults: T[]): T[] {
  const known = new Set<string>(defaults);
  const result: T[] = [];
  if (Array.isArray(saved)) {
    for (const item of saved) {
      if (typeof item === "string" && known.has(item) && !result.includes(item as T)) result.push(item as T);
    }
  }
  for (const item of defaults) if (!result.includes(item)) result.push(item);
  return result;
}

export function clampSidebarWidth(value: unknown): number {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number <= 0) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, number));
}

export function normalizeNav(saved: NavLayout | undefined): NormalizedNav {
  const tabs = normalizeOrder(saved?.tabs, DEFAULT_TAB_ORDER);
  const hiddenTabs = Array.isArray(saved?.hiddenTabs) ? tabs.filter((tab) => tab !== LOCKED_TAB && saved?.hiddenTabs?.includes(tab)) : [];
  return {
    rail: normalizeOrder(saved?.rail, DEFAULT_RAIL_ORDER),
    tabs,
    hiddenTabs,
    railSide: saved?.railSide && RAIL_SIDES.includes(saved.railSide) ? saved.railSide : "left",
    sidebarSide: saved?.sidebarSide === "right" ? "right" : "left",
    sidebarWidth: clampSidebarWidth(saved?.sidebarWidth),
    tabsSide: saved?.tabsSide && RAIL_SIDES.includes(saved.tabsSide) ? saved.tabsSide : "top",
    launchPlace: saved?.launchPlace && LAUNCH_PLACES.includes(saved.launchPlace) ? saved.launchPlace : "header"
  };
}

export function sameNav(a: NormalizedNav, b: NormalizedNav): boolean {
  return a.rail.join() === b.rail.join()
    && a.tabs.join() === b.tabs.join()
    && [...a.hiddenTabs].sort().join() === [...b.hiddenTabs].sort().join()
    && a.railSide === b.railSide
    && a.sidebarSide === b.sidebarSide
    && a.sidebarWidth === b.sidebarWidth
    && a.tabsSide === b.tabsSide
    && a.launchPlace === b.launchPlace;
}

export function defaultNav(): NormalizedNav {
  return { rail: [...DEFAULT_RAIL_ORDER], tabs: [...DEFAULT_TAB_ORDER], hiddenTabs: [], railSide: "left", sidebarSide: "left", sidebarWidth: SIDEBAR_WIDTH_DEFAULT, tabsSide: "top", launchPlace: "header" };
}

export function toNavLayout(nav: NormalizedNav): NavLayout {
  return { rail: nav.rail, tabs: nav.tabs, hiddenTabs: nav.hiddenTabs, railSide: nav.railSide, sidebarSide: nav.sidebarSide, sidebarWidth: nav.sidebarWidth, tabsSide: nav.tabsSide, launchPlace: nav.launchPlace };
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
