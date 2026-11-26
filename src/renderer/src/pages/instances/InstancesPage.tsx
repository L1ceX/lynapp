import { useEffect, useRef, useState, type CSSProperties } from "react";
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
import { ScreenshotsTab } from "./ScreenshotsTab";
import { ServersTab } from "./ServersTab";
import { VersionsTab } from "./VersionsTab";
import { WorldsTab } from "./WorldsTab";

const INITIAL_HIDE_MS = 1500;
const LEAVE_HIDE_MS = 380;

function readPinned(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writePinned(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
  }
}

export function InstancesPage() {
  const { dragZone, layoutEditing, navLayout, headerStatus, instanceTab, section, sectionExiting, selected, t, tabExiting } = useApp();
  const [sidebarPinned, setSidebarPinned] = useState(() => readPinned("lynapp:sidebar-pinned"));
  const [tabsPinned, setTabsPinned] = useState(() => readPinned("lynapp:tabs-pinned"));
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tabsOpen, setTabsOpen] = useState(true);
  const sidebarHovered = useRef(false);
  const sidebarFocused = useRef(false);
  const sidebarTimer = useRef<number | null>(null);
  const tabsHovered = useRef(false);
  const tabsTimer = useRef<number | null>(null);

  const clearSidebarTimer = (): void => {
    if (sidebarTimer.current !== null) {
      window.clearTimeout(sidebarTimer.current);
      sidebarTimer.current = null;
    }
  };

  const clearTabsTimer = (): void => {
    if (tabsTimer.current !== null) {
      window.clearTimeout(tabsTimer.current);
      tabsTimer.current = null;
    }
  };

  const scheduleSidebarClose = (delay: number): void => {
    clearSidebarTimer();
    sidebarTimer.current = window.setTimeout(() => {
      sidebarTimer.current = null;
      if (!sidebarHovered.current && !sidebarFocused.current) setSidebarOpen(false);
    }, delay);
  };

  const scheduleTabsClose = (delay: number): void => {
    clearTabsTimer();
    tabsTimer.current = window.setTimeout(() => {
      tabsTimer.current = null;
      if (!tabsHovered.current) setTabsOpen(false);
    }, delay);
  };

  useEffect(() => {
    if (section !== "instances") return;
    if (sidebarPinned || layoutEditing) {
      clearSidebarTimer();
      setSidebarOpen(true);
    } else {
      setSidebarOpen(true);
      scheduleSidebarClose(INITIAL_HIDE_MS);
    }
    return clearSidebarTimer;
  }, [section, sidebarPinned, layoutEditing]);

  useEffect(() => {
    if (section !== "instances") return;
    if (tabsPinned || layoutEditing) {
      clearTabsTimer();
      setTabsOpen(true);
    } else {
      setTabsOpen(true);
      scheduleTabsClose(INITIAL_HIDE_MS);
    }
    return clearTabsTimer;
  }, [section, tabsPinned, layoutEditing]);

  useEffect(() => {
    if (dragZone === "sidebar") {
      clearSidebarTimer();
      setSidebarOpen(true);
    }
  }, [dragZone]);

  const toggleSidebarPin = (): void => setSidebarPinned((current) => {
    const next = !current;
    writePinned("lynapp:sidebar-pinned", next);
    if (next) {
      clearSidebarTimer();
      setSidebarOpen(true);
    }
    return next;
  });

  const toggleTabsPin = (): void => setTabsPinned((current) => {
    const next = !current;
    writePinned("lynapp:tabs-pinned", next);
    if (next) {
      clearTabsTimer();
      setTabsOpen(true);
    }
    return next;
  });

  const onSidebarEnter = (): void => {
    sidebarHovered.current = true;
    clearSidebarTimer();
    setSidebarOpen(true);
  };

  const onSidebarLeave = (): void => {
    sidebarHovered.current = false;
    const hasOpenDropdown = Boolean(document.querySelector(".instance-sidebar .dropdown-popup"));
    if (!sidebarPinned && !layoutEditing && dragZone !== "sidebar" && !hasOpenDropdown) scheduleSidebarClose(LEAVE_HIDE_MS);
  };

  const onSidebarFocusChange = (focused: boolean): void => {
    sidebarFocused.current = focused;
    if (focused) {
      clearSidebarTimer();
      setSidebarOpen(true);
    } else if (!sidebarHovered.current && !sidebarPinned && !layoutEditing && dragZone !== "sidebar") {
      scheduleSidebarClose(LEAVE_HIDE_MS);
    }
  };

  const onTabsEnter = (): void => {
    tabsHovered.current = true;
    clearTabsTimer();
    setTabsOpen(true);
  };

  const onTabsLeave = (): void => {
    tabsHovered.current = false;
    if (!tabsPinned && !layoutEditing) scheduleTabsClose(LEAVE_HIDE_MS);
  };

  const sidebarDrawerMode = !sidebarPinned && !layoutEditing;
  const sidebarVisible = !sidebarDrawerMode || sidebarOpen || dragZone === "sidebar";
  const tabsDrawerMode = !tabsPinned && !layoutEditing;
  const tabsExpanded = !tabsDrawerMode || tabsOpen;
  const place = selected ? navLayout.launchPlace : "header";
  const boardTab = boardForView("instances", instanceTab) !== null;
  const tabClasses = [boardTab ? "tab-board" : "settings-surface", tabExiting ? "tab-exiting" : ""].filter(Boolean).join(" ");
  const sidebarRight = navLayout.sidebarSide === "right";
  const workspaceClasses = [
    "instances-workspace",
    sectionExiting ? "section-exiting" : "",
    sidebarRight ? "sidebar-right" : "",
    sidebarDrawerMode ? "sidebar-drawer-mode" : "",
    sidebarDrawerMode && sidebarVisible ? "sidebar-drawer-open" : ""
  ].filter(Boolean).join(" ");

  return (
    section === "instances" && (
      <main className={workspaceClasses} style={{ "--sidebar-width": `${navLayout.sidebarWidth}px` } as CSSProperties}>
        {sidebarDrawerMode && !sidebarVisible ? (
          <div
            className={sidebarRight ? "sidebar-hover-zone right" : "sidebar-hover-zone left"}
            onMouseEnter={onSidebarEnter}
            onClick={onSidebarEnter}
            title={t("Hover to open instances", "Наведите, чтобы открыть инстанции")}
          >
            <span className="sidebar-edge-pill" aria-hidden="true" />
          </div>
        ) : null}
        <InstanceSidebar
          drawerMode={sidebarDrawerMode}
          open={sidebarVisible}
          pinned={sidebarPinned}
          onTogglePin={toggleSidebarPin}
          onHoverEnter={onSidebarEnter}
          onHoverLeave={onSidebarLeave}
          onFocusChange={onSidebarFocusChange}
        />

        <section className={`instance-workspace launch-at-${place}`}>
          <header className="workspace-header">
            <div>
              <span className="eyebrow">{headerStatus.trim() ? (selected?.name ?? t("No instance selected", "Инстанция не выбрана")) : t("Instance", "Инстанция")}</span>
              {headerStatus.trim() ? <h2 key="status-promoted" className="status-promoted" title={headerStatus}>{headerStatus}</h2> : <h2 key="instance-name" title={selected?.name}>{selected?.name ?? t("No instance selected", "Инстанция не выбрана")}</h2>}
              {headerStatus.trim() ? null : <span className="status-line">{headerStatus}</span>}
            </div>
            {place === "header" ? <LaunchSlot /> : null}
          </header>
          {selected ? <div className={["instance-body", `tabs-${navLayout.tabsSide}`, tabsDrawerMode ? "tabs-auto" : "", !tabsExpanded ? "tabs-collapsed" : ""].filter(Boolean).join(" ")}>
            <InstanceTabsNav
              autoMode={tabsDrawerMode}
              expanded={tabsExpanded}
              pinned={tabsPinned}
              onTogglePin={toggleTabsPin}
              onHoverEnter={onTabsEnter}
              onHoverLeave={onTabsLeave}
            />
            <div className="instance-tab-content">
              <section className={tabClasses} key={instanceTab}>
                <GeneralTab />
                <VersionsTab />
                <FilesTab />
                <WorldsTab />
                <ServersTab />
                <ScreenshotsTab />
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
