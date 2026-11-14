import { Archive, FolderOpen, Globe, Play, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorldInfo } from "@shared/types";
import { getLauncherApi } from "../../lib/api";
import { cleanIpcError, formatBytes, formatDateTime } from "../../lib/format";
import { useApp } from "../../state/context";

export function WorldsTab() {
  const { assertNotLaunching, busy, instanceTab, isLaunching, isSelectedRunning, launchSelected, openSelectedFolder, say, selected, setBusy, t } = useApp();
  const [worlds, setWorlds] = useState<WorldInfo[] | null>(null);
  const [expandedFolder, setExpandedFolder] = useState<string | null>(null);
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<string | null>(null);
  const [workingKey, setWorkingKey] = useState<string | null>(null);

  const selectedIdRef = useRef(selected?.id);
  selectedIdRef.current = selected?.id;

  useEffect(() => {
    if (instanceTab !== "worlds" || !selected) return;
    let stale = false;
    setWorlds(null);
    setConfirmDeleteFolder(null);
    setWorkingKey(null);
    void getLauncherApi().listWorlds(selected.id).then((list) => {
      if (!stale) setWorlds(list);
    }).catch((error) => {
      if (!stale) {
        setWorlds([]);
        say(cleanIpcError(error, t("Failed to read worlds", "Не удалось прочитать миры")));
      }
    });
    return () => {
      stale = true;
    };
  }, [instanceTab, selected?.id]);

  if (!selected || instanceTab !== "worlds") return null;

  async function refreshWorlds(): Promise<void> {
    if (!selected) return;
    const instanceId = selected.id;
    setBusy(true);
    try {
      const list = await getLauncherApi().listWorlds(instanceId);
      if (selectedIdRef.current === instanceId) setWorlds(list);
    } catch (error) {
      if (selectedIdRef.current === instanceId) {
        say(cleanIpcError(error, t("Failed to read worlds", "Не удалось прочитать миры")));
      }
    } finally {
      setBusy(false);
    }
  }

  async function createBackup(world: WorldInfo): Promise<void> {
    if (!selected) return;
    const instanceId = selected.id;
    setWorkingKey(`backup:${world.folderName}`);
    say(t(`Creating backup of ${world.name}...`, `Создание бэкапа мира ${world.name}...`));
    try {
      const list = await getLauncherApi().backupWorld(instanceId, world.folderName);
      if (selectedIdRef.current !== instanceId) return;
      setWorlds(list);
      setExpandedFolder(world.folderName);
      say(t(`Backup created for ${world.name}`, `Бэкап мира ${world.name} создан`));
    } catch (error) {
      if (selectedIdRef.current === instanceId) {
        say(cleanIpcError(error, t("Failed to create backup", "Не удалось создать бэкап")));
      }
    } finally {
      if (selectedIdRef.current === instanceId) setWorkingKey(null);
    }
  }

  async function restoreBackup(world: WorldInfo, backupId: string): Promise<void> {
    if (!selected || !assertNotLaunching()) return;
    if (isSelectedRunning) {
      say(t("Stop the instance before restoring a world backup", "Остановите игру перед восстановлением бэкапа мира"));
      return;
    }
    const instanceId = selected.id;
    setWorkingKey(`restore:${backupId}`);
    say(t(`Restoring ${world.name}...`, `Восстановление мира ${world.name}...`));
    try {
      const list = await getLauncherApi().restoreWorldBackup(instanceId, world.folderName, backupId);
      if (selectedIdRef.current !== instanceId) return;
      setWorlds(list);
      say(t(`Restored ${world.name} from backup`, `Мир ${world.name} восстановлен из бэкапа`));
    } catch (error) {
      if (selectedIdRef.current === instanceId) {
        say(cleanIpcError(error, t("Failed to restore backup", "Не удалось восстановить бэкап")));
      }
    } finally {
      if (selectedIdRef.current === instanceId) setWorkingKey(null);
    }
  }

  async function removeBackup(world: WorldInfo, backupId: string): Promise<void> {
    if (!selected) return;
    const instanceId = selected.id;
    setWorkingKey(`delbackup:${backupId}`);
    try {
      const list = await getLauncherApi().deleteWorldBackup(instanceId, world.folderName, backupId);
      if (selectedIdRef.current !== instanceId) return;
      setWorlds(list);
      say(t("Backup deleted", "Бэкап удалён"));
    } catch (error) {
      if (selectedIdRef.current === instanceId) {
        say(cleanIpcError(error, t("Failed to delete backup", "Не удалось удалить бэкап")));
      }
    } finally {
      if (selectedIdRef.current === instanceId) setWorkingKey(null);
    }
  }

  async function removeWorld(world: WorldInfo): Promise<void> {
    if (!selected || !assertNotLaunching()) return;
    if (isSelectedRunning) {
      say(t("Stop the instance before deleting a world", "Остановите игру перед удалением мира"));
      return;
    }
    const instanceId = selected.id;
    setWorkingKey(`delworld:${world.folderName}`);
    try {
      const list = await getLauncherApi().deleteWorld(instanceId, world.folderName);
      if (selectedIdRef.current !== instanceId) return;
      setWorlds(list);
      setConfirmDeleteFolder(null);
      say(t(`Deleted world ${world.name}`, `Мир удалён: ${world.name}`));
    } catch (error) {
      if (selectedIdRef.current === instanceId) {
        say(cleanIpcError(error, t("Failed to delete world", "Не удалось удалить мир")));
      }
    } finally {
      if (selectedIdRef.current === instanceId) setWorkingKey(null);
    }
  }

  function gameModeLabel(mode: WorldInfo["gameMode"]): string {
    if (mode === "creative") return t("Creative", "Творческий");
    if (mode === "adventure") return t("Adventure", "Приключение");
    if (mode === "spectator") return t("Spectator", "Наблюдатель");
    return t("Survival", "Выживание");
  }

  return (
    <div className="settings-content">
      <div className="surface-heading-row">
        <div className="surface-heading">
          <Globe size={19} />
          <div>
            <h3>{t("Worlds", "Миры")}</h3>
            <span>{t("Singleplayer saves, Quick Play and ZIP backups.", "Одиночные миры, быстрый вход и резервные копии (.zip).")}</span>
          </div>
        </div>

        <div className="button-row surface-actions">
          <button type="button" onClick={() => void refreshWorlds()} disabled={busy || workingKey !== null}>
            <RefreshCw size={15} /> {t("Refresh", "Обновить")}
          </button>
          <button type="button" onClick={() => void openSelectedFolder("saves")}>
            <FolderOpen size={15} /> {t("Open folder", "Открыть папку")}
          </button>
        </div>
      </div>

      {worlds === null ? (
        <span className="muted"><RefreshCw size={14} className="spin" /> {t("Reading worlds...", "Чтение миров...")}</span>
      ) : worlds.length === 0 ? (
        <span className="muted">{t("No singleplayer worlds in this instance yet.", "В этой инстанции пока нет одиночных миров.")}</span>
      ) : (
        <div className="file-list">
          {worlds.map((world) => {
            const expanded = expandedFolder === world.folderName;
            const confirming = confirmDeleteFolder === world.folderName;
            const backingUp = workingKey === `backup:${world.folderName}`;
            return (
              <div key={world.folderName} className="world-card">
                <div className="file-row">
                  {world.iconDataUrl ? (
                    <img className="file-icon" src={world.iconDataUrl} alt="" />
                  ) : (
                    <div className="file-icon mod-icon"><Globe size={18} /></div>
                  )}
                  <div className="file-main">
                    <strong>{world.name}</strong>
                    <small className="muted">
                      {world.folderName !== world.name ? `${world.folderName} · ` : ""}
                      {formatBytes(world.size)}
                      {world.lastPlayed ? ` · ${formatDateTime(world.lastPlayed)}` : ""}
                    </small>
                  </div>
                  <div className="file-side">
                    {world.hardcore ? (
                      <span className="tag-chip incompatible-chip">{t("Hardcore", "Хардкор")}</span>
                    ) : (
                      <span className="tag-chip">{gameModeLabel(world.gameMode)}</span>
                    )}
                    {world.cheats ? <span className="tag-chip">{t("Cheats", "Читы")}</span> : null}
                    {world.versionName ? <span className="tag-chip version-chip">{world.versionName}</span> : null}
                    <button
                      type="button"
                      className="install-button row-btn"
                      onClick={() => void launchSelected({ kind: "singleplayer", value: world.folderName })}
                      disabled={busy || isSelectedRunning || isLaunching || workingKey !== null}
                      title={t(`Launch directly into ${world.name}`, `Запустить игру сразу в мире ${world.name}`)}
                    >
                      <Play size={14} /> {t("Play", "Играть")}
                    </button>
                    <button
                      type="button"
                      className="row-btn"
                      onClick={() => void createBackup(world)}
                      disabled={busy || workingKey !== null}
                      title={t("Create ZIP backup", "Создать ZIP-бэкап")}
                    >
                      {backingUp ? <RefreshCw size={14} className="spin" /> : <Archive size={14} />} {t("Backup", "Бэкап")}
                    </button>
                    {world.backups.length > 0 ? (
                      <button
                        type="button"
                        className={expanded ? "content-type active row-btn" : "row-btn"}
                        onClick={() => setExpandedFolder(expanded ? null : world.folderName)}
                        title={t("Show backups", "Показать бэкапы")}
                      >
                        <RotateCcw size={14} /> {world.backups.length}
                      </button>
                    ) : null}
                    {confirming ? (
                      <>
                        <button type="button" className="danger-button row-btn" onClick={() => void removeWorld(world)} disabled={workingKey !== null}>
                          {t("Confirm delete", "Удалить навсегда")}
                        </button>
                        <button type="button" className="row-btn" onClick={() => setConfirmDeleteFolder(null)}>
                          {t("Cancel", "Отмена")}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteFolder(world.folderName)}
                        disabled={busy || isSelectedRunning || workingKey !== null}
                        title={t("Delete world", "Удалить мир")}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                </div>
                {expanded && world.backups.length > 0 ? (
                  <div className="world-backups">
                    <span className="section-title">{t("Backups", "Резервные копии")} ({world.backups.length})</span>
                    {world.backups.map((b) => (
                      <div key={b.id} className="world-backup-row">
                        <div>
                          <strong>{formatDateTime(b.createdAt)}</strong>
                          <small className="muted"> · {formatBytes(b.size)} · {b.fileName}</small>
                        </div>
                        <div className="button-row">
                          <button
                            type="button"
                            onClick={() => void restoreBackup(world, b.id)}
                            disabled={busy || isSelectedRunning || workingKey !== null}
                          >
                            <RotateCcw size={13} /> {t("Restore", "Восстановить")}
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => void removeBackup(world, b.id)}
                            disabled={busy || workingKey !== null}
                            title={t("Delete backup", "Удалить бэкап")}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
