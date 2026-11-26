import { useEffect, useMemo, useRef, useState } from "react";
import type { ContentImportResult, ContentUpdateInfo, InstalledMod, LocalContentItem, LocalContentKind, ModDependencyItem, ModInstallPlan, ModProjectDetails, ModProvider, ModrinthProjectType, ModSearchResult, ModSortIndex, ModVersionInfo } from "@shared/types";
import type { PrepareModInstallPayload } from "@shared/ipc";
import type { FileRowActions } from "../../components/FileRow";
import { getLauncherApi } from "../../lib/api";
import { contentLabel, contentTypes, fileGroups, sortOptions } from "../../lib/content";
import { cleanIpcError } from "../../lib/format";
import { motionMs } from "../../lib/motion";
import type { CoreState } from "./useCore";
import type { InstancesState } from "./useInstances";

export interface VersionPickerState {
  key: string;
  title: string;
  projectId: string;
  provider: ModProvider;
  projectType: ModrinthProjectType;
  slug?: string;
  iconUrl?: string;
  currentVersionId?: string;
  item?: LocalContentItem;
  record?: InstalledMod;
  result?: ModSearchResult;
  versions: ModVersionInfo[] | null;
  showAll: boolean;
  incompatiblePrompt?: boolean;
}

export interface DependencyPromptState {
  instanceId: string;
  projectId: string;
  provider: ModProvider;
  projectType: ModrinthProjectType;
  title: string;
  slug?: string;
  iconUrl?: string;
  targetVersion: ModVersionInfo;
  dependencies: ModDependencyItem[];
  checked: Record<string, boolean>;
  refreshFiles?: boolean;
}

export interface ModDetailsState {
  result: ModSearchResult;
  details: ModProjectDetails | null;
  loading: boolean;
  galleryIndex: number | null;
}

const UPDATE_CONCURRENCY = 4;

const CONTENT_SCROLL_GAP = 24;

