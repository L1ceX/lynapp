import { useEffect, useState } from "react";
import { getLauncherApi } from "../../lib/api";
import type { CoreState } from "./useCore";
import type { SkinsState } from "./useSkins";

export function useAccounts(deps: Pick<CoreState & SkinsState, "activeAccount" | "bootstrap" | "busy" | "refresh" | "setBusy" | "setSelectedSkinId" | "setStatus" | "t">) {
  const { activeAccount, bootstrap, busy, refresh, setBusy, setSelectedSkinId, setStatus, t } = deps;
  const [offlineName, setOfflineName] = useState("");

  const [elyName, setElyName] = useState("");

  const [elyPassword, setElyPassword] = useState("");

  const [elyTotp, setElyTotp] = useState("");

  useEffect(() => {
    if (activeAccount?.status === "offline" && activeAccount?.profileName) setOfflineName(activeAccount.profileName);
  }, [activeAccount?.profileName, activeAccount?.status]);

  useEffect(() => {
    if (!activeAccount || activeAccount.kind !== "microsoft" || activeAccount.status !== "signed-in") return;
    const exp = activeAccount.expiresAt ? Date.parse(activeAccount.expiresAt) : NaN;
    if (!Number.isNaN(exp) && exp - Date.now() > 24 * 3600 * 1000) return;
    let stale = false;
    void getLauncherApi().refreshSession().then((state) => {
      if (stale) return;
      const refreshed = state.accounts.find((item) => item.id === state.activeAccountId);
      const refreshedExp = refreshed?.expiresAt ? Date.parse(refreshed.expiresAt) : NaN;
      if (!Number.isNaN(refreshedExp) && refreshedExp - Date.now() > 24 * 3600 * 1000) {
        void refresh({ setReadyStatus: false });
      }
    }).catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [bootstrap?.activeAccountId]);

  async function beginLogin(): Promise<void> {
    setBusy(true);
    setStatus(t("Starting Microsoft login...", "Выполняется вход через Microsoft..."));
    try {
      const result = await getLauncherApi().beginMicrosoftLogin();
      setStatus(result.message);
      await refresh({ setReadyStatus: false });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Microsoft login failed", "Не удалось войти через Microsoft"));
    } finally {
      setBusy(false);
    }
  }

  async function switchAccount(id: string): Promise<void> {
    if (busy || id === activeAccount?.id) return;
    setBusy(true);
    try {
      const name = bootstrap?.accounts.find((item) => item.id === id)?.profileName ?? "account";
      await getLauncherApi().setActiveAccount(id);
      setSelectedSkinId(null);
      await refresh({ setReadyStatus: false });
      setStatus(t(`Playing as ${name}`, `Вы играете как ${name}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to switch account", "Не удалось сменить аккаунт"));
    } finally {
      setBusy(false);
    }
  }

  async function removeAccount(id: string, name: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await getLauncherApi().removeAccount(id);
      setSelectedSkinId(null);
      await refresh({ setReadyStatus: false });
      setStatus(t(`Removed ${name}`, `Удалено: ${name}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to remove account", "Не удалось удалить аккаунт"));
    } finally {
      setBusy(false);
    }
  }

  async function useOfflineProfile(): Promise<void> {
    setBusy(true);
    try {
      await getLauncherApi().useOfflineProfile(offlineName);
      setSelectedSkinId(null);
      await refresh({ setReadyStatus: false });
      setStatus(t(`Offline profile: ${offlineName}`, `Офлайн-профиль: ${offlineName}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Offline profile failed", "Не удалось создать офлайн-профиль"));
    } finally {
      setBusy(false);
    }
  }

  async function elyLogin(): Promise<void> {
    setBusy(true);
    setStatus(t("Signing in with Ely.by...", "Выполняется вход через Ely.by..."));
    try {
      await getLauncherApi().elyLogin(elyName, elyPassword, elyTotp || undefined);
      setElyPassword("");
      setElyTotp("");
      setSelectedSkinId(null);
      await refresh({ setReadyStatus: false });
      setStatus(t(`Ely.by as ${elyName}`, `Ely.by: ${elyName}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Ely.by login failed", "Не удалось войти через Ely.by"));
    } finally {
      setBusy(false);
    }
  }

  return {
    offlineName,
    setOfflineName,
    elyName,
    setElyName,
    elyPassword,
    setElyPassword,
    elyTotp,
    setElyTotp,
    beginLogin,
    switchAccount,
    removeAccount,
    useOfflineProfile,
    elyLogin
  };
}

export type AccountsState = ReturnType<typeof useAccounts>;
