import { useState } from "react";
import { Box, CheckCircle2, ChevronRight, CircleAlert, Download, FolderOpen, Gamepad2, Layers3, Play, Plus, RefreshCw, SlidersHorizontal, Sparkles, Square, UserRoundCog, X } from "lucide-react";
import { SkinHead } from "../../components/skins";
import { formatRelative } from "../../lib/format";
import { useApp } from "../../state/context";
import type { HomeWidgetId } from "./layout";

function ContinueWidget() {
  const { busy, cancelSelected, isLaunching, isSelectedRunning, launchSelected, openSelectedFolder, selected, stopSelected, switchSection, t } = useApp();
  return (
    <div className="widget-body widget-continue">
      <div className="widget-title"><Box size={18} /><span>{t("Continue playing", "Продолжить игру")}</span></div>
      <div className="widget-continue-main">
        <h3>{selected?.name ?? t("No instance yet", "Инстанций пока нет")}</h3>
        <span className="muted">{selected ? `${selected.gameVersion} / ${selected.loader}${selected.loaderVersion ? ` ${selected.loaderVersion}` : ""}` : t("Create an instance to start playing.", "Создайте инстанцию, чтобы начать играть")}</span>
      </div>
      <div className="button-row">
        {isLaunching ? <button className="primary-button launch-button running" onClick={cancelSelected}><X size={16} /> {t("Cancel", "Отмена")}</button> : <button className={isSelectedRunning ? "primary-button launch-button running" : "primary-button launch-button"} disabled={!selected || busy} onClick={isSelectedRunning ? stopSelected : launchSelected}>{isSelectedRunning ? <><Square size={16} /> {t("Stop", "Остановить")}</> : <><Play size={17} /> {t("Launch", "Запустить")}</>}</button>}
        {selected ? <><button className="continue-manage-btn" onClick={() => switchSection("instances")}><SlidersHorizontal size={16} /> <span>{t("Manage instance", "Настроить инстанцию")}</span></button><button type="button" className="continue-folder-btn" onClick={() => void openSelectedFolder()} title={t("Open instance folder", "Открыть папку инстанции")} aria-label={t("Open instance folder", "Открыть папку инстанции")}><FolderOpen size={16} /></button></> : <button className="primary-button" onClick={() => switchSection("instances")}><Plus size={16} /> {t("New instance", "Новая инстанция")}</button>}
      </div>
    </div>
  );
}

