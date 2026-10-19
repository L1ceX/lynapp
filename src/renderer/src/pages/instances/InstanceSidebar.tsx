import { Archive, Box, Boxes, ChevronRight, Plus } from "lucide-react";
import { Dropdown } from "../../components/Dropdown";
import { loaders, NONE_OPTION } from "../../constants";
import { useApp } from "../../state/context";

export function InstanceSidebar() {
  const { bootstrap, busy, createForm, createInstance, createLoaders, creating, dragZone, gameVersions, launchingIds, loadersForVersion, mrpackProgress, openImportModal, pickLoaderOption, pickVersionOption, selected, setCreateForm, setSelectedId, t, versionsForLoader } = useApp();
  return (
    <aside className={dragZone === "sidebar" ? "instance-sidebar drop-zone" : "instance-sidebar"}>{dragZone === "sidebar" ? <div className="zone-hint"><Archive size={26} /><strong>{t("Drop a .mrpack modpack", "Отпустите модпак .mrpack")}</strong><span>{t("A new instance will be created from it", "Из него будет создана новая инстанция")}</span></div> : null}
            <div className="sidebar-heading"><div><span className="eyebrow">{t("Library", "Библиотека")}</span><h1>{t("Instances", "Инстанции")}</h1></div><span className="count-badge">{bootstrap.instances.length}</span></div>
            <div className="instance-list">
              {bootstrap.instances.map((instance) => { const progress = mrpackProgress[instance.id]; const launching = launchingIds.includes(instance.id); const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0; return <button key={instance.id} className={instance.id === selected?.id ? "instance-button active" : "instance-button"} onClick={() => setSelectedId(instance.id)} disabled={busy || !!progress}>{progress ? <span className="instance-progress"><span style={{ width: `${pct}%` }} /></span> : null}<Box size={18} /><span><strong>{instance.name}</strong><small>{progress ? `Importing... ${pct}%` : launching ? t("Launching...", "Запуск...") : `${instance.gameVersion} / ${instance.loader}`}</small></span>{progress || launching ? null : <ChevronRight size={16} />}</button>; })}
            </div>
            <form className="new-instance-form anim-stagger" onSubmit={(event) => { event.preventDefault(); void createInstance(); }}>
              <div className="form-caption"><Plus size={15} /> {t("New instance", "Новая инстанция")}</div>
              <input value={createForm.name} onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })} placeholder={t("Instance name", "Название инстанции")} />
              <div className="two-col">{gameVersions ? <Dropdown value={createForm.gameVersion || NONE_OPTION} options={[NONE_OPTION, ...(createForm.loader ? versionsForLoader(createForm.loader) : gameVersions)]} ariaLabel={t("Minecraft version", "Версия Minecraft")} searchPlaceholder={t("Find a version", "Найти версию")} stretch="right" openUp onChange={(label) => setCreateForm((form) => ({ ...form, ...pickVersionOption(label, form.loader) }))} /> : <input value={createForm.gameVersion} onChange={(event) => setCreateForm({ ...createForm, gameVersion: event.target.value })} placeholder="1.21.1" />}<Dropdown value={createForm.loader || NONE_OPTION} options={[NONE_OPTION, ...(createForm.gameVersion ? createLoaders ?? loadersForVersion(createForm.gameVersion) : loaders)]} ariaLabel={t("Loader", "Загрузчик")} stretch="left" openUp onChange={(label) => setCreateForm((form) => ({ ...form, ...pickLoaderOption(label, form.gameVersion) }))} /></div>
              <button className="primary-button" disabled={creating || !createForm.gameVersion || !createForm.loader} title={!createForm.gameVersion || !createForm.loader ? t("Choose a version and a loader", "Выберите версию и загрузчик") : undefined}><Plus size={16} /> {t("Create", "Создать")}</button><button type="button" className="import-open-button" onClick={() => void openImportModal()} disabled={busy || creating}><Boxes size={16} /> {t("Import from other launchers", "Импорт из других лаунчеров")}</button><span className="muted">{t("or drop a .mrpack onto this list", "или перетащите файл .mrpack на этот список")}</span>
            </form>
          </aside>
  );
}
