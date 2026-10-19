import { useEffect, useState } from "react";
import type { CapeInfo, SkinInfo } from "@shared/types";
import { getLauncherApi } from "../../lib/api";
import type { CoreState } from "./useCore";

export function useSkins(deps: Pick<CoreState, "activeAccount" | "bootstrap" | "section" | "setBootstrap" | "setSettingsDraft" | "setStatus" | "settingsDraft" | "t">) {
  const { activeAccount, bootstrap, section, setBootstrap, setSettingsDraft, setStatus, settingsDraft, t } = deps;
  const [skins, setSkins] = useState<SkinInfo[] | null>(null);

  const [skinBusy, setSkinBusy] = useState(false);

  const [selectedSkinId, setSelectedSkinId] = useState<string | null>(null);

  const [capes, setCapes] = useState<CapeInfo[] | null>(null);

  const [dropActive, setDropActive] = useState(false);

  const canEditSkins = activeAccount?.kind === "microsoft" && (activeAccount?.status ?? "signed-out") === "signed-in";

  const isElyAccount = activeAccount?.kind === "ely";

  const [elySkin, setElySkin] = useState<{ dataUrl: string; slim: boolean } | null | undefined>(undefined);

  const activeSkinId = canEditSkins ? (settingsDraft?.activeSkinId ?? bootstrap?.settings.activeSkinId ?? null) : null;

  async function refreshSkins(): Promise<void> {
    try {
      setSkins(await getLauncherApi().listSkins());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to load skins", "Не удалось загрузить скины"));
    }
  }

  useEffect(() => {
    if (section === "skins") {
      setSelectedSkinId(null);
      if (!canEditSkins) {
        setSkins([]);
        setCapes([]);
      } else {
        void refreshSkins();
        setCapes(null);
        getLauncherApi().listCapes().then(setCapes).catch(() => setCapes([]));
      }
    } else {
      setDropActive(false);
    }
  }, [section, canEditSkins]);

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
  }, [section, activeAccount?.id]);

  async function uploadSkin(file: File): Promise<void> {
    if (!canEditSkins) {
      setStatus(t("Sign in with Microsoft to change skins", "Войдите через Microsoft, чтобы изменять скины"));
      return;
    }
    setSkinBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error(t("Could not read file", "Не удалось прочитать файл")));
        reader.readAsDataURL(file);
      });
      setSkins(await getLauncherApi().addSkin({ name: file.name.replace(/\.png$/i, ""), dataUrl, slim: false }));
      setStatus(t(`Added skin ${file.name}`, `Добавлен скин ${file.name}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to add skin", "Не удалось добавить скин"));
    } finally {
      setSkinBusy(false);
    }
  }

  async function activateSkin(id: string, name: string): Promise<void> {
    setSkinBusy(true);
    try {
      const result = await getLauncherApi().activateSkin(id);
      setBootstrap((current) => current ? { ...current, settings: { ...current.settings, activeSkinId: result.activeSkinId } } : current);
      setSettingsDraft((current) => current ? { ...current, activeSkinId: result.activeSkinId } : current);
      setStatus(result.uploaded ? t(`Skin uploaded to Mojang: ${name}`, `Скин загружен в Mojang: ${name}`) : t(`Selected ${name}. Others see it on servers with skin plugins.`, `Выбрано: ${name}. Другие игроки увидят его на серверах с плагинами скинов.`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to apply skin", "Не удалось применить скин"));
    } finally {
      setSkinBusy(false);
    }
  }

  async function removeSkin(id: string, name: string): Promise<void> {
    setSkinBusy(true);
    try {
      const result = await getLauncherApi().removeSkin(id);
      setSkins(result.skins);
      setBootstrap((current) => current ? { ...current, settings: { ...current.settings, activeSkinId: result.activeSkinId } } : current);
      setSettingsDraft((current) => current ? { ...current, activeSkinId: result.activeSkinId } : current);
      setStatus(t(`Deleted skin ${name}`, `Скин удалён: ${name}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to delete skin", "Не удалось удалить скин"));
    } finally {
      setSkinBusy(false);
    }
  }

  async function equipCape(capeId: string | null): Promise<void> {
    setSkinBusy(true);
    try {
      setCapes(await getLauncherApi().equipCape(capeId));
      setStatus(capeId ? t("Cape equipped", "Плащ надет") : t("Cape removed", "Плащ снят"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to change cape", "Не удалось сменить плащ"));
    } finally {
      setSkinBusy(false);
    }
  }

  function dropSkin(event: React.DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    if (!canEditSkins) {
      setStatus(t("Sign in with Microsoft to change skins", "Войдите через Microsoft, чтобы изменять скины"));
      return;
    }
    const file = event.dataTransfer.files?.[0];
    if (file) void uploadSkin(file);
  }

  async function setSkinModel(id: string, slim: boolean): Promise<void> {
    setSkinBusy(true);
    try {
      setSkins(await getLauncherApi().updateSkin({ id, patch: { slim } }));
      if (id === activeSkinId) {
        const current = skins?.find((item) => item.id === id);
        await activateSkin(id, current?.name ?? "skin");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to update skin", "Не удалось обновить скин"));
    } finally {
      setSkinBusy(false);
    }
  }

  return {
    skins,
    setSkins,
    skinBusy,
    setSkinBusy,
    selectedSkinId,
    setSelectedSkinId,
    capes,
    setCapes,
    dropActive,
    setDropActive,
    canEditSkins,
    isElyAccount,
    elySkin,
    setElySkin,
    activeSkinId,
    refreshSkins,
    uploadSkin,
    activateSkin,
    removeSkin,
    equipCape,
    dropSkin,
    setSkinModel
  };
}

export type SkinsState = ReturnType<typeof useSkins>;
