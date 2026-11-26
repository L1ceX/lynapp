import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { HomeWidgetLayout, LaunchPlace, LauncherSettings, PageBoardId, PageLayouts, RailSide } from "@shared/types";
import type { InstanceTab } from "../../constants";
import { blockMeta, normalizePageBoard, PAGE_BOARD_IDS, PAGE_BOARDS, samePlacement } from "../../layout/boards";
import { clampSidebarWidth, defaultNav, LOCKED_TAB, moveItem, normalizeNav, sameNav, toNavLayout, type NormalizedNav } from "../../layout/navOrder";
import { dockTarget, type DockKind } from "../../layout/dockZones";
import { withViewTransition } from "../../lib/viewTransition";
import { getLauncherApi } from "../../lib/api";
import { cleanIpcError } from "../../lib/format";
import { DEFAULT_HOME_LAYOUT, normalizeHomeLayout, sameLayout } from "../../pages/home/layout";
import type { CoreState } from "./useCore";

export function useLayoutEditor(deps: Pick<CoreState, "bootstrap" | "instanceTab" | "setBootstrap" | "setInstanceTab" | "setSettingsDraft" | "setStatus" | "t">) {
  const { bootstrap, instanceTab, setBootstrap, setInstanceTab, setSettingsDraft, setStatus, t } = deps;
  const savedHomeLayout = useMemo(() => normalizeHomeLayout(bootstrap?.settings.homeLayout), [bootstrap?.settings.homeLayout]);
  const savedNav = useMemo(() => normalizeNav(bootstrap?.settings.navLayout), [bootstrap?.settings.navLayout]);
  const savedPages = useMemo(() => Object.fromEntries(PAGE_BOARD_IDS.map((id) => [id, normalizePageBoard(id, bootstrap?.settings.pageLayouts?.[id])])) as Record<PageBoardId, HomeWidgetLayout[]>, [bootstrap?.settings.pageLayouts]);
  const [homeDraft, setHomeDraft] = useState<HomeWidgetLayout[] | null>(null);
  const [pageDrafts, setPageDrafts] = useState<Record<PageBoardId, HomeWidgetLayout[]> | null>(null);
  const [navDraft, setNavDraft] = useState<NormalizedNav | null>(null);
  const [layoutEditing, setLayoutEditing] = useState(false);
  const [layoutExitConfirm, setLayoutExitConfirm] = useState(false);
  const [layoutSaving, setLayoutSaving] = useState(false);
  const exitTimer = useRef<number | null>(null);
  const [dockDrag, setDockDrag] = useState<{ kind: DockKind; side: string | null; x: number; y: number } | null>(null);

  const homeLayout = homeDraft ?? savedHomeLayout;
  const navLayout = navDraft ?? savedNav;
  const homeDirty = homeDraft !== null && !sameLayout(homeDraft, savedHomeLayout);
  const navDirty = navDraft !== null && !sameNav(navDraft, savedNav);
  const pageLayouts = pageDrafts ?? savedPages;
  const dirtyPages = pageDrafts ? PAGE_BOARD_IDS.filter((id) => !samePlacement(pageDrafts[id], savedPages[id], true)) : [];
  const layoutDirty = homeDirty || navDirty || dirtyPages.length > 0;

  useEffect(() => () => {
    if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
  }, []);

  useEffect(() => {
    if (!layoutEditing && savedNav.hiddenTabs.includes(instanceTab as InstanceTab)) setInstanceTab(LOCKED_TAB);
  }, [layoutEditing, savedNav, instanceTab]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || !event.shiftKey || event.code !== "KeyR") return;
      event.preventDefault();
      void emergencyResetLayout();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function emergencyResetLayout(): Promise<void> {
    try {
      const settings = await getLauncherApi().updateSettings({ homeLayout: undefined, navLayout: undefined, pageLayouts: undefined });
      withViewTransition(() => {
        setBootstrap((current) => (current ? { ...current, settings } : current));
        setSettingsDraft(settings);
        leaveLayoutEditing();
      });
      setStatus(t("Layout restored to the standard one (Ctrl+Shift+R)", "Расположение сброшено к стандартному (Ctrl+Shift+R)"));
    } catch (error) {
      setStatus(cleanIpcError(error, t("Failed to reset the layout", "Не удалось сбросить расположение")));
    }
  }

  function setRailSide(side: RailSide): void {
    withViewTransition(() => setNavDraft((current) => ({ ...(current ?? savedNav), railSide: side })));
  }

  function setSidebarSide(side: "left" | "right"): void {
    withViewTransition(() => setNavDraft((current) => ({ ...(current ?? savedNav), sidebarSide: side })));
  }

  function setSidebarWidth(width: number): void {
    setNavDraft((current) => ({ ...(current ?? savedNav), sidebarWidth: clampSidebarWidth(width) }));
  }

  function setTabsSide(side: RailSide): void {
    withViewTransition(() => setNavDraft((current) => ({ ...(current ?? savedNav), tabsSide: side })));
  }

  function setLaunchPlace(place: LaunchPlace): void {
    withViewTransition(() => setNavDraft((current) => ({ ...(current ?? savedNav), launchPlace: place })));
  }

  function startDock(kind: DockKind, event: ReactPointerEvent<HTMLElement>): void {
    if (!layoutEditing || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const move = (moveEvent: PointerEvent): void => {
      setDockDrag({ kind, side: dockTarget(kind, moveEvent.clientX, moveEvent.clientY, navLayout), x: moveEvent.clientX, y: moveEvent.clientY });
    };
    const up = (upEvent: PointerEvent): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const side = upEvent.type === "pointercancel" ? null : dockTarget(kind, upEvent.clientX, upEvent.clientY, navLayout);
      setDockDrag(null);
      if (!side) return;
      if (kind === "rail") setRailSide(side as RailSide);
      else if (kind === "sidebar") setSidebarSide(side as "left" | "right");
      else if (kind === "tabs") setTabsSide(side as RailSide);
      else setLaunchPlace(side as LaunchPlace);
    };
    setDockDrag({ kind, side: dockTarget(kind, event.clientX, event.clientY, navLayout), x: event.clientX, y: event.clientY });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLElement>): void {
    if (!layoutEditing || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = navLayout.sidebarWidth;
    const sign = navLayout.sidebarSide === "left" ? 1 : -1;
    document.documentElement.classList.add("resizing-sidebar");
    const move = (moveEvent: PointerEvent): void => setSidebarWidth(startWidth + sign * (moveEvent.clientX - startX));
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.documentElement.classList.remove("resizing-sidebar");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function startLayoutEditing(): void {
    setHomeDraft(savedHomeLayout);
    setNavDraft(savedNav);
    setPageDrafts(savedPages);
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

  function changePageLayout(board: PageBoardId, next: ReadonlyArray<{ i: string; x: number; y: number; w: number; h: number }>, resizedHeightId?: string): void {
    setPageDrafts((current) => {
      const all = current ?? savedPages;
      const base = all[board];
      const positions = new Map(next.map((item) => [item.i, item]));
      let changed = false;
      const merged = base.map((item) => {
        const moved = positions.get(item.i);
        if (!moved || item.hidden) return item;
        const nextCustomH = resizedHeightId === item.i ? true : item.customH;
        if (moved.x === item.x && moved.y === item.y && moved.w === item.w && moved.h === item.h && nextCustomH === item.customH) return item;
        changed = true;
        return { ...item, x: moved.x, y: moved.y, w: moved.w, h: moved.h, ...(nextCustomH ? { customH: true } : {}) };
      });
      return changed ? { ...all, [board]: merged } : all;
    });
  }

  function hidePageBlock(board: PageBoardId, id: string): void {
    if (blockMeta(board, id)?.locked) return;
    setPageDrafts((current) => {
      const all = current ?? savedPages;
      return { ...all, [board]: all[board].map((item) => (item.i === id ? { ...item, hidden: true } : item)) };
    });
  }

  function showPageBlock(board: PageBoardId, id: string): void {
    setPageDrafts((current) => {
      const all = current ?? savedPages;
      const bottom = all[board].filter((item) => !item.hidden).reduce((max, item) => Math.max(max, item.y + item.h), 0);
      return { ...all, [board]: all[board].map((item) => (item.i === id ? { ...item, hidden: false, x: 0, y: bottom } : item)) };
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
    withViewTransition(() => {
      setHomeDraft(DEFAULT_HOME_LAYOUT.map((item) => ({ ...item })));
      setNavDraft(defaultNav());
      setPageDrafts(Object.fromEntries(PAGE_BOARD_IDS.map((id) => [id, PAGE_BOARDS[id].defaults.map((item) => ({ ...item }))])) as Record<PageBoardId, HomeWidgetLayout[]>);
      setLayoutExitConfirm(false);
    });
  }

  function leaveLayoutEditing(): void {
    if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
    exitTimer.current = null;
    setLayoutEditing(false);
    setHomeDraft(null);
    setNavDraft(null);
    setPageDrafts(null);
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
      if (navDirty && navDraft) patch.navLayout = toNavLayout(navDraft);
      if (dirtyPages.length && pageDrafts) {
        const pages: PageLayouts = { ...(bootstrap?.settings.pageLayouts ?? {}) };
        for (const id of dirtyPages) pages[id] = pageDrafts[id];
        patch.pageLayouts = pages;
      }
      const settings = await getLauncherApi().updateSettings(patch);
      setBootstrap((current) => (current ? { ...current, settings } : current));
      setSettingsDraft(settings);
      leaveLayoutEditing();
      setStatus(t("Layout saved", "Расположение сохранено"));
    } catch (error) {
      setStatus(cleanIpcError(error, t("Failed to save", "Не удалось сохранить")));
    } finally {
      setLayoutSaving(false);
    }
  }

  return {
    homeLayout,
    navLayout,
    pageLayouts,
    changePageLayout,
    hidePageBlock,
    showPageBlock,
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
    saveLayout,
    setRailSide,
    setSidebarSide,
    setSidebarWidth,
    setTabsSide,
    setLaunchPlace,
    emergencyResetLayout,
    dockDrag,
    startDock,
    startSidebarResize
  };
}

export type LayoutEditorState = ReturnType<typeof useLayoutEditor>;
