import { useEffect, useMemo, useState } from "react";
import { FolderOpen, RefreshCw, RotateCcw, Search, Trash2, Type, Upload, X } from "lucide-react";
import type { GoogleFontInfo } from "@shared/types";
import { BUILTIN_FONTS, DEFAULT_FONT_STACK } from "../constants";
import { useApp } from "../state/context";

type FontTab = "all" | "system" | "google" | "custom";
type FontStyleFilter = "all" | "Sans Serif" | "Serif" | "Display" | "Handwriting" | "Monospace";

interface PickerEntry {
  id: string;
  label: string;
  meta: string;
  stack: string;
  kind: "builtin" | "system" | "google" | "custom";
  fileName?: string;
  google?: GoogleFontInfo;
}

const STYLE_FILTERS: Array<{ id: FontStyleFilter; label: string; labelRu: string }> = [
  { id: "all", label: "All styles", labelRu: "Все стили" },
  { id: "Sans Serif", label: "Sans", labelRu: "Гротеск" },
  { id: "Serif", label: "Serif", labelRu: "Антиква" },
  { id: "Display", label: "Display", labelRu: "Декор" },
  { id: "Handwriting", label: "Handwriting", labelRu: "Рукописные" },
  { id: "Monospace", label: "Mono", labelRu: "Моно" }
];

const PAGE_STEP = 48;

function quoteFont(name: string): string {
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}", ${DEFAULT_FONT_STACK}`;
}

