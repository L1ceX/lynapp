import { useApp } from "../state/context";
import { dockZones } from "./dockZones";

export function DockOverlay() {
  const { dockDrag, navLayout, t } = useApp();
  if (!dockDrag) return null;
  const zones = dockZones(dockDrag.kind, navLayout);
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
  return (
    <div className={`dock-overlay dock-overlay-${dockDrag.kind}`} aria-hidden="true">
      {zones.map((zone) => <div key={zone.side} className={zone.side === dockDrag.side ? "dock-zone active" : "dock-zone"} style={{ left: zone.left, top: zone.top, width: zone.width, height: zone.height }}><span>{labels[zone.side]}</span></div>)}
      <div className="dock-ghost" style={{ left: dockDrag.x + 14, top: dockDrag.y + 14 }}>{titles[dockDrag.kind]}{dockDrag.side ? ` → ${labels[dockDrag.side]}` : ""}</div>
    </div>
  );
}
