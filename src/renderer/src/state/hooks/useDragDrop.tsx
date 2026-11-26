import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import type { ContentState } from "./useContent";
import type { CoreState } from "./useCore";
import type { InstancesState } from "./useInstances";

export function useDragDrop(deps: Pick<CoreState & InstancesState & ContentState, "importContentRef" | "importMrpackRef" | "sectionRef" | "setStatus" | "tRef">) {
  const { importContentRef, importMrpackRef, sectionRef, setStatus, tRef } = deps;
  const [windowDrag, setWindowDrag] = useState(false);
  const [dragZone, setDragZone] = useState<"sidebar" | "files" | null>(null);

  useEffect(() => {
    let active = true;
    let zoneNow: "sidebar" | "files" | null = null;
    let unlisten: (() => void) | null = null;

    function zoneAtPoint(position: { x: number; y: number }): "sidebar" | "files" | null {
      const dpr = window.devicePixelRatio || 1;
      const target = document.elementFromPoint(position.x / dpr, position.y / dpr);
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

    function handleDroppedPaths(zone: "sidebar" | "files" | null, paths: string[]): void {
      if (!zone) return;
      if (!paths.length) {
        setStatus(tRef.current("Could not read the dropped file", "Не удалось прочитать перетащенный файл"));
        return;
      }
      const mrpacks = paths.filter((item) => /\.mrpack$/i.test(item));
      const others = paths.filter((item) => !/\.mrpack$/i.test(item));
      if (zone === "sidebar") {
        const packs = paths.filter((item) => /\.(mrpack|zip)$/i.test(item));
        if (!packs.length) {
          setStatus(tRef.current("Drop modpacks here (.mrpack or a CurseForge .zip). Mods, resource packs and shaders go to the Files tab of an instance.", "Сюда перетаскиваются сборки (.mrpack или .zip CurseForge). Моды, ресурспаки и шейдеры — на вкладку «Файлы» инстанции."));
          return;
        }
        void importMrpackRef.current(packs[0]);
        return;
      }
      if (mrpacks.length && !others.length) {
        setStatus(tRef.current("Drop .mrpack modpacks onto the instance list on the left.", "Модпаки .mrpack перетаскивайте на список инстанций слева."));
        return;
      }
      void importContentRef.current(others);
    }

    void getCurrentWindow().onDragDropEvent((event) => {
      if (!active) return;
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        if (sectionRef.current !== "instances") {
          setWindowDrag(false);
          setZone(null);
          return;
        }
        setWindowDrag(true);
        setZone(zoneAtPoint(payload.position));
        return;
      }
      if (payload.type === "leave") {
        setWindowDrag(false);
        setZone(null);
        return;
      }
      if (payload.type === "drop") {
        const zone = sectionRef.current === "instances" ? zoneAtPoint(payload.position) : null;
        setWindowDrag(false);
        setZone(null);
        handleDroppedPaths(zone, payload.paths);
      }
    }).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });

    function onBlur(): void {
      setWindowDrag(false);
      setZone(null);
    }
    window.addEventListener("blur", onBlur);

    return () => {
      active = false;
      unlisten?.();
      window.removeEventListener("blur", onBlur);
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
