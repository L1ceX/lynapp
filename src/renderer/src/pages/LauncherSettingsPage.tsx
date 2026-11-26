import { CheckCircle2, CircleAlert, Cpu, Download, FolderOpen, Gamepad2, Globe, Layers3, PackageSearch, Play, RefreshCw, Save, Settings, Sparkles, XCircle } from "lucide-react";
import type { UpdateEdition } from "@shared/types";
import { Board } from "../components/Board";
import { Dropdown } from "../components/Dropdown";
import { MemorySlider } from "../components/inputs";
import { VERSION_TYPE_ROWS } from "../constants";
import { useApp } from "../state/context";

export function LauncherSettingsPage() {
  const { section } = useApp();
  return section === "launcher" ? <LauncherSettingsContent /> : null;
}

function LauncherSettingsContent() {
  const { afterLaunchLabel, afterLaunchOptions, bootstrap, downloadUpdate, installUpdate, javaAction, javaBusy, javaInstalls, lang, saveSettings, sectionExiting, setAfterLaunch, setLanguage, setSettingFlag, setSettingsDraft, setUpdateEdition, setVersionTypeFlag, settingsDraft, status, t, update, versionTypes } = useApp();
  const runningEdition: UpdateEdition = bootstrap.appVersion.startsWith("2.") ? "tauri" : "electron";
  const selectedEdition: UpdateEdition = settingsDraft.updateEdition ?? runningEdition;
  const tauriVer = update?.latestTauri?.version ?? null;
  const electronVer = update?.latestElectron?.version ?? null;
  const isSwitch = update?.kind === "available" && update.edition && update.edition !== runningEdition;
  const blocks = {
    language: <div className="settings-content"><div className="surface-heading"><Globe size={19} /><div><h3>{t("Language", "Язык")}</h3><span>{t("Interface language.", "Язык интерфейса.")}</span></div></div><label>{t("Language", "Язык")}<Dropdown value={lang === "ru" ? "Русский" : "English"} options={["English", "Русский"]} ariaLabel={t("Language", "Язык")} onChange={(label) => void setLanguage(label === "Русский" ? "ru" : "en")} /></label></div>,
    afterLaunch: <div className="settings-content"><div className="surface-heading"><Play size={19} /><div><h3>{t("After the game starts", "После запуска игры")}</h3><span>{t("What the launcher does once Minecraft is running.", "Что делает лаунчер, когда Minecraft запущен.")}</span></div></div><label>{t("Launcher window", "Окно лаунчера")}<Dropdown value={afterLaunchLabel(settingsDraft.afterLaunch ?? "keep")} options={afterLaunchOptions.map((option) => afterLaunchLabel(option))} ariaLabel={t("After the game starts", "После запуска игры")} onChange={(label) => { const found = afterLaunchOptions.find((option) => afterLaunchLabel(option) === label); if (found) void setAfterLaunch(found); }} /></label><span className="muted">{settingsDraft.afterLaunch === "hide" ? t("The window hides to the system tray and comes back by itself when the game closes. Click the tray icon to open it earlier.", "Окно уходит в трей и само возвращается, когда игра закроется. Чтобы открыть раньше, нажмите на значок в трее.") : settingsDraft.afterLaunch === "close" ? t("The launcher closes a couple of seconds after the game starts. The game keeps running.", "Лаунчер закроется через пару секунд после старта игры. Игра продолжит работать.") : t("The launcher stays open while you play.", "Лаунчер остаётся открытым, пока вы играете.")}</span></div>,
    discord: <div className="settings-content"><div className="surface-heading"><Gamepad2 size={19} /><div><h3>Discord</h3><span>{t("Show what you are playing in your Discord profile.", "Показывать в профиле Discord, во что вы играете.")}</span></div></div><div className="filter-row effects-row"><div><strong>{t("Activity status", "Статус активности")}</strong><span className="muted">{t("The instance, game version and play time.", "Инстанция, версия игры и время в игре.")}</span></div><button type="button" className="switch" role="switch" aria-checked={settingsDraft.discordPresence ?? true} aria-label={t("Activity status", "Статус активности")} onClick={() => void setSettingFlag("discordPresence", !(settingsDraft.discordPresence ?? true))}><span className="knob" /></button></div><div className={(settingsDraft.discordPresence ?? true) ? "filter-row effects-row" : "filter-row effects-row off"}><div><strong>{t("Hide instance name", "Скрывать название инстанции")}</strong><span className="muted">{t("Only the game version and loader are shown.", "Показываются только версия игры и загрузчик.")}</span></div><button type="button" className="switch" role="switch" aria-checked={settingsDraft.discordHideInstance ?? false} disabled={!(settingsDraft.discordPresence ?? true)} aria-label={t("Hide instance name", "Скрывать название инстанции")} onClick={() => void setSettingFlag("discordHideInstance", !(settingsDraft.discordHideInstance ?? false))}><span className="knob" /></button></div><span className="muted">{settingsDraft.afterLaunch === "close" ? t("The launcher closes after the game starts, so the status disappears from Discord together with it.", "Лаунчер закрывается после запуска игры, поэтому статус в Discord пропадает вместе с ним.") : t("Discord must be running on this computer.", "Discord должен быть запущен на этом компьютере.")}</span></div>,
    updates: (
      <div className="settings-content">
        <div className="surface-heading"><RefreshCw size={19} /><div><h3>{t("Updates", "Обновления")}</h3><span>{t("Choose Rust 2.x or Electron 1.x edition and update track.", "Выберите редакцию Rust 2.x или Electron 1.x и канал обновлений.")}</span></div></div>
        <div className="update-edition-grid">
          <button type="button" className={selectedEdition === "tauri" ? "update-edition-card active" : "update-edition-card"} onClick={() => void setUpdateEdition("tauri")}>
            <div className="update-edition-head">
              <strong>Rust (2.x)</strong>
              {runningEdition === "tauri" ? <span className="update-edition-tag">{t("Current", "Текущая")}</span> : null}
            </div>
            <span className="muted">{tauriVer ? t(`Latest: ${tauriVer}`, `Последняя: ${tauriVer}`) : t("Lightweight (~5.5 MB)", "Лёгкая (~5.5 МБ)")}</span>
          </button>
          <button type="button" className={selectedEdition === "electron" ? "update-edition-card active" : "update-edition-card"} onClick={() => void setUpdateEdition("electron")}>
            <div className="update-edition-head">
              <strong>Electron (1.x)</strong>
              {runningEdition === "electron" ? <span className="update-edition-tag">{t("Current", "Текущая")}</span> : null}
            </div>
            <span className="muted">{electronVer ? t(`Latest: ${electronVer}`, `Последняя: ${electronVer}`) : t("Classic edition", "Классическая версия")}</span>
          </button>
        </div>
        <div className="update-action-row">
          {update?.kind === "available" ? (
            <button type="button" className="primary-button" onClick={() => void downloadUpdate(update.edition)}>
              <Download size={15} /> {isSwitch
                ? t(`Switch to ${update.edition === "tauri" ? "Rust" : "Electron"} ${update.version ?? ""}`, `Перейти на ${update.edition === "tauri" ? "Rust" : "Electron"} ${update.version ?? ""}`)
                : t(`Download ${update.version ?? ""}`, `Скачать ${update.version ?? ""}`)}
            </button>
          ) : update?.kind === "downloading" ? (
            <span className="muted"><RefreshCw size={14} className="spin" /> {t("Downloading", "Загрузка")} {update.version ?? ""} · {update.percent ?? 0}%</span>
          ) : update?.kind === "ready" ? (
            <button type="button" className="primary-button" onClick={() => void installUpdate()}>
              <Sparkles size={15} /> {t(`Install ${update.version ?? ""}`, `Установить ${update.version ?? ""}`)}
            </button>
          ) : update?.kind === "checking" ? (
            <span className="muted"><RefreshCw size={14} className="spin" /> {t("Checking for updates...", "Проверка обновлений...")}</span>
          ) : update?.kind === "error" ? (
            <span className="muted" title={update.message}><CircleAlert size={14} /> {t("Update check failed", "Ошибка проверки обновлений")}</span>
          ) : (
            <span className="muted"><CheckCircle2 size={14} /> {t("You have the latest version", "Установлена последняя версия")}</span>
          )}
        </div>
        <div className="filter-row effects-row"><div><strong>{t("Beta versions", "Бета-версии")}</strong><span className="muted">{t("Offer test builds with new features before the stable release. They may contain bugs.", "Предлагать тестовые сборки с новыми функциями до стабильного релиза. В них возможны ошибки.")}</span></div><button type="button" className="switch" role="switch" aria-checked={settingsDraft.betaUpdates ?? false} aria-label={t("Beta versions", "Бета-версии")} onClick={() => void setSettingFlag("betaUpdates", !(settingsDraft.betaUpdates ?? false))}><span className="knob" /></button></div>
        <span className="muted">{(settingsDraft.betaUpdates ?? false) ? t("After turning betas off you stay on the current version until a newer stable release comes out.", "Если отключить бета-версии, текущая версия останется до выхода более новой стабильной.") : t("Only stable releases are offered.", "Предлагаются только стабильные релизы.")}</span>
      </div>
    ),
    content: <div className="settings-content"><div className="surface-heading"><PackageSearch size={19} /><div><h3>{t("Mods and dependencies", "Моды и зависимости")}</h3><span>{t("How mods are installed from the catalog.", "Установка модов из каталога.")}</span></div></div><div className="filter-row effects-row"><div><strong>{t("Auto-install dependencies", "Автоскачивание зависимостей")}</strong><span className="muted">{t("Download required libraries and APIs automatically without confirmation.", "Автоматически скачивать обязательные библиотеки и API без окна подтверждения.")}</span></div><button type="button" className="switch" role="switch" aria-checked={settingsDraft.autoInstallDependencies ?? false} aria-label={t("Auto-install dependencies", "Автоскачивание зависимостей")} onClick={() => void setSettingFlag("autoInstallDependencies", !(settingsDraft.autoInstallDependencies ?? false))}><span className="knob" /></button></div><span className="muted">{(settingsDraft.autoInstallDependencies ?? false) ? t("Required dependencies are installed automatically together with the mod.", "Обязательные зависимости устанавливаются автоматически вместе с модом.") : t("Before installing a mod with dependencies, a window opens where you can select them.", "Перед установкой мода с зависимостями открывается окно выбора зависимостей.")}</span></div>,
    versionTypes: <div className="settings-content"><div className="surface-heading"><Layers3 size={19} /><div><h3>{t("Game versions", "Версии игры")}</h3><span>{t("Which Minecraft versions appear in the version lists.", "Какие версии Minecraft показывать в списках версий.")}</span></div></div><div className="effects-list">{VERSION_TYPE_ROWS.map((row) => { const on = versionTypes[row.id]; const last = on && Object.values(versionTypes).filter(Boolean).length === 1; return <div key={row.id} className="filter-row effects-row"><div><strong>{t(row.label, row.labelRu)}</strong><span className="muted">{t(row.hint, row.hintRu)}</span></div><button type="button" className="switch" role="switch" aria-checked={on} disabled={last} title={last ? t("At least one type must stay on", "Хотя бы один тип должен остаться включённым") : undefined} aria-label={t(row.label, row.labelRu)} onClick={() => void setVersionTypeFlag(row.id, !on)}><span className="knob" /></button></div>; })}</div><span className="muted">{t("Loaders support only some of these: Forge and NeoForge work with releases, Fabric and Quilt also with many snapshots. Very old versions run without mods.", "Загрузчики поддерживают не всё: Forge и NeoForge работают с релизами, Fabric и Quilt ещё и со многими снапшотами. Очень старые версии запускаются без модов.")}</span></div>,
    memory: <><div className="settings-content"><div className="surface-heading"><Settings size={19} /><div><h3>{t("Memory", "Память")}</h3><span>{t("Default allocated RAM for instances.", "Объём памяти по умолчанию для инстанций.")}</span></div></div><label>{t("Allocated RAM", "Объём памяти")}<MemorySlider label={t("Allocated RAM", "Объём памяти")} value={settingsDraft.maxMemoryMb} max={bootstrap.maxMemoryMb} totalMb={bootstrap.systemMemoryMb} totalOfLabel={t("of", "из")} onChange={(next) => setSettingsDraft({ ...settingsDraft, maxMemoryMb: next })} /></label><label>{t("Extra JVM flags", "Дополнительные флаги JVM")}<textarea value={settingsDraft.extraJvmArgs} rows={2} spellCheck={false} placeholder="-XX:+UseG1GC -XX:MaxGCPauseMillis=50" onChange={(event) => setSettingsDraft({ ...settingsDraft, extraJvmArgs: event.target.value })} /></label></div><button className="primary-button save-button" onClick={saveSettings}><Save size={16} /> {t("Save settings", "Сохранить настройки")}</button></>,
    java: <div className="settings-content"><div className="surface-heading"><Cpu size={19} /><div><h3>{t("Java installations", "Установленные версии Java")}</h3><span>{t("One runtime per Minecraft requirement. The launcher picks the right one automatically.", "Для каждого требования Minecraft — своя среда выполнения. Программа сама выберет подходящую.")}</span></div></div><div className="java-rows">{javaInstalls ? javaInstalls.map((installation) => <div key={installation.major} className="java-row"><div className="java-row-head"><strong>Java {installation.major} {t("location", "путь")}</strong>{installation.valid ? <CheckCircle2 size={17} className="java-status ok" /> : <XCircle size={17} className="java-status bad" />}</div><input value={installation.path} readOnly placeholder={t("Not installed", "Не установлена")} /><div className="java-actions"><button onClick={() => void javaAction(installation.major, "install")} disabled={javaBusy !== null}><Download size={15} /> {t("Install recommended", "Установить рекомендуемую")}</button><button onClick={() => void javaAction(installation.major, "detect")} disabled={javaBusy !== null}><RefreshCw size={15} /> {t("Detect", "Найти")}</button><button onClick={() => void javaAction(installation.major, "browse")} disabled={javaBusy !== null}><FolderOpen size={15} /> {t("Browse", "Выбрать")}</button></div><small className="muted">{javaBusy === installation.major ? t("Working...", "Выполняется...") : installation.message}</small></div>) : <span className="muted">{t("Loading Java installations...", "Загрузка установленных версий Java...")}</span>}</div></div>
  };
  return (
    <main className={sectionExiting ? "page-workspace section-exiting" : "page-workspace"}>
      <header className="workspace-header"><div><span className="eyebrow">{t("Application", "Приложение")}</span><h2>{t("Launcher settings", "Настройки лаунчера")}</h2><span className="status-line">{status}</span></div></header>
      <Board id="launcher" blocks={blocks} />
    </main>
  );
}
