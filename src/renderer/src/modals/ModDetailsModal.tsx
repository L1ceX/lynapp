import { Check, ChevronLeft, ChevronRight, Download, ExternalLink, Heart, Image, Layers3, Plus, RefreshCw, Scale, X } from "lucide-react";
import { useEffect } from "react";
import { Presence } from "../components/Presence";
import { getLauncherApi } from "../lib/api";
import { isInstallable } from "../lib/content";
import { formatDownloads, formatRelative, transferLabel } from "../lib/format";
import { useApp } from "../state/context";

const ALLOWED_TAGS = new Set([
  "p", "div", "span", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u", "s", "del", "code", "pre", "blockquote",
  "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td",
  "a", "img", "details", "summary", "sup", "sub"
]);

const STRIP_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "svg", "math",
  "form", "input", "button", "textarea", "select", "link", "meta", "base", "template"
]);

function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function sanitizeNode(node: Node, outDoc: Document): Node | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return outDoc.createTextNode(node.textContent ?? "");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (STRIP_TAGS.has(tag)) return null;
  const fragment = outDoc.createDocumentFragment();
  for (const child of Array.from(el.childNodes)) {
    const cleanChild = sanitizeNode(child, outDoc);
    if (cleanChild) fragment.appendChild(cleanChild);
  }
  if (!ALLOWED_TAGS.has(tag)) {
    return fragment;
  }
  const cleanEl = outDoc.createElement(tag);
  if (tag === "a") {
    const href = safeHttpUrl(el.getAttribute("href"));
    if (href) {
      cleanEl.setAttribute("href", href);
      cleanEl.setAttribute("rel", "noopener noreferrer");
    }
    const title = el.getAttribute("title");
    if (title) cleanEl.setAttribute("title", title);
  } else if (tag === "img") {
    const src = safeHttpUrl(el.getAttribute("src"));
    if (!src) return null;
    cleanEl.setAttribute("src", src);
    cleanEl.setAttribute("loading", "lazy");
    const alt = el.getAttribute("alt");
    if (alt) cleanEl.setAttribute("alt", alt);
    const title = el.getAttribute("title");
    if (title) cleanEl.setAttribute("title", title);
  } else if (tag === "td" || tag === "th") {
    const colspan = el.getAttribute("colspan");
    const rowspan = el.getAttribute("rowspan");
    if (colspan && /^\d+$/.test(colspan)) cleanEl.setAttribute("colspan", colspan);
    if (rowspan && /^\d+$/.test(rowspan)) cleanEl.setAttribute("rowspan", rowspan);
  }
  cleanEl.appendChild(fragment);
  return cleanEl;
}

