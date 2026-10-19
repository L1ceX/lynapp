import { useEffect, useState } from "react";
import { getLauncherApi } from "../../lib/api";
import type { ContentState } from "./useContent";
import type { CoreState } from "./useCore";
import type { InstancesState } from "./useInstances";

export function useDragDrop(deps: Pick<CoreState & InstancesState & ContentState, "importContentRef" | "importMrpackRef" | "sectionRef" | "setStatus" | "tRef">) {
  const { importContentRef, importMrpackRef, sectionRef, setStatus, tRef } = deps;
  const [windowDrag, setWindowDrag] = useState(false);

  const [dragZone, setDragZone] = useState<"sidebar" | "files" | null>(null);

  useEffect(() => {
    let zoneNow: "sidebar" | "files" | null = null;
    function hasFiles(event: DragEvent): boolean {
      return !!event.dataTransfer && Array.from(event.dataTransfer.types ?? []).includes("Files");
    }
    function zoneOf(event: DragEvent): "sidebar" | "files" | null {
      const target = event.target as Element | null;
      if (!target?.closest) return null;
      if (target.closest(".instance-sidebar")) return "sidebar";
      if (target.closest(".files-drop")) return "files";
      return null;
    }
    function setZone(next: "sidebar" | "files" | null): void {
      if (next === zoneNow) return;
      zoneNow = next;
      setDragZone(next);
    }
    function onDragEnter(event: DragEvent): void {
      if (sectionRef.current !== "instances" || !hasFiles(event)) return;
      event.preventDefault();
      setWindowDrag(true);
      setZone(zoneOf(event));
    }
    function onDragOver(event: DragEvent): void {
      if (sectionRef.current !== "instances" || !hasFiles(event)) return;
      event.preventDefault();
      const zone = zoneOf(event);
      if (event.dataTransfer) event.dataTransfer.dropEffect = zone ? "copy" : "none";
      setZone(zone);
    }
    function onDragLeave(event: DragEvent): void {
      const to = event.relatedTarget as Node | null;
      if (to && document.documentElement.contains(to)) return;
      setWindowDrag(false);
      setZone(null);
    }
    function onDrop(event: DragEvent): void {
      if (sectionRef.current !== "instances" || !hasFiles(event)) return;
      event.preventDefault();
      const zone = zoneOf(event);
      setWindowDrag(false);
      setZone(null);
      if (!zone) return;
      const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
      if (!files.length) return;
      void (async () => {
        const api = getLauncherApi();
        const paths: string[] = [];
        for (const file of files) {
          const direct = (file as unknown as { path?: string }).path;
          if (direct) {
            paths.push(direct);
            continue;
          }
          try {
            const resolved = await api.getFilePath(file);
            if (resolved) paths.push(resolved);
          } catch {
          }
        }
        if (!paths.length) {
          setStatus(tRef.current("Could not read the dropped file", "Не удалось прочитать перетащенный файл"));
          return;
        }
        const mrpacks = paths.filter((item) => /\.mrpack$/i.test(item));
        const others = paths.filter((item) => !/\.mrpack$/i.test(item));
        if (zone === "sidebar") {
          if (!mrpacks.length) {
            setStatus(tRef.current("Drop .mrpack modpacks here. Mods, resource packs and shaders go to the Files tab of an instance.", "Сюда перетаскиваются модпаки .mrpack. Моды, ресурспаки и шейдеры — на вкладку «Файлы» инстанции."));
            return;
          }
          void importMrpackRef.current(mrpacks[0]);
          return;
        }
        if (mrpacks.length && !others.length) {
          setStatus(tRef.current("Drop .mrpack modpacks onto the instance list on the left.", "Модпаки .mrpack перетаскивайте на список инстанций слева."));
          return;
        }
        void importContentRef.current(others);
      })();
    }
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return {
    windowDrag,
    setWindowDrag,
    dragZone,
    setDragZone
  };
}

export type DragDropState = ReturnType<typeof useDragDrop>;
