/// <reference types="vite/client" />

import type { LauncherApi } from "@shared/ipc";

declare global {
  interface Window {
    launcher: LauncherApi;
  }
}

declare module "skinview3d" {
  export class FunctionAnimation {
    constructor(fn: (player: any, progress: number, delta: number) => void);
  }
  export class SkinViewer {
    constructor(options: Record<string, unknown>);
    controls: { enablePan: boolean; enableZoom: boolean; enableRotate: boolean; getAzimuthalAngle(): number };
    autoRotate: boolean;
    animation: FunctionAnimation | null;
    loadSkin(source: string | null, options?: { model?: string }): Promise<void> | void;
    loadCape(source: string | null): Promise<void> | void;
    resetCape(): void;
    render(): void;
    draw(): void;
    dispose(): void;
  }
}

export {};