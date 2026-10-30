import type { CSSProperties } from "react";
import { Boxes } from "lucide-react";
import { boardForView } from "../../layout/boards";
import { useApp } from "../../state/context";
import { ContentTab } from "./ContentTab";
import { FilesTab } from "./FilesTab";
import { GeneralTab } from "./GeneralTab";
import { InstanceSidebar } from "./InstanceSidebar";
import { InstanceTabsNav } from "./InstanceTabsNav";
import { LaunchSlot } from "./LaunchSlot";
import { LogsTab } from "./LogsTab";
import { RuntimeTab } from "./RuntimeTab";
import { VersionsTab } from "./VersionsTab";

export function InstancesPage() {
  const { navLayout, headerStatus, instanceTab, section, sectionExiting, selected, t, tabExiting } = useApp();
  const place = selected ? navLayout.launchPlace : "header";
  const boardTab = boardForView("instances", instanceTab) !== null;
  const tabClasses = [boardTab ? "tab-board" : "settings-surface", tabExiting ? "tab-exiting" : ""].filter(Boolean).join(" ");
  return (
    section === "instances" && (
        <main className={["instances-workspace", sectionExiting ? "section-exiting" : "", navLayout.sidebarSide === "right" ? "sidebar-right" : ""].filter(Boolean).join(" ")} style={{ "--sidebar-width": `${navLayout.sidebarWidth}px` } as CSSProperties}>
          <InstanceSidebar />

          <section className={`instance-workspace launch-at-${place}`}>
            <header className="workspace-header"><div><span className="eyebrow">{headerStatus.trim() ? (selected?.name ?? t("No instance selected", "Инстанция не выбрана")) : t("Instance", "Инстанция")}</span>{headerStatus.trim() ? <h2 key="status-promoted" className="status-promoted">{headerStatus}</h2> : <h2 key="instance-name">{selected?.name ?? t("No instance selected", "Инстанция не выбрана")}</h2>}{headerStatus.trim() ? null : <span className="status-line">{headerStatus}</span>}</div>{place === "header" ? <LaunchSlot /> : null}</header>
            {selected ? <div className={`instance-body tabs-${navLayout.tabsSide}`}>
              <InstanceTabsNav />
              <div className="instance-tab-content">
                <section className={tabClasses} key={instanceTab}>
                  <GeneralTab />
                  <VersionsTab />
                  <FilesTab />
                  <RuntimeTab />
                  <LogsTab />
                  <ContentTab />
                </section>
              </div>
            </div> : <div className="blank-workspace"><Boxes size={34} /><h2>{t("Select an instance", "Выберите инстанцию")}</h2></div>}
            {place === "floating" ? <div className="launch-floating"><LaunchSlot /></div> : null}
          </section>
        </main>
      )
  );
}