function sanitizeHtml(html: string): string {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(html, "text/html");
  const outDoc = document.implementation.createHTMLDocument("");
  for (const child of Array.from(parsed.body.childNodes)) {
    const clean = sanitizeNode(child, outDoc);
    if (clean) outDoc.body.appendChild(clean);
  }
  return outDoc.body.innerHTML;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sanitizeAndFormatBody(raw: string, format?: "markdown" | "html"): string {
  if (!raw.trim()) return "";
  const looksLikeHtml = format === "html" || /<(?:p|div|h[1-6]|ul|ol|li|br|img|a|strong|em|table|blockquote)\b/i.test(raw);
  if (looksLikeHtml) {
    return sanitizeHtml(raw);
  }
  const html = escapeHtml(raw)
    .replace(/```([\s\S]*?)```/g, (_m, code: string) => `<pre><code>${code.trim()}</code></pre>`)
    .replace(/^####\s+(.+)$/gm, "<h4>$1</h4>")
    .replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
    .replace(/^##\s+(.+)$/gm, "<h2>$1</h2>")
    .replace(/^#\s+(.+)$/gm, "<h1>$1</h1>")
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<img src="$2" alt="$1" loading="lazy" />')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/^\s*[-*]\s+(.+)$/gm, "<li>$1</li>")
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      if (/^<(?:h[1-4]|pre|li|img|ul|ol|blockquote)/i.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, "<br />")}</p>`;
    })
    .join("\n");
  return sanitizeHtml(html);
}

export function ModDetailsModal() {
  const { busy, dependencyPrompt, downloadingIds, exportModal, installContent, isResultInstalled, lang, modDetails, modpackTarget, openCatalogVersionPicker, setModDetails, t, transferPct, versionPicker } = useApp();
  const isOpen = modDetails !== null;
  const childModalOpen = Boolean(versionPicker || dependencyPrompt || modpackTarget || exportModal);
  useEffect(() => {
    if (!isOpen || childModalOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setModDetails((current) => {
        if (!current) return null;
        return current.galleryIndex !== null ? { ...current, galleryIndex: null } : null;
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, childModalOpen, setModDetails]);
  if (!modDetails) return <Presence>{null}</Presence>;
  const { result, details, loading, galleryIndex } = modDetails;
  const info = details ?? result;
  const gallery = details?.gallery ?? [];
  const activeShot = galleryIndex !== null ? gallery[galleryIndex] ?? null : null;
  const installed = isResultInstalled(result);
  const bodyHtml = details?.body ? sanitizeAndFormatBody(details.body, details.bodyFormat) : "";

  const links = [
    { label: t("Website", "Сайт"), url: details?.websiteUrl ?? result.websiteUrl ?? "" },
    { label: t("Source", "Исходный код"), url: details?.sourceUrl ?? "" },
    { label: t("Issues", "Баг-трекер"), url: details?.issuesUrl ?? "" },
    { label: t("Wiki", "Вики"), url: details?.wikiUrl ?? "" },
    { label: "Discord", url: details?.discordUrl ?? "" }
  ].filter((item) => safeHttpUrl(item.url) !== null);

  function handleBodyClick(event: React.MouseEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest("a");
    if (!anchor) return;
    event.preventDefault();
    const href = safeHttpUrl(anchor.getAttribute("href"));
    if (href) {
      void getLauncherApi().openExternal(href);
    }
  }

  return (
    <Presence>
      <div className="modal-backdrop" onClick={() => setModDetails(null)}>
        <div className="modal-card mod-details-modal" role="dialog" aria-label={info.title} onClick={(event) => event.stopPropagation()}>
          <div className="export-head mod-details-head">
            {info.iconUrl ? <img className="mod-card-icon" src={info.iconUrl} alt="" /> : <div className="mod-card-icon mod-icon">{info.title[0]}</div>}
            <div className="mod-details-title">
              <h3>{info.title}</h3>
              <span className="muted">
                {info.author ? `${t(`by ${info.author}`, `автор: ${info.author}`)} · ` : ""}
                <Download size={12} /> {formatDownloads(info.downloads, lang)}
                {typeof info.follows === "number" ? <> · <Heart size={12} /> {formatDownloads(info.follows, lang)}</> : null}
                {details?.license ? <> · <Scale size={12} /> {details.license}</> : null}
                {info.dateModified ? ` · ${formatRelative(info.dateModified ?? "", lang)}` : ""}
              </span>
            </div>
            <div className="mod-card-actions">
              {installed ? (
                <span className="installed-badge"><Check size={14} /> {t("Installed", "Установлен")}</span>
              ) : info.distributionBlocked ? (
                <button type="button" className="install-button" onClick={() => { if (info.websiteUrl) void getLauncherApi().openExternal(info.websiteUrl); }} disabled={!info.websiteUrl}>
                  <ExternalLink size={14} /> {t("On the website", "На сайте")}
                </button>
              ) : (
                <button type="button" className="install-button" onClick={() => void installContent(result)} disabled={busy || !isInstallable(result) || downloadingIds.includes(result.id)}>
                  {downloadingIds.includes(result.id) ? (
                    <><RefreshCw size={14} className="spin" /> {t("Downloading", "Загрузка")} {transferLabel(transferPct[`mod:${result.id}`] ?? transferPct[`modpack:${result.id}`]) ?? "..."}</>
                  ) : (
                    <><Plus size={14} /> {t("Install", "Установить")}</>
                  )}
                </button>
              )}
              {!info.distributionBlocked ? (
                <button type="button" className="version-pick-button" onClick={() => { setModDetails(null); void openCatalogVersionPicker(result); }} disabled={busy || downloadingIds.includes(result.id)} title={t("Choose version", "Выбрать версию")}>
                  <Layers3 size={14} />
                </button>
              ) : null}
              <button type="button" className="titlebar-button" onClick={() => setModDetails(null)} aria-label={t("Close", "Закрыть")}>
                <X size={15} />
              </button>
            </div>
          </div>

          {links.length > 0 || info.categories.length > 0 ? (
            <div className="mod-details-meta">
              {info.categories.map((cat) => <span key={cat} className="tag-chip">{cat}</span>)}
              {links.map((link) => (
                <button key={link.label} type="button" className="link-chip" onClick={() => void getLauncherApi().openExternal(link.url)}>
                  <ExternalLink size={12} /> {link.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="mod-details-scroll">
            {gallery.length > 0 ? (
              <div className="mod-details-gallery-section">
                <div className="section-title"><Image size={14} /> {t("Screenshots", "Скриншоты")} ({gallery.length})</div>
                {activeShot ? (
                  <div className="mod-gallery-viewer">
                    <img src={activeShot.url} alt={activeShot.title ?? ""} onClick={() => setModDetails((cur) => cur ? { ...cur, galleryIndex: null } : cur)} />
                    <div className="mod-gallery-bar">
                      <span>{activeShot.title || `${(galleryIndex ?? 0) + 1} / ${gallery.length}`}</span>
                      <div className="button-row">
                        <button type="button" className="icon-btn" onClick={() => setModDetails((cur) => cur && cur.galleryIndex !== null ? { ...cur, galleryIndex: (cur.galleryIndex - 1 + gallery.length) % gallery.length } : cur)}><ChevronLeft size={15} /></button>
                        <button type="button" className="icon-btn" onClick={() => setModDetails((cur) => cur && cur.galleryIndex !== null ? { ...cur, galleryIndex: (cur.galleryIndex + 1) % gallery.length } : cur)}><ChevronRight size={15} /></button>
                        <button type="button" onClick={() => setModDetails((cur) => cur ? { ...cur, galleryIndex: null } : cur)}>{t("Close preview", "Свернуть")}</button>
                      </div>
                    </div>
                  </div>
                ) : null}
                <div className="mod-gallery-strip">
                  {gallery.map((shot, idx) => (
                    <button key={shot.url} type="button" className={galleryIndex === idx ? "mod-gallery-thumb active" : "mod-gallery-thumb"} onClick={() => setModDetails((cur) => cur ? { ...cur, galleryIndex: cur.galleryIndex === idx ? null : idx } : cur)}>
                      <img src={shot.url} alt={shot.title ?? ""} loading="lazy" />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mod-details-description">
              <div className="section-title">{t("Description", "Описание")}</div>
              <p className="mod-details-summary">{info.summary}</p>
              {loading ? (
                <span className="muted"><RefreshCw size={14} className="spin" /> {t("Loading full description...", "Загрузка полного описания...")}</span>
              ) : bodyHtml ? (
                <div className="mod-details-body" onClick={handleBodyClick} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </Presence>
  );
}
