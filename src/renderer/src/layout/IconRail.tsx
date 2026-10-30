import { GripHorizontal, GripVertical, House, Layers3, LayoutGrid, Palette, RefreshCw, Settings, Shirt, UserRoundCog, type LucideIcon } from "lucide-react";
import { useReorder } from "../components/useReorder";
import type { AppSection } from "../constants";
import { useApp } from "../state/context";

const RAIL_ITEMS: Record<AppSection, { icon: LucideIcon; label: string; labelRu: string }> = {
  home: { icon: House, label: "Home", labelRu: "Главная" },
  instances: { icon: Layers3, label: "Instances", labelRu: "Инстанции" },
  launcher: { icon: Settings, label: "Launcher settings", labelRu: "Настройки лаунчера" },
  visuals: { icon: Palette, label: "Visuals", labelRu: "Оформление" },
  skins: { icon: Shirt, label: "Skins", labelRu: "Скины" },
  accounts: { icon: UserRoundCog, label: "Account settings", labelRu: "Аккаунты" }
};

export function IconRail() {
  const { dockDrag, layoutEditing, moveRailItem, navLayout, refresh, refreshVersions, section, startDock, startLayoutEditing, switchSection, t } = useApp();
  const horizontal = navLayout.railSide === "top" || navLayout.railSide === "bottom";
  const { containerRef, itemProps, draggingIndex } = useReorder<HTMLElement>({ axis: horizontal ? "x" : "y", enabled: layoutEditing, onMove: moveRailItem });
  return (
    <aside className={dockDrag?.kind === "rail" ? "icon-rail docking" : "icon-rail"} aria-label={t("Launcher navigation", "Навигация")}>
      {layoutEditing ? <button type="button" className="dock-handle rail-dock-handle" onPointerDown={(event) => startDock("rail", event)} title={t("Drag the panel to any edge of the window", "Перетащите панель к любому краю окна")} aria-label={t("Move the navigation panel", "Переместить панель навигации")}>{horizontal ? <GripVertical size={16} /> : <GripHorizontal size={16} />}</button> : null}
      <nav ref={containerRef} className={layoutEditing ? "rail-nav reorder-editing" : "rail-nav"}>
        {navLayout.rail.map((id, index) => {
          const item = RAIL_ITEMS[id];
          const Icon = item.icon;
          const classes = ["rail-button", section === id ? "active" : "", layoutEditing ? "reorderable" : "", draggingIndex === index ? "reorder-dragging" : ""].filter(Boolean).join(" ");
          return <button key={id} type="button" className={classes} onClick={() => switchSection(id)} aria-label={t(item.label, item.labelRu)} title={layoutEditing ? t(`${item.label}: drag to move`, `${item.labelRu}: перетащите, чтобы переставить`) : t(item.label, item.labelRu)} {...itemProps(index)}><Icon size={19} /></button>;
        })}
      </nav>
      <div className="rail-bottom">
        {layoutEditing ? null : <button type="button" className="rail-button rail-layout" onClick={startLayoutEditing} aria-label={t("Customize layout", "Настроить расположение")} title={t("Customize layout", "Настроить расположение")}><LayoutGrid size={17} /></button>}
        <button type="button" className="rail-button rail-refresh" onClick={() => { void refresh(); void refreshVersions(); }} aria-label={t("Refresh", "Обновить")} title={t("Refresh", "Обновить")}><RefreshCw size={17} /></button>
      </div>
    </aside>
  );
}
