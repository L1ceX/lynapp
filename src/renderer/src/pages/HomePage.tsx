import { Box, Play, Plus, SlidersHorizontal, Square, X } from "lucide-react";
import { useApp } from "../state/context";

export function HomePage() {
  const { bootstrap, busy, cancelSelected, instanceStatus, isLaunching, isSelectedRunning, lastActivity, launchSelected, runningIds, section, sectionExiting, selected, status, stopSelected, switchSection, t, totalMods } = useApp();
  return (
    section === "home" && (
        <main className={sectionExiting ? "page-workspace section-exiting" : "page-workspace"}>
          <header className="workspace-header"><div><span className="eyebrow">{t("Home", "Главная")}</span><h2>{t("Welcome back", "С возвращением")}</h2><span className="status-line">{selected !== null ? instanceStatus[selected.id] ?? status : status}</span></div></header>
          <section className="settings-surface narrow-surface"><div className="settings-content"><div className="surface-heading"><Box size={19} /><div><h3>{selected?.name ?? t("No instance yet", "Инстанций пока нет")}</h3><span>{selected ? `${selected.gameVersion} / ${selected.loader}${selected.loaderVersion ? ` ${selected.loaderVersion}` : ""}` : t("Create an instance to start playing.", "Создайте инстанцию, чтобы начать играть")}</span></div></div><div className="button-row">{isLaunching ? <button className="primary-button launch-button running" onClick={cancelSelected}><X size={16} /> {t("Cancel", "Отмена")}</button> : <button className={isSelectedRunning ? "primary-button launch-button running" : "primary-button launch-button"} disabled={!selected || busy} onClick={isSelectedRunning ? stopSelected : launchSelected}>{isSelectedRunning ? <><Square size={16} /> {t("Stop", "Остановить")}</> : <><Play size={17} /> {t("Launch", "Запустить")}</>}</button>}{selected ? <button onClick={() => switchSection("instances")}><SlidersHorizontal size={16} /> {t("Manage instance", "Настроить инстанцию")}</button> : <button className="primary-button" onClick={() => switchSection("instances")}><Plus size={16} /> {t("New instance", "Новая инстанция")}</button>}</div></div></section>
          <div className="stat-grid anim-stagger"><div className="stat-card"><span className="stat-value">{bootstrap.instances.length}</span><span className="stat-label">{t("Instances", "Инстанции")}</span></div><div className="stat-card"><span className="stat-value">{totalMods}</span><span className="stat-label">{t("Mods installed", "Установлено модов")}</span></div><div className="stat-card"><span className="stat-value">{runningIds.length}</span><span className="stat-label">{t("Running now", "Запущено сейчас")}</span></div><div className="stat-card"><span className="stat-value">{lastActivity || "—"}</span><span className="stat-label">{t("Last activity", "Последняя активность")}</span></div></div>
        </main>
      )
  );
}
