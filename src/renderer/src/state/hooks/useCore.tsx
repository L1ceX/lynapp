import { Cpu, Folder, PackageSearch, ScrollText, SlidersHorizontal, Waypoints } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AfterLaunchAction, BootstrapState, LauncherSettings, UpdateStatus } from "@shared/types";
import type { AppSection, InstanceTab } from "../../constants";
import { getLauncherApi } from "../../lib/api";
import { formatRelative } from "../../lib/format";
import { motionMs } from "../../lib/motion";

export function useCore() {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);

  const bootstrapRef = useRef(bootstrap);

  bootstrapRef.current = bootstrap;

  const lang: "en" | "ru" = bootstrap?.settings.language === "ru" ? "ru" : "en";

  function t(en: string, ru: string): string {
    return lang === "ru" ? ru : en;
  }

  const tRef = useRef(t);

  tRef.current = t;

  const afterLaunchOptions: AfterLaunchAction[] = ["keep", "hide", "close"];

  function afterLaunchLabel(action: AfterLaunchAction): string {
    return action === "hide" ? t("Hide to tray", "Скрыть в трей") : action === "close" ? t("Close the launcher", "Закрыть лаунчер") : t("Keep open", "Оставить открытым");
  }

  async function setAfterLaunch(next: AfterLaunchAction): Promise<void> {
    try {
      const settings = await getLauncherApi().updateSettings({ afterLaunch: next });
      setBootstrap((current) => current ? { ...current, settings } : current);
      setSettingsDraft(settings);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to save", "Не удалось сохранить"));
    }
  }

  async function setSettingFlag(key: "discordPresence" | "discordHideInstance" | "betaUpdates", value: boolean): Promise<void> {
    try {
      const settings = await getLauncherApi().updateSettings({ [key]: value });
      setBootstrap((current) => current ? { ...current, settings } : current);
      setSettingsDraft(settings);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to save", "Не удалось сохранить"));
    }
  }

  async function setLanguage(next: "en" | "ru"): Promise<void> {
    try {
      const settings = await getLauncherApi().updateSettings({ language: next });
      setBootstrap((current) => current ? { ...current, settings } : current);
      setSettingsDraft(settings);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to save language", "Не удалось сохранить язык"));
    }
  }

  const [section, setSection] = useState<AppSection>("home");

  const [instanceTab, setInstanceTab] = useState<InstanceTab>("general");

  const [tabExiting, setTabExiting] = useState(false);

  const [sectionExiting, setSectionExiting] = useState(false);

  const [contentExiting, setContentExiting] = useState(false);

  const tabTimer = useRef<number | null>(null);

  const sectionTimer = useRef<number | null>(null);

  const contentTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (tabTimer.current !== null) window.clearTimeout(tabTimer.current);
    if (sectionTimer.current !== null) window.clearTimeout(sectionTimer.current);
    if (contentTimer.current !== null) window.clearTimeout(contentTimer.current);
  }, []);

  const [maximized, setMaximized] = useState(false);

  const [update, setUpdate] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    getLauncherApi().isMaximized().then(setMaximized).catch(() => undefined);
    return getLauncherApi().onMaximizedChange(setMaximized);
  }, []);

  useEffect(() => {
    return getLauncherApi().onUpdateStatus((status) => {
      if (status.kind === "error") {
        setUpdate(null);
        return;
      }
      setUpdate(status);
    });
  }, []);

  async function downloadUpdate(): Promise<void> {
    setUpdate((current) => ({ kind: "downloading", percent: 0, version: current?.version }));
    try {
      await getLauncherApi().downloadUpdate();
    } catch (error) {
      setUpdate(null);
      setStatus(error instanceof Error ? error.message : t("Update download failed", "Не удалось скачать обновление"));
    }
  }

  async function installUpdate(): Promise<void> {
    try {
      await getLauncherApi().installUpdate();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Update install failed", "Не удалось установить обновление"));
    }
  }

  function switchTab(next: InstanceTab): void {
    if (tabTimer.current !== null) {
      window.clearTimeout(tabTimer.current);
      tabTimer.current = null;
    }
    if (next === instanceTab) {
      setTabExiting(false);
      return;
    }
    setTabExiting(true);
    tabTimer.current = window.setTimeout(() => {
      setInstanceTab(next);
      setTabExiting(false);
      tabTimer.current = null;
    }, motionMs(225));
  }

  function switchSection(next: AppSection): void {
    if (sectionTimer.current !== null) {
      window.clearTimeout(sectionTimer.current);
      sectionTimer.current = null;
    }
    if (next === section) {
      setSectionExiting(false);
      return;
    }
    setSectionExiting(true);
    sectionTimer.current = window.setTimeout(() => {
      setSection(next);
      setSectionExiting(false);
      sectionTimer.current = null;
    }, motionMs(225));
  }

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedIdRef = useRef(selectedId);

  selectedIdRef.current = selectedId;

  const [settingsDraft, setSettingsDraft] = useState<LauncherSettings | null>(null);

  const sectionRef = useRef(section);

  sectionRef.current = section;

  const activeAccount = bootstrap?.accounts.find((item) => item.id === bootstrap.activeAccountId) ?? bootstrap?.accounts[0] ?? null;

  const [status, setStatus] = useState("Loading launcher state");

  const [busy, setBusy] = useState(false);

  const [launchingIds, setLaunchingIds] = useState<string[]>([]);

  const [instanceStatus, setInstanceStatus] = useState<Record<string, string>>({});

  function assertNotLaunching(): boolean {
    if (selected && launchingIds.includes(selected.id)) {
      setStatus(t(`Cancel the launch of ${selected.name} first`, `Сначала отмените запуск ${selected.name}`));
      return false;
    }
    return true;
  }

  const refresh = useCallback(async (options?: { setReadyStatus?: boolean }) => {
    const next = await getLauncherApi().getBootstrap();
    setBootstrap(next);
    setSettingsDraft(next.settings);
    setSelectedId((current) => current ?? next.activeInstanceId ?? next.instances[0]?.id ?? null);
    if (options?.setReadyStatus !== false) setStatus("");
  }, []);

  useEffect(() => {
    refresh().catch((error) => setStatus(error instanceof Error ? error.message : t("Failed to load launcher", "Не удалось загрузить лаунчер")));
  }, [refresh]);

  const selected = useMemo(
    () => bootstrap?.instances.find((instance) => instance.id === selectedId) ?? null,
    [bootstrap?.instances, selectedId]
  );

  const isLaunching = launchingIds.length > 0 && selected !== null && launchingIds.includes(selected.id);

  const headerStatus = selected !== null ? instanceStatus[selected.id] ?? "" : "";

  function say(message: string): void {
    if (selected) {
      setInstanceStatus((current) => ({ ...current, [selected.id]: message }));
    }
  }

  const totalMods = useMemo(() => (bootstrap?.instances ?? []).reduce((sum, item) => sum + (item.mods?.length ?? 0), 0), [bootstrap?.instances]);

  const lastActivity = useMemo(() => {
    const stamps = (bootstrap?.instances ?? []).map((item) => item.updatedAt ?? "").filter(Boolean);
    if (!stamps.length) return "";
    return formatRelative(stamps.sort().reverse()[0], lang);
  }, [bootstrap?.instances, lang]);

  async function saveSettings(): Promise<void> {
    if (!settingsDraft) return;
    const settings = await getLauncherApi().updateSettings({
      maxMemoryMb: settingsDraft.maxMemoryMb,
      extraJvmArgs: settingsDraft.extraJvmArgs
    });
    setBootstrap((current) => current ? { ...current, settings } : current);
    setSettingsDraft(settings);
    setStatus(t("Settings saved", "Настройки сохранены"));
  }

  const instanceTabs = [
    { id: "general" as const, label: t("General", "Основные"), icon: SlidersHorizontal },
    { id: "versions" as const, label: t("Versions", "Версии"), icon: Waypoints },
    { id: "content" as const, label: t("Content", "Контент"), icon: PackageSearch },
    { id: "files" as const, label: t("Files", "Файлы"), icon: Folder },
    { id: "runtime" as const, label: "RAM", icon: Cpu },
    { id: "logs" as const, label: t("Logs", "Журнал"), icon: ScrollText }
  ];

  return {
    bootstrap,
    setBootstrap,
    bootstrapRef,
    lang,
    t,
    tRef,
    afterLaunchOptions,
    afterLaunchLabel,
    setAfterLaunch,
    setSettingFlag,
    setLanguage,
    section,
    setSection,
    instanceTab,
    setInstanceTab,
    tabExiting,
    setTabExiting,
    sectionExiting,
    setSectionExiting,
    contentExiting,
    setContentExiting,
    tabTimer,
    sectionTimer,
    contentTimer,
    maximized,
    setMaximized,
    update,
    setUpdate,
    downloadUpdate,
    installUpdate,
    switchTab,
    switchSection,
    selectedId,
    setSelectedId,
    selectedIdRef,
    settingsDraft,
    setSettingsDraft,
    sectionRef,
    activeAccount,
    status,
    setStatus,
    busy,
    setBusy,
    launchingIds,
    setLaunchingIds,
    instanceStatus,
    setInstanceStatus,
    assertNotLaunching,
    refresh,
    selected,
    isLaunching,
    headerStatus,
    say,
    totalMods,
    lastActivity,
    saveSettings,
    instanceTabs
  };
}

export type CoreState = ReturnType<typeof useCore>;