function StatWidget({ kind }: { kind: "statInstances" | "statMods" | "statRunning" | "statActivity" }) {
  const { bootstrap, lastActivity, runningIds, t, totalMods } = useApp();
  const value = kind === "statInstances" ? String(bootstrap.instances.length) : kind === "statMods" ? String(totalMods) : kind === "statRunning" ? String(runningIds.length) : lastActivity || "—";
  const label = kind === "statInstances" ? t("Instances", "Инстанции") : kind === "statMods" ? t("Mods installed", "Установлено модов") : kind === "statRunning" ? t("Running now", "Сейчас запущено") : t("Last activity", "Последняя активность");
  return (
    <div className="widget-body stat-card widget-stat">
      <span className="stat-value" title={value}>{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function RecentWidget() {
  const { bootstrap, busy, lang, launchingIds, launchInstanceById, runningIds, setSelectedId, stopInstanceById, switchSection, t } = useApp();
  const recent = [...bootstrap.instances]
    .sort((a, b) => (b.lastPlayedAt ?? b.updatedAt ?? "").localeCompare(a.lastPlayedAt ?? a.updatedAt ?? ""))
    .slice(0, 6);
  return (
    <div className="widget-body widget-recent">
      <div className="widget-title"><Layers3 size={18} /><span>{t("Recent instances", "Недавние инстанции")}</span></div>
      {recent.length ? <div className="widget-list">{recent.map((instance) => {
        const stamp = instance.lastPlayedAt ?? instance.updatedAt;
        const running = runningIds.includes(instance.id);
        const launching = launchingIds.includes(instance.id);
        return (
          <div key={instance.id} className={running ? "widget-list-item running" : "widget-list-item"}>
            <button type="button" className="widget-list-row" onClick={() => { setSelectedId(instance.id); switchSection("instances"); }}>
              <Box size={16} />
              <span className="widget-list-main"><strong>{instance.name}</strong><small className="muted">{instance.gameVersion} / {instance.loader}{stamp ? ` · ${formatRelative(stamp, lang)}` : ""}</small></span>
              {running ? <span className="tag-chip widget-running">{t("Running", "Запущена")}</span> : null}
              <ChevronRight size={15} className="widget-list-chevron" />
            </button>
            <button type="button" className={running ? "widget-quick-play stop" : "widget-quick-play"} disabled={busy || launching} title={running ? t(`Stop ${instance.name}`, `Остановить ${instance.name}`) : t(`Launch ${instance.name}`, `Запустить ${instance.name}`)} aria-label={running ? t("Stop", "Остановить") : t("Launch", "Запустить")} onClick={(event) => { event.stopPropagation(); setSelectedId(instance.id); void (running ? stopInstanceById(instance.id) : launchInstanceById(instance)); }}>{launching ? <RefreshCw size={13} className="spin" /> : running ? <Square size={12} /> : <Play size={13} />}</button>
          </div>
        );
      })}</div> : <span className="muted">{t("No instances yet.", "Инстанций пока нет.")}</span>}
    </div>
  );
}

function AccountWidget() {
  const { accountSkinUrl, activeAccount, switchSection, t } = useApp();
  const [failedSkinUrl, setFailedSkinUrl] = useState<string | null>(null);
  const kind = activeAccount?.kind === "microsoft" ? "Microsoft" : activeAccount?.kind === "ely" ? "Ely.by" : activeAccount ? t("Offline", "Офлайн") : "";
  const name = activeAccount?.profileName ?? t("No account", "Нет аккаунта");
  const showSkin = Boolean(accountSkinUrl && failedSkinUrl !== accountSkinUrl);
  return (
    <div className="widget-body widget-account">
      <div className="widget-title"><UserRoundCog size={18} /><span>{t("Account", "Аккаунт")}</span></div>
      <div className="widget-account-main">
        <span className={showSkin ? "widget-avatar widget-avatar-skin" : "widget-avatar"}>{showSkin && accountSkinUrl ? <SkinHead dataUrl={accountSkinUrl} className="widget-avatar-canvas" onError={() => setFailedSkinUrl(accountSkinUrl)} /> : (name.trim()[0]?.toUpperCase() ?? "?")}</span>
        <span className="widget-list-main"><strong>{name}</strong><small className="muted">{kind || t("Add an account to play", "Добавьте аккаунт, чтобы играть")}</small></span>
      </div>
      <button type="button" onClick={() => switchSection("accounts")}>{t("Accounts", "Аккаунты")} <ChevronRight size={15} /></button>
    </div>
  );
}

function LauncherWidget() {
  const { bootstrap, checkLauncherUpdates, downloadUpdate, installUpdate, settingsDraft, setSettingFlag, setUpdateEdition, t, update } = useApp();
  const beta = settingsDraft.betaUpdates ?? false;
  const runningEdition = bootstrap.appVersion.startsWith("2.") ? "tauri" : "electron";
  const selectedEdition = settingsDraft.updateEdition ?? runningEdition;
  const isSwitch = update?.kind === "available" && update.edition && update.edition !== runningEdition;
  return (
    <div className="widget-body widget-launcher">
      <div className="widget-title"><Gamepad2 size={18} /><span>lynapp {bootstrap.appVersion}</span></div>
      <div className="widget-edition-row">
        <button type="button" className={selectedEdition === "tauri" ? "widget-edition-btn active" : "widget-edition-btn"} onClick={() => void setUpdateEdition("tauri")}>
          <strong>Rust</strong><span>{update?.latestTauri?.version ?? "2.x"}</span>
        </button>
        <button type="button" className={selectedEdition === "electron" ? "widget-edition-btn active" : "widget-edition-btn"} onClick={() => void setUpdateEdition("electron")}>
          <strong>Electron</strong><span>{update?.latestElectron?.version ?? "1.x"}</span>
        </button>
      </div>
      <div className="widget-launcher-status">
        {update?.kind === "available" ? <button type="button" className="primary-button" onClick={() => void downloadUpdate(update.edition)}><Download size={15} /> {isSwitch ? t(`Switch to ${update.version ?? ""}`, `Перейти на ${update.version ?? ""}`) : t(`Download ${update.version ?? ""}`, `Скачать ${update.version ?? ""}`)}</button>
          : update?.kind === "downloading" ? <span className="muted"><RefreshCw size={14} className="spin" /> {t("Downloading", "Загрузка")} {update.percent ?? 0}%</span>
            : update?.kind === "ready" ? <button type="button" className="primary-button" onClick={() => void installUpdate()}><Sparkles size={15} /> {t("Restart to update", "Перезапустить и обновить")}</button>
              : update?.kind === "checking" ? <span className="muted"><RefreshCw size={14} className="spin" /> {t("Checking for updates...", "Проверка обновлений...")}</span>
                : update?.kind === "error" ? <span className="muted" title={update.message}><CircleAlert size={14} /> {t("Update failed", "Ошибка обновления")}</span>
                  : <span className="muted"><CheckCircle2 size={14} /> {t("You have the latest version", "Установлена последняя версия")}</span>}
        <button type="button" className="update-refresh-btn" onClick={() => void checkLauncherUpdates()} disabled={update?.kind === "checking" || update?.kind === "downloading"} title={t("Check for updates", "Проверить обновления")} aria-label={t("Check for updates", "Проверить обновления")}><RefreshCw size={14} className={update?.kind === "checking" ? "spin" : undefined} /></button>
      </div>
      <div className="filter-row widget-beta"><strong>{t("Beta versions", "Бета-версии")}</strong><button type="button" className="switch" role="switch" aria-checked={beta} aria-label={t("Beta versions", "Бета-версии")} onClick={() => void setSettingFlag("betaUpdates", !beta)}><span className="knob" /></button></div>
    </div>
  );
}

export function HomeWidget({ id }: { id: HomeWidgetId }) {
  switch (id) {
    case "continue":
      return <ContinueWidget />;
    case "account":
      return <AccountWidget />;
    case "recent":
      return <RecentWidget />;
    case "launcher":
      return <LauncherWidget />;
    default:
      return <StatWidget kind={id} />;
  }
}
