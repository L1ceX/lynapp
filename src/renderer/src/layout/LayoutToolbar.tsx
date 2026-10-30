import { Check, LogOut, Move, Plus, RefreshCw, RotateCcw } from "lucide-react";
import { Presence } from "../components/Presence";
import { widgetMeta } from "../pages/home/layout";
import { useApp } from "../state/context";
import { blockMeta, boardForView } from "./boards";

export function LayoutToolbar() {
  const { exitLayoutEditing, homeLayout, instanceTab, layoutDirty, layoutEditing, layoutExitConfirm, layoutSaving, pageLayouts, resetLayout, saveLayout, section, showHomeWidget, showPageBlock, t } = useApp();
  const board = boardForView(section, instanceTab);
  const hidden = section === "home"
    ? homeLayout.filter((item) => item.hidden).map((item) => { const meta = widgetMeta(item.i); return { id: item.i, label: meta ? t(meta.label, meta.labelRu) : item.i, show: () => showHomeWidget(item.i) }; })
    : board
      ? pageLayouts[board].filter((item) => item.hidden).map((item) => { const meta = blockMeta(board, item.i); return { id: item.i, label: meta ? t(meta.label, meta.labelRu) : item.i, show: () => showPageBlock(board, item.i) }; })
      : [];
  const hint = section === "home"
    ? t("Drag blocks, pull a corner to resize. Panels move to any edge by their handle.", "Перетаскивайте блоки, тяните за угол, чтобы изменить размер. Панели переносятся за ручку к любому краю.")
    : section === "instances"
      ? t("Tabs, the list and the Launch button move by their handles. Drag tabs to reorder, the eye hides a tab.", "Вкладки, список и кнопка «Запустить» переносятся за ручки. Вкладки можно переставлять, глаз скрывает вкладку.") + (board ? " " + t("Blocks inside the tab move and change width.", "Блоки внутри вкладки перетаскиваются и меняют ширину.") : "")
      : board
        ? t("Drag blocks, pull a side edge to change the width. The height follows the content.", "Перетаскивайте блоки, тяните за боковой край, чтобы изменить ширину. Высота подстраивается под содержимое.")
        : t("Drag the navigation buttons or move the panel to any edge by its handle.", "Перетаскивайте кнопки навигации или перенесите панель за ручку к любому краю.");
  return (
    <Presence>{layoutEditing ? <div className="layout-toolbar" role="toolbar" aria-label={t("Layout editor", "Редактор расположения")}>
      <div className="layout-toolbar-hint"><Move size={15} /><span>{hint}</span></div>
      {hidden.length ? <div className="layout-toolbar-hidden">{hidden.map((item) => <button key={item.id} type="button" className="layout-chip" onClick={item.show} title={t("Show this block again", "Вернуть блок")}><Plus size={13} /> {item.label}</button>)}</div> : null}
      <span className="layout-toolbar-sos">{t("Ctrl+Shift+R — emergency reset", "Ctrl+Shift+R — аварийный сброс")}</span>
      <div className="layout-toolbar-actions">
        <button type="button" className="primary-button" onClick={() => void saveLayout()} disabled={!layoutDirty || layoutSaving}>{layoutSaving ? <RefreshCw size={15} className="spin" /> : <Check size={15} />} {t("Save", "Сохранить")}</button>
        <button type="button" onClick={resetLayout} disabled={layoutSaving} title={t("Restore the standard layout everywhere", "Вернуть стандартное расположение везде")}><RotateCcw size={15} /> {t("Reset", "Сбросить")}</button>
        <button type="button" className={layoutExitConfirm ? "danger-button" : ""} onClick={exitLayoutEditing} disabled={layoutSaving}><LogOut size={15} /> {layoutExitConfirm ? t("Exit without saving?", "Выйти без сохранения?") : t("Exit editor", "Выйти из редактора")}</button>
      </div>
    </div> : null}</Presence>
  );
}
