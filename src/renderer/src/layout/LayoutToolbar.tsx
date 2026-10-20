import { Check, LogOut, Move, Plus, RefreshCw, RotateCcw } from "lucide-react";
import { Presence } from "../components/Presence";
import { widgetMeta } from "../pages/home/layout";
import { useApp } from "../state/context";

export function LayoutToolbar() {
  const { exitLayoutEditing, homeLayout, layoutDirty, layoutEditing, layoutExitConfirm, layoutSaving, resetLayout, saveLayout, section, showHomeWidget, t } = useApp();
  const hidden = section === "home" ? homeLayout.filter((item) => item.hidden) : [];
  const hint = section === "home"
    ? t("Drag blocks, pull a corner to resize. Buttons on the left can be dragged too.", "Перетаскивайте блоки, тяните за угол, чтобы изменить размер. Кнопки слева тоже перетаскиваются.")
    : section === "instances"
      ? t("Drag the buttons on the left and the instance tabs, the eye hides a tab.", "Перетаскивайте кнопки слева и вкладки инстанции, глаз скрывает вкладку.")
      : t("Drag the buttons on the left. Blocks are on Home, tabs are in Instances.", "Перетаскивайте кнопки слева. Блоки — на главной, вкладки — в инстанциях.");
  return (
    <Presence>{layoutEditing ? <div className="layout-toolbar" role="toolbar" aria-label={t("Layout editor", "Редактор расположения")}>
      <div className="layout-toolbar-hint"><Move size={15} /><span>{hint}</span></div>
      {hidden.length ? <div className="layout-toolbar-hidden">{hidden.map((item) => { const meta = widgetMeta(item.i); return <button key={item.i} type="button" className="layout-chip" onClick={() => showHomeWidget(item.i)} title={t("Show this block again", "Вернуть блок")}><Plus size={13} /> {meta ? t(meta.label, meta.labelRu) : item.i}</button>; })}</div> : null}
      <div className="layout-toolbar-actions">
        <button type="button" className="primary-button" onClick={() => void saveLayout()} disabled={!layoutDirty || layoutSaving}>{layoutSaving ? <RefreshCw size={15} className="spin" /> : <Check size={15} />} {t("Save", "Сохранить")}</button>
        <button type="button" onClick={resetLayout} disabled={layoutSaving} title={t("Restore the standard layout everywhere", "Вернуть стандартное расположение везде")}><RotateCcw size={15} /> {t("Reset", "Сбросить")}</button>
        <button type="button" className={layoutExitConfirm ? "danger-button" : ""} onClick={exitLayoutEditing} disabled={layoutSaving}><LogOut size={15} /> {layoutExitConfirm ? t("Exit without saving?", "Выйти без сохранения?") : t("Exit editor", "Выйти из редактора")}</button>
      </div>
    </div> : null}</Presence>
  );
}
