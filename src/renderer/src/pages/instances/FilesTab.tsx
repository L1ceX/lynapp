import { useState } from "react";
import { Download, Folder, FolderOpen, RefreshCw } from "lucide-react";
import { Dropdown } from "../../components/Dropdown";
import { FileRow } from "../../components/FileRow";
import { fileGroups, fileSortLabelRu, fileSortOptions, filterSortFiles } from "../../lib/content";
import { useApp } from "../../state/context";

type FileFilter = "all" | "enabled" | "disabled" | "updates";

export function FilesTab() {
  const { busy, checkingUpdates, contentKey, dragZone, fileQuery, fileRowActions, fileSort, instanceTab, lang, localContent, openSelectedFolder, recordFor, refreshLocalContent, selected, setFileQuery, setFileSort, t, updateAll, updateInfo, updatingKeys, updateAllProgress } = useApp();
  const [filter, setFilter] = useState<FileFilter>("all");
  if (!selected || instanceTab !== "files") return null;

  const updatableCount = Object.values(updateInfo).filter((info) => info.latest && !info.latest.distributionBlocked).length;
  const activeFilter: FileFilter = filter === "updates" && updatableCount === 0 ? "all" : filter;

  return (
    <div className={dragZone === "files" ? "settings-content files-drop drop-zone" : "settings-content files-drop"} key={`files-${selected.id}`}>
      {dragZone === "files" ? <div className="zone-hint"><Download size={26} /><strong>{t(`Add to ${selected.name}`, `Добавить в ${selected.name}`)}</strong><span>{t("Mods, resource packs, shaders and data packs go to the right folders automatically", "Моды, ресурспаки, шейдеры и датапаки сами разложатся по нужным папкам")}</span></div> : null}
      <div className="surface-heading-row">
        <div className="surface-heading"><Folder size={19} /><div><h3>{t("Local files", "Локальные файлы")}</h3><span>{t("Everything inside this instance folders, including files added by hand.", "Всё содержимое папок инстанции, включая файлы, добавленные вручную.")}</span></div></div>
        <div className="button-row surface-actions">
          <button onClick={() => void refreshLocalContent()} disabled={busy}><RefreshCw size={15} /> {t("Refresh", "Обновить")}</button>
          <button onClick={() => void openSelectedFolder(selected.loader === "vanilla" ? "resourcepack" : "mod")} title={selected.loader === "vanilla" ? t("Open the resource packs folder", "Открыть папку ресурспаков") : t("Open the mods folder", "Открыть папку модов")}><FolderOpen size={15} /> {t("Open folder", "Открыть папку")}</button>
          {updateAllProgress && updateAllProgress.instanceId === selected.id
            ? <button className="primary-button" disabled><RefreshCw size={15} className="spin" /> {t(`Updating ${updateAllProgress.done} of ${updateAllProgress.total}`, `Обновление: ${updateAllProgress.done} из ${updateAllProgress.total}`)}</button>
            : updatableCount > 0
              ? <button className="primary-button" onClick={() => void updateAll()} disabled={busy || checkingUpdates || updatingKeys.length > 0 || Boolean(updateAllProgress)}><Download size={15} /> {t("Update all", "Обновить всё")} ({updatableCount})</button>
              : checkingUpdates ? <span className="muted update-check"><RefreshCw size={14} className="spin" /> {t("Checking for updates...", "Проверка обновлений...")}</span> : null}
        </div>
      </div>
      <div className="files-toolbar">
        <input data-quick-search="files" className="files-search" value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} placeholder={t("Search files", "Поиск файлов")} aria-label={t("Search files", "Поиск файлов")} />
        <div className="files-filter-pills" role="group" aria-label={t("Filter files", "Фильтр файлов")}>
          <button type="button" className={activeFilter === "all" ? "filter-pill active" : "filter-pill"} onClick={() => setFilter("all")}>{t("All", "Все")}</button>
          <button type="button" className={activeFilter === "enabled" ? "filter-pill active" : "filter-pill"} onClick={() => setFilter("enabled")}>{t("Enabled", "Вкл")}</button>
          <button type="button" className={activeFilter === "disabled" ? "filter-pill active" : "filter-pill"} onClick={() => setFilter("disabled")}>{t("Disabled", "Выкл")}</button>
          {updatableCount > 0 ? <button type="button" className={activeFilter === "updates" ? "filter-pill active" : "filter-pill"} onClick={() => setFilter("updates")}>{t("Updates", "Обновления")} ({updatableCount})</button> : null}
        </div>
        <label className="sort-label">{t("Sort by:", "Сортировать по:")}<Dropdown value={t(fileSortOptions.find((option) => option.id === fileSort)?.label ?? "Name A-Z", fileSortLabelRu[fileSortOptions.find((option) => option.id === fileSort)?.label ?? ""] ?? "")} options={fileSortOptions.map((option) => t(option.label, fileSortLabelRu[option.label] ?? option.label))} ariaLabel={t("Sort files", "Сортировка файлов")} onChange={(label) => { const found = fileSortOptions.find((option) => option.label === label || t(option.label, fileSortLabelRu[option.label] ?? option.label) === label); if (found) setFileSort(found.id); }} /></label>
      </div>
      {localContent === null ? <span className="muted">{t("Reading instance folders...", "Чтение папок инстанции...")}</span> : fileGroups.map((group) => {
        const groupItems = localContent.filter((item) => item.kind === group.id);
        const stateFiltered = groupItems.filter((item) => {
          if (activeFilter === "enabled") return item.enabled;
          if (activeFilter === "disabled") return !item.enabled;
          if (activeFilter === "updates") {
            const info = updateInfo[contentKey(item.kind, item.fileName)];
            return Boolean(info?.latest && !info.latest.distributionBlocked);
          }
          return true;
        });
        const rows = filterSortFiles(stateFiltered, fileQuery, fileSort);
        return (
          <div key={group.id} className="file-group">
            <div className="section-title file-group-title">
              <span>{t(group.label, group.labelRu)} · {groupItems.filter((row) => row.enabled).length}/{groupItems.length}</span>
              <button type="button" className="file-group-open" onClick={() => void openSelectedFolder(group.id)} title={t(`Open folder: ${group.label}`, `Открыть папку: ${group.labelRu}`)} aria-label={t(`Open folder: ${group.label}`, `Открыть папку: ${group.labelRu}`)}><FolderOpen size={14} /></button>
            </div>
            {rows.length ? rows.map((item) => {
              const key = contentKey(item.kind, item.fileName);
              return <FileRow key={item.kind + (item.world ? `:${item.world}:` : ":") + item.fileName} item={item} info={updateInfo[key]} hasRecord={(item.source === "modrinth" || item.source === "curseforge") && recordFor(item) !== undefined} updating={updatingKeys.includes(key)} busy={busy} anyUpdating={updatingKeys.length > 0} lang={lang} actions={fileRowActions} />;
            }) : <span className="muted">{activeFilter !== "all" || fileQuery.trim() ? t("Nothing matches this filter.", "По этому фильтру ничего не найдено.") : t("Empty — drop files into the folder or install from Content.", "Пусто — закиньте файлы в папку или поставьте из контента.")}</span>}
          </div>
        );
      })}
    </div>
  );
}
