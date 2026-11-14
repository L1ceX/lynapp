import { ChevronLeft, ChevronRight, Copy, FolderOpen, Image, ImageOff, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ScreenshotInfo } from "@shared/types";
import { Presence } from "../../components/Presence";
import { getLauncherApi } from "../../lib/api";
import { cleanIpcError, formatBytes, formatDateTime } from "../../lib/format";
import { useApp } from "../../state/context";

export function ScreenshotsTab() {
  const { busy, instanceTab, openSelectedFolder, say, selected, setBusy, t } = useApp();
  const [screenshots, setScreenshots] = useState<ScreenshotInfo[] | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [brokenFiles, setBrokenFiles] = useState<Record<string, boolean>>({});
  const selectedIdRef = useRef(selected?.id);
  selectedIdRef.current = selected?.id;

  useEffect(() => {
    if (!selected || instanceTab !== "screenshots" || previewIndex === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setPreviewIndex(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [instanceTab, selected?.id, previewIndex]);

  useEffect(() => {
    if (instanceTab !== "screenshots" || !selected) return;
    let stale = false;
    setScreenshots(null);
    setPreviewIndex(null);
    setBrokenFiles({});
    void getLauncherApi().listScreenshots(selected.id).then((list) => {
      if (!stale) setScreenshots(list);
    }).catch((error) => {
      if (!stale) {
        setScreenshots([]);
        say(cleanIpcError(error, t("Failed to read screenshots", "Не удалось прочитать скриншоты")));
      }
    });
    return () => {
      stale = true;
    };
  }, [instanceTab, selected?.id]);

  if (!selected || instanceTab !== "screenshots") return null;

  const list = screenshots ?? [];
  const activeShot = previewIndex !== null ? list[previewIndex] ?? null : null;

  async function refreshScreenshots(): Promise<void> {
    if (!selected) return;
    const instanceId = selected.id;
    setBusy(true);
    try {
      const list = await getLauncherApi().listScreenshots(instanceId);
      if (selectedIdRef.current === instanceId) {
        setBrokenFiles({});
        setScreenshots(list);
      }
    } catch (error) {
      if (selectedIdRef.current === instanceId) {
        say(cleanIpcError(error, t("Failed to read screenshots", "Не удалось прочитать скриншоты")));
      }
    } finally {
      setBusy(false);
    }
  }

  async function copyShot(shot: ScreenshotInfo): Promise<void> {
    if (!selected) return;
    const instanceId = selected.id;
    try {
      await getLauncherApi().copyScreenshot(instanceId, shot.fileName);
      if (selectedIdRef.current === instanceId) {
        say(t(`Copied ${shot.fileName} to clipboard`, `Скопировано в буфер обмена: ${shot.fileName}`));
      }
    } catch (error) {
      if (selectedIdRef.current === instanceId) {
        say(cleanIpcError(error, t("Failed to copy screenshot", "Не удалось скопировать скриншот")));
      }
    }
  }

  async function deleteShot(shot: ScreenshotInfo): Promise<void> {
    if (!selected) return;
    const instanceId = selected.id;
    setBusy(true);
    try {
      const updated = await getLauncherApi().deleteScreenshot(instanceId, shot.fileName);
      if (selectedIdRef.current !== instanceId) return;
      setScreenshots(updated);
      setPreviewIndex((cur) => {
        if (cur === null) return null;
        if (updated.length === 0) return null;
        return Math.min(cur, updated.length - 1);
      });
      say(t(`Deleted ${shot.fileName}`, `Удалён скриншот: ${shot.fileName}`));
    } catch (error) {
      if (selectedIdRef.current === instanceId) {
        say(cleanIpcError(error, t("Failed to delete screenshot", "Не удалось удалить скриншот")));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-content">
      <div className="surface-heading-row">
        <div className="surface-heading">
          <Image size={19} />
          <div>
            <h3>{t("Screenshots", "Скриншоты")}</h3>
            <span>{t("In-game F2 screenshots · click to enlarge or copy to clipboard.", "Игровые скриншоты (F2) · нажмите для увеличения или копирования в буфер.")}</span>
          </div>
        </div>

        <div className="button-row surface-actions">
          <button type="button" onClick={() => void refreshScreenshots()} disabled={busy}>
            <RefreshCw size={15} /> {t("Refresh", "Обновить")}
          </button>
          <button type="button" onClick={() => void openSelectedFolder("screenshots")}>
            <FolderOpen size={15} /> {t("Open folder", "Открыть папку")}
          </button>
        </div>
      </div>

      {screenshots === null ? (
        <span className="muted"><RefreshCw size={14} className="spin" /> {t("Reading screenshots...", "Чтение скриншотов...")}</span>
      ) : list.length === 0 ? (
        <span className="muted">{t("No screenshots in this instance yet. Press F2 in-game to take one.", "В этой инстанции пока нет скриншотов. Нажмите F2 в игре, чтобы сделать снимок.")}</span>
      ) : (
        <div className="screenshot-grid">
          {list.map((shot, idx) => (
            <div key={shot.fileName} className="screenshot-card">
              <button type="button" className="screenshot-thumb" onClick={() => setPreviewIndex(idx)}>
                {brokenFiles[shot.fileName] ? (
                  <span className="screenshot-broken">
                    <ImageOff size={22} />
                    <span>{t("Broken image", "Файл повреждён")}</span>
                  </span>
                ) : (
                  <img
                    src={shot.dataUrl}
                    alt={shot.fileName}
                    loading="lazy"
                    onError={() => setBrokenFiles((cur) => (cur[shot.fileName] ? cur : { ...cur, [shot.fileName]: true }))}
                  />
                )}
              </button>
              <div className="screenshot-meta">
                <div>
                  <strong>{shot.fileName}</strong>
                  <small className="muted">{formatDateTime(shot.modified)} · {formatBytes(shot.size)}</small>
                </div>
                <div className="screenshot-actions">
                  <button type="button" className="icon-btn" onClick={() => void copyShot(shot)} title={t("Copy image to clipboard", "Скопировать картинку в буфер обмена")}>
                    <Copy size={14} />
                  </button>
                  <button type="button" className="icon-btn" onClick={() => void deleteShot(shot)} disabled={busy} title={t("Delete screenshot", "Удалить скриншот")}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Presence>
        {activeShot ? (
          <div className="modal-backdrop" onClick={() => setPreviewIndex(null)}>
            <div className="modal-card screenshot-modal" role="dialog" aria-label={activeShot.fileName} onClick={(event) => event.stopPropagation()}>
              <div className="export-head">
                <Image size={19} />
                <div>
                  <h3>{activeShot.fileName}</h3>
                  <span className="muted">{formatDateTime(activeShot.modified)} · {formatBytes(activeShot.size)} · {(previewIndex ?? 0) + 1} / {list.length}</span>
                </div>
                <div className="screenshot-actions">
                  <button type="button" className="primary-button" onClick={() => void copyShot(activeShot)}>
                    <Copy size={14} /> {t("Copy", "Копировать")}
                  </button>
                  <button type="button" className="icon-btn" onClick={() => void deleteShot(activeShot)} disabled={busy} title={t("Delete", "Удалить")}>
                    <Trash2 size={14} />
                  </button>
                  {list.length > 1 ? (
                    <>
                      <button type="button" className="icon-btn" onClick={() => setPreviewIndex((cur) => cur !== null ? (cur - 1 + list.length) % list.length : null)}><ChevronLeft size={15} /></button>
                      <button type="button" className="icon-btn" onClick={() => setPreviewIndex((cur) => cur !== null ? (cur + 1) % list.length : null)}><ChevronRight size={15} /></button>
                    </>
                  ) : null}
                  <button type="button" className="titlebar-button" onClick={() => setPreviewIndex(null)} aria-label={t("Close", "Закрыть")}>
                    <X size={15} />
                  </button>
                </div>
              </div>
              <div className="screenshot-lightbox-view">
                {brokenFiles[activeShot.fileName] ? (
                  <span className="screenshot-broken">
                    <ImageOff size={28} />
                    <span>{t("Could not decode image file", "Не удалось декодировать изображение")}</span>
                  </span>
                ) : (
                  <img
                    src={activeShot.dataUrl}
                    alt={activeShot.fileName}
                    onError={() => setBrokenFiles((cur) => (cur[activeShot.fileName] ? cur : { ...cur, [activeShot.fileName]: true }))}
                  />
                )}
              </div>
            </div>
          </div>
        ) : null}
      </Presence>
    </div>
  );
}
