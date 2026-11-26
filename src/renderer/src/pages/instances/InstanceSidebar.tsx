import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Box, Boxes, ChevronRight, GripHorizontal, Pin, PinOff, Play, Plus, Search, Square, X } from "lucide-react";
import { Dropdown } from "../../components/Dropdown";
import { loaders, NONE_OPTION } from "../../constants";
import { useApp } from "../../state/context";

interface InstanceSidebarProps {
  drawerMode?: boolean;
  open?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
  onFocusChange?: (focused: boolean) => void;
}

export function InstanceSidebar({ drawerMode = false, open = true, pinned = true, onTogglePin, onHoverEnter, onHoverLeave, onFocusChange }: InstanceSidebarProps) {
  const { layoutEditing, startDock, startSidebarResize, dockDrag, bootstrap, busy, createForm, createInstance, createLoaders, creating, dragZone, gameVersions, launchingIds, launchInstanceById, loadersForVersion, mrpackProgress, openImportModal, pickLoaderOption, pickVersionOption, runningIds, selected, setCreateForm, setSelectedId, stopInstanceById, t, versionsForLoader } = useApp();
  const [query, setQuery] = useState("");
  const asideRef = useRef<HTMLElement | null>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);
  const filtered = useMemo(() => {
    const clean = query.trim().toLowerCase();
    if (!clean) return bootstrap.instances;
    return bootstrap.instances.filter((item) => item.name.toLowerCase().includes(clean) || item.gameVersion.toLowerCase().includes(clean) || item.loader.toLowerCase().includes(clean));
  }, [bootstrap.instances, query]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected?.id]);

  const classes = [
    "instance-sidebar",
    drawerMode ? "drawer" : "",
    drawerMode && open ? "drawer-open" : "",
    drawerMode && !open ? "drawer-closed" : "",
    dragZone === "sidebar" ? "drop-zone" : "",
    dockDrag?.kind === "sidebar" ? "docking" : ""
  ].filter(Boolean).join(" ");

  return (
    <aside
      ref={asideRef}
      className={classes}
      aria-hidden={drawerMode && !open}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
      onFocusCapture={(event) => {
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) {
          onFocusChange?.(true);
        }
      }}
      onBlurCapture={(event) => {
        const next = event.relatedTarget as HTMLElement | null;
        const stillInField = Boolean(next && asideRef.current?.contains(next) && (next.tagName === "INPUT" || next.tagName === "TEXTAREA" || next.tagName === "SELECT" || next.isContentEditable));
        if (!stillInField) onFocusChange?.(false);
      }}
    >
      {layoutEditing ? <><button type="button" className="dock-handle sidebar-dock-handle" onPointerDown={(event) => startDock("sidebar", event)} title={t("Drag the list to the left or right side", "Перетащите список влево или вправо")} aria-label={t("Move the instance list", "Переместить список инстанций")}><GripHorizontal size={16} /></button><div className="sidebar-resizer" onPointerDown={startSidebarResize} title={t("Drag to change the width", "Потяните, чтобы изменить ширину")} /></> : null}
      {dragZone === "sidebar" ? <div className="zone-hint"><Archive size={26} /><strong>{t("Drop a modpack (.mrpack or .zip)", "Отпустите сборку (.mrpack или .zip)")}</strong><span>{t("A new instance will be created from it", "Из него будет создана новая инстанция")}</span></div> : null}
      <div className="sidebar-heading">
        <div><span className="eyebrow">{t("Library", "Библиотека")}</span><h1>{t("Instances", "Инстанции")}</h1></div>
        <div className="sidebar-heading-actions">
          <span className="count-badge">{bootstrap.instances.length}</span>
          {onTogglePin && !layoutEditing ? (
            <button
              type="button"
              className={pinned ? "sidebar-pin-btn active" : "sidebar-pin-btn"}
              onClick={onTogglePin}
              title={pinned ? t("Auto-hide drawer", "Автоскрытие шторки") : t("Pin drawer open", "Закрепить шторку")}
              aria-label={pinned ? t("Auto-hide drawer", "Автоскрытие шторки") : t("Pin drawer open", "Закрепить шторку")}
            >
              {pinned ? <Pin size={14} /> : <PinOff size={14} />}
            </button>
          ) : null}
        </div>
      </div>
      {bootstrap.instances.length >= 4 ? <div className="sidebar-search"><Search size={14} /><input data-quick-search="sidebar" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Filter instances...", "Поиск инстанций...")} aria-label={t("Filter instances", "Поиск инстанций")} />{query ? <button type="button" className="sidebar-search-clear" onClick={() => setQuery("")} aria-label={t("Clear search", "Очистить поиск")}><X size={13} /></button> : null}</div> : null}
      <div className="instance-list">
        {filtered.length ? filtered.map((instance) => {
          const progress = mrpackProgress[instance.id];
          const launching = launchingIds.includes(instance.id);
          const running = runningIds.includes(instance.id);
          const isSelected = instance.id === selected?.id;
          const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
          return (
            <div key={instance.id} ref={isSelected ? activeRef : undefined} className={["instance-row-wrap", isSelected ? "active" : "", running ? "running" : ""].filter(Boolean).join(" ")}>
              <button type="button" className={isSelected ? "instance-button active" : "instance-button"} onClick={() => setSelectedId(instance.id)} disabled={busy || !!progress}>
                {progress ? <span className="instance-progress"><span style={{ width: `${pct}%` }} /></span> : null}
                <span className="instance-icon-wrap"><Box size={18} />{running ? <span className="instance-live-dot" /> : null}</span>
                <span className="instance-meta"><strong>{instance.name}</strong><small>{progress ? t(`Importing... ${pct}%`, `Импорт... ${pct}%`) : launching ? t("Launching...", "Запуск...") : `${instance.gameVersion} / ${instance.loader}`}</small></span>
                {progress || launching ? null : <ChevronRight size={16} className="instance-chevron" />}
              </button>
              {!progress && !launching ? <button type="button" className={running ? "instance-quick-btn stop" : "instance-quick-btn"} disabled={busy} title={running ? t(`Stop ${instance.name}`, `Остановить ${instance.name}`) : t(`Launch ${instance.name}`, `Запустить ${instance.name}`)} aria-label={running ? t("Stop", "Остановить") : t("Launch", "Запустить")} onClick={(event) => { event.stopPropagation(); setSelectedId(instance.id); void (running ? stopInstanceById(instance.id) : launchInstanceById(instance)); }}>{running ? <Square size={12} /> : <Play size={13} />}</button> : null}
            </div>
          );
        }) : <span className="muted sidebar-empty">{t("No matching instances", "Ничего не найдено")}</span>}
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
