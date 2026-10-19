import { Archive, Copy, FolderCog, FolderOpen, HardDrive, Trash2 } from "lucide-react";
import { CommitInput } from "../../components/inputs";
import { useApp } from "../../state/context";

export function GeneralTab() {
  const { busy, duplicateSelected, exportSelected, instanceTab, isSelectedRunning, openSelectedFolder, selected, setConfirmDelete, t, updateSelected } = useApp();
  if (!selected) return null;
  return (
    instanceTab === "general" && <div className="settings-content"><div className="surface-heading"><FolderCog size={19} /><div><h3>{t("General", "Основные")}</h3><span>{t("Identity and location for this installation.", "Название и расположение этой инстанции.")}</span></div></div><label>{t("Instance name", "Название инстанции")}<CommitInput key={selected.id} value={selected.name} onCommit={(name) => void updateSelected({ name })} /></label><div className="readonly-path"><HardDrive size={16} /><span>{selected.directory}</span><button type="button" className="path-open" onClick={() => void openSelectedFolder()} title={t("Open instance folder", "Открыть папку инстанции")}><FolderOpen size={15} /></button></div><button onClick={() => void exportSelected()} disabled={busy || isSelectedRunning} title={t("Export instance as .mrpack", "Экспортировать инстанцию в .mrpack")}><Archive size={16} /> {t("Export .mrpack", "Экспорт .mrpack")}</button><button onClick={() => void duplicateSelected()} disabled={busy || isSelectedRunning} title={isSelectedRunning ? t("Stop the instance first", "Сначала остановите инстанцию") : t("Create a full copy with worlds, mods and settings", "Создать полную копию с мирами, модами и настройками")}><Copy size={16} /> {t("Duplicate", "Дублировать")}</button><button className="danger-button" onClick={() => setConfirmDelete(true)} disabled={busy || isSelectedRunning} title={isSelectedRunning ? t("Stop the instance first", "Сначала остановите инстанцию") : t("Delete the instance and its folder", "Удалить инстанцию с папкой")}><Trash2 size={16} /> {t("Delete instance", "Удалить инстанцию")}</button></div>
  );
}
