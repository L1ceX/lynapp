import { Check, Copy, Download, Minus, RefreshCw, Square, X } from "lucide-react";
import appIcon from "../assets/icon.png";
import { getLauncherApi } from "../lib/api";
import { useApp } from "../state/context";

export function Titlebar() {
  const { downloadUpdate, installUpdate, maximized, t, update } = useApp();
  return (
    <header className="titlebar" onDoubleClick={() => void getLauncherApi().toggleMaximize()}>
        <div className="titlebar-brand"><img src={appIcon} alt="" /><span>lynapp</span></div>
        <div className="titlebar-controls" onDoubleClick={(event) => event.stopPropagation()}>
          {update?.kind === "available" ? <button type="button" className="titlebar-button titlebar-update" onClick={() => void downloadUpdate()} title={t(`Download lynapp ${update.version ?? ""}`.trim(), `Скачать lynapp ${update.version ?? ""}`.trim())}><Download size={14} /> {t("Update", "Обновление")}{update.version ? ` ${update.version}` : ""}</button> : null}
          {update?.kind === "downloading" ? <button type="button" className="titlebar-button titlebar-update" disabled title={t("Downloading update", "Загрузка обновления")}><RefreshCw size={14} className="spin" /> {update.percent ?? 0}%</button> : null}
          {update?.kind === "ready" ? <button type="button" className="titlebar-button titlebar-update" onClick={() => void installUpdate()} title={t("Restart to install the update", "Перезапустите, чтобы установить обновление")}><Check size={14} /> {t("Restart", "Перезапустить")}</button> : null}
          <button type="button" className="titlebar-button" onClick={() => void getLauncherApi().minimizeWindow()} aria-label={t("Minimize", "Свернуть")} title={t("Minimize", "Свернуть")}><Minus size={16} /></button>
          <button type="button" className="titlebar-button" onClick={() => void getLauncherApi().toggleMaximize()} aria-label={maximized ? t("Restore", "Восстановить") : t("Maximize", "Развернуть")} title={maximized ? t("Restore", "Восстановить") : t("Maximize", "Развернуть")}>{maximized ? <Copy size={13} /> : <Square size={13} />}</button>
          <button type="button" className="titlebar-button titlebar-close" onClick={() => void getLauncherApi().closeWindow()} aria-label={t("Close", "Закрыть")} title={t("Close", "Закрыть")}><X size={16} /></button>
        </div>
      </header>
  );
}
