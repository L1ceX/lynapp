import { useEffect, useRef, useState } from "react";
import { hexToRgb, resolveTheme, THEME_DEFAULTS, THEME_PRESETS, THEME_TOKENS, type ThemeTokenId } from "@shared/theme";
import { EFFECTS_DEFAULTS, type EffectsSettings, type LauncherSettings } from "@shared/types";
import { effectGroups } from "../../constants";
import { getLauncherApi } from "../../lib/api";
import { setMotionRate } from "../../lib/motion";
import type { CoreState } from "./useCore";

export function useVisuals(deps: Pick<CoreState, "bootstrap" | "setBootstrap" | "setSettingsDraft" | "setStatus" | "t">) {
  const { bootstrap, setBootstrap, setSettingsDraft, setStatus, t } = deps;
  const [theme, setTheme] = useState<Record<string, string>>({ ...THEME_DEFAULTS });

  const [previewToken, setPreviewToken] = useState<ThemeTokenId>("accent");

  const [glowOn, setGlowOn] = useState(true);

  const [glowSize, setGlowSize] = useState(100);

  const [glowSpeed, setGlowSpeed] = useState(100);

  const [animsOn, setAnimsOn] = useState(true);

  const [animSpeed, setAnimSpeed] = useState(100);

  const [effects, setEffects] = useState<EffectsSettings>({ ...EFFECTS_DEFAULTS });

  const motionSaveTimer = useRef<number | null>(null);

  const pendingMotion = useRef<Pick<Partial<LauncherSettings>, "animationSpeed" | "effects">>({});

  const glowColor = useRef<[number, number, number]>([255, 255, 255]);

  const glowOnRef = useRef(true);

  const glowSizeRef = useRef(100);

  const glowSpeedRef = useRef(100);

  const animsRef = useRef(true);

  const themeSaveTimer = useRef<number | null>(null);

  const prefsSaveTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (themeSaveTimer.current !== null) window.clearTimeout(themeSaveTimer.current);
    if (prefsSaveTimer.current !== null) window.clearTimeout(prefsSaveTimer.current);
    if (motionSaveTimer.current !== null) window.clearTimeout(motionSaveTimer.current);
  }, []);

  useEffect(() => {
    if (bootstrap) {
      setTheme(resolveTheme(bootstrap.settings.theme));
      setGlowOn(bootstrap.settings.glowEnabled ?? true);
      setGlowSize(bootstrap.settings.glowSize ?? 100);
      setGlowSpeed(Math.min(bootstrap.settings.glowSpeed ?? 100, 150));
      setAnimsOn(bootstrap.settings.animationsEnabled ?? true);
      setAnimSpeed(Math.min(200, Math.max(50, bootstrap.settings.animationSpeed ?? 100)));
      setEffects({ ...EFFECTS_DEFAULTS, ...(bootstrap.settings.effects ?? {}) });
    }
  }, [bootstrap]);

  useEffect(() => {
    const root = document.documentElement;
    for (const group of effectGroups) {
      root.classList.toggle(group.cls, animsOn && effects.enabled && effects[group.id]);
    }
  }, [effects, animsOn]);

  useEffect(() => {
    const rate = animSpeed / 100;
    setMotionRate(rate);
    const adjust = (animation: Animation): void => {
      if (animation.playbackRate !== rate) animation.playbackRate = rate;
    };
    for (const animation of document.getAnimations()) adjust(animation);
    const onStart = (event: Event): void => {
      const target = event.target;
      if (target instanceof Element) target.getAnimations().forEach(adjust);
      const pseudo = (event as AnimationEvent).pseudoElement;
      if (pseudo && target instanceof Element) {
        for (const animation of document.getAnimations()) {
          const effect = animation.effect as KeyframeEffect | null;
          if (effect?.target === target && effect.pseudoElement === pseudo) adjust(animation);
        }
      }
    };
    document.addEventListener("animationstart", onStart, true);
    document.addEventListener("transitionrun", onStart, true);
    return () => {
      document.removeEventListener("animationstart", onStart, true);
      document.removeEventListener("transitionrun", onStart, true);
    };
  }, [animSpeed]);

  function saveMotion(change: Pick<Partial<LauncherSettings>, "animationSpeed" | "effects">): void {
    if (motionSaveTimer.current !== null) window.clearTimeout(motionSaveTimer.current);
    pendingMotion.current = { ...pendingMotion.current, ...change };
    motionSaveTimer.current = window.setTimeout(() => {
      motionSaveTimer.current = null;
      const patch = pendingMotion.current;
      pendingMotion.current = {};
      void getLauncherApi().updateSettings(patch).then((settings) => {
        setBootstrap((current) => current ? { ...current, settings } : current);
        setSettingsDraft((current) => current ? { ...current, ...patch } : current);
      }).catch((error) => setStatus(error instanceof Error ? error.message : t("Failed to save", "Не удалось сохранить")));
    }, 350);
  }

  function setAnimSpeedValue(value: number): void {
    setAnimSpeed(value);
    saveMotion({ animationSpeed: value });
  }

  function setEffectFlag(id: keyof EffectsSettings, value: boolean): void {
    const next = { ...effects, [id]: value };
    setEffects(next);
    saveMotion({ effects: next });
  }

  useEffect(() => {
    const root = document.documentElement;
    THEME_TOKENS.forEach((token) => token.vars.forEach((name) => root.style.setProperty(name, theme[token.id] ?? token.default)));
    glowColor.current = hexToRgb(typeof theme.glow === "string" ? theme.glow : "#ffffff");
    glowOnRef.current = glowOn;
    glowSizeRef.current = glowSize;
    glowSpeedRef.current = glowSpeed;
    animsRef.current = animsOn;
    root.classList.toggle("no-anim", !animsOn);
  }, [theme, glowOn, glowSize, glowSpeed, animsOn ]);

  async function persistTheme(next: Record<string, string>): Promise<void> {
    try {
      const settings = await getLauncherApi().updateSettings({ theme: next });
      setBootstrap((current) => current ? { ...current, settings } : current);
      setSettingsDraft((current) => current ? { ...current, theme: next } : current);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to save theme", "Не удалось сохранить тему"));
    }
  }

  function scheduleThemeSave(next: Record<string, string>): void {
    if (themeSaveTimer.current !== null) window.clearTimeout(themeSaveTimer.current);
    themeSaveTimer.current = window.setTimeout(() => {
      themeSaveTimer.current = null;
      void persistTheme(next);
    }, 350);
  }

  function setToken(id: ThemeTokenId, value: string): void {
    const next = { ...theme, [id]: value };
    setTheme(next);
    scheduleThemeSave(next);
  }

  function applyPreset(id: string): void {
    const found = THEME_PRESETS.find((item) => item.id === id);
    if (!found) return;
    const next = { ...found.values };
    setTheme(next);
    scheduleThemeSave(next);
    setStatus(t(`Theme: ${found.label}`, `Тема: ${found.label}`));
  }

  function savePrefs(next: { glowEnabled: boolean; glowSize: number; glowSpeed: number; animationsEnabled: boolean }): void {
    if (prefsSaveTimer.current !== null) window.clearTimeout(prefsSaveTimer.current);
    const snapshot = { ...next };
    prefsSaveTimer.current = window.setTimeout(() => {
      prefsSaveTimer.current = null;
      void getLauncherApi().updateSettings(snapshot).then((settings) => {
        setBootstrap((current) => current ? { ...current, settings } : current);
        setSettingsDraft((current) => current ? { ...current, ...snapshot } : current);
      }).catch((error) => setStatus(error instanceof Error ? error.message : t("Failed to save", "Не удалось сохранить")));
    }, 350);
  }

  function setGlowEnabled(value: boolean): void {
    setGlowOn(value);
    savePrefs({ glowEnabled: value, glowSize, glowSpeed, animationsEnabled: animsOn });
  }

  function setGlowSizeValue(value: number): void {
    setGlowSize(value);
    savePrefs({ glowEnabled: glowOn, glowSize: value, glowSpeed, animationsEnabled: animsOn });
  }

  function setGlowSpeedValue(value: number): void {
    setGlowSpeed(value);
    savePrefs({ glowEnabled: glowOn, glowSize, glowSpeed: value, animationsEnabled: animsOn });
  }

  function setAnimsEnabled(value: boolean): void {
    setAnimsOn(value);
    savePrefs({ glowEnabled: glowOn, glowSize, glowSpeed, animationsEnabled: value });
  }

  useEffect(() => {
    const graceTimers = new WeakMap<HTMLButtonElement, number>();
    const cycleStarts = new WeakMap<HTMLButtonElement, number>();

    function findButton(event: Event): HTMLButtonElement | null {
      const target = event.target as Element | null;
      return (target?.closest?.("button") as HTMLButtonElement | null) ?? null;
    }

    function onMouseOver(event: Event): void {
      const button = findButton(event);
      if (!button || button.disabled) return;
      if (button.classList.contains("dropdown-option") || button.classList.contains("page-button") || button.classList.contains("path-open") || button.classList.contains("rail-button") || button.classList.contains("titlebar-button")) return;
      const pending = graceTimers.get(button);
      if (pending !== undefined) {
        window.clearTimeout(pending);
        graceTimers.delete(button);
        return;
      }
      if (button.classList.contains("sheen-live")) return;
      button.classList.add("sheen-live");
      cycleStarts.set(button, Date.now() + 1000);
    }

    function onMouseOut(event: Event): void {
      const button = findButton(event);
      if (!button || !button.classList.contains("sheen-live")) return;
      const related = (event as MouseEvent).relatedTarget as Node | null;
      if (related && button.contains(related)) return;
      const elapsed = (Date.now() - (cycleStarts.get(button) ?? 0)) % 4000;
      const sweepLeft = elapsed < 0 ? 0 : elapsed < 1600 ? 1600 - elapsed : 0;
      if (sweepLeft <= 0) {
        button.classList.remove("sheen-live");
        cycleStarts.delete(button);
        return;
      }
      const timer = window.setTimeout(() => {
        button.classList.remove("sheen-live");
        cycleStarts.delete(button);
        graceTimers.delete(button);
      }, sweepLeft);
      graceTimers.set(button, timer);
    }

    document.addEventListener("mouseover", onMouseOver);
    document.addEventListener("mouseout", onMouseOut);
    return () => {
      document.removeEventListener("mouseover", onMouseOver);
      document.removeEventListener("mouseout", onMouseOut);
    };
  }, []);

  useEffect(() => {
    const glow = document.createElement("div");
    glow.className = "cursor-glow";
    document.body.appendChild(glow);
    let current: Element | null = null;
    let cx = 0;
    let cy = 0;
    let gx = -300;
    let gy = -300;
    let raf = 0;

    function place(): void {
      if (!glowOnRef.current || !animsRef.current || !current || !document.contains(current)) {
        if (current) {
          current = null;
          glow.classList.remove("on");
        }
        raf = 0;
        return;
      }
      const rect = current.getBoundingClientRect();
      const follow = Math.min(1, 0.16 * (glowSpeedRef.current / 100));
      gx += (cx - gx) * follow;
      gy += (cy - gy) * follow;
      const radius = Math.max(rect.width, rect.height) * 0.75 * (glowSizeRef.current / 100);
      const [gr, gg, gb] = glowColor.current;
      glow.style.width = `${rect.width}px`;
      glow.style.height = `${rect.height}px`;
      glow.style.borderRadius = getComputedStyle(current).borderRadius;
      glow.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
      glow.style.background = `radial-gradient(circle ${radius.toFixed(0)}px at ${(gx - rect.left).toFixed(1)}px ${(gy - rect.top).toFixed(1)}px, rgba(${gr}, ${gg}, ${gb}, .22), rgba(${gr}, ${gg}, ${gb}, .07) 45%, transparent 70%)`;
      raf = requestAnimationFrame(place);
    }

    function onMove(event: MouseEvent): void {
      cx = event.clientX;
      cy = event.clientY;
      const target = (event.target as Element | null)?.closest?.('button, input, select, a, [role="button"]') ?? null;
      const next = target && glowOnRef.current && animsRef.current && !(target as HTMLButtonElement).disabled ? target : null;
      if (next !== current) {
        current = next;
        gx = cx;
        gy = cy;
        glow.classList.toggle("on", !!next);
      }
      if (next && !raf) raf = requestAnimationFrame(place);
    }

    function onLeave(): void {
      current = null;
      glow.classList.remove("on");
    }

    document.addEventListener("mousemove", onMove);
    document.documentElement.addEventListener("mouseleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("mousemove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      glow.remove();
    };
  }, []);

  return {
    theme,
    setTheme,
    previewToken,
    setPreviewToken,
    glowOn,
    setGlowOn,
    glowSize,
    setGlowSize,
    glowSpeed,
    setGlowSpeed,
    animsOn,
    setAnimsOn,
    animSpeed,
    setAnimSpeed,
    effects,
    setEffects,
    motionSaveTimer,
    pendingMotion,
    glowColor,
    glowOnRef,
    glowSizeRef,
    glowSpeedRef,
    animsRef,
    themeSaveTimer,
    prefsSaveTimer,
    saveMotion,
    setAnimSpeedValue,
    setEffectFlag,
    persistTheme,
    scheduleThemeSave,
    setToken,
    applyPreset,
    savePrefs,
    setGlowEnabled,
    setGlowSizeValue,
    setGlowSpeedValue,
    setAnimsEnabled
  };
}

export type VisualsState = ReturnType<typeof useVisuals>;
