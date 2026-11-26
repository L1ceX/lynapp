import { useApp } from "../state/context";
import { dockZones } from "./dockZones";

export function DockOverlay() {
  const { dockDrag, navLayout, t } = useApp();
  if (!dockDrag) return null;
  const zones = dockZones(dockDrag.kind, navLayout, dockDrag.side);
  if (!zones.length) return null;
  const labels: Record<string, string> = {
    left: t("Left", "Слева"),
    right: t("Right", "Справа"),
    top: t("Top", "Сверху"),
    bottom: t("Bottom", "Снизу"),
    header: t("In the header", "В шапке"),
    tabs: t("Next to the tabs", "Рядом с вкладками"),
    floating: t("Floating in the corner", "В углу поверх страницы")
  };
  const titles: Record<string, string> = {
    rail: t("Navigation panel", "Панель навигации"),
    sidebar: t("Instance list", "Список инстанций"),
    tabs: t("Instance tabs", "Вкладки инстанции"),
    launch: t("Launch button", "Кнопка «Запустить»")
  };
  const ghostX = Math.max(12, Math.min(dockDrag.x + 14, window.innerWidth - 240));
  const ghostY = Math.max(12, Math.min(dockDrag.y + 14, window.innerHeight - 48));
  return (
    <div className={`dock-overlay dock-overlay-${dockDrag.kind}`} aria-hidden="true">
      {zones.map((zone) => {
        const isActive = zone.side === dockDrag.side;
        const isVerticalPill = Boolean(zone.compact && (zone.side === "left" || zone.side === "right"));
        const cls = ["dock-zone", isActive ? "active" : "", zone.compact ? "compact" : "", isVerticalPill ? "vertical" : ""].filter(Boolean).join(" ");
        return <div key={zone.side} className={cls} style={{ left: zone.left, top: zone.top, width: zone.width, height: zone.height }}><span>{labels[zone.side]}</span></div>;
      })}
      <div className="dock-ghost" style={{ left: ghostX, top: ghostY }}>{titles[dockDrag.kind]}{dockDrag.side ? ` → ${labels[dockDrag.side]}` : ""}</div>
    </div>
  );
}