export function useContent(deps: Pick<CoreState & InstancesState, "assertNotLaunching" | "bootstrapRef" | "busy" | "contentTimer" | "downloadingIds" | "finishModpackToInstance" | "importMrpackByPath" | "instanceTab" | "refresh" | "say" | "selected" | "selectedId" | "selectedIdRef" | "setBootstrap" | "setBusy" | "setContentExiting" | "setDownloadingIds" | "setModpackTarget" | "setStatus" | "setTransferPct" | "t">) {
  const { assertNotLaunching, bootstrapRef, busy, contentTimer, downloadingIds, finishModpackToInstance, importMrpackByPath, instanceTab, refresh, say, selected, selectedId, selectedIdRef, setBootstrap, setBusy, setContentExiting, setDownloadingIds, setModpackTarget, setStatus, setTransferPct, t } = deps;
  const pendingSwitchRef = useRef<{ type?: ModrinthProjectType; provider?: ModProvider }>({});

  function clearContentSwitch(): void {
    if (contentTimer.current !== null) {
      window.clearTimeout(contentTimer.current);
      contentTimer.current = null;
    }
    pendingSwitchRef.current = {};
  }

  function scheduleContentSwitch(patch: { type?: ModrinthProjectType; provider?: ModProvider }): void {
    if (contentTimer.current !== null) {
      window.clearTimeout(contentTimer.current);
      contentTimer.current = null;
    }
    const pending = { ...pendingSwitchRef.current, ...patch };
    if (pending.type === contentType) delete pending.type;
    if (pending.provider === contentProvider) delete pending.provider;
    pendingSwitchRef.current = pending;
    if (pending.type === undefined && pending.provider === undefined) {
      setContentExiting(false);
      if (modResults.length === 0) contentAutoKey.current = "";
      return;
    }
    searchSeqRef.current += 1;
    activeSearchRef.current = null;
    if (busyOpsRef.current === 0) setBusy(false);
    setContentExiting(true);
    contentTimer.current = window.setTimeout(() => {
      const next = pendingSwitchRef.current;
      pendingSwitchRef.current = {};
      contentTimer.current = null;
      if (next.type !== undefined) setContentType(next.type);
      if (next.provider !== undefined) {
        setContentProviderState(next.provider);
        setTotalHits(0);
      }
      setModResults([]);
      setContentExiting(false);
    }, motionMs(225));
  }

  function switchContentType(next: ModrinthProjectType): void {
    scheduleContentSwitch({ type: next });
  }

  const [contentType, setContentType] = useState<ModrinthProjectType>("mod");

  const [contentProvider, setContentProviderState] = useState<ModProvider>("modrinth");

  const providerName = contentProvider === "curseforge" ? "CurseForge" : "Modrinth";

  function hasCurseForgeKey(): boolean {
    return Boolean(bootstrapRef.current?.curseforgeAvailable);
  }

  function setContentProvider(next: ModProvider): void {
    scheduleContentSwitch({ provider: next });
  }

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

  const [updateAllProgress, setUpdateAllProgress] = useState<{ instanceId: string; done: number; total: number } | null>(null);

  const updatingAllRef = useRef(false);

  const [versionPicker, setVersionPicker] = useState<VersionPickerState | null>(null);

  const [dependencyPrompt, setDependencyPrompt] = useState<DependencyPromptState | null>(null);

  const [modDetails, setModDetails] = useState<ModDetailsState | null>(null);

  async function openModDetails(result: ModSearchResult): Promise<void> {
    setModDetails({ result, details: null, loading: true, galleryIndex: null });
    try {
      const details = await getLauncherApi().getModDetails(result.id, result.projectType, result.provider);
      setModDetails((current) => (current && current.result.id === result.id ? { ...current, details, loading: false } : current));
    } catch (error) {
      setModDetails((current) => (current && current.result.id === result.id ? { ...current, loading: false } : current));
      say(cleanIpcError(error, t("Failed to load project details", "Не удалось загрузить описание проекта")));
    }
  }

  const [fileQuery, setFileQuery] = useState("");

  const [fileSort, setFileSort] = useState("name-asc");

  const contentAutoKey = useRef("");

  const searchSeqRef = useRef(0);

  const activeSearchRef = useRef<number | null>(null);

  const busyOpsRef = useRef(0);

  const localSeqRef = useRef(0);

  const updatesSeqRef = useRef(0);

  const skipResetSearchRef = useRef(false);

  function beginBusyOp(): void {
    busyOpsRef.current += 1;
    setBusy(true);
  }

  function endBusyOp(): void {
    busyOpsRef.current = Math.max(0, busyOpsRef.current - 1);
    if (busyOpsRef.current === 0 && activeSearchRef.current === null) {
      setBusy(false);
    }
  }

  async function importDroppedContent(paths: string[]): Promise<void> {
    if (!selected) return;
    if (!assertNotLaunching()) return;
    const instanceId = selected.id;
    const seq = ++localSeqRef.current;
    beginBusyOp();
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
        if (selectedIdRef.current === instanceId && localSeqRef.current === seq) {
          const list = await getLauncherApi().getLocalContent(instanceId);
          if (selectedIdRef.current === instanceId && localSeqRef.current === seq) {
            setLocalContent(list);
          }
        }
      }
    } catch (error) {
      say(cleanIpcError(error, t("Failed to add files", "Не удалось добавить файлы")));
    } finally {
      endBusyOp();
    }
  }

  const importContentRef = useRef(importDroppedContent);

  importContentRef.current = importDroppedContent;

  const installedProjectIds = useMemo(() => {
    const ids = new Set<string>();
    const missingKeys = new Set<string>();
    const presentKeys = new Set<string>();
    for (const item of localContent ?? []) {
      const key = `${item.kind}:${item.fileName.replace(/\.disabled$/i, "").toLowerCase()}`;
      if (item.source === "missing") missingKeys.add(key);
      else presentKeys.add(key);
    }
    for (const mod of selected?.mods ?? []) {
      const kind = mod.projectType ?? "mod";
      const fileKey = mod.fileName ? `${kind}:${mod.fileName.replace(/\.disabled$/i, "").toLowerCase()}` : null;
      if (fileKey && missingKeys.has(fileKey) && !presentKeys.has(fileKey)) continue;
      if (mod.projectId) ids.add(`${kind}:${mod.projectId}`);
      if (mod.slug) ids.add(`${kind}:slug:${mod.slug.toLowerCase()}`);
    }
    return ids;
  }, [selected?.mods, localContent]);

  const isResultInstalled = (result: ModSearchResult): boolean =>
    installedProjectIds.has(`${result.projectType}:${result.id}`)
    || Boolean(result.slug && installedProjectIds.has(`${result.projectType}:slug:${result.slug.toLowerCase()}`));

  const visibleResults = hideInstalled ? modResults.filter((result) => !isResultInstalled(result)) : modResults;

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
    if (!selected || busy) return;
    const instanceId = selected.id;
    const seq = ++localSeqRef.current;
    beginBusyOp();
    try {
      const list = await getLauncherApi().getLocalContent(instanceId);
      if (selectedIdRef.current === instanceId && localSeqRef.current === seq) {
        setLocalContent(list);
      }
    } catch (error) {
      setStatus(cleanIpcError(error, t("Failed to read instance files", "Не удалось прочитать файлы инстанции")));
    } finally {
      endBusyOp();
    }
  }

  async function toggleLocalItem(item: LocalContentItem): Promise<void> {
    if (!selected || busy || !assertNotLaunching()) return;
    const instanceId = selected.id;
    const seq = ++localSeqRef.current;
    beginBusyOp();
    try {
      const list = await getLauncherApi().toggleLocalContent({ instanceId, fileName: item.fileName, kind: item.kind, world: item.world });
      if (selectedIdRef.current === instanceId && localSeqRef.current === seq) {
        setLocalContent(list);
      }
      const depWarn = item.enabled && item.dependents?.length ? t(` · Required by: ${item.dependents.join(", ")}`, ` · Внимание, от него зависят: ${item.dependents.join(", ")}`) : "";
      say(`${item.enabled ? t("Disabled", "Отключено") : t("Enabled", "Включено")} ${item.displayName}${depWarn}`, instanceId);
    } catch (error) {
      setStatus(cleanIpcError(error, t("Failed to toggle file", "Не удалось переключить файл")));
    } finally {
      endBusyOp();
    }
  }

  function contentKey(kind: string, fileName: string): string {
    return `${kind}:${fileName.replace(/\.disabled$/i, "").toLowerCase()}`;
  }

  function recordFor(item: LocalContentItem): InstalledMod | undefined {
    return selected?.mods.find((mod) => mod.fileName !== undefined && contentKey(mod.projectType ?? "mod", mod.fileName) === contentKey(item.kind, item.fileName));
  }

  async function checkUpdates(instanceId: string): Promise<void> {
    const seq = ++updatesSeqRef.current;
    setCheckingUpdates(true);
    try {
      const list = await getLauncherApi().checkContentUpdates(instanceId);
      if (selectedIdRef.current !== instanceId || updatesSeqRef.current !== seq) return;
      setUpdateInfo(Object.fromEntries(list.map((info) => [contentKey(info.projectType, info.fileName), info])));
    } catch {
      if (selectedIdRef.current === instanceId && updatesSeqRef.current === seq) {
        setUpdateInfo({});
      }
    } finally {
      if (updatesSeqRef.current === seq) {
        setCheckingUpdates(false);
      }
    }
  }

  async function installVersion(item: LocalContentItem, record: InstalledMod, version: ModVersionInfo, refreshFiles = true, targetInstanceId?: string): Promise<boolean> {
    const instanceId = targetInstanceId ?? selected?.id;
    if (!instanceId) return false;
    const key = contentKey(item.kind, item.fileName);
    setUpdatingKeys((current) => [...current, key]);
    try {
      const updated = await getLauncherApi().installMod({
        instanceId,
        provider: version.provider ?? record.provider,
        projectId: version.projectId ?? record.projectId,
        versionId: version.id,
        replaceModId: record.id,
        name: record.name,
        slug: record.slug,
        iconUrl: record.iconUrl,
        projectType: item.kind
      });
      setBootstrap((current) => current ? { ...current, instances: current.instances.map((entry) => entry.id === updated.id ? updated : entry) } : current);
      if (refreshFiles && selectedIdRef.current === instanceId) {
        const list = await getLauncherApi().getLocalContent(instanceId);
        if (selectedIdRef.current === instanceId) {
          setLocalContent(list);
        }
      }
      return true;
    } catch (error) {
      say(cleanIpcError(error, t("Failed to install the version", "Не удалось установить версию")), instanceId);
      return false;
    } finally {
      setUpdatingKeys((current) => current.filter((entry) => entry !== key));
    }
  }

  async function updateItem(item: LocalContentItem): Promise<void> {
    const record = recordFor(item);
    const latest = updateInfo[contentKey(item.kind, item.fileName)]?.latest;
    if (!record || !latest || !selected || !assertNotLaunching()) return;
    const instanceId = selected.id;
    if (await installVersion(item, record, latest, true, instanceId)) {
      say(t(`Updated ${record.name} to ${latest.versionNumber}`, `${record.name} обновлён до ${latest.versionNumber}`), instanceId);
    }
  }

  async function updateAll(): Promise<void> {
    if (!localContent || !selected || updatingAllRef.current || !assertNotLaunching()) return;
    const instanceId = selected.id;
    const seen = new Set<string>();
    const queue = localContent.flatMap((item) => {
      const record = recordFor(item);
      const latest = updateInfo[contentKey(item.kind, item.fileName)]?.latest;
      if (!record || !latest || latest.distributionBlocked || seen.has(record.id)) return [];
      seen.add(record.id);
      return [{ item, record, version: latest }];
    });
    const total = queue.length;
    if (!total) return;
    let finished = 0;
    let done = 0;
    updatingAllRef.current = true;
    setUpdateAllProgress({ instanceId, done: 0, total });
    say(t(`Updating 0 of ${total}...`, `Обновление: 0 из ${total}...`), instanceId);
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        if (await installVersion(next.item, next.record, next.version, false, instanceId)) done += 1;
        finished += 1;
        setUpdateAllProgress({ instanceId, done: finished, total });
        say(t(`Updating ${finished} of ${total}...`, `Обновление: ${finished} из ${total}...`), instanceId);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(UPDATE_CONCURRENCY, total) }, worker));
      if (selectedIdRef.current === instanceId) {
        setLocalContent(await getLauncherApi().getLocalContent(instanceId).catch(() => localContent));
      }
    } finally {
      updatingAllRef.current = false;
      setUpdateAllProgress(null);
    }
    say(t(`Updated ${done} of ${total}`, `Обновлено: ${done} из ${total}`), instanceId);
    if (selectedIdRef.current === instanceId) await checkUpdates(instanceId);
  }

  async function openVersionPicker(item: LocalContentItem): Promise<void> {
    const record = recordFor(item);
    if (!record || !selected) return;
    const key = contentKey(item.kind, item.fileName);
    const currentVersionId = updateInfo[key]?.currentVersionId ?? record.versionId;
    setVersionPicker({
      key,
      title: record.name,
      projectId: record.projectId,
      provider: record.provider,
      projectType: item.kind,
      slug: record.slug,
      iconUrl: record.iconUrl,
      currentVersionId,
      item,
      record,
      versions: null,
      showAll: false
    });
    try {
      const versions = await getLauncherApi().listModVersions(selected.id, record.projectId, item.kind, record.provider);
      const hasCompat = versions.some((v) => v.compatible);
      setVersionPicker((current) => current && current.key === key ? { ...current, versions, showAll: current.showAll || !hasCompat } : current);
    } catch (error) {
      setVersionPicker(null);
      say(cleanIpcError(error, t("Failed to load versions", "Не удалось загрузить версии")));
    }
  }

  async function openCatalogVersionPicker(result: ModSearchResult): Promise<void> {
    if (!selected) return setStatus(t("Select an instance first", "Сначала выберите инстанцию"));
    const key = `catalog:${result.provider}:${result.projectType}:${result.id}`;
    const existing = selected.mods.find(
      (mod) => (mod.projectType ?? "mod") === result.projectType && (mod.projectId === result.id || Boolean(result.slug && mod.slug && mod.slug.toLowerCase() === result.slug.toLowerCase()))
    );
    setVersionPicker({
      key,
      title: result.title,
      projectId: result.id,
      provider: result.provider,
      projectType: result.projectType,
      slug: result.slug,
      iconUrl: result.iconUrl,
      currentVersionId: existing?.versionId,
      result,
      versions: null,
      showAll: false
    });
    try {
      const versions = await getLauncherApi().listModVersions(selected.id, result.id, result.projectType, result.provider);
      const hasCompat = versions.some((v) => v.compatible);
      setVersionPicker((current) =>
        current && current.key === key
          ? { ...current, versions, showAll: current.showAll || !hasCompat, incompatiblePrompt: !hasCompat && versions.length > 0 }
          : current
      );
    } catch (error) {
      setVersionPicker(null);
      say(cleanIpcError(error, t("Failed to load versions", "Не удалось загрузить версии")));
    }
  }

  async function executeModInstallWithDeps(
    params: {
      instanceId: string;
      projectId: string;
      provider: ModProvider;
      projectType: ModrinthProjectType;
      title: string;
      slug?: string;
      iconUrl?: string;
      targetVersion: ModVersionInfo;
      refreshFiles?: boolean;
    },
    depsToInstall: ModDependencyItem[]
  ): Promise<void> {
    if (!assertNotLaunching()) return;
    const { instanceId, projectId, provider, projectType, title, slug, iconUrl, targetVersion, refreshFiles } = params;
    const allIds = [projectId, ...depsToInstall.map((d) => d.projectId)];
    setDownloadingIds((current) => [...new Set([...current, ...allIds])]);
    try {
      let installedDeps = 0;
      for (const dep of depsToInstall) {
        say(t(`Installing dependency ${dep.title}...`, `Установка зависимости: ${dep.title}...`), instanceId);
        const updatedDep = await getLauncherApi().installMod({
          instanceId,
          provider: dep.provider,
          projectId: dep.projectId,
          versionId: dep.versionId,
          name: dep.title,
          slug: dep.slug,
          iconUrl: dep.iconUrl,
          projectType: "mod"
        });
        installedDeps += 1;
        setBootstrap((current) => current ? { ...current, instances: current.instances.map((entry) => entry.id === updatedDep.id ? updatedDep : entry) } : current);
      }
      say(t(`Installing ${title}...`, `Установка: ${title}...`), instanceId);
      const updated = await getLauncherApi().installMod({
        instanceId,
        provider: targetVersion.provider ?? provider,
        projectId: targetVersion.projectId ?? projectId,
        versionId: targetVersion.id,
        name: title,
        slug,
        iconUrl,
        projectType
      });
      setBootstrap((current) => current ? { ...current, instances: current.instances.map((entry) => entry.id === updated.id ? updated : entry) } : current);
      if (refreshFiles && selectedIdRef.current === instanceId) {
        setLocalContent(await getLauncherApi().getLocalContent(instanceId));
      }
      if (installedDeps > 0) {
        say(t(`Installed ${title} ${targetVersion.versionNumber} (+${installedDeps} ${installedDeps === 1 ? "dependency" : "dependencies"})`, `Установлено: ${title} ${targetVersion.versionNumber} (+ зависимостей: ${installedDeps})`), instanceId);
      } else {
        say(t(`Installed ${title} ${targetVersion.versionNumber}`, `Установлено: ${title} ${targetVersion.versionNumber}`), instanceId);
      }
    } catch (error) {
      say(cleanIpcError(error, t(`Failed to download ${title}`, `Не удалось скачать ${title}`)), instanceId);
    } finally {
      setDownloadingIds((current) => current.filter((id) => !allIds.includes(id)));
      setTransferPct((current) => {
        const next = { ...current };
        for (const id of allIds) delete next[`mod:${id}`];
        return next;
      });
    }
  }

  async function prepareModInstallSafe(payload: PrepareModInstallPayload): Promise<ModInstallPlan> {
    const api = getLauncherApi();
    if (typeof api.prepareModInstall === "function") {
      return api.prepareModInstall(payload);
    }
    const kind = payload.projectType === "modpack" ? "mod" : payload.projectType;
    const versions = await api.listModVersions(payload.instanceId, payload.projectId, kind, payload.provider);
    const targetVersion = payload.versionId
      ? versions.find((v) => v.id === payload.versionId) ?? null
      : versions.find((v) => v.compatible) ?? null;
    return { targetVersion, hasCompatibleVersion: versions.some((v) => v.compatible), versions, dependencies: [] };
  }

  function toggleDependencyCheck(projectId: string): void {
    setDependencyPrompt((current) =>
      current ? { ...current, checked: { ...current.checked, [projectId]: !current.checked[projectId] } } : current
    );
  }

  async function confirmDependencyInstall(includeSelected: boolean): Promise<void> {
    if (!dependencyPrompt) return;
    const prompt = dependencyPrompt;
    setDependencyPrompt(null);
    const chosenDeps = includeSelected
      ? prompt.dependencies.filter((d) => !d.installed && d.compatible && !d.distributionBlocked && prompt.checked[d.projectId])
      : [];
    await executeModInstallWithDeps(prompt, chosenDeps);
  }

  async function pickVersion(version: ModVersionInfo): Promise<void> {
    if (!versionPicker || !selected || !assertNotLaunching()) return;
    const picker = versionPicker;
    setVersionPicker(null);

    if (picker.projectType === "modpack") {
      if (downloadingIds.includes(picker.projectId)) return;
      setDownloadingIds((current) => [...current, picker.projectId]);
      try {
        say(t(`Downloading ${picker.title} (${version.versionNumber})...`, `Загрузка: ${picker.title} (${version.versionNumber})...`));
        const filePath = await getLauncherApi().downloadModpack({
          provider: version.provider ?? picker.provider,
          instanceId: selected.id,
          projectId: version.projectId ?? picker.projectId,
          versionId: version.id,
          name: picker.title
        });
        await importMrpackByPath(filePath);
      } catch (error) {
        say(cleanIpcError(error, t(`Failed to download ${picker.title}`, `Не удалось скачать ${picker.title}`)));
      } finally {
        setDownloadingIds((current) => current.filter((id) => id !== picker.projectId));
        setTransferPct((current) => {
          const next = { ...current };
          delete next[`modpack:${picker.projectId}`];
          return next;
        });
      }
      return;
    }

    const instanceId = selected.id;
    const refreshFiles = Boolean(picker.item);
    if (picker.projectType === "mod") {
      setDownloadingIds((current) => [...current, picker.projectId]);
      try {
        const plan = await prepareModInstallSafe({
          instanceId,
          provider: version.provider ?? picker.provider,
          projectId: version.projectId ?? picker.projectId,
          versionId: version.id,
          projectType: "mod"
        });
        const target = plan.targetVersion ?? version;
        const uninstalled = plan.dependencies.filter((d) => !d.installed);
        const autoInstall = Boolean(bootstrapRef.current?.settings.autoInstallDependencies);
        if (!autoInstall && uninstalled.length > 0) {
          const checked = Object.fromEntries(
            uninstalled
              .filter((d) => d.dependencyType === "required" && d.compatible && !d.distributionBlocked)
              .map((d) => [d.projectId, true])
          );
          setDependencyPrompt({
            instanceId,
            projectId: picker.projectId,
            provider: picker.provider,
            projectType: picker.projectType,
            title: picker.title,
            slug: picker.slug,
            iconUrl: picker.iconUrl,
            targetVersion: target,
            dependencies: plan.dependencies,
            checked,
            refreshFiles
          });
          return;
        }
        const autoDeps = autoInstall
          ? uninstalled.filter((d) => d.dependencyType === "required" && d.compatible && !d.distributionBlocked)
          : [];
        await executeModInstallWithDeps(
          {
            instanceId,
            projectId: picker.projectId,
            provider: picker.provider,
            projectType: picker.projectType,
            title: picker.title,
            slug: picker.slug,
            iconUrl: picker.iconUrl,
            targetVersion: target,
            refreshFiles
          },
          autoDeps
        );
      } catch (error) {
        say(cleanIpcError(error, t("Failed to install the version", "Не удалось установить версию")));
      } finally {
        setDownloadingIds((current) => current.filter((id) => id !== picker.projectId));
      }
      return;
    }

    await executeModInstallWithDeps(
      {
        instanceId,
        projectId: picker.projectId,
        provider: picker.provider,
        projectType: picker.projectType,
        title: picker.title,
        slug: picker.slug,
        iconUrl: picker.iconUrl,
        targetVersion: version,
        refreshFiles
      },
      []
    );
  }

  const fileRowActions = useRef<FileRowActions>({ toggle: () => undefined, remove: () => undefined, update: () => undefined, versions: () => undefined });

  fileRowActions.current = {
    toggle: (item) => void toggleLocalItem(item),
    remove: (item) => void removeLocalItem(item),
    update: (item) => void updateItem(item),
    versions: (item) => void openVersionPicker(item)
  };

  async function removeLocalItem(item: LocalContentItem): Promise<void> {
    if (!selected || busy || !assertNotLaunching()) return;
    const instanceId = selected.id;
    const seq = ++localSeqRef.current;
    beginBusyOp();
    try {
      const list = await getLauncherApi().removeLocalContent({ instanceId, fileName: item.fileName, kind: item.kind, world: item.world });
      if (selectedIdRef.current === instanceId && localSeqRef.current === seq) {
        setLocalContent(list);
      }
      const depWarn = item.dependents?.length ? t(` · Required by: ${item.dependents.join(", ")}`, ` · Внимание, от него зависят: ${item.dependents.join(", ")}`) : "";
      say(t(`Deleted ${item.displayName}`, `Удалено: ${item.displayName}`) + depWarn, instanceId);
      await refresh();
    } catch (error) {
      setStatus(cleanIpcError(error, t("Failed to delete file", "Не удалось удалить файл")));
    } finally {
      endBusyOp();
    }
  }

  useEffect(() => {
    setContentPage(1);
    setSelectedCategories([]);
    setHideInstalled(false);
    if (skipResetSearchRef.current) {
      skipResetSearchRef.current = false;
    } else {
      searchSeqRef.current += 1;
      activeSearchRef.current = null;
      if (busyOpsRef.current === 0) setBusy(false);
      setTotalHits(0);
      setModResults([]);
      setVersionUnlocked(false);
      setVersionOverride(null);
      setLoaderUnlocked(false);
      setLoaderOverride(null);
    }
    if (contentProvider === "curseforge" && !hasCurseForgeKey()) {
      setCategoryTags([]);
      return;
    }
    let stale = false;
    getLauncherApi().getCategoryTags(contentType, contentProvider).then((tags) => {
      if (!stale) setCategoryTags(tags);
    }).catch(() => {
      if (!stale) setCategoryTags([]);
    });
    return () => {
      stale = true;
    };
  }, [selectedId, contentType, contentProvider]);

  useEffect(() => {
    if (instanceTab !== "content" || !selectedId || busy) return;
    const key = `${selectedId}|${contentType}|${contentProvider}`;
    if (contentAutoKey.current === key || modResults.length > 0) return;
    contentAutoKey.current = key;
    void runContentSearch({ page: 1 });
  });

  useEffect(() => {
    if (instanceTab !== "files" || !selectedId) return;
    const id = selectedId;
    const seq = ++localSeqRef.current;
    let stale = false;
    setLocalContent(null);
    void getLauncherApi().getLocalContent(id).then((list) => {
      if (!stale && selectedIdRef.current === id && localSeqRef.current === seq) {
        setLocalContent(list);
      }
    }).catch((error) => {
      if (!stale && selectedIdRef.current === id && localSeqRef.current === seq) {
        setLocalContent([]);
        setStatus(cleanIpcError(error, t("Failed to read instance files", "Не удалось прочитать файлы инстанции")));
      }
    });
    return () => {
      stale = true;
    };
  }, [instanceTab, selectedId]);

  useEffect(() => {
    setLocalContent(null);
    setUpdateInfo({});
  }, [selectedId]);

  useEffect(() => {
    if (instanceTab !== "files" || !selectedId || updatingAllRef.current) return;
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
      const changed = !before || before.updatedAt !== updated.updatedAt || before.mods.length !== updated.mods.length;
      if (changed) {
        setBootstrap((current) => current ? { ...current, instances: current.instances.map((item) => item.id === updated.id ? updated : item) } : current);
      }
      if (changed || tab === "content") {
        void getLauncherApi().getLocalContent(id).then((list) => {
          if (!stale && selectedIdRef.current === id) setLocalContent(list);
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

  function currentContentQuery(overrides: Partial<ContentQuery> = {}, targetType: ModrinthProjectType = contentType): ContentQuery {
    return {
      page: overrides.page ?? contentPage,
      sort: overrides.sort ?? contentSort,
      limit: overrides.limit ?? contentLimit,
      categories: overrides.categories ?? selectedCategories,
      versions: overrides.versions ?? (versionUnlocked && versionOverride ? [versionOverride] : []),
      loaders: overrides.loaders ?? ((targetType === "mod" || targetType === "modpack") && loaderUnlocked && loaderOverride ? [loaderOverride] : [])
    };
  }

  function scrollResultsToTop(): void {
    window.requestAnimationFrame(() => {
      const list = document.querySelector<HTMLElement>(".mod-results");
      const scroller = list?.closest<HTMLElement>(".instance-workspace");
      if (!list || !scroller) return;
      const offset = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top - CONTENT_SCROLL_GAP;
      if (offset >= 0) return;
      const instant = document.documentElement.classList.contains("no-anim");
      scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + offset), behavior: instant ? "auto" : "smooth" });
    });
  }

  async function runContentSearch(overrides: Partial<ContentQuery> & { query?: string; projectType?: ModrinthProjectType } = {}): Promise<void> {
    if (!selected) return setStatus(t("Select an instance first", "Сначала выберите инстанцию"));
    const targetType = overrides.projectType ?? contentType;
    const targetQuery = overrides.query ?? modQuery;
    const query = currentContentQuery(overrides, targetType);
    const seq = ++searchSeqRef.current;
    const targetInstanceId = selected.id;
    const targetProvider = contentProvider;
    const targetProviderName = providerName;
    if (overrides.query !== undefined || overrides.projectType !== undefined) {
      contentAutoKey.current = `${targetInstanceId}|${targetType}|${targetProvider}`;
    }
    if (targetProvider === "curseforge" && !hasCurseForgeKey()) {
      setModResults([]);
      setTotalHits(0);
      return;
    }
    setBusy(true);
    activeSearchRef.current = seq;
    try {
      const response = await getLauncherApi().searchMods({
        provider: targetProvider,
        query: targetQuery,
        instanceId: targetInstanceId,
        projectType: targetType,
        sort: query.sort,
        limit: query.limit,
        offset: (query.page - 1) * query.limit,
        categories: query.categories,
        versions: query.versions,
        loaders: query.loaders
      });
      if (seq !== searchSeqRef.current || selectedIdRef.current !== targetInstanceId) return;
      const pageChanged = query.page !== contentPage;
      setModResults(response.results);
      setTotalHits(response.totalHits);
      setContentPage(query.page);
      if (pageChanged) scrollResultsToTop();
      setContentSort(query.sort);
      setContentLimit(query.limit);
      setSelectedCategories(query.categories);
      say(t(`Found ${response.totalHits} ${contentLabel(targetType).toLowerCase()} on ${targetProviderName}`, `Найдено: ${response.totalHits} — ${(contentTypes.find((c) => c.id === targetType)?.labelRu ?? "").toLowerCase()} на ${targetProviderName}`));
    } catch (error) {
      if (seq !== searchSeqRef.current) return;
      setModResults([]);
      setTotalHits(0);
      say(cleanIpcError(error, t(`${targetProviderName} search failed`, `Поиск на ${targetProviderName} не удался`)));
    } finally {
      if (activeSearchRef.current === seq) {
        activeSearchRef.current = null;
        if (busyOpsRef.current === 0) setBusy(false);
      }
    }
  }

  function searchCatalog(query: string, projectType: ModrinthProjectType = "mod"): void {
    clearContentSwitch();
    setContentExiting(false);
    setModQuery(query);
    setSelectedCategories([]);
    setHideInstalled(false);
    setVersionUnlocked(false);
    setVersionOverride(null);
    setLoaderUnlocked(false);
    setLoaderOverride(null);
    if (contentType !== projectType) {
      skipResetSearchRef.current = true;
      setContentType(projectType);
    }
    void runContentSearch({ page: 1, query, projectType, categories: [], versions: [], loaders: [] });
  }

  function toggleCategory(tag: string): void {
    const next = selectedCategories.includes(tag) ? selectedCategories.filter((item) => item !== tag) : [...selectedCategories, tag];
    void runContentSearch({ page: 1, categories: next });
  }

  async function installContent(result: ModSearchResult): Promise<void> {
    if (!selected) return setStatus(t("Select an instance first", "Сначала выберите инстанцию"));
    if (!assertNotLaunching()) return;
    if (downloadingIds.includes(result.id)) return;
    if (result.projectType === "modpack") {
      setDownloadingIds((current) => [...current, result.id]);
      try {
        say(t(`Downloading ${result.title}...`, `Загрузка: ${result.title}...`));
        const filePath = await getLauncherApi().downloadModpack({
          provider: result.provider,
          instanceId: selected.id,
          projectId: result.id,
          name: result.title
        });
        await importMrpackByPath(filePath);
      } catch (error) {
        say(cleanIpcError(error, t(`Failed to download ${result.title}`, `Не удалось скачать ${result.title}`)));
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

    const instanceId = selected.id;
    setDownloadingIds((current) => [...current, result.id]);
    try {
      const plan = await prepareModInstallSafe({
        instanceId,
        provider: result.provider,
        projectId: result.id,
        projectType: result.projectType,
        gameVersions: currentContentQuery().versions,
        loaders: currentContentQuery().loaders
      });

      if (!plan.targetVersion) {
        const existing = selected.mods.find(
          (mod) => (mod.projectType ?? "mod") === result.projectType && (mod.projectId === result.id || Boolean(result.slug && mod.slug && mod.slug.toLowerCase() === result.slug.toLowerCase()))
        );
        setVersionPicker({
          key: `catalog:${result.provider}:${result.projectType}:${result.id}`,
          title: result.title,
          projectId: result.id,
          provider: result.provider,
          projectType: result.projectType,
          slug: result.slug,
          iconUrl: result.iconUrl,
          currentVersionId: existing?.versionId,
          result,
          versions: plan.versions,
          showAll: true,
          incompatiblePrompt: true
        });
        say(t(`No compatible version of ${result.title} for ${selected.gameVersion} / ${selected.loader} — choose a version manually`, `Нет совместимой версии ${result.title} для ${selected.gameVersion} / ${selected.loader} — выберите версию вручную`));
        return;
      }

      const uninstalled = plan.dependencies.filter((d) => !d.installed);
      const autoInstall = Boolean(bootstrapRef.current?.settings.autoInstallDependencies);
      if (result.projectType === "mod" && !autoInstall && uninstalled.length > 0) {
        const checked = Object.fromEntries(
          uninstalled
            .filter((d) => d.dependencyType === "required" && d.compatible && !d.distributionBlocked)
            .map((d) => [d.projectId, true])
        );
        setDependencyPrompt({
          instanceId,
          projectId: result.id,
          provider: result.provider,
          projectType: result.projectType,
          title: result.title,
          slug: result.slug,
          iconUrl: result.iconUrl,
          targetVersion: plan.targetVersion,
          dependencies: plan.dependencies,
          checked
        });
        return;
      }

      const autoDeps = result.projectType === "mod" && autoInstall
        ? uninstalled.filter((d) => d.dependencyType === "required" && d.compatible && !d.distributionBlocked)
        : [];
      await executeModInstallWithDeps(
        {
          instanceId,
          projectId: result.id,
          provider: result.provider,
          projectType: result.projectType,
          title: result.title,
          slug: result.slug,
          iconUrl: result.iconUrl,
          targetVersion: plan.targetVersion
        },
        autoDeps
      );
    } catch (error) {
      say(cleanIpcError(error, t(`Failed to download ${result.title}`, `Не удалось скачать ${result.title}`)));
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
        provider: result.provider,
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
        await finishModpackToInstance(selected.id, selected.name, info.skipped);
      } finally {
        setDownloadingIds((current) => current.filter((id) => id !== result.id));
        setTransferPct((current) => {
          const next = { ...current };
          delete next[`modpack:${result.id}`];
          return next;
        });
      }
    } catch (error) {
      say(cleanIpcError(error, t(`Failed to download ${result.title}`, `Не удалось скачать ${result.title}`)));
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
    contentProvider,
    setContentProvider,
    providerName,
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
    updateAllProgress,
    versionPicker,
    setVersionPicker,
    dependencyPrompt,
    setDependencyPrompt,
    modDetails,
    setModDetails,
    openModDetails,
    toggleDependencyCheck,
    confirmDependencyInstall,
    fileQuery,
    setFileQuery,
    fileSort,
    setFileSort,
    contentAutoKey,
    importDroppedContent,
    importContentRef,
    installedProjectIds,
    isResultInstalled,
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
    openCatalogVersionPicker,
    pickVersion,
    fileRowActions,
    removeLocalItem,
    currentContentQuery,
    runContentSearch,
    searchCatalog,
    toggleCategory,
    installContent,
    installIntoThis
  };
}

export type ContentState = ReturnType<typeof useContent>;