export function FontPickerCard() {
  const {
    addCustomFont,
    customFontCssMap,
    customFonts,
    fontFamily,
    fontsBusy,
    googleFonts,
    googleFontsLoading,
    loadGoogleFontPreviews,
    openFontsFolder,
    refreshCustomFonts,
    removeCustomFont,
    setFontFamilyValue,
    systemFonts,
    t
  } = useApp();

  const [tab, setTab] = useState<FontTab>("all");
  const [query, setQuery] = useState("");
  const [styleFilter, setStyleFilter] = useState<FontStyleFilter>("all");
  const [cyrillicOnly, setCyrillicOnly] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_STEP);

  const totalFonts = BUILTIN_FONTS.length + systemFonts.length + googleFonts.length + customFonts.length;
  const cyrillicGoogleCount = useMemo(() => googleFonts.reduce((sum, item) => sum + (item.cyrillic ? 1 : 0), 0), [googleFonts]);

  const activeInfo = useMemo(() => {
    const builtin = BUILTIN_FONTS.find((item) => item.id === fontFamily);
    if (builtin) return { name: t(builtin.label, builtin.labelRu), source: t("Built-in", "Встроенный") };
    const custom = customFonts.find((item) => item.id === fontFamily);
    if (custom) return { name: custom.name, source: t("Custom", "Свой файл") };
    if (fontFamily.startsWith("system:")) return { name: fontFamily.slice(7), source: t("System (PC)", "Система (ПК)") };
    if (fontFamily.startsWith("google:")) return { name: fontFamily.slice(7), source: "Google Fonts" };
    return { name: t("Default", "По умолчанию"), source: t("Built-in", "Встроенный") };
  }, [fontFamily, customFonts, t]);

  const allEntries = useMemo<PickerEntry[]>(() => {
    const q = query.trim().toLowerCase();
    const list: PickerEntry[] = [];

    const includeBuiltin = tab === "all" && styleFilter === "all";
    if (includeBuiltin) {
      for (const item of BUILTIN_FONTS) {
        const label = t(item.label, item.labelRu);
        const sample = t(item.sample, item.sampleRu);
        if (q && !label.toLowerCase().includes(q) && !item.id.toLowerCase().includes(q) && !sample.toLowerCase().includes(q)) continue;
        list.push({ id: item.id, label, meta: sample, stack: item.stack, kind: "builtin" });
      }
    }

    const includeCustom = (tab === "all" || tab === "custom") && (tab === "custom" || styleFilter === "all");
    if (includeCustom) {
      for (const item of customFonts) {
        if (q && !item.name.toLowerCase().includes(q) && !item.fileName.toLowerCase().includes(q)) continue;
        const cssName = customFontCssMap[item.id];
        list.push({
          id: item.id,
          label: item.name,
          meta: item.fileName,
          stack: cssName ? `"${cssName}", ${DEFAULT_FONT_STACK}` : DEFAULT_FONT_STACK,
          kind: "custom",
          fileName: item.fileName
        });
      }
    }

    const includeSystem = (tab === "all" || tab === "system") && (tab === "system" || styleFilter === "all");
    if (includeSystem) {
      for (const name of systemFonts) {
        if (q && !name.toLowerCase().includes(q)) continue;
        list.push({
          id: `system:${name}`,
          label: name,
          meta: t("System", "Система"),
          stack: quoteFont(name),
          kind: "system"
        });
      }
    }

    const includeGoogle = tab === "all" || tab === "google";
    if (includeGoogle) {
      for (const item of googleFonts) {
        if (cyrillicOnly && !item.cyrillic) continue;
        if (styleFilter !== "all" && item.category !== styleFilter) continue;
        if (q && !item.family.toLowerCase().includes(q) && !item.category.toLowerCase().includes(q)) continue;
        list.push({
          id: `google:${item.family}`,
          label: item.family,
          meta: item.cyrillic ? `${item.category} · RU` : item.category,
          stack: quoteFont(item.family),
          kind: "google",
          google: item
        });
      }
    }

    return list;
  }, [tab, query, styleFilter, cyrillicOnly, customFonts, customFontCssMap, systemFonts, googleFonts, t]);

  useEffect(() => {
    setVisibleCount(PAGE_STEP);
  }, [tab, query, styleFilter, cyrillicOnly]);

  const visibleEntries = useMemo(() => allEntries.slice(0, visibleCount), [allEntries, visibleCount]);

  useEffect(() => {
    const toLoad: GoogleFontInfo[] = [];
    for (const item of visibleEntries) {
      if (item.google && item.id !== fontFamily) toLoad.push(item.google);
    }
    if (toLoad.length > 0) loadGoogleFontPreviews(toLoad);
  }, [visibleEntries, fontFamily, loadGoogleFontPreviews]);

  const remaining = Math.max(0, allEntries.length - visibleEntries.length);

  function onListScroll(event: React.UIEvent<HTMLDivElement>): void {
    if (remaining <= 0) return;
    const el = event.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      setVisibleCount((prev) => Math.min(allEntries.length, prev + PAGE_STEP));
    }
  }

  return (
    <div className="settings-content font-card">
      <div className="surface-heading">
        <Type size={19} />
        <div>
          <h3>{t("Font", "Шрифт")} <span className="font-total-count">{totalFonts.toLocaleString()}</span></h3>
          <span>{t("Pick from installed PC fonts, 1 900+ Google Fonts, or your own .ttf / .otf / .woff2 files.", "Выбирайте из шрифтов ПК, 1 900+ шрифтов Google Fonts или своих файлов .ttf / .otf / .woff2.")}</span>
        </div>
      </div>

      <div className="font-preview-card">
        <div className="font-preview-top">
          <span className="font-preview-label">
            {t("Active font", "Активный шрифт")}: <strong>{activeInfo.name}</strong> <span className="font-preview-source">· {activeInfo.source}</span>
          </span>
          {fontFamily ? (
            <button type="button" className="font-reset-btn" onClick={() => void setFontFamilyValue("")}>
              <RotateCcw size={13} />{t("Reset", "Сбросить")}
            </button>
          ) : null}
        </div>
        <p className="font-preview-sample">{t("Minecraft 1.21.11 · The quick brown fox jumps over the lazy dog · 0123456789", "Minecraft 1.21.11 · Съешь же ещё этих мягких французских булок · 0123456789")}</p>
      </div>

      <div className="font-toolbar">
        <div className="font-search-box">
          <Search size={15} />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t(`Search ${totalFonts.toLocaleString()} fonts...`, `Поиск среди ${totalFonts.toLocaleString()} шрифтов...`)}
            aria-label={t("Search fonts", "Поиск шрифтов")}
          />
          {query ? (
            <button type="button" className="font-search-clear" onClick={() => setQuery("")} aria-label={t("Clear search", "Очистить поиск")}>
              <X size={14} />
            </button>
          ) : null}
        </div>

        <div className="font-tabs">
          <button type="button" className={tab === "all" ? "font-chip active" : "font-chip"} onClick={() => setTab("all")}>
            {t("All", "Все")} <span>{totalFonts}</span>
          </button>
          <button type="button" className={tab === "system" ? "font-chip active" : "font-chip"} onClick={() => setTab("system")}>
            {t("PC", "ПК")} <span>{systemFonts.length}</span>
          </button>
          <button type="button" className={tab === "google" ? "font-chip active" : "font-chip"} onClick={() => setTab("google")}>
            Google <span>{googleFontsLoading && googleFonts.length === 0 ? "…" : googleFonts.length}</span>
          </button>
          <button type="button" className={tab === "custom" ? "font-chip active" : "font-chip"} onClick={() => setTab("custom")}>
            {t("Custom", "Свои")} <span>{customFonts.length}</span>
          </button>
        </div>
      </div>

      {tab === "all" || tab === "google" ? (
        <div className="font-subfilters">
          {STYLE_FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styleFilter === item.id ? "font-mini-chip active" : "font-mini-chip"}
              onClick={() => setStyleFilter(item.id)}
            >
              {t(item.label, item.labelRu)}
            </button>
          ))}
          <button
            type="button"
            className={cyrillicOnly ? "font-mini-chip active" : "font-mini-chip"}
            onClick={() => setCyrillicOnly((prev) => !prev)}
          >
            {t("Cyrillic", "Кириллица")} ({cyrillicGoogleCount})
          </button>
        </div>
      ) : null}

      <div className="font-browser-scroll" onScroll={onListScroll}>
        {visibleEntries.length > 0 ? (
          <>
            <div className="font-grid">
              {visibleEntries.map((item) => {
                const active = fontFamily === item.id;
                if (item.kind === "custom" && item.fileName) {
                  return (
                    <div key={item.id} className={active ? "font-custom-row active" : "font-custom-row"}>
                      <button
                        type="button"
                        className="font-custom-pick"
                        style={{ fontFamily: item.stack }}
                        onClick={() => void setFontFamilyValue(item.id)}
                      >
                        <strong>{item.label}</strong>
                        <span>{item.meta}</span>
                      </button>
                      <button
                        type="button"
                        className="icon-btn font-custom-del"
                        disabled={fontsBusy}
                        onClick={() => void removeCustomFont(item.fileName!)}
                        title={t("Remove font", "Удалить шрифт")}
                        aria-label={t("Remove font", "Удалить шрифт")}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                }
                return (
                  <button
                    key={item.id || "default"}
                    type="button"
                    className={active ? "font-option active" : "font-option"}
                    style={{ fontFamily: item.stack }}
                    onClick={() => void setFontFamilyValue(item.id)}
                  >
                    <strong>{item.label}</strong>
                    <span>{item.meta}</span>
                  </button>
                );
              })}
            </div>
            {remaining > 0 ? (
              <div className="font-more-row">
                <button type="button" onClick={() => setVisibleCount((prev) => Math.min(allEntries.length, prev + PAGE_STEP))}>
                  {t(`Show more (${remaining} left)`, `Показать ещё (осталось ${remaining})`)}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="font-empty">
            <span className="muted">
              {tab === "custom" && !query
                ? t("No custom fonts yet. Upload a .ttf, .otf, .woff or .woff2 file below.", "Своих шрифтов пока нет. Загрузите .ttf, .otf, .woff или .woff2 ниже.")
                : googleFontsLoading && tab === "google"
                  ? t("Loading Google Fonts catalog...", "Загрузка каталога Google Fonts...")
                  : t("No fonts match your filter.", "По вашему запросу шрифты не найдены.")}
            </span>
          </div>
        )}
      </div>

      <div className="font-custom-footer">
        <div className="button-row font-actions">
          <button type="button" className="primary-button" disabled={fontsBusy} onClick={() => void addCustomFont()}>
            <Upload size={15} />{t("Upload font", "Загрузить шрифт")}
          </button>
          <button type="button" onClick={() => void openFontsFolder()}>
            <FolderOpen size={15} />{t("Fonts folder", "Папка шрифтов")}
          </button>
          <button type="button" className="icon-btn" disabled={fontsBusy} onClick={() => void refreshCustomFonts()} title={t("Refresh fonts", "Обновить список шрифтов")} aria-label={t("Refresh fonts", "Обновить список шрифтов")}>
            <RefreshCw size={15} />
          </button>
        </div>
        <span className="muted font-footer-count">
          {t(`Showing ${visibleEntries.length} of ${allEntries.length}`, `Показано ${visibleEntries.length} из ${allEntries.length}`)}
        </span>
      </div>
    </div>
  );
}
