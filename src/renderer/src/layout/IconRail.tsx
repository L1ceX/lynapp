import { House, Layers3, LayoutGrid, Palette, RefreshCw, Settings, Shirt, UserRoundCog, type LucideIcon } from "lucide-react";
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
  const { layoutEditing, moveRailItem, navLayout, refresh, refreshVersions, section, startLayoutEditing, switchSection, t } = useApp();
  const { containerRef, itemProps, draggingIndex } = useReorder<HTMLElement>({ axis: "y", enabled: layoutEditing, onMove: moveRailItem });
  return (
    <aside className="icon-rail" aria-label={t("Launcher navigation", "Навигация")}>
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
