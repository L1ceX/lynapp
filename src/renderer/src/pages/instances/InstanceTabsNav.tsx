import { Eye, EyeOff, GripHorizontal, GripVertical } from "lucide-react";
import { useReorder } from "../../components/useReorder";
import { LOCKED_TAB } from "../../layout/navOrder";
import { useApp } from "../../state/context";
import { LaunchSlot } from "./LaunchSlot";

export function InstanceTabsNav() {
  const { dockDrag, instanceTab, instanceTabs, layoutEditing, moveTabItem, navLayout, startDock, switchTab, t, toggleTabHidden } = useApp();
  const vertical = navLayout.tabsSide === "left" || navLayout.tabsSide === "right";
  const ordered = navLayout.tabs.map((id) => instanceTabs.find((tab) => tab.id === id)).filter((tab): tab is (typeof instanceTabs)[number] => !!tab);
  const shown = layoutEditing ? ordered : ordered.filter((tab) => !navLayout.hiddenTabs.includes(tab.id));
  const { containerRef, itemProps, draggingIndex } = useReorder<HTMLElement>({
    axis: vertical ? "y" : "x",
    enabled: layoutEditing,
    onMove: (from, to) => moveTabItem(navLayout.tabs.indexOf(shown[from].id), navLayout.tabs.indexOf(shown[to].id))
  });
  const barClasses = ["instance-tabs-bar", vertical ? "vertical" : "", dockDrag?.kind === "tabs" ? "docking" : ""].filter(Boolean).join(" ");
  return (
    <div className={barClasses}>
      {layoutEditing ? <button type="button" className="dock-handle tabs-dock-handle" onPointerDown={(event) => startDock("tabs", event)} title={t("Drag the tabs to any side of the instance page", "Перетащите вкладки к любой стороне страницы инстанции")} aria-label={t("Move the instance tabs", "Переместить вкладки инстанции")}>{vertical ? <GripHorizontal size={16} /> : <GripVertical size={16} />}</button> : null}
      <nav ref={containerRef} className={layoutEditing ? "instance-tabs reorder-editing" : "instance-tabs"} aria-label={t("Instance settings", "Настройки инстанции")}>
        {shown.map(({ id, label, icon: Icon }, index) => {
          const hidden = navLayout.hiddenTabs.includes(id);
          const classes = ["tab-button", instanceTab === id ? "active" : "", layoutEditing ? "reorderable" : "", hidden ? "tab-hidden" : "", draggingIndex === index ? "reorder-dragging" : ""].filter(Boolean).join(" ");
          return <button key={id} type="button" className={classes} onClick={() => switchTab(id)} {...itemProps(index)}>
            <Icon size={16} />{label}
            {layoutEditing && id !== LOCKED_TAB ? <span className="tab-visibility" role="button" tabIndex={0} data-reorder-ignore title={hidden ? t("Show this tab", "Показывать вкладку") : t("Hide this tab", "Скрыть вкладку")} onClick={(event) => { event.stopPropagation(); toggleTabHidden(id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); toggleTabHidden(id); } }}>{hidden ? <EyeOff size={13} /> : <Eye size={13} />}</span> : null}
          </button>;
        })}
      </nav>
      {navLayout.launchPlace === "tabs" ? <LaunchSlot /> : null}
    </div>
  );
}
