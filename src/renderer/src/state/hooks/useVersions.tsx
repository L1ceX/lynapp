import { useCallback, useEffect, useMemo, useState } from "react";
import { type GameVersionInfo, type GameVersionType, type LauncherInstance, type ModLoader, VERSION_TYPES_DEFAULTS } from "@shared/types";
import { defaultCreateForm, loaders, NONE_OPTION } from "../../constants";
import { getLauncherApi } from "../../lib/api";
import type { CoreState } from "./useCore";
import type { InstancesState } from "./useInstances";

export function useVersions(deps: Pick<CoreState & InstancesState, "bootstrap" | "instanceTab" | "say" | "selected" | "setBootstrap" | "setSelectedId" | "setSettingsDraft" | "setStatus" | "t" | "updateSelected">) {
  const { bootstrap, instanceTab, say, selected, setBootstrap, setSelectedId, setSettingsDraft, setStatus, t, updateSelected } = deps;
  const [createForm, setCreateForm] = useState(defaultCreateForm);

  const [creating, setCreating] = useState(false);

  const [gameVersionList, setGameVersionList] = useState<GameVersionInfo[] | null>(null);

  const versionTypes = bootstrap?.settings.versionTypes ?? VERSION_TYPES_DEFAULTS;

  const gameVersions = useMemo(() => gameVersionList ? gameVersionList.filter((item) => versionTypes[item.type]).map((item) => item.id) : null, [gameVersionList, versionTypes]);

  const [versionDraft, setVersionDraft] = useState<{ id: string; gameVersion: string; loader: ModLoader | "" } | null>(null);

  const [loaderSupport, setLoaderSupport] = useState<Record<string, string[]> | null>(null);

  const [loaderVersions, setLoaderVersions] = useState<string[] | null>(null);

  const refreshVersions = useCallback(async () => {
    try {
      setGameVersionList(await getLauncherApi().getGameVersions());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to load Minecraft versions", "Не удалось загрузить версии Minecraft"));
    }
    try {
      setLoaderSupport(await getLauncherApi().getLoaderSupport());
    } catch {
      setLoaderSupport(null);
    }
  }, []);

  useEffect(() => {
    void refreshVersions();
  }, [refreshVersions]);

  const loaderSupportSets = useMemo(() => loaderSupport ? Object.fromEntries(Object.entries(loaderSupport).map(([key, list]) => [key, new Set(list)])) as Record<string, Set<string>> : null, [loaderSupport]);

  function loadersForVersion(version: string): ModLoader[] {
    if (!loaderSupportSets) return loaders;
    return loaders.filter((loader) => loader === "vanilla" || loaderSupportSets[loader]?.has(version));
  }

  function versionsForLoader(loader: ModLoader): string[] {
    if (!gameVersions) return [];
    if (loader === "vanilla" || !loaderSupportSets) return gameVersions;
    const supported = loaderSupportSets[loader];
    return supported ? gameVersions.filter((version) => supported.has(version)) : [];
  }

  const [createLoaders, setCreateLoaders] = useState<ModLoader[] | null>(null);

  const [selectedLoaders, setSelectedLoaders] = useState<ModLoader[] | null>(null);

  async function availableLoaders(version: string): Promise<ModLoader[]> {
    const base = loadersForVersion(version);
    const results = await Promise.all(
      base.map(async (loader) => {
        if (loader === "vanilla") return loader;
        try {
          const versions = await getLauncherApi().getLoaderVersions(loader, version);
          return versions.length ? loader : null;
        } catch {
          return loader;
        }
      })
    );
    return results.filter((loader): loader is ModLoader => loader !== null);
  }

  useEffect(() => {
    const version = createForm.gameVersion;
    let stale = false;
    setCreateLoaders(null);
    if (!version) return;
    void availableLoaders(version).then((list) => {
      if (stale) return;
      setCreateLoaders(list);
      setCreateForm((form) => (form.gameVersion === version && form.loader && !list.includes(form.loader) ? { ...form, loader: "" } : form));
    });
    return () => {
      stale = true;
    };
  }, [createForm.gameVersion]);

  useEffect(() => {
    if (!selected) return;
    const version = selected.gameVersion;
    const id = selected.id;
    let stale = false;
    setSelectedLoaders(null);
    void availableLoaders(version).then((list) => {
      if (stale) return;
      setSelectedLoaders(list);
      if (selected.loader && list.length > 0 && !list.includes(selected.loader)) {
        setStatus(t(`${selected.name}: ${selected.loader} has no releases for ${version} yet`, `${selected.name}: у загрузчика ${selected.loader} пока нет выпусков для версии ${version}`));
      }
    });
    return () => {
      stale = true;
    };
  }, [selected?.id, selected?.gameVersion]);

  async function setVersionTypeFlag(id: GameVersionType, value: boolean): Promise<void> {
    const next = { ...versionTypes, [id]: value };
    if (!Object.values(next).some(Boolean)) return;
    try {
      const settings = await getLauncherApi().updateSettings({ versionTypes: next });
      setBootstrap((current) => current ? { ...current, settings } : current);
      setSettingsDraft(settings);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to save", "Не удалось сохранить"));
    }
  }

  function pickVersionOption(label: string, loader: ModLoader | ""): { gameVersion: string; loader: ModLoader | "" } {
    const gameVersion = label === NONE_OPTION ? "" : label;
    const keepLoader = loader && gameVersion && !loadersForVersion(gameVersion).includes(loader) ? "" : loader;
    return { gameVersion, loader: keepLoader };
  }

  function pickLoaderOption(label: string, gameVersion: string): { gameVersion: string; loader: ModLoader | "" } {
    const loader = label === NONE_OPTION ? "" : (label as ModLoader);
    const keepVersion = loader && gameVersion && !versionsForLoader(loader).includes(gameVersion) ? "" : gameVersion;
    return { gameVersion: keepVersion, loader };
  }

  function applyVersionDraft(next: { gameVersion: string; loader: ModLoader | "" }): void {
    if (!selected) return;
    if (next.gameVersion && next.loader) {
      setVersionDraft(null);
      const patch: Partial<LauncherInstance> = {};
      if (next.gameVersion !== selected.gameVersion) patch.gameVersion = next.gameVersion;
      if (next.loader !== selected.loader) patch.loader = next.loader;
      if (Object.keys(patch).length) void updateSelected(patch);
      return;
    }
    setVersionDraft({ id: selected.id, ...next });
  }

  async function createInstance(): Promise<void> {
    if (creating) return;
    if (!createForm.gameVersion || !createForm.loader) {
      setStatus(t("Choose a Minecraft version and a loader first", "Сначала выберите версию Minecraft и загрузчик"));
      return;
    }
    setCreating(true);
    try {
      const instance = await getLauncherApi().createInstance({ ...createForm, loader: createForm.loader });
      setBootstrap((current) => current ? { ...current, activeInstanceId: instance.id, instances: [instance, ...current.instances] } : current);
      setSelectedId(instance.id);
      say(t(`Created ${instance.name}`, `Создано: ${instance.name}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to create instance", "Не удалось создать инстанцию"));
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    if (instanceTab !== "versions" || !selected || selected.loader === "vanilla") {
      setLoaderVersions(null);
      return;
    }
    let cancelled = false;
    setLoaderVersions(null);
    getLauncherApi().getLoaderVersions(selected.loader, selected.gameVersion).then((versions) => {
      if (cancelled) return;
      setLoaderVersions(versions);
      const current = selected.loaderVersion?.trim() ?? "";
      if (current && versions.length > 0 && !versions.includes(current)) {
        setStatus(t(`${selected.name}: loader version ${current} is not listed upstream, keeping it`, `${selected.name}: версия загрузчика ${current} не найдена в списке, оставлена текущая`));
      }
    }).catch(() => {
      if (!cancelled) setLoaderVersions([]);
    });
    return () => {
      cancelled = true;
    };
  }, [instanceTab, selected?.id, selected?.gameVersion, selected?.loader]);

  return {
    createForm,
    setCreateForm,
    creating,
    setCreating,
    gameVersionList,
    setGameVersionList,
    versionTypes,
    gameVersions,
    versionDraft,
    setVersionDraft,
    loaderSupport,
    setLoaderSupport,
    loaderVersions,
    setLoaderVersions,
    refreshVersions,
    loaderSupportSets,
    loadersForVersion,
    versionsForLoader,
    createLoaders,
    setCreateLoaders,
    selectedLoaders,
    setSelectedLoaders,
    availableLoaders,
    setVersionTypeFlag,
    pickVersionOption,
    pickLoaderOption,
    applyVersionDraft,
    createInstance
  };
}

export type VersionsState = ReturnType<typeof useVersions>;
