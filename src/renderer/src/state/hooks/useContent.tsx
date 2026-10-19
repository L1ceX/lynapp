import { useEffect, useMemo, useRef, useState } from "react";
import type { ContentImportResult, ContentUpdateInfo, InstalledMod, LocalContentItem, LocalContentKind, ModrinthProjectType, ModSearchResult, ModSortIndex, ModVersionInfo } from "@shared/types";
import type { FileRowActions } from "../../components/FileRow";
import { getLauncherApi } from "../../lib/api";
import { contentLabel, contentTypes, fileGroups, sortOptions } from "../../lib/content";
import { motionMs } from "../../lib/motion";
import type { CoreState } from "./useCore";
import type { InstancesState } from "./useInstances";

export function useContent(deps: Pick<CoreState & InstancesState, "assertNotLaunching" | "bootstrapRef" | "busy" | "contentTimer" | "downloadingIds" | "finishModpackToInstance" | "importMrpackByPath" | "instanceTab" | "refresh" | "say" | "selected" | "selectedId" | "selectedIdRef" | "setBootstrap" | "setBusy" | "setContentExiting" | "setDownloadingIds" | "setModpackTarget" | "setStatus" | "setTransferPct" | "t">) {
  const { assertNotLaunching, bootstrapRef, busy, contentTimer, downloadingIds, finishModpackToInstance, importMrpackByPath, instanceTab, refresh, say, selected, selectedId, selectedIdRef, setBootstrap, setBusy, setContentExiting, setDownloadingIds, setModpackTarget, setStatus, setTransferPct, t } = deps;
  function switchContentType(next: ModrinthProjectType): void {
    if (contentTimer.current !== null) {
      window.clearTimeout(contentTimer.current);
      contentTimer.current = null;
    }
    if (next === contentType) {
      setContentExiting(false);
      return;
    }
    setContentExiting(true);
    contentTimer.current = window.setTimeout(() => {
      setContentType(next);
      setModResults([]);
      setContentExiting(false);
      contentTimer.current = null;
    }, motionMs(225));
  }

  const [contentType, setContentType] = useState<ModrinthProjectType>("mod");

  const [modQuery, setModQuery] = useState("");

  const [modResults, setModResults] = useState<ModSearchResult[]>([]);

  const [contentSort, setContentSort] = useState<ModSortIndex>("relevance");

  const [contentLimit, setContentLimit] = useState(20);

  const [contentPage, setContentPage] = useState(1);

  const [totalHits, setTotalHits] = useState(0);

  const [hideInstalled, setHideInstalled] = useState(false);

  const [versionUnlocked, setVersionUnlocked] = useState(false);

  const [versionOverride, setVersionOverride] = useState<string | null>(null);

  const [loaderUnlocked, setLoaderUnlocked] = useState(false);

  const [loaderOverride, setLoaderOverride] = useState<string | null>(null);

  const [categoryTags, setCategoryTags] = useState<string[]>([]);

  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);

  const [localContent, setLocalContent] = useState<LocalContentItem[] | null>(null);

  const [updateInfo, setUpdateInfo] = useState<Record<string, ContentUpdateInfo>>({});

  const [checkingUpdates, setCheckingUpdates] = useState(false);

  const [updatingKeys, setUpdatingKeys] = useState<string[]>([]);

  const [versionPicker, setVersionPicker] = useState<{ key: string; item: LocalContentItem; record: InstalledMod; versions: ModVersionInfo[] | null; showAll: boolean } | null>(null);

  const [fileQuery, setFileQuery] = useState("");

  const [fileSort, setFileSort] = useState("name-asc");

  const contentAutoKey = useRef("");

  async function importDroppedContent(paths: string[]): Promise<void> {
    if (!selected) return;
    if (!assertNotLaunching()) return;
    const instanceId = selected.id;
    setBusy(true);
    say(t("Adding files...", "Добавление файлов..."));
    try {
      const result = await getLauncherApi().importLocalContent(instanceId, paths);
      const kindLabel = (kind: LocalContentKind): string => {
        const group = fileGroups.find((item) => item.id === kind);
        return group ? t(group.label, group.labelRu).toLowerCase() : kind;
      };
      const parts: string[] = [];
      if (result.added.length) {
        const byKind = new Map<LocalContentKind, number>();
        for (const item of result.added) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
        parts.push(t("Added", "Добавлено") + ": " + [...byKind.entries()].map(([kind, count]) => `${kindLabel(kind)} ${count}`).join(", "));
      }
      const reasons: Array<[ContentImportResult["skipped"][number]["reason"], string]> = [
        ["exists", t("already in the instance", "уже есть в инстанции")],
        ["unknown", t("type not recognized", "тип не распознан")],
        ["unsupported", t("not a mod, resource pack, shader or data pack", "не мод, ресурспак, шейдер или датапак")],
        ["failed", t("could not be copied", "не удалось скопировать")]
      ];
      for (const [reason, label] of reasons) {
        const names = result.skipped.filter((item) => item.reason === reason).map((item) => item.fileName);
        if (names.length) parts.push(`${label}: ${names.join(", ")}`);
      }
      say(parts.join(" · ") || t("Nothing to add", "Нечего добавить"));
      if (result.added.length) {
        const updated = await getLauncherApi().detectLocalContent(instanceId).catch(() => null);
        if (updated) {
          setBootstrap((current) => current ? { ...current, instances: current.instances.map((item) => item.id === updated.id ? updated : item) } : current);
        }
        if (selectedIdRef.current === instanceId) {
          setLocalContent(await getLauncherApi().getLocalContent(instanceId));
        }
      }
    } catch (error) {
      say(error instanceof Error ? error.message : t("Failed to add files", "Не удалось добавить файлы"));
    } finally {
      setBusy(false);
    }
  }

  const importContentRef = useRef(importDroppedContent);

  importContentRef.current = importDroppedContent;

  const installedProjectIds = useMemo(() => new Set((selected?.mods ?? []).map((mod) => mod.projectId)), [selected?.mods]);

  const visibleResults = hideInstalled ? modResults.filter((result) => !installedProjectIds.has(result.id)) : modResults;

  const totalPages = Math.max(1, Math.ceil(totalHits / contentLimit));

  const sortLabel = sortOptions.find((option) => option.id === contentSort)?.label ?? "Relevance";

  const isVanillaSelected = selected?.loader === "vanilla";

  const visibleContentTypes = isVanillaSelected ? contentTypes.filter((item) => item.id === "resourcepack" || item.id === "datapack") : contentTypes;

  useEffect(() => {
    if (isVanillaSelected && contentType !== "resourcepack" && contentType !== "datapack") {
      setContentType("resourcepack");
      setModResults([]);
      setTotalHits(0);
    }
  }, [isVanillaSelected]);

  async function refreshLocalContent(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    try {
      setLocalContent(await getLauncherApi().getLocalContent(selected.id));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to read instance files", "Не удалось прочитать файлы инстанции"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleLocalItem(item: LocalContentItem): Promise<void> {
    if (!selected || !assertNotLaunching()) return;
    setBusy(true);
    try {
      setLocalContent(await getLauncherApi().toggleLocalContent({ instanceId: selected.id, fileName: item.fileName, kind: item.kind }));
      say(`${item.enabled ? t("Disabled", "Отключено") : t("Enabled", "Включено")} ${item.displayName}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to toggle file", "Не удалось переключить файл"));
    } finally {
      setBusy(false);
    }
  }

  function contentKey(kind: string, fileName: string): string {
    return `${kind}:${fileName.replace(/\.disabled$/i, "").toLowerCase()}`;
  }

  function recordFor(item: LocalContentItem): InstalledMod | undefined {
    return selected?.mods.find((mod) => mod.provider === "modrinth" && mod.fileName !== undefined && contentKey(mod.projectType ?? "mod", mod.fileName) === contentKey(item.kind, item.fileName));
  }

  async function checkUpdates(instanceId: string): Promise<void> {
    setCheckingUpdates(true);
    try {
      const list = await getLauncherApi().checkContentUpdates(instanceId);
      if (selectedIdRef.current !== instanceId) return;
      setUpdateInfo(Object.fromEntries(list.map((info) => [contentKey(info.projectType, info.fileName), info])));
    } catch {
      setUpdateInfo({});
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function installVersion(item: LocalContentItem, record: InstalledMod, versionId: string): Promise<boolean> {
    if (!selected || !assertNotLaunching()) return false;
    const key = contentKey(item.kind, item.fileName);
    setUpdatingKeys((current) => [...current, key]);
    try {
      const updated = await getLauncherApi().installMod({
        instanceId: selected.id,
        provider: "modrinth",
        projectId: record.projectId,
        versionId,
        name: record.name,
        slug: record.slug,
        iconUrl: record.iconUrl,
        projectType: item.kind
      });
      setBootstrap((current) => current ? { ...current, instances: current.instances.map((entry) => entry.id === updated.id ? updated : entry) } : current);
      setLocalContent(await getLauncherApi().getLocalContent(selected.id));
      return true;
    } catch (error) {
      say(error instanceof Error ? error.message : t("Failed to install the version", "Не удалось установить версию"));
      return false;
    } finally {
      setUpdatingKeys((current) => current.filter((entry) => entry !== key));
    }
  }

  async function updateItem(item: LocalContentItem): Promise<void> {
    const record = recordFor(item);
    const latest = updateInfo[contentKey(item.kind, item.fileName)]?.latest;
    if (!record || !latest) return;
    if (await installVersion(item, record, latest.id)) {
      say(t(`Updated ${record.name} to ${latest.versionNumber}`, `${record.name} обновлён до ${latest.versionNumber}`));
    }
  }

  async function updateAll(): Promise<void> {
    if (!localContent) return;
    const pending = localContent.filter((item) => recordFor(item) && updateInfo[contentKey(item.kind, item.fileName)]?.latest);
    let done = 0;
    for (const item of pending) {
      say(t(`Updating ${done + 1} of ${pending.length}...`, `Обновление ${done + 1} из ${pending.length}...`));
      const record = recordFor(item);
      const latest = updateInfo[contentKey(item.kind, item.fileName)]?.latest;
      if (record && latest && await installVersion(item, record, latest.id)) done += 1;
    }
    say(t(`Updated ${done} of ${pending.length}`, `Обновлено: ${done} из ${pending.length}`));
  }

  async function openVersionPicker(item: LocalContentItem): Promise<void> {
    const record = recordFor(item);
    if (!record || !selected) return;
    const key = contentKey(item.kind, item.fileName);
    setVersionPicker({ key, item, record, versions: null, showAll: false });
    try {
      const versions = await getLauncherApi().listModVersions(selected.id, record.projectId, item.kind);
      setVersionPicker((current) => current && current.key === key ? { ...current, versions } : current);
    } catch (error) {
      setVersionPicker(null);
      say(error instanceof Error ? error.message : t("Failed to load versions", "Не удалось загрузить версии"));
    }
  }

  async function pickVersion(version: ModVersionInfo): Promise<void> {
    if (!versionPicker) return;
    const { item, record } = versionPicker;
    setVersionPicker(null);
    if (await installVersion(item, record, version.id)) {
      say(t(`Installed ${record.name} ${version.versionNumber}`, `Установлена версия ${version.versionNumber}: ${record.name}`));
    }
  }

  const fileRowActions = useRef<FileRowActions>({ toggle: () => undefined, remove: () => undefined, update: () => undefined, versions: () => undefined });

  fileRowActions.current = {
    toggle: (item) => void toggleLocalItem(item),
    remove: (item) => void removeLocalItem(item),
    update: (item) => void updateItem(item),
    versions: (item) => void openVersionPicker(item)
  };

  async function removeLocalItem(item: LocalContentItem): Promise<void> {
    if (!selected || !assertNotLaunching()) return;
    setBusy(true);
    try {
      setLocalContent(await getLauncherApi().removeLocalContent({ instanceId: selected.id, fileName: item.fileName, kind: item.kind }));
      say(t(`Deleted ${item.displayName}`, `Удалено: ${item.displayName}`));
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("Failed to delete file", "Не удалось удалить файл"));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setContentPage(1);
    setTotalHits(0);
    setModResults([]);
    setVersionUnlocked(false);
    setVersionOverride(null);
    setLoaderUnlocked(false);
    setLoaderOverride(null);
    setSelectedCategories([]);
    setHideInstalled(false);
    getLauncherApi().getCategoryTags(contentType).then(setCategoryTags).catch(() => setCategoryTags([]));
  }, [selectedId, contentType]);

  useEffect(() => {
    if (instanceTab !== "content" || !selectedId || busy) return;
    const key = `${selectedId}|${contentType}`;
    if (contentAutoKey.current === key || modResults.length > 0) return;
    contentAutoKey.current = key;
    void runContentSearch({ page: 1 });
  });

  useEffect(() => {
    if (instanceTab !== "files" || !selectedId) return;
    setLocalContent(null);
    void refreshLocalContent();
  }, [instanceTab, selectedId]);

  useEffect(() => {
    setUpdateInfo({});
  }, [selectedId]);

  useEffect(() => {
    if (instanceTab !== "files" || !selectedId) return;
    void checkUpdates(selectedId);
  }, [instanceTab, selectedId, selected?.updatedAt]);

  useEffect(() => {
    if (!selectedId || (instanceTab !== "content" && instanceTab !== "files")) return;
    const id = selectedId;
    const tab = instanceTab;
    let stale = false;
    void getLauncherApi().detectLocalContent(id).then((updated) => {
      if (stale) return;
      const before = bootstrapRef.current?.instances.find((item) => item.id === updated.id);
      if (before && before.updatedAt === updated.updatedAt && before.mods.length === updated.mods.length) return;
      setBootstrap((current) => current ? { ...current, instances: current.instances.map((item) => item.id === updated.id ? updated : item) } : current);
      if (tab === "files") {
        void getLauncherApi().getLocalContent(id).then((list) => {
          if (!stale) setLocalContent(list);
        }).catch(() => undefined);
      }
    }).catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [selectedId, instanceTab]);

  interface ContentQuery {
    page: number;
    sort: ModSortIndex;
    limit: number;
    categories: string[];
    versions: string[];
    loaders: string[];
  }

  function currentContentQuery(overrides: Partial<ContentQuery> = {}): ContentQuery {
    return {
      page: overrides.page ?? contentPage,
      sort: overrides.sort ?? contentSort,
      limit: overrides.limit ?? contentLimit,
      categories: overrides.categories ?? selectedCategories,
      versions: overrides.versions ?? (versionUnlocked && versionOverride ? [versionOverride] : []),
      loaders: overrides.loaders ?? ((contentType === "mod" || contentType === "modpack") && loaderUnlocked && loaderOverride ? [loaderOverride] : [])
    };
  }

  async function runContentSearch(overrides: Partial<ContentQuery> = {}): Promise<void> {
    if (!selected) return setStatus(t("Select an instance first", "Сначала выберите инстанцию"));
    const query = currentContentQuery(overrides);
    setBusy(true);
    try {
      const response = await getLauncherApi().searchMods({
        query: modQuery,
        instanceId: selected.id,
        projectType: contentType,
        sort: query.sort,
        limit: query.limit,
        offset: (query.page - 1) * query.limit,
        categories: query.categories,
        versions: query.versions,
        loaders: query.loaders
      });
      setModResults(response.results);
      setTotalHits(response.totalHits);
      setContentPage(query.page);
      setContentSort(query.sort);
      setContentLimit(query.limit);
      setSelectedCategories(query.categories);
      say(t(`Found ${response.totalHits} ${contentLabel(contentType).toLowerCase()} on Modrinth`, `Найдено: ${response.totalHits} — ${(contentTypes.find((c) => c.id === contentType)?.labelRu ?? "").toLowerCase()} на Modrinth`));
    } catch (error) {
      say(error instanceof Error ? error.message : t("Modrinth search failed", "Поиск на Modrinth не удался"));
    } finally {
      setBusy(false);
    }
  }

  function toggleCategory(tag: string): void {
    const next = selectedCategories.includes(tag) ? selectedCategories.filter((item) => item !== tag) : [...selectedCategories, tag];
    void runContentSearch({ page: 1, categories: next });
  }

  async function installContent(result: ModSearchResult): Promise<void> {
    if (!selected) return setStatus(t("Select an instance first", "Сначала выберите инстанцию"));
    if (!assertNotLaunching()) return;
    if (downloadingIds.includes(result.id)) return;
    setDownloadingIds((current) => [...current, result.id]);
    if (result.projectType === "modpack") {
      try {
        say(t(`Downloading ${result.title}...`, `Загрузка: ${result.title}...`));
        const filePath = await getLauncherApi().downloadModpack({
          instanceId: selected.id,
          projectId: result.id,
          name: result.title
        });
        await importMrpackByPath(filePath);
      } catch (error) {
        say(error instanceof Error ? error.message : t(`Failed to download ${result.title}`, `Не удалось скачать ${result.title}`));
      } finally {
        setDownloadingIds((current) => current.filter((id) => id !== result.id));
        setTransferPct((current) => {
          const next = { ...current };
          delete next[`modpack:${result.id}`];
          return next;
        });
      }
      return;
    }
    try {
      const updated = await getLauncherApi().installMod({
        instanceId: selected.id,
        provider: "modrinth",
        projectId: result.id,
        name: result.title,
        slug: result.slug,
        iconUrl: result.iconUrl,
        projectType: result.projectType,
        gameVersions: currentContentQuery().versions,
        loaders: currentContentQuery().loaders
      });
      setBootstrap((current) => current ? { ...current, instances: current.instances.map((item) => item.id === updated.id ? updated : item) } : current);
      say(t(`Installed ${result.title}`, `Установлено: ${result.title}`));
    } catch (error) {
      say(error instanceof Error ? error.message : t(`Failed to download ${result.title}`, `Не удалось скачать ${result.title}`));
    } finally {
      setDownloadingIds((current) => current.filter((id) => id !== result.id));
      setTransferPct((current) => {
        const next = { ...current };
        delete next[`mod:${result.id}`];
        return next;
      });
    }
  }

  async function installIntoThis(result: ModSearchResult): Promise<void> {
    if (!selected) return setStatus(t("Select an instance first", "Сначала выберите инстанцию"));
    if (!assertNotLaunching()) return;
    if (downloadingIds.includes(result.id)) return;
    setDownloadingIds((current) => [...current, result.id]);
    try {
      say(t(`Downloading ${result.title}...`, `Загрузка: ${result.title}...`));
      const filePath = await getLauncherApi().downloadModpack({
        instanceId: selected.id,
        projectId: result.id,
        name: result.title
      });
      const info = await getLauncherApi().importMrpackStartToInstance(filePath, selected.id);
      if (info.packGameVersion !== selected.gameVersion || info.packLoader !== selected.loader) {
        setModpackTarget({ resultId: result.id, title: result.title, filePath, instanceId: selected.id, instanceName: selected.name, instanceVersion: selected.gameVersion, instanceLoader: selected.loader, info });
        say(t(`${info.packName}: ${info.packGameVersion} / ${info.packLoader} vs instance ${selected.gameVersion} / ${selected.loader}`, `${info.packName}: ${info.packGameVersion} / ${info.packLoader}, в инстанции ${selected.gameVersion} / ${selected.loader}`));
        return;
      }
      try {
        await finishModpackToInstance(selected.id, selected.name);
      } finally {
        setDownloadingIds((current) => current.filter((id) => id !== result.id));
        setTransferPct((current) => {
          const next = { ...current };
          delete next[`modpack:${result.id}`];
          return next;
        });
      }
    } catch (error) {
      say(error instanceof Error ? error.message : t(`Failed to download ${result.title}`, `Не удалось скачать ${result.title}`));
      setDownloadingIds((current) => current.filter((id) => id !== result.id));
      setTransferPct((current) => {
        const next = { ...current };
        delete next[`modpack:${result.id}`];
        return next;
      });
    }
  }

  return {
    switchContentType,
    contentType,
    setContentType,
    modQuery,
    setModQuery,
    modResults,
    setModResults,
    contentSort,
    setContentSort,
    contentLimit,
    setContentLimit,
    contentPage,
    setContentPage,
    totalHits,
    setTotalHits,
    hideInstalled,
    setHideInstalled,
    versionUnlocked,
    setVersionUnlocked,
    versionOverride,
    setVersionOverride,
    loaderUnlocked,
    setLoaderUnlocked,
    loaderOverride,
    setLoaderOverride,
    categoryTags,
    setCategoryTags,
    selectedCategories,
    setSelectedCategories,
    localContent,
    setLocalContent,
    updateInfo,
    setUpdateInfo,
    checkingUpdates,
    setCheckingUpdates,
    updatingKeys,
    setUpdatingKeys,
    versionPicker,
    setVersionPicker,
    fileQuery,
    setFileQuery,
    fileSort,
    setFileSort,
    contentAutoKey,
    importDroppedContent,
    importContentRef,
    installedProjectIds,
    visibleResults,
    totalPages,
    sortLabel,
    isVanillaSelected,
    visibleContentTypes,
    refreshLocalContent,
    toggleLocalItem,
    contentKey,
    recordFor,
    checkUpdates,
    installVersion,
    updateItem,
    updateAll,
    openVersionPicker,
    pickVersion,
    fileRowActions,
    removeLocalItem,
    currentContentQuery,
    runContentSearch,
    toggleCategory,
    installContent,
    installIntoThis
  };
}

export type ContentState = ReturnType<typeof useContent>;
