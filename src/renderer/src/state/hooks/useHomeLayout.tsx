import { useEffect, useMemo, useRef, useState } from "react";
import type { HomeWidgetLayout } from "@shared/types";
import { getLauncherApi } from "../../lib/api";
import { DEFAULT_HOME_LAYOUT, normalizeHomeLayout, sameLayout } from "../../pages/home/layout";
import type { CoreState } from "./useCore";

export function useHomeLayout(deps: Pick<CoreState, "bootstrap" | "section" | "setBootstrap" | "setSettingsDraft" | "setStatus" | "t">) {
  const { bootstrap, section, setBootstrap, setSettingsDraft, setStatus, t } = deps;
  const savedHomeLayout = useMemo(() => normalizeHomeLayout(bootstrap?.settings.homeLayout), [bootstrap?.settings.homeLayout]);
  const [homeDraft, setHomeDraft] = useState<HomeWidgetLayout[] | null>(null);
  const [homeEditing, setHomeEditing] = useState(false);
  const [homeExitConfirm, setHomeExitConfirm] = useState(false);
  const [homeSaving, setHomeSaving] = useState(false);
  const exitTimer = useRef<number | null>(null);

  const homeLayout = homeDraft ?? savedHomeLayout;
  const homeDirty = homeDraft !== null && !sameLayout(homeDraft, savedHomeLayout);

  useEffect(() => () => {
    if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
  }, []);

  useEffect(() => {
    if (section !== "home" && homeEditing && !homeDirty) {
      setHomeEditing(false);
      setHomeDraft(null);
    }
  }, [section, homeEditing, homeDirty]);

  function startHomeEditing(): void {
    setHomeDraft(savedHomeLayout);
    setHomeExitConfirm(false);
    setHomeEditing(true);
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

  function resetHomeLayout(): void {
    setHomeDraft(DEFAULT_HOME_LAYOUT.map((item) => ({ ...item })));
    setHomeExitConfirm(false);
  }

  function leaveHomeEditing(): void {
    if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
    setHomeEditing(false);
    setHomeDraft(null);
    setHomeExitConfirm(false);
  }

  function exitHomeEditing(): void {
    if (homeDirty && !homeExitConfirm) {
      setHomeExitConfirm(true);
      if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
      exitTimer.current = window.setTimeout(() => {
        setHomeExitConfirm(false);
        exitTimer.current = null;
      }, 3500);
      return;
    }
    leaveHomeEditing();
  }

  async function saveHomeLayout(): Promise<void> {
    if (!homeDraft || homeSaving) return;
    setHomeSaving(true);
    try {
      const settings = await getLauncherApi().updateSettings({ homeLayout: homeDraft });
      setBootstrap((current) => (current ? { ...current, settings } : current));
      setSettingsDraft(settings);
      leaveHomeEditing();
      setStatus(t("Home layout saved", "Расположение главной сохранено"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to save", "Не удалось сохранить"));
    } finally {
      setHomeSaving(false);
    }
  }

  return {
    homeLayout,
    homeEditing,
    homeDirty,
    homeExitConfirm,
    homeSaving,
    startHomeEditing,
    changeHomeLayout,
    hideHomeWidget,
    showHomeWidget,
    resetHomeLayout,
    exitHomeEditing,
    saveHomeLayout
  };
}

export type HomeLayoutState = ReturnType<typeof useHomeLayout>;
