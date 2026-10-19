import { Boxes, Check, CheckCircle2, Download, FolderOpen, HardDrive, RefreshCw, X, XCircle } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import type { ExternalImportProgress } from "@shared/types";
import { EXTERNAL_LAUNCHERS, type ImportModalState, LOADER_NAMES } from "../../constants";
import { getLauncherApi } from "../../lib/api";
import { formatRelative, ruPlural } from "../../lib/format";
import type { CoreState } from "./useCore";

export function useExternalImport(deps: Pick<CoreState, "busy" | "lang" | "refresh" | "setBusy" | "setSelectedId" | "setStatus" | "t" | "update">) {
  const { busy, lang, refresh, setBusy, setSelectedId, setStatus, t, update } = deps;
  const [importModal, setImportModal] = useState<ImportModalState | null>(null);

  useEffect(() => getLauncherApi().onExternalImportProgress((update) => {
    setImportModal((current) => current ? { ...current, progress: { ...current.progress, [update.key]: update } } : current);
  }), []);

  async function openImportModal(): Promise<void> {
    if (importModal) return;
    setImportModal({ launchers: null, active: null, extraRoots: [], checked: {}, running: false, progress: {}, result: null });
    try {
      const launchers = await getLauncherApi().scanExternalLaunchers();
      const active = launchers.find((launcher) => launcher.instances.some((item) => !item.issue))?.key ?? launchers[0]?.key ?? null;
      setImportModal((current) => current ? { ...current, launchers, active } : current);
    } catch (error) {
      setImportModal((current) => current ? { ...current, launchers: [], error: error instanceof Error ? error.message : String(error) } : current);
    }
  }

  function closeImportModal(): void {
    setImportModal((current) => current?.running ? current : null);
  }

  function toggleImportItem(key: string): void {
    setImportModal((current) => current && !current.running && !current.result ? { ...current, checked: { ...current.checked, [key]: !current.checked[key] } } : current);
  }

  function setImportAll(on: boolean): void {
    setImportModal((current) => {
      if (!current || current.running || current.result) return current;
      const launcher = current.launchers?.find((item) => item.key === current.active);
      if (!launcher) return current;
      const checked = { ...current.checked };
      for (const item of launcher.instances) {
        if (!item.issue) checked[item.key] = on;
      }
      return { ...current, checked };
    });
  }

  async function runImport(): Promise<void> {
    if (!importModal || importModal.running || busy) return;
    const keys = Object.keys(importModal.checked).filter((key) => importModal.checked[key]);
    if (!keys.length) return;
    setImportModal((current) => current ? { ...current, running: true, progress: {}, error: undefined } : current);
    setBusy(true);
    try {
      const result = await getLauncherApi().importExternalInstances(keys, importModal.extraRoots);
      await refresh();
      const last = result.imported.at(-1);
      if (last) setSelectedId(last.instanceId);
      setImportModal((current) => current ? { ...current, running: false, result } : current);
      setStatus(result.failed.length
        ? t(`Imported ${result.imported.length}, failed ${result.failed.length}`, `Импортировано: ${result.imported.length}, с ошибкой: ${result.failed.length}`)
        : t(`Imported ${result.imported.length}`, `Импортировано: ${result.imported.length}`));
    } catch (error) {
      setImportModal((current) => current ? { ...current, running: false, error: error instanceof Error ? error.message : String(error) } : current);
    } finally {
      setBusy(false);
    }
  }

  async function pickImportFolder(): Promise<void> {
    if (!importModal || importModal.running || importModal.picking) return;
    setImportModal((current) => current ? { ...current, picking: true, error: undefined } : current);
    try {
      const picked = await getLauncherApi().pickExternalFolder();
      setImportModal((current) => {
        if (!current) return current;
        if (!picked) return { ...current, picking: false };
        if (!picked.launcher) return { ...current, picking: false, error: t(`No instances found in ${picked.folder}`, `В папке ${picked.folder} инстанции не найдены`) };
        const found = picked.launcher;
        const others = (current.launchers ?? []).filter((item) => item.key !== found.key);
        return { ...current, picking: false, launchers: [...others, found], active: found.key, extraRoots: [...new Set([...current.extraRoots, picked.folder])] };
      });
    } catch (error) {
      setImportModal((current) => current ? { ...current, picking: false, error: error instanceof Error ? error.message : String(error) } : current);
    }
  }

  function renderImportModal() {
    if (!importModal) return null;
    const { launchers, active, checked, running, progress, result, error } = importModal;
    const launcher = launchers?.find((item) => item.key === active) ?? null;
    const totalInstances = (launchers ?? []).reduce((sum, item) => sum + item.instances.length, 0);
    const selectedKeys = Object.keys(checked).filter((key) => checked[key]);
    const doneCount = Object.values(progress).filter((item) => item.phase === "done" || item.phase === "failed").length;
    const runPct = selectedKeys.length ? Math.round((doneCount / selectedKeys.length) * 100) : 0;
    const phaseLabel = (phase: ExternalImportProgress["phase"]): string => phase === "create" ? t("Creating", "Создание") : phase === "copy" ? t("Copying files", "Копирование файлов") : phase === "detect" ? t("Detecting mods", "Поиск модов") : phase === "done" ? t("Done", "Готово") : t("Failed", "Ошибка");
    const countLabel = (n: number, en: string, one: string, few: string, many: string): string => lang === "ru" ? `${n} ${ruPlural(n, one, few, many)}` : `${n} ${en}${n === 1 ? "" : "s"}`;
    return <div className="modal-backdrop" onClick={closeImportModal}><div className="modal-card import-modal" role="dialog" aria-label={t("Import from other launchers", "Импорт из других лаунчеров")} onClick={(event) => event.stopPropagation()}>
      <div className="export-head"><Boxes size={20} /><div><h3>{t("Import from other launchers", "Импорт из других лаунчеров")}</h3><span className="muted">{launchers === null ? t("Looking for installed launchers...", "Поиск установленных лаунчеров...") : launchers.length ? t(`Found ${launchers.length} launcher(s), ${totalInstances} instance(s)`, `Найдено лаунчеров: ${launchers.length}, инстанций: ${totalInstances}`) : t("No supported launchers found", "Поддерживаемые лаунчеры не найдены")}</span></div><button type="button" className="titlebar-button" onClick={closeImportModal} disabled={running} aria-label={t("Close", "Закрыть")}><X size={15} /></button></div>
      {launchers === null ? <div className="import-empty"><RefreshCw size={22} className="spin" /><span>{t("Scanning launcher folders...", "Проверяем папки лаунчеров...")}</span></div> : !launchers.length ? <div className="import-empty"><Boxes size={26} /><strong>{t("Nothing to import yet", "Пока нечего импортировать")}</strong><span className="muted">{t("Supported: Modrinth App, Prism Launcher, PolyMC, MultiMC, CurseForge, official launcher and TLauncher. If yours is in an unusual place, point to its folder.", "Поддерживаются: Modrinth App, Prism Launcher, PolyMC, MultiMC, CurseForge, официальный лаунчер и TLauncher. Если лаунчер лежит в необычном месте, укажите его папку.")}</span><button type="button" onClick={() => void pickImportFolder()} disabled={importModal.picking}><FolderOpen size={15} /> {t("Choose folder", "Указать папку")}</button></div> : <>
        <div className="import-launchers" role="tablist">{launchers.map((item) => { const meta = EXTERNAL_LAUNCHERS[item.id]; const twins = launchers.filter((other) => other.id === item.id).length > 1; return <button key={item.key} type="button" role="tab" aria-selected={item.key === active} className={item.key === active ? "import-launcher active" : "import-launcher"} style={{ "--launcher-color": meta.color } as CSSProperties} onClick={() => setImportModal((current) => current ? { ...current, active: item.key } : current)} disabled={running} title={item.root}><span className="import-launcher-dot" /><span>{t(meta.label, meta.labelRu)}{twins ? <small className="import-launcher-path"> · {item.root.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] ?? item.root}</small> : null}</span><span className="import-launcher-count">{item.instances.length}</span></button>; })}<button type="button" className="import-launcher import-launcher-pick" onClick={() => void pickImportFolder()} disabled={running || !!result || importModal.picking}>{importModal.picking ? <RefreshCw size={14} className="spin" /> : <FolderOpen size={14} />}<span>{t("Choose folder", "Указать папку")}</span></button></div>
        {launcher ? <div className="readonly-path import-root"><HardDrive size={15} /><span>{launcher.root}</span></div> : null}
        {launcher?.error ? <div className="export-warning" role="alert"><XCircle size={15} /><span>{launcher.error}</span></div> : null}
        <div className="import-rows">{(launcher?.instances ?? []).map((item) => { const on = !!checked[item.key]; const state = progress[item.key]; const meta = EXTERNAL_LAUNCHERS[item.launcher]; const loaderText = item.loader ? `${LOADER_NAMES[item.loader] ?? item.loader}${item.loaderVersion && item.loader !== "vanilla" ? ` ${item.loaderVersion}` : ""}` : null; const details = [item.gameVersion ? `Minecraft ${item.gameVersion}` : null, loaderText, countLabel(item.mods, "mod", "мод", "мода", "модов"), countLabel(item.worlds, "world", "мир", "мира", "миров"), item.lastPlayed ? formatRelative(item.lastPlayed, lang) : null].filter(Boolean).join(" · "); return <button key={item.key} type="button" className={[ "import-row", on ? "on" : "", item.issue ? "blocked" : "", state ? `phase-${state.phase}` : "" ].filter(Boolean).join(" ")} onClick={() => toggleImportItem(item.key)} disabled={!!item.issue || running || !!result} title={item.issue ?? item.directory}><span className="export-check">{on ? <Check size={14} /> : null}</span>{item.iconDataUrl ? <img className="import-icon" src={item.iconDataUrl} alt="" /> : <span className="import-icon import-icon-letter" style={{ "--launcher-color": meta.color } as CSSProperties}>{(item.name.trim()[0] ?? "?").toUpperCase()}</span>}<span className="import-main"><strong>{item.name}</strong><small className="muted">{details}</small>{item.issue ? <small className="import-issue">{item.issue}</small> : state?.phase === "failed" && state.message ? <small className="import-issue">{state.message}</small> : null}</span>{state ? <span className={`import-state ${state.phase}`}>{state.phase === "done" ? <CheckCircle2 size={14} /> : state.phase === "failed" ? <XCircle size={14} /> : <RefreshCw size={14} className="spin" />}{phaseLabel(state.phase)}</span> : item.issue ? <span className="export-tag private">{t("Unsupported", "Не поддерживается")}</span>  : null}</button>; })}</div>
      </>}
      {running || result ? <div className="import-progress" aria-hidden="true"><span style={{ width: `${result ? 100 : runPct}%` }} /></div> : null}
      {result ? <div className={result.failed.length ? "export-warning" : "export-note"} role="status"><span>{result.failed.length ? t(`Imported ${result.imported.length}, failed ${result.failed.length}. The reason is shown in the row.`, `Импортировано: ${result.imported.length}, с ошибкой: ${result.failed.length}. Причина указана в строке.`) : t(`Imported ${result.imported.length}. The new instances are in your library; mods were matched with Modrinth.`, `Импортировано: ${result.imported.length}. Новые инстанции уже в библиотеке, моды сопоставлены с Modrinth.`)}</span></div> : <div className="export-note"><span>{t("Files are copied, the original launcher is not changed. Java settings are not transferred: lynapp picks Java itself.", "Файлы копируются, исходный лаунчер не меняется. Настройки Java не переносятся: lynapp подбирает Java сам.")}</span></div>}
      {error ? <div className="export-warning" role="alert"><XCircle size={15} /><span>{error}</span></div> : null}
      <div className="button-row modal-actions import-actions">{launcher && !result ? <div className="import-select"><button type="button" onClick={() => setImportAll(true)} disabled={running}>{t("Select all", "Выбрать все")}</button><button type="button" onClick={() => setImportAll(false)} disabled={running}>{t("Clear", "Снять")}</button></div> : null}{result ? <button className="primary-button" onClick={closeImportModal}><Check size={15} /> {t("Done", "Готово")}</button> : <><button onClick={closeImportModal} disabled={running}>{t("Cancel", "Отмена")}</button><button className="primary-button" onClick={() => void runImport()} disabled={running || busy || !selectedKeys.length}>{running ? <><RefreshCw size={15} className="spin" /> {t(`Importing ${doneCount}/${selectedKeys.length}`, `Импорт ${doneCount}/${selectedKeys.length}`)}</> : <><Download size={15} /> {selectedKeys.length ? t(`Import ${selectedKeys.length}`, `Импортировать (${selectedKeys.length})`) : t("Import", "Импортировать")}</>}</button></>}</div>
    </div></div>;
  }

  return {
    importModal,
    setImportModal,
    openImportModal,
    closeImportModal,
    toggleImportItem,
    setImportAll,
    runImport,
    pickImportFolder,
    renderImportModal
  };
}

export type ExternalImportState = ReturnType<typeof useExternalImport>;
