import { useMemo } from "react";
import ReactGridLayout, { useContainerWidth } from "react-grid-layout";
import { GridBackground } from "react-grid-layout/extras";
import { EyeOff, LayoutGrid } from "lucide-react";
import { useApp } from "../state/context";
import { HOME_COLS, HOME_MARGIN, HOME_ROW_HEIGHT, widgetMeta, type HomeWidgetId } from "./home/layout";
import { HomeWidget } from "./home/widgets";

export function HomePage() {
  const { section } = useApp();
  return section === "home" ? <HomeContent /> : null;
}

function HomeContent() {
  const { changeHomeLayout, hideHomeWidget, layoutEditing, homeLayout, instanceStatus, sectionExiting, selected, startLayoutEditing, status, t } = useApp();
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
        {layoutEditing ? <span className="layout-editing-badge"><LayoutGrid size={15} /> {t("Editing layout", "Редактирование расположения")}</span> : <button type="button" className="layout-edit-button" onClick={startLayoutEditing} title={t("Rearrange the blocks on this page", "Переставить блоки на этой странице")}><LayoutGrid size={16} /> {t("Customize", "Настроить")}</button>}
      </header>
      <div ref={containerRef} className={layoutEditing ? "home-board editing" : "home-board"}>
        {mounted ? <>
          {layoutEditing ? <GridBackground className="home-grid-bg" width={width} cols={HOME_COLS} rowHeight={HOME_ROW_HEIGHT} margin={HOME_MARGIN} containerPadding={[0, 0]} rows={rows} color="transparent" borderRadius={12} /> : null}
          <ReactGridLayout
            className="home-grid"
            width={width}
            layout={gridLayout}
            gridConfig={{ cols: HOME_COLS, rowHeight: HOME_ROW_HEIGHT, margin: HOME_MARGIN, containerPadding: [0, 0] }}
            dragConfig={{ enabled: layoutEditing, threshold: 4, cancel: ".widget-hide" }}
            resizeConfig={{ enabled: layoutEditing, handles: ["se"] }}
            onLayoutChange={(next) => { if (layoutEditing) changeHomeLayout(next); }}
          >
            {visible.map((item) => <div key={item.i} className="home-widget">
              <HomeWidget id={item.i as HomeWidgetId} />
              {layoutEditing ? <button type="button" className="widget-hide" onClick={() => hideHomeWidget(item.i)} title={t("Hide this block", "Скрыть блок")} aria-label={t("Hide this block", "Скрыть блок")}><EyeOff size={14} /></button> : null}
            </div>)}
          </ReactGridLayout>
        </> : null}
      </div>
    </main>
  );
}
