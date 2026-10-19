import { useEffect, useRef } from "react";
import { FunctionAnimation, SkinViewer } from "skinview3d";

export function drawSkinPreview(canvas: HTMLCanvasElement, image: HTMLImageElement, slim: boolean): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const u = 5;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const arm = slim ? 3 : 4;
  const bodyX = 40;
  const rowY = 44;
  const legY = 104;
  const part = (sx: number, sy: number, w: number, h: number, dx: number, dy: number) => {
    ctx.drawImage(image, sx, sy, w, h, dx, dy, w * u, h * u);
  };
  part(8, 8, 8, 8, bodyX, 4);
  part(40, 8, 8, 8, bodyX, 4);
  part(44, 20, arm, 12, bodyX - arm * u, rowY);
  part(44, 36, arm, 12, bodyX - arm * u, rowY);
  part(36, 52, arm, 12, bodyX + 8 * u, rowY);
  part(52, 52, arm, 12, bodyX + 8 * u, rowY);
  part(20, 20, 8, 12, bodyX, rowY);
  part(20, 36, 8, 12, bodyX, rowY);
  part(4, 20, 4, 12, bodyX, legY);
  part(4, 36, 4, 12, bodyX, legY);
  part(20, 52, 4, 12, bodyX + 4 * u, legY);
  part(4, 52, 4, 12, bodyX + 4 * u, legY);
}

export function SkinPreview({ dataUrl, slim }: { dataUrl: string; slim: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const image = document.createElement("img");
    image.onload = () => drawSkinPreview(canvas, image, slim);
    image.src = dataUrl;
  }, [dataUrl, slim]);

  return <canvas ref={ref} width={120} height={176} className="skin-canvas" />;
}

export function CapeThumb({ url }: { url: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const image = document.createElement("img");
    image.onload = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 1, 1, 10, 16, 0, 0, canvas.width, canvas.height);
    };
    image.src = url;
  }, [url]);

  return <canvas ref={ref} width={60} height={96} className="cape-canvas" />;
}

