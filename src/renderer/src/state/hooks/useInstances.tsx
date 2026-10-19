import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JavaInstallation, LauncherInstance } from "@shared/types";
import { getLauncherApi } from "../../lib/api";
import { detectCrash } from "../../lib/crash";
import { transferLabel } from "../../lib/format";
import type { CoreState } from "./useCore";

export function useInstances(deps: Pick<CoreState, "assertNotLaunching" | "busy" | "instanceTab" | "isLaunching" | "lang" | "launchingIds" | "refresh" | "say" | "section" | "selected" | "selectedId" | "setBootstrap" | "setBusy" | "setInstanceStatus" | "setLaunchingIds" | "setSelectedId" | "setSettingsDraft" | "setStatus" | "switchSection" | "t" | "tRef" | "update">) {
  const { assertNotLaunching, busy, instanceTab, isLaunching, lang, launchingIds, refresh, say, section, selected, selectedId, setBootstrap, setBusy, setInstanceStatus, setLaunchingIds, setSelectedId, setSettingsDraft, setStatus, switchSection, t, tRef, update } = deps;
  const [runningIds, setRunningIds] = useState<string[]>([]);

  const [instanceLogs, setInstanceLogs] = useState<{ log: string; plan: string; hasLog: boolean; crash: { file: string; description: string } | null } | null>(null);

  const [logsFollow, setLogsFollow] = useState(true);

  const logPreRef = useRef<HTMLPreElement | null>(null);

  const [confirmDelete, setConfirmDelete] = useState(false);

  const [modpackTarget, setModpackTarget] = useState<{ resultId: string; title: string; filePath: string; instanceId: string; instanceName: string; instanceVersion: string; instanceLoader: string; info: { totalFiles: number; packName: string; packGameVersion: string; packLoader: string } } | null>(null);

  const [exportModal, setExportModal] = useState<{ entries: Array<{ name: string; isDir: boolean; size: number; modified: string | null }>; checked: Record<string, boolean> } | null>(null);

  const [mrpackProgress, setMrpackProgress] = useState<Record<string, { done: number; total: number }>>({});

  useEffect(() => {
    if (!confirmDelete) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmDelete(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmDelete]);

  useEffect(() => {
    return getLauncherApi().onMrpackProgress((update) => {
      setMrpackProgress((current) => ({ ...current, [update.instanceId]: { done: update.done, total: update.total } }));
    });
  }, []);

  async function importMrpackByPath(filePath: string): Promise<void> {
    if (!/\.mrpack$/i.test(filePath)) {
      setStatus(t("Only .mrpack modpack files can be dropped here", "Сюда можно перетаскивать только файлы .mrpack"));
      return;
    }
    setBusy(true);
    const short = filePath.split(/[\\/]/).pop() ?? filePath;
    setStatus(t(`Importing ${short}...`, `Импорт: ${short}...`));
    let startedId: string | null = null;
    try {
      const started = await getLauncherApi().importMrpackStart(filePath);
      startedId = started.instance.id;
      await refresh({ setReadyStatus: false });
      setSelectedId(started.instance.id);
      switchSection("instances");
      setMrpackProgress((current) => ({ ...current, [started.instance.id]: { done: 0, total: started.totalFiles } }));
      setInstanceStatus((current) => ({ ...current, [started.instance.id]: t(`Importing ${started.instance.name}... 0%`, `Импорт: ${started.instance.name}... 0%`) }));
      setStatus(t(t(`Importing ${started.instance.name}... 0%`, `Импорт: ${started.instance.name}... 0%`), `Импорт: ${started.instance.name}... 0%`));
      try {
        await getLauncherApi().importMrpackFiles(started.instance.id);
        await refresh({ setReadyStatus: false });
        setInstanceStatus((current) => ({ ...current, [started.instance.id]: t(`Imported ${started.instance.name}`, `Импортировано: ${started.instance.name}`) }));
        setStatus(t(`Imported ${started.instance.name}`, `Импортировано: ${started.instance.name}`));
      } finally {
        setMrpackProgress((current) => {
          const next = { ...current };
          delete next[started.instance.id];
          return next;
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t("Modpack import failed", "Не удалось импортировать модпак");
      if (startedId) {
        const sid: string = startedId;
        setInstanceStatus((current) => ({ ...current, [sid]: message }));
        const fresh = await getLauncherApi().getBootstrap().catch(() => null);
        if (fresh) {
          setBootstrap(fresh);
          setSettingsDraft(fresh.settings);
          if (!fresh.instances.some((item) => item.id === sid)) {
            setSelectedId(fresh.activeInstanceId ?? fresh.instances[0]?.id ?? null);
          }
        }
      }
      setStatus(message);
    } finally {
      setBusy(false);
    }
  }

  const importMrpackRef = useRef(importMrpackByPath);

  importMrpackRef.current = importMrpackByPath;

  const [downloadingIds, setDownloadingIds] = useState<string[]>([]);

  const [transferPct, setTransferPct] = useState<Record<string, { received: number; total: number | null }>>({});

  useEffect(() => {
    return getLauncherApi().onDownloadProgress((update) => {
      if (update.key.startsWith("launch:")) {
        const id = update.key.slice(7);
        if (update.phase === "java") {
          const label = transferLabel({ received: update.received, total: update.total });
          setInstanceStatus((current) => ({ ...current, [id]: tRef.current(`Downloading Java ${label ?? "..."}`, `Загрузка Java ${label ?? "..."}`) }));
        } else if (update.phase === "loader") {
          setInstanceStatus((current) => ({ ...current, [id]: tRef.current("Installing loader...", "Установка загрузчика...") }));
        } else {
          const label = update.phase === "assets" ? tRef.current("Preparing assets", "Подготовка ассетов") : tRef.current("Preparing libraries", "Подготовка библиотек");
          setInstanceStatus((current) => ({ ...current, [id]: `${label} ${update.doneFiles ?? 0}/${update.totalFiles ?? 0}` }));
        }
        return;
      }
      setTransferPct((current) => ({ ...current, [update.key]: { received: update.received, total: update.total } }));
    });
  }, []);

  const [javaInstalls, setJavaInstalls] = useState<JavaInstallation[] | null>(null);

  const [javaBusy, setJavaBusy] = useState<number | null>(null);

  const refreshRunning = useCallback(async () => {
    try {
      setRunningIds(await getLauncherApi().getRunningInstances());
    } catch {
    }
  }, []);

  useEffect(() => {
    void refreshRunning();
    const timer = window.setInterval(() => {
      void refreshRunning();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [refreshRunning]);

  const refreshJava = useCallback(async () => {
    try {
      setJavaInstalls(await getLauncherApi().getJavaInstallations());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : tRef.current("Failed to load Java installations", "Не удалось загрузить установленные версии Java"));
    }
  }, []);

  useEffect(() => {
    if (section === "launcher") void refreshJava();
  }, [section, refreshJava]);

  async function javaAction(major: number, action: "install" | "detect" | "browse"): Promise<void> {
    setJavaBusy(major);
    setStatus(action === "install" ? t(`Downloading Java ${major}...`, `Загрузка Java ${major}...`) : t(`Java ${major}: working...`, `Java ${major}: выполняется операция...`));
    try {
      const api = getLauncherApi();
      const updated = action === "install" ? await api.installJava(major) : action === "detect" ? await api.detectJava(major) : await api.browseJava(major);
      if (updated) {
        setJavaInstalls((current) => current ? current.map((item) => item.major === major ? updated : item) : current);
        setStatus(updated.message);
      } else {
        setStatus(t("Browse cancelled", "Операция отменена"));
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t(`Java ${major} action failed`, `Java ${major}: действие не выполнено`));
    } finally {
      setJavaBusy(null);
    }
  }

  const isSelectedRunning = selected !== null && runningIds.includes(selected.id);

  async function updateSelected(patch: Partial<LauncherInstance>): Promise<void> {
    if (!selected || !assertNotLaunching()) return;
    try {
      const updated = await getLauncherApi().updateInstance({ id: selected.id, patch });
      setBootstrap((current) => current ? { ...current, instances: current.instances.map((item) => item.id === updated.id ? updated : item) } : current);
      say(t(`Saved ${updated.name}`, `Сохранено: ${updated.name}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to save instance", "Не удалось сохранить инстанцию"));
    }
  }

  async function exportSelected(): Promise<void> {
    if (!selected || busy || !assertNotLaunching()) return;
    setBusy(true);
    try {
      const entries = await getLauncherApi().listExportEntries(selected.id);
      const defaults = new Set(["mods", "resourcepacks", "shaderpacks", "datapacks", "config", "defaultconfigs", "options.txt", "optionsof.txt", "optionsshaders.txt", "servers.dat"]);
      const checked: Record<string, boolean> = {};
      for (const entry of entries) {
        checked[entry.name] = defaults.has(entry.name);
      }
      setExportModal({ entries, checked });
    } catch (error) {
      say(error instanceof Error ? error.message : t(`Failed to export ${selected.name}`, `Не удалось экспортировать: ${selected.name}`));
    } finally {
      setBusy(false);
    }
  }

  async function confirmExport(): Promise<void> {
    if (!exportModal || !selected || busy) return;
    const include = exportModal.entries.filter((entry) => exportModal.checked[entry.name]).map((entry) => entry.name);
    setExportModal(null);
    setBusy(true);
    say(t(`Exporting ${selected.name}...`, `Экспорт: ${selected.name}...`));
    try {
      const filePath = await getLauncherApi().exportMrpack(selected.id, include);
      if (filePath) {
        say(t(`Exported ${selected.name}`, `Экспортировано: ${selected.name}`));
      } else {
        say(t("Export cancelled", "Экспорт отменён"));
      }
    } catch (error) {
      say(error instanceof Error ? error.message : t(`Failed to export ${selected.name}`, `Не удалось экспортировать: ${selected.name}`));
    } finally {
      setBusy(false);
    }
  }

  async function removeSelected(): Promise<void> {
    if (!selected || busy || !assertNotLaunching()) return;
    setBusy(true);
    try {
      await getLauncherApi().removeInstance(selected.id);
      setSelectedId(null);
      await refresh();
      setStatus(t(`Deleted ${selected.name} with all its files`, `Удалено: ${selected.name} со всеми файлами`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to delete instance", "Не удалось удалить инстанцию"));
    } finally {
      setBusy(false);
    }
  }

  async function duplicateSelected(): Promise<void> {
    if (!selected || busy || !assertNotLaunching()) return;
    const source = selected;
    setBusy(true);
    say(t(`Copying ${source.name}...`, `Копирование: ${source.name}...`));
    try {
      const copy = await getLauncherApi().duplicateInstance(source.id);
      setInstanceStatus((current) => ({ ...current, [source.id]: "" }));
      setSelectedId(copy.id);
      await refresh();
      setStatus(t(`Created a copy: ${copy.name}`, `Создана копия: ${copy.name}`));
    } catch (error) {
      setInstanceStatus((current) => ({ ...current, [source.id]: "" }));
      setStatus(error instanceof Error ? error.message : t("Failed to copy the instance", "Не удалось скопировать инстанцию"));
    } finally {
      setBusy(false);
    }
  }

  async function openSelectedFolder(): Promise<void> {
    if (!selected) return;
    try {
      const error = await getLauncherApi().openInstanceFolder(selected.id);
      if (error) setStatus(t(`Could not open folder: ${error}`, `Не удалось открыть папку: ${error}`));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : t("Could not open folder", "Не удалось открыть папку"));
    }
  }

  function cleanLaunchError(error: unknown): string {
    const message = error instanceof Error ? error.message : t("Failed to prepare Java runtime", "Не удалось подготовить Java");
    return message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, "");
  }

  async function launchSelected(): Promise<void> {
    if (!selected || launchingIds.includes(selected.id)) return;
    setLaunchingIds((current) => [...current, selected.id]);
    setInstanceLogs(null);
    say(t(`Preparing ${selected.gameVersion}...`, `Подготовка: ${selected.gameVersion}...`));
    try {
      const result = await getLauncherApi().launchInstance(selected.id);
      say(result.message);
      await refresh({ setReadyStatus: false });
      await refreshRunning();
    } catch (error) {
      say(cleanLaunchError(error));
    } finally {
      setLaunchingIds((current) => current.filter((id) => id !== selected.id));
    }
  }

  async function cancelSelected(): Promise<void> {
    if (!selected || !isLaunching) return;
    say(t("Cancelling launch...", "Отмена запуска..."));
    try {
      await getLauncherApi().cancelLaunch(selected.id);
    } catch (error) {
      say(error instanceof Error ? error.message : t("Failed to cancel launch", "Не удалось отменить запуск"));
    }
  }

  async function stopSelected(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await getLauncherApi().stopInstance(selected.id);
      say(result.message);
      await refreshRunning();
    } catch (error) {
      say(error instanceof Error ? error.message : t("Failed to stop instance", "Не удалось остановить инстанцию"));
    } finally {
      setBusy(false);
    }
  }

  async function refreshInstanceLogs(silent: boolean): Promise<void> {
    if (!selectedId) return;
    try {
      const logs = await getLauncherApi().getInstanceLogs(selectedId);
      setInstanceLogs((prev) => (prev && prev.log === logs.log && prev.plan === logs.plan && prev.hasLog === logs.hasLog && prev.crash?.file === logs.crash?.file ? prev : logs));
    } catch (error) {
      if (!silent) say(error instanceof Error ? error.message : t("Failed to read logs", "Не удалось прочитать журнал"));
    }
  }

  useEffect(() => {
    setInstanceLogs(null);
  }, [instanceTab, selectedId]);

  const logsLive = selectedId !== null && instanceTab === "logs" && (runningIds.includes(selectedId) || launchingIds.includes(selectedId));

  const crashAssist = useMemo(() => {
    if (!instanceLogs || !instanceLogs.hasLog) return null;
    const found = detectCrash(instanceLogs.log, t);
    if (found && !found.generic) return found;
    if (instanceLogs.crash) {
      return { title: found?.title ?? t("Crashed", "Краш"), hint: `${instanceLogs.crash.description} (${instanceLogs.crash.file})` };
    }
    return found;
  }, [instanceLogs, lang]);

  async function copyCrashAssist(): Promise<void> {
    if (!instanceLogs || !crashAssist) return;
    try {
      const crashFile = instanceLogs.crash ? `${instanceLogs.crash.file}: ${instanceLogs.crash.description}\n\n` : "";
      await navigator.clipboard.writeText(`${crashAssist.title}\n${crashAssist.hint}\n\n${crashFile}${instanceLogs.log.slice(-8000)}`);
      say(t("Crash info copied", "Данные о краше скопированы"));
    } catch {
      say(t("Failed to copy crash info", "Не удалось скопировать данные о краше"));
    }
  }

  useEffect(() => {
    if (instanceTab !== "logs" || !selectedId) return;
    let stale = false;
    const apply = (logs: { log: string; plan: string; hasLog: boolean; crash: { file: string; description: string } | null }): void => {
      if (stale) return;
      setInstanceLogs((prev) => (prev && prev.log === logs.log && prev.plan === logs.plan && prev.hasLog === logs.hasLog && prev.crash?.file === logs.crash?.file ? prev : logs));
    };
    void getLauncherApi().getInstanceLogs(selectedId).then(apply).catch(() => {
      if (!stale) setInstanceLogs({ log: "", plan: "", hasLog: false, crash: null });
    });
    const timer = logsLive ? window.setInterval(() => {
      void getLauncherApi().getInstanceLogs(selectedId).then(apply).catch(() => undefined);
    }, 1500) : null;
    return () => {
      stale = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [instanceTab, logsLive, selectedId]);

  useEffect(() => {
    if (instanceTab !== "logs" || !logsFollow) return;
    const el = logPreRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [instanceTab, instanceLogs, logsFollow]);

  async function finishModpackToInstance(instanceId: string, instanceName: string): Promise<void> {
    setBusy(true);
    try {
      await refresh({ setReadyStatus: false });
      setMrpackProgress((current) => ({ ...current, [instanceId]: { done: 0, total: 0 } }));
      setInstanceStatus((current) => ({ ...current, [instanceId]: t(`Importing into ${instanceName}...`, `Импорт в ${instanceName}...`) }));
      await getLauncherApi().importMrpackFiles(instanceId);
      await refresh({ setReadyStatus: false });
      setInstanceStatus((current) => ({ ...current, [instanceId]: t(`Imported into ${instanceName}`, `Импортировано в ${instanceName}`) }));
      setStatus(t(`Imported into ${instanceName}`, `Импортировано в ${instanceName}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("Modpack import failed", "Не удалось импортировать модпак");
      setInstanceStatus((current) => ({ ...current, [instanceId]: message }));
      setStatus(message);
    } finally {
      setMrpackProgress((current) => {
        const next = { ...current };
        delete next[instanceId];
        return next;
      });
      setBusy(false);
    }
  }

  async function confirmModpackTarget(): Promise<void> {
    if (!modpackTarget) return;
    const target = modpackTarget;
    setModpackTarget(null);
    try {
      await finishModpackToInstance(target.instanceId, target.instanceName);
    } finally {
      setDownloadingIds((current) => current.filter((id) => id !== target.resultId));
      setTransferPct((current) => {
        const next = { ...current };
        delete next[`modpack:${target.resultId}`];
        return next;
      });
    }
  }

  async function cancelModpackTarget(): Promise<void> {
    if (!modpackTarget) return;
    const target = modpackTarget;
    setModpackTarget(null);
    try {
      await getLauncherApi().importMrpackCancel(target.instanceId);
    } catch {
    } finally {
      setDownloadingIds((current) => current.filter((id) => id !== target.resultId));
      setTransferPct((current) => {
        const next = { ...current };
        delete next[`modpack:${target.resultId}`];
        return next;
      });
      say(t("Modpack install cancelled", "Установка модпака отменена"));
    }
  }

  return {
    runningIds,
    setRunningIds,
    instanceLogs,
    setInstanceLogs,
    logsFollow,
    setLogsFollow,
    logPreRef,
    confirmDelete,
    setConfirmDelete,
    modpackTarget,
    setModpackTarget,
    exportModal,
    setExportModal,
    mrpackProgress,
    setMrpackProgress,
    importMrpackByPath,
    importMrpackRef,
    downloadingIds,
    setDownloadingIds,
    transferPct,
    setTransferPct,
    javaInstalls,
    setJavaInstalls,
    javaBusy,
    setJavaBusy,
    refreshRunning,
    refreshJava,
    javaAction,
    isSelectedRunning,
    updateSelected,
    exportSelected,
    confirmExport,
    removeSelected,
    duplicateSelected,
    openSelectedFolder,
    cleanLaunchError,
    launchSelected,
    cancelSelected,
    stopSelected,
    refreshInstanceLogs,
    logsLive,
    crashAssist,
    copyCrashAssist,
    finishModpackToInstance,
    confirmModpackTarget,
    cancelModpackTarget
  };
}

export type InstancesState = ReturnType<typeof useInstances>;
