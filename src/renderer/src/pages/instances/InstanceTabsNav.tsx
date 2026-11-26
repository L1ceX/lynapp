import { Eye, EyeOff, GripHorizontal, GripVertical, Pin, PinOff } from "lucide-react";
import { useReorder } from "../../components/useReorder";
import { LOCKED_TAB } from "../../layout/navOrder";
import { useApp } from "../../state/context";
import { LaunchSlot } from "./LaunchSlot";

interface InstanceTabsNavProps {
  autoMode?: boolean;
  expanded?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
}

export function InstanceTabsNav({ autoMode = false, expanded = true, pinned = true, onTogglePin, onHoverEnter, onHoverLeave }: InstanceTabsNavProps) {
  const { dockDrag, instanceTab, instanceTabs, layoutEditing, moveTabItem, navLayout, startDock, switchTab, t, toggleTabHidden } = useApp();
  const vertical = navLayout.tabsSide === "left" || navLayout.tabsSide === "right";
  const ordered = navLayout.tabs.map((id) => instanceTabs.find((tab) => tab.id === id)).filter((tab): tab is (typeof instanceTabs)[number] => !!tab);
  const shown = layoutEditing ? ordered : ordered.filter((tab) => !navLayout.hiddenTabs.includes(tab.id));
  const { containerRef, itemProps, draggingIndex } = useReorder<HTMLElement>({
    axis: vertical ? "y" : "x",
    enabled: layoutEditing,
    onMove: (from, to) => moveTabItem(navLayout.tabs.indexOf(shown[from].id), navLayout.tabs.indexOf(shown[to].id))
  });
  const barClasses = [
    "instance-tabs-bar",
    vertical ? "vertical" : "",
    autoMode ? "auto-mode" : "",
    autoMode && expanded ? "auto-open" : "",
    autoMode && !expanded ? "collapsed" : "",
    dockDrag?.kind === "tabs" ? "docking" : ""
  ].filter(Boolean).join(" ");
  return (
    <div className={barClasses} onMouseEnter={onHoverEnter} onMouseLeave={onHoverLeave}>
      {layoutEditing ? <button type="button" className="dock-handle tabs-dock-handle" onPointerDown={(event) => startDock("tabs", event)} title={t("Drag the tabs to any side of the instance page", "Перетащите вкладки к любой стороне страницы инстанции")} aria-label={t("Move the instance tabs", "Переместить вкладки инстанции")}>{vertical ? <GripHorizontal size={16} /> : <GripVertical size={16} />}</button> : null}
      <nav ref={containerRef} className={layoutEditing ? "instance-tabs reorder-editing" : "instance-tabs"} aria-label={t("Instance settings", "Настройки инстанции")}>
        {shown.map(({ id, label, icon: Icon }, index) => {
          const hidden = navLayout.hiddenTabs.includes(id);
          const classes = ["tab-button", instanceTab === id ? "active" : "", layoutEditing ? "reorderable" : "", hidden ? "tab-hidden" : "", draggingIndex === index ? "reorder-dragging" : ""].filter(Boolean).join(" ");
          return <button key={id} type="button" className={classes} title={!expanded ? label : undefined} onClick={() => switchTab(id)} {...itemProps(index)}>
            <Icon size={16} /><span className="tab-label">{label}</span>
            {layoutEditing && id !== LOCKED_TAB ? <span className="tab-visibility" role="button" tabIndex={0} data-reorder-ignore title={hidden ? t("Show this tab", "Показывать вкладку") : t("Hide this tab", "Скрыть вкладку")} onClick={(event) => { event.stopPropagation(); toggleTabHidden(id); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); toggleTabHidden(id); } }}>{hidden ? <EyeOff size={13} /> : <Eye size={13} />}</span> : null}
          </button>;
        })}
        {onTogglePin && !layoutEditing ? (
          <button
            type="button"
            className={pinned ? "tab-button tabs-collapse-btn active" : "tab-button tabs-collapse-btn"}
            onClick={onTogglePin}
            title={pinned ? t("Auto-hide tabs", "Автоскрытие вкладок") : t("Pin tabs open", "Закрепить вкладки")}
            aria-label={pinned ? t("Auto-hide tabs", "Автоскрытие вкладок") : t("Pin tabs open", "Закрепить вкладки")}
          >
            {pinned ? <Pin size={14} /> : <PinOff size={14} />}
          </button>
        ) : null}
      </nav>
      {navLayout.launchPlace === "tabs" ? <LaunchSlot /> : null}
    </div>
  );
}
