import { Copy, Play, Plus, RefreshCw, Server, Trash2, Wifi, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ServerEntry, ServerPingResult } from "@shared/types";
import { getLauncherApi } from "../../lib/api";
import { cleanIpcError } from "../../lib/format";
import { useApp } from "../../state/context";

export function ServersTab() {
  const { busy, instanceTab, isLaunching, isSelectedRunning, launchSelected, say, selected, setBusy, t } = useApp();
  const [servers, setServers] = useState<ServerEntry[] | null>(null);
  const [pings, setPings] = useState<Record<string, ServerPingResult | "loading">>({});
  const [newName, setNewName] = useState("");
  const [newIp, setNewIp] = useState("");
  const pingGenRef = useRef(0);
  const selectedIdRef = useRef(selected?.id);
  selectedIdRef.current = selected?.id;

  function pingAll(list: ServerEntry[], instanceId: string): void {
    const gen = ++pingGenRef.current;
    const initial: Record<string, ServerPingResult | "loading"> = {};
    for (const entry of list) initial[entry.ip] = "loading";
    setPings(initial);
    for (const entry of list) {
      void getLauncherApi().pingServer(entry.ip).then((res) => {
        if (pingGenRef.current === gen && selectedIdRef.current === instanceId) {
          setPings((cur) => ({ ...cur, [entry.ip]: res }));
        }
      }).catch(() => {
        if (pingGenRef.current === gen && selectedIdRef.current === instanceId) {
          setPings((cur) => ({ ...cur, [entry.ip]: { ip: entry.ip, online: false } }));
        }
      });
    }
  }

  useEffect(() => {
    if (instanceTab !== "servers" || !selected) return;
    const instanceId = selected.id;
    let stale = false;
    pingGenRef.current += 1;
    setServers(null);
    setPings({});
    void getLauncherApi().listServers(instanceId).then((list) => {
      if (stale || selectedIdRef.current !== instanceId) return;
      setServers(list);
      pingAll(list, instanceId);
    }).catch((error) => {
      if (!stale && selectedIdRef.current === instanceId) {
        setServers([]);
        say(cleanIpcError(error, t("Failed to read servers.dat", "Не удалось прочитать servers.dat")));
      }
    });
    return () => {
      stale = true;
      pingGenRef.current += 1;
    };
  }, [instanceTab, selected?.id]);

  if (!selected || instanceTab !== "servers") return null;

  async function refreshServers(): Promise<void> {
    if (!selected) return;
    const instanceId = selected.id;
    setBusy(true);
    try {
      const list = await getLauncherApi().listServers(instanceId);
      if (selectedIdRef.current !== instanceId) return;
      setServers(list);
      pingAll(list, instanceId);
    } catch (error) {
      if (selectedIdRef.current === instanceId) {
        say(cleanIpcError(error, t("Failed to read servers", "Не удалось прочитать список серверов")));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleAddServer(): Promise<void> {
    if (!selected || !newIp.trim()) return;
    const instanceId = selected.id;
    setBusy(true);
    try {
      const ip = newIp.trim();
      const name = newName.trim() || ip;
      const list = await getLauncherApi().addServer(instanceId, name, ip);
      if (selectedIdRef.current !== instanceId) return;
      setServers(list);
      setNewName("");
      setNewIp("");
      say(t(`Added server ${name}`, `Сервер добавлен: ${name}`));
      const gen = pingGenRef.current;
      setPings((cur) => ({ ...cur, [ip]: "loading" }));
      void getLauncherApi().pingServer(ip).then((res) => {
        if (pingGenRef.current === gen && selectedIdRef.current === instanceId) {
          setPings((cur) => ({ ...cur, [ip]: res }));
        }
      }).catch(() => {
        if (pingGenRef.current === gen && selectedIdRef.current === instanceId) {
          setPings((cur) => ({ ...cur, [ip]: { ip, online: false } }));
        }
      });
    } catch (error) {
      if (selectedIdRef.current === instanceId) {
        say(cleanIpcError(error, t("Failed to add server", "Не удалось добавить сервер")));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveServer(entry: ServerEntry): Promise<void> {
    if (!selected) return;
    const instanceId = selected.id;
    setBusy(true);
    try {
      const list = await getLauncherApi().removeServer(instanceId, entry.ip);
      if (selectedIdRef.current !== instanceId) return;
      setServers(list);
      say(t(`Removed ${entry.name}`, `Удалён сервер: ${entry.name}`));
    } catch (error) {
      if (selectedIdRef.current === instanceId) {
        say(cleanIpcError(error, t("Failed to remove server", "Не удалось удалить сервер")));
      }
    } finally {
      setBusy(false);
    }
  }

  async function copyIp(ip: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(ip);
      say(t(`Copied ${ip}`, `Скопирован адрес: ${ip}`));
    } catch {
      say(t("Could not copy address", "Не удалось скопировать адрес"));
    }
  }

  return (
    <div className="settings-content">
      <div className="surface-heading-row">
        <div className="surface-heading">
          <Server size={19} />
          <div>
            <h3>{t("Servers", "Серверы")}</h3>
            <span>{t("Saved in servers.dat · live status ping and instant join.", "Список из servers.dat · проверка онлайна и быстрый вход на сервер.")}</span>
          </div>
        </div>

        <div className="button-row surface-actions">
          <button type="button" onClick={() => void refreshServers()} disabled={busy}>
            <RefreshCw size={15} /> {t("Refresh", "Обновить")}
          </button>
        </div>
      </div>

      <div className="server-add-row">
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder={t("Server name (optional)", "Название сервера")}
        />
        <input
          value={newIp}
          onChange={(event) => setNewIp(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void handleAddServer(); }}
          placeholder={t("Server address (e.g. mc.hypixel.net)", "IP или домен (например, mc.hypixel.net)")}
        />
        <button type="button" className="primary-button" onClick={() => void handleAddServer()} disabled={busy || !newIp.trim()}>
          <Plus size={15} /> {t("Add", "Добавить")}
        </button>
      </div>

      {servers === null ? (
        <span className="muted"><RefreshCw size={14} className="spin" /> {t("Reading servers...", "Чтение серверов...")}</span>
      ) : servers.length === 0 ? (
        <span className="muted">{t("No servers in servers.dat yet. Add one above.", "В servers.dat пока нет серверов. Добавьте адрес выше.")}</span>
      ) : (
        <div className="file-list">
          {servers.map((entry, idx) => {
            const ping = pings[entry.ip];
            const isLoading = ping === "loading" || ping === undefined;
            const status = typeof ping === "object" ? ping : null;
            const iconSrc = status?.iconDataUrl ?? entry.iconDataUrl;
            return (
              <div key={`${entry.ip}-${idx}`} className="file-row server-row">
                {iconSrc ? (
                  <img className="file-icon" src={iconSrc} alt="" />
                ) : (
                  <div className="file-icon mod-icon"><Server size={18} /></div>
                )}
                <div className="file-main">
                  <strong>{entry.name}</strong>
                  <small className="muted" title={`${entry.ip}${status?.motd ? ` · ${status.motd}` : ""}`}>{entry.ip}{status?.motd ? ` · ${status.motd}` : ""}</small>
                </div>
                <div className="file-side">
                  {isLoading ? (
                    <span className="muted"><RefreshCw size={13} className="spin" /> {t("Pinging...", "Пинг...")}</span>
                  ) : status?.online ? (
                    <>
                      <span className="tag-chip server-online">
                        <Wifi size={12} /> {status.playersOnline ?? 0}/{status.playersMax ?? 0}
                      </span>
                      {status.latencyMs !== undefined ? <span className="tag-chip">{status.latencyMs} ms</span> : null}
                      {status.versionName ? <span className="tag-chip version-chip server-version-chip" title={status.versionName}>{status.versionName}</span> : null}
                    </>
                  ) : (
                    <span className="tag-chip missing">
                      <WifiOff size={12} /> {t("Offline", "Офлайн")}
                    </span>
                  )}
                  <button
                    type="button"
                    className="install-button row-btn"
                    onClick={() => void launchSelected({ kind: "multiplayer", value: entry.ip })}
                    disabled={busy || isSelectedRunning || isLaunching}
                    title={t(`Launch and connect to ${entry.ip}`, `Запустить игру и подключиться к ${entry.ip}`)}
                  >
                    <Play size={14} /> {t("Join", "Войти")}
                  </button>
                  <button type="button" onClick={() => void copyIp(entry.ip)} title={t("Copy IP", "Скопировать IP")}>
                    <Copy size={14} />
                  </button>
                  <button type="button" onClick={() => void handleRemoveServer(entry)} disabled={busy} title={t("Remove server", "Удалить сервер")}>
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
