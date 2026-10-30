import { useEffect, useState } from "react";

const SVG_CSS_VAR_STYLE = `
  :root {
    --color-text-primary: black;
    --color-text-secondary: #1f2937;
    --color-text-tertiary: #4b5563;
    --color-background-primary: white;
    --color-background-secondary: #f8fafc;
    --color-background-tertiary: #f1f5f9;
    --color-border-primary: #111827;
    --color-border-secondary: #6b7280;
    --color-border-tertiary: #cbd5e1;
  }
`;

function ensureSvgSizing(svg) {
  return String(svg || "").replace(/<svg\b([^>]*)>/i, (match, attrs) => {
    const responsive = "max-width:100%;height:auto;overflow:visible;";
    const nextAttrs = /\bstyle=/i.test(attrs)
      ? attrs.replace(/\bstyle=(["'])(.*?)\1/i, (_m, quote, style) => `style=${quote}${responsive}${style}${quote}`)
      : `${attrs} style="${responsive}"`;
    return `<svg${nextAttrs}>`;
  });
}

function ensureSvgCssVars(svg) {
  const source = String(svg || "");
  if (!source.trim().startsWith("<svg") || source.includes("data-svg-vars")) return source;
  return source.replace(/<svg\b([^>]*)>/i, (match) => {
    return `${match}<style data-svg-vars="true">${SVG_CSS_VAR_STYLE}</style>`;
  });
}

function hasEmbeddedAnswerLabel(value) {
  return /\b(?:ans|answer|correct)\s*[:：]/i.test(String(value || ""));
}

function stripEmbeddedAnswerMarkup(svg) {
  return String(svg || "")
    .replace(/<!--\s*(?:answer|correct answer)\s*-->\s*/gi, "")
    .replace(/<text\b[^>]*>[\s\S]*?<\/text>/gi, (match) => (
      hasEmbeddedAnswerLabel(match) ? "" : match
    ))
    .replace(/<tspan\b[^>]*>[\s\S]*?<\/tspan>/gi, (match) => (
      hasEmbeddedAnswerLabel(match) ? "" : match
    ));
}

function authoredSvgDataUrl(svg) {
  const source = ensureSvgCssVars(ensureSvgSizing(stripEmbeddedAnswerMarkup(svg).trim()));
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
}

function encodePublicPath(path) {
  return String(path || "")
    .split("/")
    .map(part => encodeURIComponent(part))
    .join("/");
}

function localVisualPath(asset) {
  if (!asset) return null;
  const candidates = [
    asset.local_path,
    asset.filename,
    asset.file_name,
    asset.name,
    asset.asset_key,
    asset.storage_path,
    asset.file_path,
    asset.path,
    asset.object_path,
  ].filter(Boolean);

  const found = candidates
    .map(value => String(value).replace(/\\/g, "/").split("/").pop())
    .find(name => /\.svg$/i.test(name));

  return found ? `/visuals/${encodePublicPath(found)}` : null;
}

export function assetSources(asset, storageBase) {
  if (!asset) return null;
  const sources = [];
  const direct = asset.url || asset.public_url || asset.file_url || asset.asset_url || asset.src;
  if (direct) sources.push(direct);
  const storagePath = asset.storage_path || asset.file_path || asset.path || asset.object_path;
  if (storagePath && /^https?:\/\//i.test(storagePath)) {
    sources.push(storagePath);
  } else if (storagePath && storageBase) {
    const bucket = asset.bucket || asset.bucket_name || asset.storage_bucket;
    const cleanPath = String(storagePath).replace(/^\/+/, "");
    sources.push(bucket && !cleanPath.startsWith(`${bucket}/`) ? `${storageBase}/${bucket}/${cleanPath}` : `${storageBase}/${cleanPath}`);
  }

  const local = localVisualPath(asset);
  if (local) sources.push(local);

  return [...new Set(sources)];
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|heic|heif|tiff?)$/i;
const SVG_EXT = /\.svg$/i;
const PDF_EXT = /\.pdf$/i;
const VIDEO_EXT = /\.(mp4|webm|ogv|mov|m4v)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|oga|flac|ogg)$/i;

function kindFromUrl(url) {
  const clean = String(url || "").split("?")[0].split("#")[0];
  if (SVG_EXT.test(clean)) return "svg";
  if (IMAGE_EXT.test(clean)) return "image";
  if (PDF_EXT.test(clean)) return "pdf";
  if (VIDEO_EXT.test(clean)) return "video";
  if (AUDIO_EXT.test(clean)) return "audio";
  return null;
}

function kindFromContentType(contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("svg")) return "svg";
  if (ct.startsWith("image/")) return "image";
  if (ct.includes("pdf")) return "pdf";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  return null;
}

function kindFromAssetType(assetType) {
  const t = String(assetType || "").toLowerCase();
  if (t.includes("svg")) return "svg";
  if (t.includes("image") || t.includes("img") || t.includes("photo") || t.includes("figure") || t.includes("diagram")) return "image";
  if (t.includes("pdf")) return "pdf";
  if (t.includes("video")) return "video";
  if (t.includes("audio")) return "audio";
  return null;
}

function SvgVisual({ svg, sources, alt, imgStyle }) {
  const [loadedSvg, setLoadedSvg] = useState(svg || "");
  const [plainImage, setPlainImage] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = sources?.[0] || null;

  useEffect(() => {
    if (svg) {
      setLoadedSvg(svg);
      setPlainImage(false);
      setFailed(false);
      return;
    }
    if (!sources?.length) {
      setLoadedSvg("");
      setPlainImage(false);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setLoadedSvg("");
    setPlainImage(false);
    setFailed(false);

    async function load() {
      for (const candidate of sources) {
        try {
          const r = await fetch(candidate);
          if (!r.ok) throw new Error("Visual fetch failed");
          const contentType = r.headers.get("content-type") || "";
          const text = await r.text();
          if (text.trim().startsWith("<svg")) return { svg: text };
          if (contentType.startsWith("image/")) return { image: candidate };
        } catch {
          // Try the next candidate.
        }
      }
      return null;
    }

    load()
      .then(result => {
        if (cancelled) return;
        if (result?.svg) setLoadedSvg(result.svg);
        else if (result?.image) setPlainImage(true);
        else setFailed(true);
      });
    return () => { cancelled = true; };
  }, [svg, sources]);

  if (loadedSvg) {
    return <img src={authoredSvgDataUrl(loadedSvg)} alt={alt} style={imgStyle} onError={e => { e.currentTarget.style.display = "none"; }} />;
  }

  if (src && (plainImage || failed)) {
    return <img src={src} alt={alt} style={imgStyle} onError={e => { e.currentTarget.style.display = "none"; }} />;
  }

  return null;
}

function PdfVisual({ src, alt }) {
  return (
    <div style={{ width: "100%" }}>
      <object data={src} type="application/pdf" style={{ width: "100%", height: "70vh", border: "none", display: "block", borderRadius: 4 }}>
        <iframe src={src} title={alt || "PDF document"} style={{ width: "100%", height: "70vh", border: "none" }} />
      </object>
      <a href={src} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", marginTop: 6, fontSize: 12, fontWeight: 600, color: "#2563eb", textDecoration: "none" }}>
        Open PDF in new tab ↗
      </a>
    </div>
  );
}

function DownloadCard({ href, name }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", border: "1px solid #cbd5e1", borderRadius: 6, textDecoration: "none", color: "#1f2937", background: "#f8fafc", fontSize: 13, fontWeight: 600 }}>
      <span style={{ fontSize: 18 }} aria-hidden="true">📎</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name || "Open attachment"}</span>
    </a>
  );
}

