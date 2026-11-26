import { useEffect, useRef, useState } from "react";
import type { CapeInfo, SkinInfo } from "@shared/types";
import { getLauncherApi } from "../../lib/api";
import { cleanIpcError } from "../../lib/format";
import type { CoreState } from "./useCore";

export function useSkins(deps: Pick<CoreState, "activeAccount" | "bootstrap" | "section" | "setBootstrap" | "setSettingsDraft" | "setStatus" | "settingsDraft" | "t">) {
  const { activeAccount, bootstrap, section, setBootstrap, setSettingsDraft, setStatus, settingsDraft, t } = deps;
  const activeAccountIdRef = useRef(activeAccount?.id);
  activeAccountIdRef.current = activeAccount?.id;
  const [skins, setSkins] = useState<SkinInfo[] | null>(null);

  const [skinBusy, setSkinBusy] = useState(false);

  const [selectedSkinId, setSelectedSkinId] = useState<string | null>(null);

  const [capes, setCapes] = useState<CapeInfo[] | null>(null);

  const [dropActive, setDropActive] = useState(false);

  const [skinLibrary, setSkinLibrary] = useState<"account" | "shared">("account");

  const canEditSkins = (activeAccount?.kind === "microsoft" || activeAccount?.kind === "ely") && (activeAccount?.status ?? "signed-out") === "signed-in";

  const isElyAccount = activeAccount?.kind === "ely";

  const [elySkin, setElySkin] = useState<{ dataUrl: string; slim: boolean } | null | undefined>(undefined);

  const [accountSkin, setAccountSkin] = useState<{ dataUrl: string; slim: boolean } | null>(null);

  const activeSkinId = canEditSkins ? (activeAccount?.activeSkinId ?? null) : null;

  function syncActiveSkinId(nextId: string | null, deletedId?: string): void {
    setBootstrap((current) => current ? {
      ...current,
      settings: { ...current.settings, activeSkinId: nextId },
      accounts: current.accounts.map((acc) => {
        if (deletedId && acc.activeSkinId === deletedId) return { ...acc, activeSkinId: null };
        if (acc.id === activeAccount?.id) return { ...acc, activeSkinId: nextId };
        return acc;
      })
    } : current);
    setSettingsDraft((current) => current ? { ...current, activeSkinId: nextId } : current);
  }

  async function refreshSkins(): Promise<void> {
    try {
      setSkins(await getLauncherApi().listSkins());
    } catch (error) {
      setStatus(cleanIpcError(error, t("Failed to load skins", "Не удалось загрузить скины")));
    }
  }

  useEffect(() => {
    if (section !== "skins") {
      setDropActive(false);
      return;
    }
    let stale = false;
    setSelectedSkinId(null);
    if (!canEditSkins) {
      setSkins([]);
      setCapes([]);
      return;
    }
    getLauncherApi().listSkins().then((list) => {
      if (!stale) setSkins(list);
    }).catch((error) => {
      if (!stale) setStatus(cleanIpcError(error, t("Failed to load skins", "Не удалось загрузить скины")));
    });
    if (activeAccount?.kind === "microsoft") {
      setCapes(null);
      getLauncherApi().listCapes().then((list) => {
        if (!stale) setCapes(list);
      }).catch(() => {
        if (!stale) setCapes([]);
      });
    } else {
      setCapes([]);
    }
    return () => {
      stale = true;
    };
  }, [section, canEditSkins, activeAccount?.id, activeAccount?.kind]);

  useEffect(() => {
    if (section !== "skins" || activeAccount?.kind !== "ely") {
      setElySkin(undefined);
      return;
    }
    let stale = false;
    setElySkin(undefined);
    getLauncherApi().elySkin().then((skin) => {
      if (!stale) setElySkin(skin);
    }).catch(() => {
      if (!stale) setElySkin(null);
    });
    return () => {
      stale = true;
    };
  }, [section, activeAccount?.id, activeAccount?.kind, activeAccount?.status]);

  useEffect(() => {
    if (!canEditSkins) {
      setAccountSkin(null);
      return;
    }
    let stale = false;
    setAccountSkin(null);
    getLauncherApi().accountSkin().then((skin) => {
      if (!stale) setAccountSkin(skin);
    }).catch(() => {
      if (!stale) setAccountSkin(null);
    });
    return () => {
      stale = true;
    };
  }, [canEditSkins, activeAccount?.id, activeAccount?.kind, activeAccount?.status, activeAccount?.activeSkinId, activeAccount?.profileName]);

  async function uploadSkin(file: File): Promise<void> {
    if (!canEditSkins) {
      setStatus(t("Sign in with Microsoft or Ely.by to change skins", "Войдите через Microsoft или Ely.by, чтобы изменять скины"));
      return;
    }
    const reqAccountId = activeAccount?.id;
    const reqKind = activeAccount?.kind;
    setSkinBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error(t("Could not read file", "Не удалось прочитать файл")));
        reader.readAsDataURL(file);
      });
      if (activeAccountIdRef.current !== reqAccountId) return;
      const skinName = file.name.replace(/\.png$/i, "");
      const accountId = skinLibrary === "account" ? (reqAccountId ?? null) : null;
      const nextSkins = await getLauncherApi().addSkin({ name: skinName, dataUrl, slim: false, accountId });
      if (activeAccountIdRef.current !== reqAccountId) return;
      setSkins(nextSkins);
      const added = nextSkins[0];
      if (added) {
        setSelectedSkinId(added.id);
        setStatus(t(`Uploading skin ${added.name}...`, `Загрузка скина ${added.name}...`));
        const result = await getLauncherApi().activateSkin(added.id);
        if (activeAccountIdRef.current !== reqAccountId) return;
        syncActiveSkinId(result.activeSkinId);
        setAccountSkin({ dataUrl: added.dataUrl, slim: added.slim });
        if (reqKind === "ely") {
          setElySkin({ dataUrl: added.dataUrl, slim: added.slim });
          if (!result.uploaded) {
            void getLauncherApi().elySkin().then((fresh) => {
              if (fresh && activeAccountIdRef.current === reqAccountId) setElySkin(fresh);
            }).catch(() => undefined);
          }
        }
        const targetLabel = reqKind === "ely" ? "Ely.by" : "Mojang";
        setStatus(result.uploaded ? t(`Skin uploaded to ${targetLabel}: ${added.name}`, `Скин загружен в ${targetLabel}: ${added.name}`) : t(`Added skin ${added.name}`, `Добавлен скин ${added.name}`));
      } else {
        setStatus(t(`Added skin ${file.name}`, `Добавлен скин ${file.name}`));
      }
    } catch (error) {
      if (activeAccountIdRef.current === reqAccountId) {
        setStatus(cleanIpcError(error, t("Failed to add skin", "Не удалось добавить скин")));
      }
    } finally {
      setSkinBusy(false);
    }
  }

  async function applyActivation(id: string, name: string, chosenSkin?: SkinInfo): Promise<void> {
    const reqAccountId = activeAccount?.id;
    const reqKind = activeAccount?.kind;
    const targetLabel = reqKind === "ely" ? "Ely.by" : "Mojang";
    setStatus(t(`Uploading skin to ${targetLabel}: ${name}...`, `Загрузка скина в ${targetLabel}: ${name}...`));
    const result = await getLauncherApi().activateSkin(id);
    if (activeAccountIdRef.current !== reqAccountId) return;
    syncActiveSkinId(result.activeSkinId);
    const chosen = chosenSkin ?? skins?.find((item) => item.id === id);
    if (chosen) {
      setAccountSkin({ dataUrl: chosen.dataUrl, slim: chosen.slim });
    }
    if (reqKind === "ely") {
      if (chosen) setElySkin({ dataUrl: chosen.dataUrl, slim: chosen.slim });
      if (!result.uploaded) {
        void getLauncherApi().elySkin().then((fresh) => {
          if (fresh && activeAccountIdRef.current === reqAccountId) setElySkin(fresh);
        }).catch(() => undefined);
      }
    }
    setStatus(result.uploaded ? t(`Skin uploaded to ${targetLabel}: ${name}`, `Скин загружен в ${targetLabel}: ${name}`) : t(`Selected ${name}. Others see it on servers with skin plugins.`, `Выбрано: ${name}. Другие игроки увидят его на серверах с плагинами скинов.`));
  }

  async function activateSkin(id: string, name: string): Promise<void> {
    setSkinBusy(true);
    try {
      await applyActivation(id, name);
    } catch (error) {
      setStatus(cleanIpcError(error, t("Failed to apply skin", "Не удалось применить скин")));
    } finally {
      setSkinBusy(false);
    }
  }

  async function removeSkin(id: string, name: string): Promise<void> {
    const reqAccountId = activeAccount?.id;
    const wasActive = id === activeSkinId;
    setSkinBusy(true);
    try {
      const result = await getLauncherApi().removeSkin(id);
      if (activeAccountIdRef.current !== reqAccountId) return;
      setSkins(result.skins);
      syncActiveSkinId(result.activeSkinId, id);
      if (wasActive) {
        setAccountSkin(null);
        void getLauncherApi().accountSkin().then((remote) => {
          if (activeAccountIdRef.current === reqAccountId) setAccountSkin(remote);
        }).catch(() => undefined);
      }
      setStatus(t(`Deleted skin ${name}`, `Скин удалён: ${name}`));
    } catch (error) {
      if (activeAccountIdRef.current === reqAccountId) {
        setStatus(cleanIpcError(error, t("Failed to delete skin", "Не удалось удалить скин")));
      }
    } finally {
      setSkinBusy(false);
    }
  }

  async function equipCape(capeId: string | null): Promise<void> {
    if (skinBusy) return;
    if (capeId === null ? capes?.every((item) => !item.active) : capes?.some((item) => item.id === capeId && item.active)) {
      return;
    }
    setSkinBusy(true);
    try {
      setCapes(await getLauncherApi().equipCape(capeId));
      setStatus(capeId ? t("Cape equipped", "Плащ надет") : t("Cape removed", "Плащ снят"));
    } catch (error) {
      setStatus(cleanIpcError(error, t("Failed to change cape", "Не удалось сменить плащ")));
    } finally {
      setSkinBusy(false);
    }
  }

  function dropSkin(event: React.DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    if (!canEditSkins) {
      setStatus(t("Sign in with Microsoft or Ely.by to change skins", "Войдите через Microsoft или Ely.by, чтобы изменять скины"));
      return;
    }
    const file = event.dataTransfer.files?.[0];
    if (file) void uploadSkin(file);
  }

  async function setSkinModel(id: string, slim: boolean): Promise<void> {
    const reqAccountId = activeAccount?.id;
    setSkinBusy(true);
    try {
      const nextSkins = await getLauncherApi().updateSkin({ id, patch: { slim } });
      if (activeAccountIdRef.current !== reqAccountId) return;
      setSkins(nextSkins);
      if (id === activeSkinId) {
        const current = nextSkins.find((item) => item.id === id);
        await applyActivation(id, current?.name ?? "skin", current);
      }
    } catch (error) {
      if (activeAccountIdRef.current === reqAccountId) {
        setStatus(cleanIpcError(error, t("Failed to update skin", "Не удалось обновить скин")));
      }
    } finally {
      setSkinBusy(false);
    }
  }

  async function moveSkinLibrary(id: string, toAccount: boolean): Promise<void> {
    if (!canEditSkins) return;
    const reqAccountId = activeAccount?.id;
    setSkinBusy(true);
    try {
      const accountId = toAccount ? (reqAccountId ?? null) : null;
      const nextSkins = await getLauncherApi().updateSkin({ id, patch: { accountId } });
      if (activeAccountIdRef.current !== reqAccountId) return;
      setSkins(nextSkins);
      setStatus(toAccount
        ? t("Moved skin to this account's library", "Скин перенесён в библиотеку аккаунта")
        : t("Moved skin to shared library", "Скин перенесён в общую библиотеку"));
    } catch (error) {
      if (activeAccountIdRef.current === reqAccountId) {
        setStatus(cleanIpcError(error, t("Failed to move skin", "Не удалось перенести скин")));
      }
    } finally {
      setSkinBusy(false);
    }
  }

  async function renameSkin(id: string, nextName: string): Promise<void> {
    const trimmed = nextName.trim().slice(0, 32);
    if (!trimmed || !canEditSkins) return;
    const reqAccountId = activeAccount?.id;
    setSkinBusy(true);
    try {
      const nextSkins = await getLauncherApi().updateSkin({ id, patch: { name: trimmed } });
      if (activeAccountIdRef.current !== reqAccountId) return;
      setSkins(nextSkins);
      setStatus(t(`Renamed skin to ${trimmed}`, `Скин переименован: ${trimmed}`));
    } catch (error) {
      if (activeAccountIdRef.current === reqAccountId) {
        setStatus(cleanIpcError(error, t("Failed to rename skin", "Не удалось переименовать скин")));
      }
    } finally {
      setSkinBusy(false);
    }
  }

  const activeLibrarySkin = canEditSkins && activeSkinId ? skins?.find((item) => item.id === activeSkinId) ?? null : null;
  const accountSkinUrl = canEditSkins ? (activeLibrarySkin?.dataUrl ?? (isElyAccount ? (elySkin?.dataUrl ?? accountSkin?.dataUrl) : accountSkin?.dataUrl) ?? null) : null;

  return {
    skins,
    setSkins,
    skinBusy,
    setSkinBusy,
    selectedSkinId,
    setSelectedSkinId,
    skinLibrary,
    setSkinLibrary,
    capes,
    setCapes,
    dropActive,
    setDropActive,
    canEditSkins,
    isElyAccount,
    elySkin,
    setElySkin,
    accountSkin,
    accountSkinUrl,
    activeSkinId,
    refreshSkins,
    uploadSkin,
    activateSkin,
    removeSkin,
    moveSkinLibrary,
    renameSkin,
    equipCape,
    dropSkin,
    setSkinModel
  };
}

export type SkinsState = ReturnType<typeof useSkins>;
