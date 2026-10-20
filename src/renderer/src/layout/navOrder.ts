import type { NavLayout } from "@shared/types";
import type { AppSection, InstanceTab } from "../constants";

export const DEFAULT_RAIL_ORDER: AppSection[] = ["home", "instances", "launcher", "visuals", "skins", "accounts"];
export const DEFAULT_TAB_ORDER: InstanceTab[] = ["general", "versions", "content", "files", "runtime", "logs"];
export const LOCKED_TAB: InstanceTab = "general";

export interface NormalizedNav {
  rail: AppSection[];
  tabs: InstanceTab[];
  hiddenTabs: InstanceTab[];
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

export function normalizeNav(saved: NavLayout | undefined): NormalizedNav {
  const tabs = normalizeOrder(saved?.tabs, DEFAULT_TAB_ORDER);
  const hiddenTabs = Array.isArray(saved?.hiddenTabs) ? tabs.filter((tab) => tab !== LOCKED_TAB && saved?.hiddenTabs?.includes(tab)) : [];
  return { rail: normalizeOrder(saved?.rail, DEFAULT_RAIL_ORDER), tabs, hiddenTabs };
}

export function sameNav(a: NormalizedNav, b: NormalizedNav): boolean {
  return a.rail.join() === b.rail.join() && a.tabs.join() === b.tabs.join() && [...a.hiddenTabs].sort().join() === [...b.hiddenTabs].sort().join();
}

export function defaultNav(): NormalizedNav {
  return { rail: [...DEFAULT_RAIL_ORDER], tabs: [...DEFAULT_TAB_ORDER], hiddenTabs: [] };
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
