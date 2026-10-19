import { House, Layers3, Palette, RefreshCw, Settings, Shirt, UserRoundCog } from "lucide-react";
import { useApp } from "../state/context";

export function IconRail() {
  const { refresh, refreshVersions, section, switchSection, t } = useApp();
  return (
    <aside className="icon-rail" aria-label={t("Launcher navigation", "Навигация")}>
        <nav className="rail-nav">
          <button className={section === "home" ? "rail-button active" : "rail-button"} onClick={() => switchSection("home")} aria-label={t("Home", "Главная")} title={t("Home", "Главная")}><House size={19} /></button>
          <button className={section === "instances" ? "rail-button active" : "rail-button"} onClick={() => switchSection("instances")} aria-label={t("Instances", "Инстанции")} title={t("Instances", "Инстанции")}><Layers3 size={19} /></button>
          <button className={section === "launcher" ? "rail-button active" : "rail-button"} onClick={() => switchSection("launcher")} aria-label={t("Launcher settings", "Настройки лаунчера")} title={t("Launcher settings", "Настройки лаунчера")}><Settings size={19} /></button>
          <button className={section === "visuals" ? "rail-button active" : "rail-button"} onClick={() => switchSection("visuals")} aria-label={t("Visuals", "Оформление")} title={t("Visuals", "Оформление")}><Palette size={19} /></button>
          <button className={section === "skins" ? "rail-button active" : "rail-button"} onClick={() => switchSection("skins")} aria-label={t("Skins", "Скины")} title={t("Skins", "Скины")}><Shirt size={19} /></button>
          <button className={section === "accounts" ? "rail-button active" : "rail-button"} onClick={() => switchSection("accounts")} aria-label={t("Account settings", "Аккаунты")} title={t("Account settings", "Аккаунты")}><UserRoundCog size={19} /></button>
        </nav>
        <button className="rail-button rail-refresh" onClick={() => { void refresh(); void refreshVersions(); }} aria-label={t("Refresh", "Обновить")} title={t("Refresh", "Обновить")}><RefreshCw size={17} /></button>
      </aside>
  );
}
