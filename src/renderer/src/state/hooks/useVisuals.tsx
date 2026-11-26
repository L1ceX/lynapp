import { useCallback, useEffect, useRef, useState } from "react";
import { hexToRgb, resolveTheme, THEME_DEFAULTS, THEME_PRESETS, THEME_TOKENS, type ThemeTokenId } from "@shared/theme";
import { EFFECTS_DEFAULTS, type CustomFontInfo, type EffectsSettings, type GoogleFontInfo, type LauncherSettings } from "@shared/types";
import { BUILTIN_FONTS, DEFAULT_FONT_STACK, effectGroups } from "../../constants";
import { getLauncherApi } from "../../lib/api";
import { cleanIpcError } from "../../lib/format";
import { setMotionRate } from "../../lib/motion";
import type { CoreState } from "./useCore";

function escapeCssFontName(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function encodeGoogleFamily(family: string): string {
  return encodeURIComponent(family).replace(/%20/g, "+");
}

function buildGoogleFontSpec(family: string, weights?: number[]): string {
  const encoded = encodeGoogleFamily(family);
  if (!weights || weights.length === 0) return `family=${encoded}`;
  const wanted = [400, 500, 600, 700].filter((w) => weights.includes(w));
  if (wanted.length > 1) return `family=${encoded}:wght@${wanted.join(";")}`;
  if (wanted.length === 1) return wanted[0] === 400 ? `family=${encoded}` : `family=${encoded}:wght@${wanted[0]}`;
  return `family=${encoded}:wght@${weights[0]}`;
}

function buildGooglePreviewSpec(font: GoogleFontInfo): string {
  const encoded = encodeGoogleFamily(font.family);
  if (font.weights.includes(400) || font.weights.length === 0) return `family=${encoded}`;
  return `family=${encoded}:wght@${font.weights[0]}`;
}

function customFontCssName(fileName: string): string {
  let hash = 2166136261;
  for (let i = 0; i < fileName.length; i += 1) {
    hash ^= fileName.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `lynapp-font-${(hash >>> 0).toString(36)}`;
}

function srgbLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

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

  const [fontFamily, setFontFamily] = useState<string>("");

  const [customFonts, setCustomFonts] = useState<CustomFontInfo[]>([]);

  const [systemFonts, setSystemFonts] = useState<string[]>([]);

  const [googleFonts, setGoogleFonts] = useState<GoogleFontInfo[]>([]);

  const [googleFontsLoading, setGoogleFontsLoading] = useState(false);

  const [customFontCssMap, setCustomFontCssMap] = useState<Record<string, string>>({});

  const [fontsBusy, setFontsBusy] = useState(false);

  const loadedFacesRef = useRef<Map<string, { cssName: string; dataUrl: string; face: FontFace }>>(new Map());

  const previewGoogleSetRef = useRef<Set<string>>(new Set());

  const fontInFlight = useRef(0);

  const motionSaveTimer = useRef<number | null>(null);

  const pendingMotion = useRef<Pick<Partial<LauncherSettings>, "animationSpeed" | "effects">>({});

  const glowColor = useRef<[number, number, number]>([255, 255, 255]);

  const glowOnRef = useRef(true);

  const glowSizeRef = useRef(100);

  const glowSpeedRef = useRef(100);

  const animsRef = useRef(true);

  const themeSaveTimer = useRef<number | null>(null);

  const prefsSaveTimer = useRef<number | null>(null);

  const themeInFlight = useRef(0);

  const prefsInFlight = useRef(0);

  const motionInFlight = useRef(0);

  const syncedRef = useRef<{ theme: string; prefs: string; motion: string; font: string } | null>(null);

  useEffect(() => () => {
    if (themeSaveTimer.current !== null) window.clearTimeout(themeSaveTimer.current);
    if (prefsSaveTimer.current !== null) window.clearTimeout(prefsSaveTimer.current);
    if (motionSaveTimer.current !== null) window.clearTimeout(motionSaveTimer.current);
  }, []);

  const syncFontFaces = useCallback(async (list: CustomFontInfo[]): Promise<Record<string, string>> => {
    const loaded = loadedFacesRef.current;
    const activeIds = new Set(list.map((item) => item.id));
    for (const [id, entry] of Array.from(loaded.entries())) {
      if (!activeIds.has(id)) {
        document.fonts.delete(entry.face);
        loaded.delete(id);
      }
    }
    const nextMap: Record<string, string> = {};
    await Promise.all(list.map(async (item) => {
      const cssName = customFontCssName(item.fileName);
      const existing = loaded.get(item.id);
      if (existing && existing.dataUrl === item.dataUrl) {
        nextMap[item.id] = existing.cssName;
        return;
      }
      if (existing) {
        document.fonts.delete(existing.face);
        loaded.delete(item.id);
      }
      try {
        const face = new FontFace(cssName, `url("${item.dataUrl}")`);
        const ready = await face.load();
        document.fonts.add(ready);
        loaded.set(item.id, { cssName, dataUrl: item.dataUrl, face: ready });
        nextMap[item.id] = cssName;
      } catch {
      }
    }));
    setCustomFontCssMap(nextMap);
    return nextMap;
  }, []);

  useEffect(() => {
    let alive = true;
    const api = getLauncherApi();
    void api.listCustomFonts().then(async (list) => {
      if (!alive) return;
      setCustomFonts(list);
      await syncFontFaces(list);
    }).catch(() => {});
    void api.listSystemFonts().then((list) => {
      if (alive) setSystemFonts(list);
    }).catch(() => {});
    setGoogleFontsLoading(true);
    void api.listGoogleFonts().then((list) => {
      if (alive) setGoogleFonts(list);
    }).catch(() => {}).finally(() => {
      if (alive) setGoogleFontsLoading(false);
    });
    return () => {
      alive = false;
      for (const entry of loadedFacesRef.current.values()) {
        document.fonts.delete(entry.face);
      }
      loadedFacesRef.current.clear();
    };
  }, [syncFontFaces]);

  const loadGoogleFontPreviews = useCallback((fonts: GoogleFontInfo[]): void => {
    const missing = fonts.filter((item) => !previewGoogleSetRef.current.has(item.family));
    if (missing.length === 0) return;
    const previewChars = encodeURIComponent("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -.");
    const activeEl = document.getElementById("lynapp-active-google-font");
    for (let i = 0; i < missing.length; i += 16) {
      const chunk = missing.slice(i, i + 16);
      chunk.forEach((item) => previewGoogleSetRef.current.add(item.family));
      const spec = chunk.map(buildGooglePreviewSpec).join("&");
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.dataset.lynappGfontPreview = "1";
      link.href = `https://fonts.googleapis.com/css2?${spec}&text=${previewChars}&display=swap`;
      if (activeEl && activeEl.parentNode === document.head) {
        document.head.insertBefore(link, activeEl);
      } else {
        document.head.appendChild(link);
      }
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const existingActiveLink = document.getElementById("lynapp-active-google-font") as HTMLLinkElement | null;
    if (!fontFamily) {
      root.style.removeProperty("--t-font");
      existingActiveLink?.remove();
      return;
    }
    const preset = BUILTIN_FONTS.find((item) => item.id === fontFamily);
    if (preset) {
      root.style.setProperty("--t-font", preset.stack);
      existingActiveLink?.remove();
      return;
    }
    if (fontFamily.startsWith("system:")) {
      const family = fontFamily.slice(7);
      if (family) {
        root.style.setProperty("--t-font", `"${escapeCssFontName(family)}", ${DEFAULT_FONT_STACK}`);
      } else {
        root.style.removeProperty("--t-font");
      }
      existingActiveLink?.remove();
      return;
    }
    if (fontFamily.startsWith("google:")) {
      const family = fontFamily.slice(7);
      if (!family) {
        root.style.removeProperty("--t-font");
        existingActiveLink?.remove();
        return;
      }
      const meta = googleFonts.find((item) => item.family === family);
      const href = `https://fonts.googleapis.com/css2?${buildGoogleFontSpec(family, meta?.weights)}&display=swap`;
      let link = existingActiveLink;
      if (!link) {
        link = document.createElement("link");
        link.id = "lynapp-active-google-font";
        link.rel = "stylesheet";
        document.head.appendChild(link);
      } else {
        document.head.appendChild(link);
      }
      if (link.href !== href) link.href = href;
      root.style.setProperty("--t-font", `"${escapeCssFontName(family)}", ${DEFAULT_FONT_STACK}`);
      return;
    }
    existingActiveLink?.remove();
    const customCss = customFontCssMap[fontFamily];
    if (customCss) {
      root.style.setProperty("--t-font", `"${customCss}", ${DEFAULT_FONT_STACK}`);
      return;
    }
    root.style.removeProperty("--t-font");
  }, [fontFamily, customFontCssMap, googleFonts]);

  useEffect(() => {
    if (!bootstrap) return;
    const resolvedTheme = resolveTheme(bootstrap.settings.theme);
    const themeSig = JSON.stringify(resolvedTheme);
    const prefsVal = {
      glowEnabled: bootstrap.settings.glowEnabled ?? true,
      glowSize: bootstrap.settings.glowSize ?? 100,
      glowSpeed: Math.min(bootstrap.settings.glowSpeed ?? 100, 150),
      animationsEnabled: bootstrap.settings.animationsEnabled ?? true
    };
    const prefsSig = JSON.stringify(prefsVal);
    const motionVal = {
      animationSpeed: Math.min(200, Math.max(25, bootstrap.settings.animationSpeed ?? 100)),
      effects: { ...EFFECTS_DEFAULTS, ...(bootstrap.settings.effects ?? {}) }
    };
    const motionSig = JSON.stringify(motionVal);
    const fontVal = bootstrap.settings.fontFamily ?? "";
    const prev = syncedRef.current;
    if (themeSaveTimer.current === null && themeInFlight.current === 0 && themeSig !== prev?.theme) {
      setTheme(resolvedTheme);
    }
    if (prefsSaveTimer.current === null && prefsInFlight.current === 0 && prefsSig !== prev?.prefs) {
      setGlowOn(prefsVal.glowEnabled);
      setGlowSize(prefsVal.glowSize);
      setGlowSpeed(prefsVal.glowSpeed);
      setAnimsOn(prefsVal.animationsEnabled);
    }
    if (motionSaveTimer.current === null && motionInFlight.current === 0 && motionSig !== prev?.motion) {
      setAnimSpeed(motionVal.animationSpeed);
      setEffects(motionVal.effects);
    }
    if (fontInFlight.current === 0 && fontVal !== prev?.font) {
      setFontFamily(fontVal);
    }
    syncedRef.current = {
      theme: themeSaveTimer.current === null && themeInFlight.current === 0 ? themeSig : prev?.theme ?? themeSig,
      prefs: prefsSaveTimer.current === null && prefsInFlight.current === 0 ? prefsSig : prev?.prefs ?? prefsSig,
      motion: motionSaveTimer.current === null && motionInFlight.current === 0 ? motionSig : prev?.motion ?? motionSig,
      font: fontInFlight.current === 0 ? fontVal : prev?.font ?? fontVal
    };
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
    document.documentElement.style.setProperty("--vt-duration", `${Math.round(420 / rate)}ms`);
    const adjust = (animation: Animation): void => {
      if (animation.playbackRate !== rate) animation.playbackRate = rate;
    };
    const syncAll = (): void => {
      for (const animation of document.getAnimations()) adjust(animation);
    };
    syncAll();
    let pendingRaf = 0;
    const scheduleSync = (): void => {
      if (pendingRaf) return;
      pendingRaf = requestAnimationFrame(() => {
        pendingRaf = 0;
        syncAll();
      });
    };
    const onStart = (event: Event): void => {
      const target = event.target;
      if (target instanceof Element) target.getAnimations().forEach(adjust);
      scheduleSync();
    };
    document.addEventListener("animationstart", onStart, true);
    document.addEventListener("transitionrun", onStart, true);
    document.addEventListener("transitionstart", onStart, true);
    return () => {
      if (pendingRaf) cancelAnimationFrame(pendingRaf);
      document.removeEventListener("animationstart", onStart, true);
      document.removeEventListener("transitionrun", onStart, true);
      document.removeEventListener("transitionstart", onStart, true);
    };
  }, [animSpeed]);

  function saveMotion(change: Pick<Partial<LauncherSettings>, "animationSpeed" | "effects">): void {
    if (motionSaveTimer.current !== null) window.clearTimeout(motionSaveTimer.current);
    pendingMotion.current = { ...pendingMotion.current, ...change };
    motionSaveTimer.current = window.setTimeout(() => {
      motionSaveTimer.current = null;
      const patch = pendingMotion.current;
      pendingMotion.current = {};
      motionInFlight.current += 1;
      void getLauncherApi().updateSettings(patch).then((settings) => {
        if (syncedRef.current) {
          syncedRef.current.motion = JSON.stringify({
            animationSpeed: Math.min(200, Math.max(25, settings.animationSpeed ?? 100)),
            effects: { ...EFFECTS_DEFAULTS, ...(settings.effects ?? {}) }
          });
        }
        setBootstrap((current) => current ? { ...current, settings } : current);
        setSettingsDraft((current) => current ? { ...current, ...patch } : current);
      }).catch((error) => setStatus(cleanIpcError(error, t("Failed to save", "Не удалось сохранить")))).finally(() => {
        motionInFlight.current = Math.max(0, motionInFlight.current - 1);
      });
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
    root.classList.toggle("theme-light", srgbLuminance(theme.background ?? "#0d1118") > 0.45);
    root.style.setProperty("--t-on-primary", srgbLuminance(theme.primary ?? "#3b76e8") > 0.36 ? "#0e1624" : "#ffffff");
    root.style.setProperty("--t-on-accent", srgbLuminance(theme.accent ?? "#55a4ed") > 0.36 ? "#071525" : "#ffffff");
    glowColor.current = hexToRgb(typeof theme.glow === "string" ? theme.glow : "#ffffff");
    glowOnRef.current = glowOn;
    glowSizeRef.current = glowSize;
    glowSpeedRef.current = glowSpeed;
    animsRef.current = animsOn;
    root.classList.toggle("no-anim", !animsOn);
  }, [theme, glowOn, glowSize, glowSpeed, animsOn]);

  async function persistTheme(next: Record<string, string>): Promise<void> {
    themeInFlight.current += 1;
    try {
      const settings = await getLauncherApi().updateSettings({ theme: next });
      if (syncedRef.current) {
        syncedRef.current.theme = JSON.stringify(resolveTheme(settings.theme));
      }
      setBootstrap((current) => current ? { ...current, settings } : current);
      setSettingsDraft((current) => current ? { ...current, theme: next } : current);
    } catch (error) {
      setStatus(cleanIpcError(error, t("Failed to save theme", "Не удалось сохранить тему")));
    } finally {
      themeInFlight.current = Math.max(0, themeInFlight.current - 1);
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
      prefsInFlight.current += 1;
      void getLauncherApi().updateSettings(snapshot).then((settings) => {
        if (syncedRef.current) {
          syncedRef.current.prefs = JSON.stringify({
            glowEnabled: settings.glowEnabled ?? true,
            glowSize: settings.glowSize ?? 100,
            glowSpeed: Math.min(settings.glowSpeed ?? 100, 150),
            animationsEnabled: settings.animationsEnabled ?? true
          });
        }
        setBootstrap((current) => current ? { ...current, settings } : current);
        setSettingsDraft((current) => current ? { ...current, ...snapshot } : current);
      }).catch((error) => setStatus(cleanIpcError(error, t("Failed to save", "Не удалось сохранить")))).finally(() => {
        prefsInFlight.current = Math.max(0, prefsInFlight.current - 1);
      });
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

  async function setFontFamilyValue(id: string, announce = true): Promise<void> {
    setFontFamily(id);
    fontInFlight.current += 1;
    try {
      const settings = await getLauncherApi().updateSettings({ fontFamily: id });
      if (syncedRef.current) syncedRef.current.font = settings.fontFamily ?? "";
      setBootstrap((current) => current ? { ...current, settings } : current);
      setSettingsDraft((current) => current ? { ...current, fontFamily: id } : current);
      if (announce) {
        const builtin = BUILTIN_FONTS.find((item) => item.id === id);
        const custom = customFonts.find((item) => item.id === id);
        const label = builtin
          ? t(builtin.label, builtin.labelRu)
          : custom
            ? custom.name
            : id.startsWith("system:")
              ? id.slice(7)
              : id.startsWith("google:")
                ? id.slice(7)
                : id;
        setStatus(t(`Font: ${label}`, `Шрифт: ${label}`));
      }
    } catch (error) {
      setStatus(cleanIpcError(error, t("Failed to save font", "Не удалось сохранить шрифт")));
    } finally {
      fontInFlight.current = Math.max(0, fontInFlight.current - 1);
    }
  }

  async function addCustomFont(): Promise<void> {
    setFontsBusy(true);
    try {
      const result = await getLauncherApi().addCustomFont();
      if (!result) return;
      setCustomFonts(result.fonts);
      const map = await syncFontFaces(result.fonts);
      if (result.added && map[result.added.id]) {
        await setFontFamilyValue(result.added.id, false);
        setStatus(t(`Font added: ${result.added.name}`, `Шрифт добавлен: ${result.added.name}`));
      } else if (result.added) {
        setStatus(t("Font file could not be loaded", "Не удалось загрузить файл шрифта"));
      }
    } catch (error) {
      setStatus(cleanIpcError(error, t("Failed to add font", "Не удалось добавить шрифт")));
    } finally {
      setFontsBusy(false);
    }
  }

  async function removeCustomFont(fileName: string): Promise<void> {
    setFontsBusy(true);
    try {
      const fonts = await getLauncherApi().removeCustomFont(fileName);
      setCustomFonts(fonts);
      await syncFontFaces(fonts);
      if (fontFamily === `custom:${fileName}`) {
        await setFontFamilyValue("", false);
      }
      setStatus(t("Font removed", "Шрифт удалён"));
    } catch (error) {
      setStatus(cleanIpcError(error, t("Failed to remove font", "Не удалось удалить шрифт")));
    } finally {
      setFontsBusy(false);
    }
  }

  async function refreshCustomFonts(): Promise<void> {
    setFontsBusy(true);
    try {
      const api = getLauncherApi();
      const [fonts, sys] = await Promise.all([api.listCustomFonts(), api.listSystemFonts()]);
      setCustomFonts(fonts);
      setSystemFonts(sys);
      await syncFontFaces(fonts);
      setStatus(t(`Fonts refreshed (${sys.length} system, ${fonts.length} custom)`, `Шрифты обновлены (системных: ${sys.length}, своих: ${fonts.length})`));
    } catch (error) {
      setStatus(cleanIpcError(error, t("Failed to scan fonts", "Не удалось обновить список шрифтов")));
    } finally {
      setFontsBusy(false);
    }
  }

  async function openFontsFolder(): Promise<void> {
    try {
      await getLauncherApi().openFontsFolder();
    } catch (error) {
      setStatus(cleanIpcError(error, t("Failed to open fonts folder", "Не удалось открыть папку шрифтов")));
    }
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
      if (button.classList.contains("dropdown-option") || button.classList.contains("page-button") || button.classList.contains("path-open") || button.classList.contains("rail-button") || button.classList.contains("titlebar-button") || button.classList.contains("font-custom-pick")) return;
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
    setAnimsEnabled,
    fontFamily,
    customFonts,
    systemFonts,
    googleFonts,
    googleFontsLoading,
    customFontCssMap,
    fontsBusy,
    loadGoogleFontPreviews,
    setFontFamilyValue,
    addCustomFont,
    removeCustomFont,
    refreshCustomFonts,
    openFontsFolder
  };
}

export type VisualsState = ReturnType<typeof useVisuals>;
