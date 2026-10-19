import { useMemo } from "react";
import ReactGridLayout, { useContainerWidth } from "react-grid-layout";
import { GridBackground } from "react-grid-layout/extras";
import { Check, EyeOff, LayoutGrid, LogOut, Move, Plus, RefreshCw, RotateCcw } from "lucide-react";
import { Presence } from "../components/Presence";
import { useApp } from "../state/context";
import { HOME_COLS, HOME_MARGIN, HOME_ROW_HEIGHT, widgetMeta, type HomeWidgetId } from "./home/layout";
import { HomeWidget } from "./home/widgets";

function HomeEditorToolbar() {
  const { exitHomeEditing, homeDirty, homeEditing, homeExitConfirm, homeLayout, homeSaving, resetHomeLayout, saveHomeLayout, showHomeWidget, t } = useApp();
  const hidden = homeLayout.filter((item) => item.hidden);
  return (
    <Presence>{homeEditing ? <div className="layout-toolbar" role="toolbar" aria-label={t("Layout editor", "Редактор расположения")}>
      <div className="layout-toolbar-hint"><Move size={15} /><span>{t("Drag blocks, pull a corner to resize", "Перетаскивайте блоки, тяните за угол, чтобы изменить размер")}</span></div>
      {hidden.length ? <div className="layout-toolbar-hidden">{hidden.map((item) => { const meta = widgetMeta(item.i); return <button key={item.i} type="button" className="layout-chip" onClick={() => showHomeWidget(item.i)} title={t("Show this block again", "Вернуть блок")}><Plus size={13} /> {meta ? t(meta.label, meta.labelRu) : item.i}</button>; })}</div> : null}
      <div className="layout-toolbar-actions">
        <button type="button" className="primary-button" onClick={() => void saveHomeLayout()} disabled={!homeDirty || homeSaving}>{homeSaving ? <RefreshCw size={15} className="spin" /> : <Check size={15} />} {t("Save", "Сохранить")}</button>
        <button type="button" onClick={resetHomeLayout} disabled={homeSaving}><RotateCcw size={15} /> {t("Reset", "Сбросить")}</button>
        <button type="button" className={homeExitConfirm ? "danger-button" : ""} onClick={exitHomeEditing} disabled={homeSaving}><LogOut size={15} /> {homeExitConfirm ? t("Exit without saving?", "Выйти без сохранения?") : t("Exit editor", "Выйти из редактора")}</button>
      </div>
    </div> : null}</Presence>
  );
}

export function HomePage() {
  const { section } = useApp();
  return section === "home" ? <HomeContent /> : null;
}

function HomeContent() {
  const { changeHomeLayout, hideHomeWidget, homeEditing, homeLayout, instanceStatus, sectionExiting, selected, startHomeEditing, status, t } = useApp();
  const { width, containerRef, mounted } = useContainerWidth();
  const visible = useMemo(() => homeLayout.filter((item) => !item.hidden), [homeLayout]);
  const gridLayout = useMemo(() => visible.map((item) => {
    const meta = widgetMeta(item.i);
    return { i: item.i, x: item.x, y: item.y, w: item.w, h: item.h, minW: meta?.minW, minH: meta?.minH };
  }), [visible]);
  const rows = visible.reduce((max, item) => Math.max(max, item.y + item.h), 0) + 3;

  return (
    <main className={sectionExiting ? "page-workspace section-exiting" : "page-workspace"}>
      <header className="workspace-header">
        <div><span className="eyebrow">{t("Home", "Главная")}</span><h2>{t("Welcome back", "С возвращением")}</h2><span className="status-line">{selected !== null ? instanceStatus[selected.id] ?? status : status}</span></div>
        {homeEditing ? <span className="layout-editing-badge"><LayoutGrid size={15} /> {t("Editing layout", "Редактирование расположения")}</span> : <button type="button" className="layout-edit-button" onClick={startHomeEditing} title={t("Rearrange the blocks on this page", "Переставить блоки на этой странице")}><LayoutGrid size={16} /> {t("Customize", "Настроить")}</button>}
      </header>
      <div ref={containerRef} className={homeEditing ? "home-board editing" : "home-board"}>
        {mounted ? <>
          {homeEditing ? <GridBackground className="home-grid-bg" width={width} cols={HOME_COLS} rowHeight={HOME_ROW_HEIGHT} margin={HOME_MARGIN} containerPadding={[0, 0]} rows={rows} color="transparent" borderRadius={12} /> : null}
          <ReactGridLayout
            className="home-grid"
            width={width}
            layout={gridLayout}
            gridConfig={{ cols: HOME_COLS, rowHeight: HOME_ROW_HEIGHT, margin: HOME_MARGIN, containerPadding: [0, 0] }}
            dragConfig={{ enabled: homeEditing, threshold: 4, cancel: ".widget-hide" }}
            resizeConfig={{ enabled: homeEditing, handles: ["se"] }}
            onLayoutChange={(next) => { if (homeEditing) changeHomeLayout(next); }}
          >
            {visible.map((item) => <div key={item.i} className="home-widget">
              <HomeWidget id={item.i as HomeWidgetId} />
              {homeEditing ? <button type="button" className="widget-hide" onClick={() => hideHomeWidget(item.i)} title={t("Hide this block", "Скрыть блок")} aria-label={t("Hide this block", "Скрыть блок")}><EyeOff size={14} /></button> : null}
            </div>)}
          </ReactGridLayout>
        </> : null}
      </div>
      <HomeEditorToolbar />
    </main>
  );
}