// Renders a visual asset in whatever format it is: inline SVG, image file,
// SVG file, PDF, video, audio, or — for anything else — a download link.
function AssetVisual({ inlineSvg, sources, assetType, alt, imgStyle, fileName }) {
  const hasInlineSvg = typeof inlineSvg === "string" && inlineSvg.trim().startsWith("<svg");
  const src = sources && sources.length ? sources[0] : null;
  const resolveKind = () => (hasInlineSvg ? "svg-inline" : (kindFromUrl(src) || kindFromAssetType(assetType)));
  const [kind, setKind] = useState(resolveKind);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const initial = resolveKind();
    setKind(initial);
    setFailed(false);
    // Extension/asset_type already told us the format — no sniffing needed.
    if (initial || !sources?.length) return;
    let cancelled = false;
    (async () => {
      for (const candidate of sources) {
        try {
          const r = await fetch(candidate);
          if (!r.ok) continue;
          let detected = kindFromContentType(r.headers.get("content-type"));
          if (!detected) {
            const text = await r.text();
            if (text.trim().startsWith("<svg")) detected = "svg";
          }
          if (!cancelled && detected) { setKind(detected); return; }
        } catch {
          // Try the next candidate.
        }
      }
      if (!cancelled) setFailed(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inlineSvg, src]);

  if (kind === "svg-inline") return <SvgVisual svg={inlineSvg} alt={alt} imgStyle={imgStyle} />;
  if (kind === "svg") return <SvgVisual sources={sources} alt={alt} imgStyle={imgStyle} />;
  if (!src) return null;
  if (kind === "image") return <img src={src} alt={alt} style={imgStyle} onError={e => { e.currentTarget.style.display = "none"; }} />;
  if (kind === "pdf") return <PdfVisual src={src} alt={alt} />;
  if (kind === "video") return <video src={src} controls style={{ ...imgStyle, maxHeight: "70vh" }} />;
  if (kind === "audio") return <audio src={src} controls style={{ width: "100%" }} />;
  if (failed) return <DownloadCard href={src} name={fileName || alt} />;
  return null;
}

export function VisualAssetPreview({ assets, storageBase, compact = false }) {
  const list = (assets || []).map(v => v.visual_assets || v).filter(Boolean);
  if (!list.length) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 4 : 8, margin: compact ? "4px 0" : "0 0 12px" }}>
      {list.map((asset, i) => {
        const inlineSvg = asset.svg || asset.svg_markup || asset.svg_text || asset.svg_content || asset.content || asset.markup || asset.data;
        const sources = assetSources(asset, storageBase);
        const hasInlineSvg = typeof inlineSvg === "string" && inlineSvg.trim().startsWith("<svg");
        if (!hasInlineSvg && !(sources && sources.length)) return null;
        const key = asset.id || asset.question_id || asset.session_question_id || asset.asset_key || sources?.[0] || (typeof inlineSvg === "string" ? inlineSvg.slice(0, 80) : i);
        const fileName = String(asset.storage_path || sources?.[0] || asset.asset_key || "").split("/").pop();
        const wrapStyle = {
          background: "#fff",
          border: "1px solid #253048",
          borderRadius: compact ? 5 : 8,
          padding: compact ? 4 : 8,
          maxWidth: "100%",
          overflow: "visible",
        };
        const imgStyle = {
          display: "block",
          width: "100%",
          maxHeight: "none",
          objectFit: "contain",
          overflow: "visible",
        };

        return (
          <div key={key} style={wrapStyle}>
            <AssetVisual
              inlineSvg={inlineSvg}
              sources={sources}
              assetType={asset.asset_type}
              alt={asset.alt_text || asset.asset_key || "Question visual"}
              imgStyle={imgStyle}
              fileName={fileName}
            />
          </div>
        );
      })}
    </div>
  );
}

export function questionInlineVisualAssets(q) {
  if (!q) return [];
  const hasInlineSvg = q.svg || q.svg_markup || q.svg_text || q.svg_content || q.question_svg || q.diagram_svg || q.visual_svg;
  const hasSource = q.image_url || q.svg_url || q.visual_url || q.asset_url || q.storage_path || q.visual_storage_path;
  if (!hasInlineSvg && !hasSource) return [];
  const stableId = q.question_id || q.session_question_id || q.id || q._previewKey || "question";
  return [{
    id: `${stableId}-inline-visual`,
    question_id: q.question_id,
    session_question_id: q.session_question_id,
    svg: hasInlineSvg,
    url: q.image_url || q.svg_url || q.visual_url || q.asset_url,
    storage_path: q.visual_storage_path || q.storage_path,
    alt_text: q.question_text || "Question visual",
  }];
}

