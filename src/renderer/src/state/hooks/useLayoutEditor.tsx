import { useEffect, useMemo, useRef, useState } from "react";
import type { HomeWidgetLayout, LauncherSettings } from "@shared/types";
import type { InstanceTab } from "../../constants";
import { defaultNav, LOCKED_TAB, moveItem, normalizeNav, sameNav, type NormalizedNav } from "../../layout/navOrder";
import { getLauncherApi } from "../../lib/api";
import { DEFAULT_HOME_LAYOUT, normalizeHomeLayout, sameLayout } from "../../pages/home/layout";
import type { CoreState } from "./useCore";

export function useLayoutEditor(deps: Pick<CoreState, "bootstrap" | "instanceTab" | "setBootstrap" | "setInstanceTab" | "setSettingsDraft" | "setStatus" | "t">) {
  const { bootstrap, instanceTab, setBootstrap, setInstanceTab, setSettingsDraft, setStatus, t } = deps;
  const savedHomeLayout = useMemo(() => normalizeHomeLayout(bootstrap?.settings.homeLayout), [bootstrap?.settings.homeLayout]);
  const savedNav = useMemo(() => normalizeNav(bootstrap?.settings.navLayout), [bootstrap?.settings.navLayout]);
  const [homeDraft, setHomeDraft] = useState<HomeWidgetLayout[] | null>(null);
  const [navDraft, setNavDraft] = useState<NormalizedNav | null>(null);
  const [layoutEditing, setLayoutEditing] = useState(false);
  const [layoutExitConfirm, setLayoutExitConfirm] = useState(false);
  const [layoutSaving, setLayoutSaving] = useState(false);
  const exitTimer = useRef<number | null>(null);

  const homeLayout = homeDraft ?? savedHomeLayout;
  const navLayout = navDraft ?? savedNav;
  const homeDirty = homeDraft !== null && !sameLayout(homeDraft, savedHomeLayout);
  const navDirty = navDraft !== null && !sameNav(navDraft, savedNav);
  const layoutDirty = homeDirty || navDirty;

  useEffect(() => () => {
    if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
  }, []);

  useEffect(() => {
    if (!layoutEditing && savedNav.hiddenTabs.includes(instanceTab as InstanceTab)) setInstanceTab(LOCKED_TAB);
  }, [layoutEditing, savedNav, instanceTab]);

  function startLayoutEditing(): void {
    setHomeDraft(savedHomeLayout);
    setNavDraft(savedNav);
    setLayoutExitConfirm(false);
    setLayoutEditing(true);
  }

  function changeHomeLayout(next: ReadonlyArray<{ i: string; x: number; y: number; w: number; h: number }>): void {
    setHomeDraft((current) => {
      const base = current ?? savedHomeLayout;
      const positions = new Map(next.map((item) => [item.i, item]));
      let changed = false;
      const merged = base.map((item) => {
        const moved = positions.get(item.i);
        if (!moved || item.hidden) return item;
        if (moved.x === item.x && moved.y === item.y && moved.w === item.w && moved.h === item.h) return item;
        changed = true;
        return { ...item, x: moved.x, y: moved.y, w: moved.w, h: moved.h };
      });
      return changed ? merged : base;
    });
  }

  function hideHomeWidget(id: string): void {
    setHomeDraft((current) => (current ?? savedHomeLayout).map((item) => (item.i === id ? { ...item, hidden: true } : item)));
  }

  function showHomeWidget(id: string): void {
    setHomeDraft((current) => {
      const base = current ?? savedHomeLayout;
      const bottom = base.filter((item) => !item.hidden).reduce((max, item) => Math.max(max, item.y + item.h), 0);
      return base.map((item) => (item.i === id ? { ...item, hidden: false, x: 0, y: bottom } : item));
    });
  }

  function moveRailItem(from: number, to: number): void {
    if (from === to) return;
    setNavDraft((current) => {
      const base = current ?? savedNav;
      return { ...base, rail: moveItem(base.rail, from, to) };
    });
  }

  function moveTabItem(from: number, to: number): void {
    if (from === to) return;
    setNavDraft((current) => {
      const base = current ?? savedNav;
      return { ...base, tabs: moveItem(base.tabs, from, to) };
    });
  }

  function toggleTabHidden(tab: InstanceTab): void {
    if (tab === LOCKED_TAB) return;
    setNavDraft((current) => {
      const base = current ?? savedNav;
      const hiddenTabs = base.hiddenTabs.includes(tab) ? base.hiddenTabs.filter((item) => item !== tab) : [...base.hiddenTabs, tab];
      return { ...base, hiddenTabs };
    });
  }

  function resetLayout(): void {
    setHomeDraft(DEFAULT_HOME_LAYOUT.map((item) => ({ ...item })));
    setNavDraft(defaultNav());
    setLayoutExitConfirm(false);
  }

  function leaveLayoutEditing(): void {
    if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
    exitTimer.current = null;
    setLayoutEditing(false);
    setHomeDraft(null);
    setNavDraft(null);
    setLayoutExitConfirm(false);
  }

  function exitLayoutEditing(): void {
    if (layoutDirty && !layoutExitConfirm) {
      setLayoutExitConfirm(true);
      if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
      exitTimer.current = window.setTimeout(() => {
        setLayoutExitConfirm(false);
        exitTimer.current = null;
      }, 3500);
      return;
    }
    leaveLayoutEditing();
  }

  async function saveLayout(): Promise<void> {
    if (!layoutDirty || layoutSaving) return;
    setLayoutSaving(true);
    try {
      const patch: Partial<LauncherSettings> = {};
      if (homeDirty && homeDraft) patch.homeLayout = homeDraft;
      if (navDirty && navDraft) patch.navLayout = { rail: navDraft.rail, tabs: navDraft.tabs, hiddenTabs: navDraft.hiddenTabs };
      const settings = await getLauncherApi().updateSettings(patch);
      setBootstrap((current) => (current ? { ...current, settings } : current));
      setSettingsDraft(settings);
      leaveLayoutEditing();
      setStatus(t("Layout saved", "Расположение сохранено"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to save", "Не удалось сохранить"));
    } finally {
      setLayoutSaving(false);
    }
  }

  return {
    homeLayout,
    navLayout,
    layoutEditing,
    layoutDirty,
    layoutExitConfirm,
    layoutSaving,
    startLayoutEditing,
    changeHomeLayout,
    hideHomeWidget,
    showHomeWidget,
    moveRailItem,
    moveTabItem,
    toggleTabHidden,
    resetLayout,
    exitLayoutEditing,
    saveLayout
  };
}

export type LayoutEditorState = ReturnType<typeof useLayoutEditor>;
