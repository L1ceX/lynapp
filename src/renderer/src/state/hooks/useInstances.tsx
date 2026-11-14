import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InstanceLogsResult } from "@shared/ipc";
import type { InstanceFolder, JavaInstallation, LauncherInstance, QuickPlayTarget } from "@shared/types";
import { getLauncherApi } from "../../lib/api";
import { detectCrash } from "../../lib/crash";
import { cleanIpcError, transferLabel } from "../../lib/format";
import type { CoreState } from "./useCore";

export function useInstances(deps: Pick<CoreState, "assertNotLaunching" | "busy" | "instanceTab" | "isLaunching" | "lang" | "launchingIds" | "refresh" | "say" | "section" | "selected" | "selectedId" | "setBootstrap" | "setBusy" | "setInstanceStatus" | "setLaunchingIds" | "setSelectedId" | "setSettingsDraft" | "setStatus" | "switchSection" | "t" | "tRef" | "update">) {
  const { assertNotLaunching, busy, instanceTab, isLaunching, lang, launchingIds, refresh, say, section, selected, selectedId, setBootstrap, setBusy, setInstanceStatus, setLaunchingIds, setSelectedId, setSettingsDraft, setStatus, switchSection, t, tRef, update } = deps;
  const [runningIds, setRunningIds] = useState<string[]>([]);

  const [instanceLogs, setInstanceLogs] = useState<InstanceLogsResult | null>(null);

  const [logsFollow, setLogsFollow] = useState(true);

  const logPreRef = useRef<HTMLPreElement | null>(null);

  const [confirmDelete, setConfirmDelete] = useState(false);

  const [modpackTarget, setModpackTarget] = useState<{ resultId: string; title: string; filePath: string; instanceId: string; instanceName: string; instanceVersion: string; instanceLoader: string; info: { totalFiles: number; packName: string; packGameVersion: string; packLoader: string; skipped?: string[] } } | null>(null);

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
    if (busy) return;
    if (!/\.(mrpack|zip)$/i.test(filePath)) {
      setStatus(t("Only modpack files (.mrpack or a CurseForge .zip) can be dropped here", "Сюда можно перетаскивать только сборки (.mrpack или .zip CurseForge)"));
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
        const done = t(`Imported ${started.instance.name}`, `Импортировано: ${started.instance.name}`) + skippedNote(started.skipped);
        setInstanceStatus((current) => ({ ...current, [started.instance.id]: done }));
        setStatus(done);
      } finally {
        setMrpackProgress((current) => {
          const next = { ...current };
          delete next[started.instance.id];
          return next;
        });
      }
    } catch (error) {
      const message = cleanIpcError(error, t("Modpack import failed", "Не удалось импортировать модпак"));
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
      setStatus(cleanIpcError(error, tRef.current("Failed to load Java installations", "Не удалось загрузить установленные версии Java")));
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
      setStatus(cleanIpcError(error, t(`Java ${major} action failed`, `Java ${major}: действие не выполнено`)));
    } finally {
      setJavaBusy(null);
    }
  }

  const isSelectedRunning = selected !== null && runningIds.includes(selected.id);

  async function updateSelected(patch: Partial<LauncherInstance>): Promise<void> {
    if (!selected || !assertNotLaunching()) return;
    const targetId = selected.id;
    try {
      const updated = await getLauncherApi().updateInstance({ id: targetId, patch });
      setBootstrap((current) => current ? { ...current, instances: current.instances.map((item) => item.id === updated.id ? updated : item) } : current);
      say(t(`Saved ${updated.name}`, `Сохранено: ${updated.name}`), targetId);
    } catch (error) {
      setStatus(cleanIpcError(error, t("Failed to save instance", "Не удалось сохранить инстанцию")));
    }
  }

  async function exportSelected(): Promise<void> {
    if (!selected || busy || !assertNotLaunching()) return;
    const target = selected;
    setBusy(true);
    try {
      const entries = await getLauncherApi().listExportEntries(target.id);
      const defaults = new Set(["mods", "resourcepacks", "shaderpacks", "datapacks", "config", "defaultconfigs", "options.txt", "optionsof.txt", "optionsshaders.txt", "servers.dat"]);
      const checked: Record<string, boolean> = {};
      for (const entry of entries) {
        checked[entry.name] = defaults.has(entry.name);
      }
      setExportModal({ entries, checked });
    } catch (error) {
      say(cleanIpcError(error, t(`Failed to export ${target.name}`, `Не удалось экспортировать: ${target.name}`)), target.id);
    } finally {
      setBusy(false);
    }
  }

  async function confirmExport(): Promise<void> {
    if (!exportModal || !selected || busy) return;
    const target = selected;
    const include = exportModal.entries.filter((entry) => exportModal.checked[entry.name]).map((entry) => entry.name);
    setExportModal(null);
    setBusy(true);
    say(t(`Exporting ${target.name}...`, `Экспорт: ${target.name}...`), target.id);
    try {
      const filePath = await getLauncherApi().exportMrpack(target.id, include);
      if (filePath) {
        say(t(`Exported ${target.name}`, `Экспортировано: ${target.name}`), target.id);
      } else {
        say(t("Export cancelled", "Экспорт отменён"), target.id);
      }
    } catch (error) {
      say(cleanIpcError(error, t(`Failed to export ${target.name}`, `Не удалось экспортировать: ${target.name}`)), target.id);
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
      setStatus(cleanIpcError(error, t("Failed to delete instance", "Не удалось удалить инстанцию")));
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
      setStatus(cleanIpcError(error, t("Failed to copy the instance", "Не удалось скопировать инстанцию")));
    } finally {
      setBusy(false);
    }
  }

  async function openSelectedFolder(folder: InstanceFolder = "root"): Promise<void> {
    if (!selected) return;
    try {
      const error = await getLauncherApi().openInstanceFolder(selected.id, folder);
      if (error) setStatus(t(`Could not open folder: ${error}`, `Не удалось открыть папку: ${error}`));
    } catch (err) {
      setStatus(cleanIpcError(err, t("Could not open folder", "Не удалось открыть папку")));
    }
  }

  async function launchSelected(quickPlay?: QuickPlayTarget | unknown): Promise<void> {
    if (!selected || launchingIds.includes(selected.id)) return;
    const targetId = selected.id;
    const targetGameVersion = selected.gameVersion;
    const qp = quickPlay && typeof quickPlay === "object" && "kind" in quickPlay && "value" in quickPlay ? (quickPlay as QuickPlayTarget) : undefined;
    setLaunchingIds((current) => [...current, targetId]);
    setInstanceLogs(null);
    say(t(`Preparing ${targetGameVersion}...`, `Подготовка: ${targetGameVersion}...`), targetId);
    try {
      const result = await getLauncherApi().launchInstance(targetId, qp);
      say(result.message, targetId);
      await refresh({ setReadyStatus: false });
      await refreshRunning();
    } catch (error) {
      say(cleanIpcError(error, t("Failed to prepare Java runtime", "Не удалось подготовить Java")), targetId);
    } finally {
      setLaunchingIds((current) => current.filter((id) => id !== targetId));
    }
  }

  async function cancelSelected(): Promise<void> {
    if (!selected || !isLaunching) return;
    const targetId = selected.id;
    say(t("Cancelling launch...", "Отмена запуска..."), targetId);
    try {
      await getLauncherApi().cancelLaunch(targetId);
    } catch (error) {
      say(cleanIpcError(error, t("Failed to cancel launch", "Не удалось отменить запуск")), targetId);
    }
  }

  async function stopSelected(): Promise<void> {
    if (!selected) return;
    const targetId = selected.id;
    setBusy(true);
    try {
      const result = await getLauncherApi().stopInstance(targetId);
      say(result.message, targetId);
      await refreshRunning();
    } catch (error) {
      say(cleanIpcError(error, t("Failed to stop instance", "Не удалось остановить инстанцию")), targetId);
    } finally {
      setBusy(false);
    }
  }

  async function refreshInstanceLogs(silent: boolean): Promise<void> {
    if (!selectedId) return;
    try {
      const logs = await getLauncherApi().getInstanceLogs(selectedId);
      setInstanceLogs((prev) => (prev && prev.log === logs.log && prev.plan === logs.plan && prev.hasLog === logs.hasLog && prev.crash?.file === logs.crash?.file && prev.crash?.text === logs.crash?.text ? prev : logs));
    } catch (error) {
      if (!silent) say(cleanIpcError(error, t("Failed to read logs", "Не удалось прочитать журнал")));
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
      const fromReport = detectCrash(instanceLogs.crash.text, t);
      if (fromReport && !fromReport.generic) return fromReport;
      return { title: found?.title ?? t("Crashed", "Краш"), hint: `${instanceLogs.crash.description} (${instanceLogs.crash.file})` };
    }
    return found;
  }, [instanceLogs, lang]);

  async function copyCrashAssist(): Promise<void> {
    if (!instanceLogs || !crashAssist) return;
    try {
      if (instanceLogs.crash?.text) {
        await navigator.clipboard.writeText(instanceLogs.crash.text);
        say(t("Crash log copied", "Краш-лог скопирован"));
        return;
      }
      await navigator.clipboard.writeText(`${crashAssist.title}\n${crashAssist.hint}\n\n${instanceLogs.log.slice(-8000)}`);
      say(t("Crash info copied", "Данные о краше скопированы"));
    } catch {
      say(t("Failed to copy crash info", "Не удалось скопировать данные о краше"));
    }
  }

  useEffect(() => {
    if (instanceTab !== "logs" || !selectedId) return;
    let stale = false;
    const apply = (logs: InstanceLogsResult): void => {
      if (stale) return;
      setInstanceLogs((prev) => (prev && prev.log === logs.log && prev.plan === logs.plan && prev.hasLog === logs.hasLog && prev.crash?.file === logs.crash?.file && prev.crash?.text === logs.crash?.text ? prev : logs));
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

  function skippedNote(skipped: string[] | undefined): string {
    if (!skipped?.length) return "";
    const list = skipped.slice(0, 5).join(", ") + (skipped.length > 5 ? t(` and ${skipped.length - 5} more`, ` и ещё ${skipped.length - 5}`) : "");
    return t(`. Not downloaded, the authors do not allow other launchers: ${list}. Download them from CurseForge and drop them onto the Files tab.`, `. Не скачано, авторы запретили сторонние лаунчеры: ${list}. Скачайте их на сайте CurseForge и перетащите на вкладку «Файлы».`);
  }

  async function finishModpackToInstance(instanceId: string, instanceName: string, skipped?: string[]): Promise<void> {
    setBusy(true);
    try {
      await refresh({ setReadyStatus: false });
      setMrpackProgress((current) => ({ ...current, [instanceId]: { done: 0, total: 0 } }));
      setInstanceStatus((current) => ({ ...current, [instanceId]: t(`Importing into ${instanceName}...`, `Импорт в ${instanceName}...`) }));
      await getLauncherApi().importMrpackFiles(instanceId);
      await refresh({ setReadyStatus: false });
      const done = t(`Imported into ${instanceName}`, `Импортировано в ${instanceName}`) + skippedNote(skipped);
      setInstanceStatus((current) => ({ ...current, [instanceId]: done }));
      setStatus(done);
    } catch (error) {
      const message = cleanIpcError(error, t("Modpack import failed", "Не удалось импортировать модпак"));
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
      await finishModpackToInstance(target.instanceId, target.instanceName, target.info.skipped);
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
