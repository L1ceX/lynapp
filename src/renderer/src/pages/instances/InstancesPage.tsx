import { Boxes, Play, Square, X } from "lucide-react";
import { useApp } from "../../state/context";
import { ContentTab } from "./ContentTab";
import { FilesTab } from "./FilesTab";
import { GeneralTab } from "./GeneralTab";
import { InstanceSidebar } from "./InstanceSidebar";
import { LogsTab } from "./LogsTab";
import { RuntimeTab } from "./RuntimeTab";
import { VersionsTab } from "./VersionsTab";

export function InstancesPage() {
  const { busy, cancelSelected, headerStatus, instanceTab, instanceTabs, isLaunching, isSelectedRunning, launchSelected, section, sectionExiting, selected, stopSelected, switchTab, t, tabExiting } = useApp();
  return (
    section === "instances" && (
        <main className={sectionExiting ? "instances-workspace section-exiting" : "instances-workspace"}>
          <InstanceSidebar />

          <section className="instance-workspace">
            <header className="workspace-header"><div><span className="eyebrow">{headerStatus.trim() ? (selected?.name ?? t("No instance selected", "Инстанция не выбрана")) : t("Instance", "Инстанция")}</span>{headerStatus.trim() ? <h2 key="status-promoted" className="status-promoted">{headerStatus}</h2> : <h2 key="instance-name">{selected?.name ?? t("No instance selected", "Инстанция не выбрана")}</h2>}{headerStatus.trim() ? null : <span className="status-line">{headerStatus}</span>}</div>{isLaunching ? <button className="primary-button launch-button running" onClick={cancelSelected}><X size={16} /> {t("Cancel", "Отмена")}</button> : <button className={isSelectedRunning ? "primary-button launch-button running" : "primary-button launch-button"} disabled={!selected || busy} onClick={isSelectedRunning ? stopSelected : launchSelected}>{isSelectedRunning ? <><Square size={16} /> {t("Stop", "Остановить")}</> : <><Play size={17} /> {t("Launch", "Запустить")}</>}</button>}</header>
            {selected ? <>
              <nav className="instance-tabs" aria-label={t("Instance settings", "Настройки инстанции")}>{instanceTabs.map(({ id, label, icon: Icon }) => <button key={id} className={instanceTab === id ? "tab-button active" : "tab-button"} onClick={() => switchTab(id)}><Icon size={16} />{label}</button>)}</nav>
              <section className={tabExiting ? "settings-surface tab-exiting" : "settings-surface"} key={instanceTab}>
                <GeneralTab />
                <VersionsTab />
                <FilesTab />
                <RuntimeTab />
                <LogsTab />
                <ContentTab />
              </section>
            </> : <div className="blank-workspace"><Boxes size={34} /><h2>{t("Select an instance", "Выберите инстанцию")}</h2></div>}
          </section>
        </main>
      )
  );
}
