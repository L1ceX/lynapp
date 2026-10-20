import { Eye, EyeOff } from "lucide-react";
import { useReorder } from "../../components/useReorder";
import { LOCKED_TAB } from "../../layout/navOrder";
import { useApp } from "../../state/context";

export function InstanceTabsNav() {
  const { instanceTab, instanceTabs, layoutEditing, moveTabItem, navLayout, switchTab, t, toggleTabHidden } = useApp();
  const ordered = navLayout.tabs.map((id) => instanceTabs.find((tab) => tab.id === id)).filter((tab): tab is (typeof instanceTabs)[number] => !!tab);
  const shown = layoutEditing ? ordered : ordered.filter((tab) => !navLayout.hiddenTabs.includes(tab.id));
  const { containerRef, itemProps, draggingIndex } = useReorder<HTMLElement>({
    axis: "x",
    enabled: layoutEditing,
    onMove: (from, to) => moveTabItem(navLayout.tabs.indexOf(shown[from].id), navLayout.tabs.indexOf(shown[to].id))
  });
  return (
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
  );
}