export function SkinViewer3D({ dataUrl, slim, capeUrl }: { dataUrl: string | null; slim: boolean; capeUrl: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);
  const loadSeq = useRef(0);
  const latestReq = useRef<{ dataUrl: string | null; slim: boolean; capeUrl: string | null }>({ dataUrl, slim, capeUrl });
  latestReq.current = { dataUrl, slim, capeUrl };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const viewer = new SkinViewer({ canvas, width: 280, height: 340, pixelRatio: 1.5 });
    viewer.autoRotate = false;
    viewer.controls.enablePan = false;
    viewerRef.current = viewer;
    try {
      const internal = viewer as unknown as {
        composer?: {
          renderTarget1?: { samples?: number };
          renderTarget2?: { samples?: number };
          setSize?(width: number, height: number): void;
        };
      };
      if (internal.composer?.renderTarget1) internal.composer.renderTarget1.samples = 4;
      if (internal.composer?.renderTarget2) internal.composer.renderTarget2.samples = 4;
      internal.composer?.setSize?.(280, 340);
    } catch {
    }
    viewer.controls.enableRotate = false;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let lastT = 0;
    let spinW = 0;
    let capeX = 0.14;
    let capeVX = 0;
    let playerRef: any = null;
    const onPointerDown = (event: PointerEvent): void => {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      lastT = performance.now();
      spinW = 0;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
      }
    };
    const rotateAround = (v: { x: number; y: number; z: number }, axis: { x: number; y: number; z: number }, ang: number): void => {
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const dot = v.x * axis.x + v.y * axis.y + v.z * axis.z;
      const cx = axis.y * v.z - axis.z * v.y;
      const cy = axis.z * v.x - axis.x * v.z;
      const cz = axis.x * v.y - axis.y * v.x;
      v.x = v.x * c + cx * s + axis.x * dot * (1 - c);
      v.y = v.y * c + cy * s + axis.y * dot * (1 - c);
      v.z = v.z * c + cz * s + axis.z * dot * (1 - c);
    };
    const pitchCamera = (dy: number): void => {
      try {
        const internal = viewer as unknown as {
          controls?: {
            object?: { position: { x: number; y: number; z: number } };
            target?: { x: number; y: number; z: number };
            update?: () => void;
          };
        };
        const cam = internal.controls?.object;
        const tgt = internal.controls?.target;
        if (!cam || !tgt || dy === 0) return;
        const off = { x: cam.position.x - tgt.x, y: cam.position.y - tgt.y, z: cam.position.z - tgt.z };
        const len = Math.hypot(off.x, off.y, off.z) || 1;
        const rx = -off.z / len;
        const rz = off.x / len;
        const rn = Math.hypot(rx, rz) || 1;
        rotateAround(off, { x: rx / rn, y: 0, z: rz / rn }, dy * 0.005);
        const cosP = off.y / len;
        if (cosP < -0.95 || cosP > 0.95) return;
        cam.position.x = tgt.x + off.x;
        cam.position.y = tgt.y + off.y;
        cam.position.z = tgt.z + off.z;
        internal.controls?.update?.();
      } catch {
      }
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging || !playerRef) return;
      const now = performance.now();
      const dt = Math.min(Math.max((now - lastT) / 1000, 0.001), 0.1);
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      lastT = now;
      const w = (dx * 0.0085) / dt;
      playerRef.rotation.y += dx * 0.0085;
      spinW = spinW * 0.65 + w * 0.35;
      pitchCamera(dy);
    };
    const onPointerUp = (): void => {
      dragging = false;
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    try {
      viewer.animation = new FunctionAnimation((player: any, progress: number, delta: number) => {
        try {
          const dt = Math.min(Math.max(delta, 0.001), 0.1);
          playerRef = player;
          if (!dragging && player) {
            spinW *= Math.exp(-2.2 * dt);
            if (Math.abs(spinW) < 0.001) spinW = 0;
            player.rotation.y += spinW * dt;
          }
          const stiff = 55;
          const damp = 7;
          const restX = 0.12;
          const flareTarget = Math.min(spinW * spinW * 0.02, 0.6);
          capeVX += (-stiff * (capeX - (restX + flareTarget)) - damp * capeVX) * dt;
          capeX += capeVX * dt;
          const t = progress * 1.3;
          const sway = Math.sin(t);
          const skin = player?.skin;
          const body = skin?.body;
          if (body) {
            body.rotation.x = 0;
            body.rotation.z = 0;
          }
          const head = skin?.head;
          if (head) {
            head.rotation.y = Math.sin(t * 0.7 + 0.6) * 0.09;
            head.rotation.x = Math.sin(t * 0.9) * 0.03;
          }
          for (const key of ["leftArm", "rightArm"]) {
            const arm = skin?.[key];
            if (arm) {
              const dir = key === "leftArm" ? 1 : -1;
              arm.rotation.z = 0.08 * Math.sign(arm.position.x || 1);
              arm.rotation.x = dir * (0.04 + sway * 0.06);
            }
          }
          for (const key of ["leftLeg", "rightLeg"]) {
            const leg = skin?.[key];
            if (leg) {
              const dir = key === "leftLeg" ? 1 : -1;
              leg.rotation.z = 0.02 * Math.sign(leg.position.x || 1);
              leg.rotation.x = dir * sway * 0.025;
            }
          }
          const cape = player?.cape;
          if (cape) {
            cape.rotation.x = capeX;
            cape.rotation.y = 0;
          }
        } catch {
        }
      });
    } catch {
    }
    viewer.draw();
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const seq = (loadSeq.current += 1);
    const apply = async (): Promise<void> => {
      try {
        if (dataUrl) {
          await viewer.loadSkin(dataUrl, { model: slim ? "slim" : "default" });
        } else {
          viewer.loadSkin(null);
        }
        if (seq !== loadSeq.current) {
          return;
        }
        if (capeUrl) {
          await viewer.loadCape(capeUrl);
        } else {
          viewer.resetCape();
        }
      } catch {
      }
      if (seq !== loadSeq.current) {
        const latest = latestReq.current;
        const v = viewerRef.current;
        if (v) {
          try {
            if (latest.dataUrl) {
              await v.loadSkin(latest.dataUrl, { model: latest.slim ? "slim" : "default" });
            } else {
              v.loadSkin(null);
            }
            if (latest.capeUrl) {
              await v.loadCape(latest.capeUrl);
            } else {
              v.resetCape();
            }
          } catch {
          }
        }
      }
    };
    void apply();
  }, [dataUrl, slim, capeUrl]);

  return <canvas ref={canvasRef} className="skin-stage-canvas" />;
}
