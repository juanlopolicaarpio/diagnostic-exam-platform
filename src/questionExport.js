// ═══════════════════════════════════════════════════════════════
// SHARED QUESTION EXPORT / RENDER PIPELINE
// ═══════════════════════════════════════════════════════════════
// Extracted from App.jsx so both the Question Bank export and the
// Quiz Builder export render questions identically (KaTeX MathML math,
// underline segments, passages, and SVG/image resolution).
//
// Answer visibility is parameterized so the same code produces both a
// student test (answers hidden) and an answer key (answers shown).
// ═══════════════════════════════════════════════════════════════

import { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun } from "docx";
import katex from "katex";
import { convertRawMathToDelimited, normalizeMathExpression, containsMath } from "./mathContent";
import { assetSources, questionInlineVisualAssets } from "./visualContent";

const EXPORT_MATH_RE = /(\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$)/g;

// Returns [{text, underlined}] segments, handling both ̲ combining chars
// and the "select best replacement" choiceA underline pattern.
export function parseUnderlineSegments(text, choiceA) {
  const source = String(text ?? "");
  const chars = Array.from(source);

  if (chars.includes("̲")) {
    const pieces = [];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === "̲") continue;
      let underlined = false;
      let j = i + 1;
      while (chars[j] === "̲") { underlined = true; j++; }
      pieces.push({ text: ch, underlined });
    }
    pieces.forEach((p, idx) => {
      if (/^\s+$/.test(p.text) && pieces[idx - 1]?.underlined && pieces[idx + 1]?.underlined) p.underlined = true;
    });
    return pieces.reduce((segs, p) => {
      const prev = segs[segs.length - 1];
      if (prev && prev.underlined === p.underlined) prev.text += p.text;
      else segs.push({ ...p });
      return segs;
    }, []);
  }

  if (choiceA && /select\s+best\s+replacement/i.test(source)) {
    const mainText = source.replace(/\s*[-–—]+\s*Select best replacement.*$/i, "").trimEnd();
    const suffix = source.slice(mainText.length);
    const target = String(choiceA).trim().replace(/[.,;:]$/, "").replace(/\s+/g, " ");
    const norm = mainText.replace(/\s+/g, " ");
    const idx = norm.toLowerCase().indexOf(target.toLowerCase());
    if (idx !== -1) {
      return [
        { text: mainText.slice(0, idx), underlined: false },
        { text: mainText.slice(idx, idx + target.length), underlined: true },
        { text: mainText.slice(idx + target.length) + suffix, underlined: false },
      ].filter(s => s.text);
    }
  }

  return [{ text: source, underlined: false }];
}

function toSuperscript(text) {
  const map = { '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻','n':'ⁿ','a':'ᵃ','b':'ᵇ','c':'ᶜ','d':'ᵈ','e':'ᵉ','i':'ⁱ','j':'ʲ','k':'ᵏ','m':'ᵐ','o':'ᵒ','p':'ᵖ','r':'ʳ','s':'ˢ','t':'ᵗ','u':'ᵘ','v':'ᵛ','w':'ʷ','x':'ˣ','y':'ʸ','z':'ᶻ' };
  return [...String(text)].map(c => map[c] || c).join('');
}

function toSubscript(text) {
  const map = { '0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉','+':'₊','-':'₋','a':'ₐ','e':'ₑ','o':'ₒ','x':'ₓ','i':'ᵢ','n':'ₙ','p':'ₚ','r':'ᵣ','s':'ₛ','t':'ₜ','u':'ᵤ','v':'ᵥ' };
  return [...String(text)].map(c => map[c] || c).join('');
}

function latexSegmentToUnicode(latex) {
  let text = String(latex ?? "");
  // Handle nested \frac first (innermost)
  for (let i = 0; i < 3; i++) {
    text = text.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, n, d) => `(${n})/(${d})`);
  }
  return text
    .replace(/\\sqrt\[([^\]]+)\]\{([^{}]*)\}/g, (_, deg, body) => `${toSuperscript(deg)}√(${body})`)
    .replace(/\\sqrt\{([^{}]*)\}/g, (_, body) => `√(${body})`)
    .replace(/\\sqrt\s([A-Za-z0-9])/g, (_, c) => `√${c}`)
    .replace(/\^\{([^{}]*)\}/g, (_, e) => toSuperscript(e))
    .replace(/\^(-?\d+)/g, (_, e) => toSuperscript(e))
    .replace(/\^([A-Za-z])/g, (_, e) => toSuperscript(e))
    .replace(/_\{([^{}]*)\}/g, (_, s) => toSubscript(s))
    .replace(/_([A-Za-z0-9])/g, (_, s) => toSubscript(s))
    .replace(/\\alpha/g,'α').replace(/\\beta/g,'β').replace(/\\gamma/g,'γ')
    .replace(/\\delta/g,'δ').replace(/\\epsilon/g,'ε').replace(/\\theta/g,'θ')
    .replace(/\\lambda/g,'λ').replace(/\\mu/g,'μ').replace(/\\pi/g,'π')
    .replace(/\\sigma/g,'σ').replace(/\\omega/g,'ω').replace(/\\Omega/g,'Ω')
    .replace(/\\Sigma/g,'Σ').replace(/\\Delta/g,'Δ').replace(/\\Gamma/g,'Γ')
    .replace(/\\Theta/g,'Θ').replace(/\\Lambda/g,'Λ').replace(/\\Phi/g,'Φ')
    .replace(/\\phi/g,'φ').replace(/\\psi/g,'ψ').replace(/\\Psi/g,'Ψ')
    .replace(/\\rho/g,'ρ').replace(/\\nu/g,'ν').replace(/\\xi/g,'ξ')
    .replace(/\\eta/g,'η').replace(/\\tau/g,'τ').replace(/\\iota/g,'ι')
    .replace(/\\kappa/g,'κ').replace(/\\zeta/g,'ζ').replace(/\\upsilon/g,'υ')
    .replace(/\\chi/g,'χ').replace(/\\Xi/g,'Ξ').replace(/\\Pi/g,'Π')
    .replace(/\\Upsilon/g,'Υ')
    .replace(/\\times/g,'×').replace(/\\div/g,'÷').replace(/\\cdot\s*/g,'·')
    .replace(/\\pm/g,'±').replace(/\\mp/g,'∓')
    .replace(/\\leq\b/g,'≤').replace(/\\le\b/g,'≤')
    .replace(/\\geq\b/g,'≥').replace(/\\ge\b/g,'≥')
    .replace(/\\neq\b/g,'≠').replace(/\\ne\b/g,'≠')
    .replace(/\\approx/g,'≈').replace(/\\equiv/g,'≡').replace(/\\sim/g,'~')
    .replace(/\\infty/g,'∞').replace(/\\in\b/g,'∈').replace(/\\mid\b/g,'|')
    .replace(/\\cup\b/g,'∪').replace(/\\cap\b/g,'∩')
    .replace(/\\subset\b/g,'⊂').replace(/\\supset\b/g,'⊃')
    .replace(/\\sum\b/g,'Σ').replace(/\\int\b/g,'∫')
    .replace(/\\partial\b/g,'∂').replace(/\\nabla\b/g,'∇')
    .replace(/\\sin\b/g,'sin').replace(/\\cos\b/g,'cos').replace(/\\tan\b/g,'tan')
    .replace(/\\sec\b/g,'sec').replace(/\\csc\b/g,'csc').replace(/\\cot\b/g,'cot')
    .replace(/\\log\b/g,'log').replace(/\\ln\b/g,'ln').replace(/\\lim\b/g,'lim')
    .replace(/\\max\b/g,'max').replace(/\\min\b/g,'min').replace(/\\exp\b/g,'exp')
    .replace(/\\text\{([^{}]*)\}/g,'$1')
    .replace(/\\mathbb\{([^{}]*)\}/g,'$1')
    .replace(/\\mathrm\{([^{}]*)\}/g,'$1')
    .replace(/\\mathbf\{([^{}]*)\}/g,'$1')
    .replace(/\\left\s*\(/g,'(').replace(/\\right\s*\)/g,')')
    .replace(/\\left\s*\[/g,'[').replace(/\\right\s*\]/g,']')
    .replace(/\\left\s*\\?\{/g,'{').replace(/\\right\s*\\?\}/g,'}')
    .replace(/[{}]/g,'')
    .replace(/\\,/g,' ').replace(/\\;/g,' ').replace(/\\!/g,'')
    .replace(/\\quad/g,'  ').replace(/\\qquad/g,'    ')
    .replace(/\\\\/g,'\n')
    .replace(/\\[a-zA-Z]+/g,'')
    .replace(/\s+/g,' ').trim();
}

export function latexToPlainText(text) {
  // Normalize raw math notation into \( \) delimiters first
  const source = containsMath(String(text ?? ""))
    ? String(text ?? "")
    : convertRawMathToDelimited(String(text ?? ""));
  let result = "";
  let last = 0;
  let match;
  EXPORT_MATH_RE.lastIndex = 0;
  while ((match = EXPORT_MATH_RE.exec(source)) !== null) {
    result += source.slice(last, match.index);
    const math = match[2] ?? match[3] ?? match[4] ?? "";
    result += latexSegmentToUnicode(normalizeMathExpression(math));
    last = EXPORT_MATH_RE.lastIndex;
  }
  result += source.slice(last);
  return result;
}

export function renderTextForHtml(text) {
  // Normalize raw math notation into \( \) delimiters first
  const source = containsMath(String(text ?? ""))
    ? String(text ?? "")
    : convertRawMathToDelimited(String(text ?? ""));
  let result = "";
  let last = 0;
  let match;
  EXPORT_MATH_RE.lastIndex = 0;
  while ((match = EXPORT_MATH_RE.exec(source)) !== null) {
    result += escapeHtml(source.slice(last, match.index));
    const inlineMath = match[2];
    const displayMath = match[3] ?? match[4];
    const rawMath = inlineMath !== undefined ? inlineMath : displayMath;
    const math = normalizeMathExpression(rawMath);
    const displayMode = inlineMath === undefined;
    try {
      // output: 'mathml' renders natively in browsers — no CSS or fonts needed
      result += katex.renderToString(math, { output: "mathml", displayMode, throwOnError: false, strict: "ignore" });
    } catch {
      result += escapeHtml(match[0]);
    }
    last = EXPORT_MATH_RE.lastIndex;
  }
  result += escapeHtml(source.slice(last));
  return result;
}

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderQuestionTextHtml(text, choiceA) {
  const segs = parseUnderlineSegments(text, choiceA);
  return segs.map(s =>
    s.underlined
      ? `<span style="text-decoration:underline;text-decoration-color:#f59e0b;text-underline-offset:3px;text-decoration-thickness:2px">${renderTextForHtml(s.text)}</span>`
      : renderTextForHtml(s.text)
  ).join("");
}

export function textRunsForSegments(text, choiceA, baseProps = {}) {
  const segs = parseUnderlineSegments(latexToPlainText(text), choiceA ? latexToPlainText(choiceA) : undefined);
  return segs.map(s =>
    new TextRun({ ...baseProps, text: s.text, underline: s.underlined ? {} : undefined })
  );
}

// ═══════════════════════════════════════════════════════════════
// Question Bank export — layout preserved byte-for-byte from App.jsx.
// ═══════════════════════════════════════════════════════════════

export function generateQuestionsHtml(rows) {
  const questionsHtml = rows.map((row, i) => {
    const choices = ["a", "b", "c", "d", "e"]
      .filter(l => row[`choice_${l}`])
      .map(l => {
        const isCorrect = row.correct_answer?.toLowerCase() === l;
        return `<div class="choice${isCorrect ? " correct" : ""}"><span class="cl">${l.toUpperCase()}.</span> ${renderTextForHtml(row[`choice_${l}`])}</div>`;
      }).join("");
    const passage = (row.stimulus_title || row.stimulus_text)
      ? `<div class="passage">${row.stimulus_title ? `<div class="passage-title">Passage: <em>${escapeHtml(row.stimulus_title)}</em></div>` : ""}${row.stimulus_text ? `<div class="passage-body">${renderTextForHtml(row.stimulus_text)}</div>` : ""}</div>`
      : "";
    const visuals = questionImageHtml(row._visuals);
    return `<div class="q">
<div class="meta">${escapeHtml(row.subject || "")} &bull; ${escapeHtml(row.topic || "")}${row.subtopic ? ` &bull; ${escapeHtml(row.subtopic)}` : ""} &bull; <span class="d-${row.difficulty_level}">${row.difficulty_level || ""}</span> &bull; ${escapeHtml(row.status || "")}</div>
<div class="qt"><span class="qn">${i + 1}.</span> ${renderQuestionTextHtml(row.question_text || "", row.choice_a)}</div>
${passage}${visuals}${choices}</div>`;
  }).join("");
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Question Bank Export</title>
<style>
body{font-family:Arial,sans-serif;font-size:11pt;color:#1e293b;margin:.75in}
h1{font-size:16pt;margin-bottom:4px}.sub{color:#64748b;font-size:10pt;margin-bottom:24px}
.q{margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid #e2e8f0;page-break-inside:avoid}
.meta{font-size:9pt;color:#64748b;margin-bottom:6px}
.qn{font-weight:bold;margin-right:4px}.qt{margin-bottom:8px;line-height:1.5}
.choice{margin:3px 0 3px 24px;line-height:1.4}.cl{font-weight:bold;display:inline-block;min-width:20px}
.correct{color:#16a34a;font-weight:bold}.passage{font-size:9.5pt;color:#1e293b;margin-top:10px;border-left:3px solid #cbd5e1;padding-left:10px}.passage-title{font-weight:bold;font-style:italic;color:#475569;margin-bottom:4px}.passage-body{line-height:1.7;white-space:pre-wrap}
.visual{margin:8px 0 8px 0;page-break-inside:avoid}.visual img{max-width:100%;max-height:280px;display:block;background:#fff;border:1px solid #e2e8f0;border-radius:4px;padding:4px}
.d-easy{color:#16a34a}.d-medium{color:#d97706}.d-hard{color:#dc2626}
math{font-size:1.05em}
@media print{body{margin:.5in}.q{page-break-inside:avoid}}
</style>
<script>window.onload=function(){window.print();}</script>
</head><body>
<h1>Question Bank Export</h1>
<div class="sub">${rows.length} question${rows.length !== 1 ? "s" : ""} &mdash; ${date}</div>
${questionsHtml}</body></html>`;
}

// ═══════════════════════════════════════════════════════════════
// Quiz export — student test (answers hidden) or answer key.
// Same renderers as the bank; a cleaner, exam-style layout that hides
// bank metadata (subject/topic/difficulty/status) from students.
// ═══════════════════════════════════════════════════════════════

export function generateQuizHtml(rows, opts = {}) {
  const {
    title = "Quiz",
    subtitle = "",
    showAnswers = false,       // answer key vs student test
    stripSvgAnswers = true,    // strip ans/answer labels from SVGs (student test)
  } = opts;

  // Group consecutive rows that share a stimulus so a passage prints once.
  const questionsHtml = rows.map((row, i) => {
    const prev = rows[i - 1];
    const samePassageAsPrev = row.stimulus_id && prev && prev.stimulus_id === row.stimulus_id;
    const choices = ["a", "b", "c", "d", "e"]
      .filter(l => row[`choice_${l}`])
      .map(l => {
        const isCorrect = showAnswers && row.correct_answer?.toLowerCase() === l;
        return `<div class="choice${isCorrect ? " correct" : ""}"><span class="cl">${l.toUpperCase()}.</span> ${renderTextForHtml(row[`choice_${l}`])}${isCorrect ? ' <span class="tick">&#10004;</span>' : ""}</div>`;
      }).join("");
    const passage = (!samePassageAsPrev && (row.stimulus_title || row.stimulus_text))
      ? `<div class="passage">${row.stimulus_title ? `<div class="passage-title"><em>${escapeHtml(row.stimulus_title)}</em></div>` : ""}${row.stimulus_text ? `<div class="passage-body">${renderTextForHtml(row.stimulus_text)}</div>` : ""}</div>`
      : "";
    const instruction = row.instruction_text
      ? `<div class="instruction">${renderTextForHtml(row.instruction_text)}</div>`
      : "";
    const visuals = questionImageHtml(row._visuals, stripSvgAnswers);
    const answerLine = showAnswers
      ? `<div class="answer">Answer: <strong>${escapeHtml((row.correct_answer || "").toUpperCase())}</strong></div>`
      : "";
    return `${passage}<div class="q">
${instruction}<div class="qt"><span class="qn">${i + 1}.</span> ${renderQuestionTextHtml(row.question_text || "", row.choice_a)}</div>
${visuals}${choices}${answerLine}</div>`;
  }).join("");

  const heading = showAnswers ? `${escapeHtml(title)} — Answer Key` : escapeHtml(title);
  const subLine = subtitle
    ? `<div class="sub">${escapeHtml(subtitle)}</div>`
    : `<div class="sub">${rows.length} question${rows.length !== 1 ? "s" : ""}</div>`;
  const nameRow = showAnswers
    ? ""
    : `<div class="namerow"><span>Name: ______________________________</span><span>Date: ________________</span><span>Score: ______ / ${rows.length}</span></div>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${heading}</title>
<style>
body{font-family:Arial,sans-serif;font-size:11pt;color:#1e293b;margin:.75in}
h1{font-size:17pt;margin-bottom:4px}.sub{color:#64748b;font-size:10pt;margin-bottom:14px}
.namerow{display:flex;justify-content:space-between;gap:16px;font-size:10pt;color:#334155;border:1px solid #cbd5e1;border-radius:6px;padding:8px 12px;margin-bottom:20px}
.q{margin-bottom:16px;padding-bottom:12px;page-break-inside:avoid}
.qn{font-weight:bold;margin-right:4px}.qt{margin-bottom:8px;line-height:1.5}
.instruction{font-size:9.5pt;font-style:italic;color:#475569;margin-bottom:6px}
.choice{margin:3px 0 3px 24px;line-height:1.4}.cl{font-weight:bold;display:inline-block;min-width:20px}
.correct{color:#16a34a;font-weight:bold}.tick{color:#16a34a}
.answer{margin:6px 0 0 24px;font-size:10pt;color:#16a34a}
.passage{font-size:10pt;color:#1e293b;margin:14px 0 10px;border-left:3px solid #cbd5e1;padding-left:12px}.passage-title{font-weight:bold;font-style:italic;color:#475569;margin-bottom:4px}.passage-body{line-height:1.7;white-space:pre-wrap}
.visual{margin:8px 0;page-break-inside:avoid}.visual img{max-width:100%;max-height:300px;display:block;background:#fff;border:1px solid #e2e8f0;border-radius:4px;padding:4px}
math{font-size:1.05em}
@media print{body{margin:.5in}.q{page-break-inside:avoid}}
</style>
<script>window.onload=function(){window.print();}</script>
</head><body>
<h1>${heading}</h1>
${subLine}
${nameRow}
${questionsHtml}</body></html>`;
}

// ═══════════════════════════════════════════════════════════════
// SVG / image rendering
// ═══════════════════════════════════════════════════════════════

export function cleanSvgForExport(svg, stripAnswers = true) {
  if (!stripAnswers) return String(svg || "");
  return String(svg || "").replace(/<text\b[^>]*>[\s\S]*?<\/text>/gi, m =>
    /\b(?:ans|answer|correct)\s*[:：]/i.test(m) ? "" : m
  );
}

function parseSvgDimensions(svg) {
  const vb = svg.match(/viewBox=["']([^"']+)["']/);
  if (vb) {
    const p = vb[1].trim().split(/[\s,]+/);
    if (p.length === 4) {
      const w = parseFloat(p[2]), h = parseFloat(p[3]);
      if (w && h) return { width: w, height: h };
    }
  }
  const wm = svg.match(/\bwidth=["'](\d+(?:\.\d+)?)/);
  const hm = svg.match(/\bheight=["'](\d+(?:\.\d+)?)/);
  if (wm && hm) return { width: parseFloat(wm[1]), height: parseFloat(hm[1]) };
  return { width: 400, height: 300 };
}

export function svgToImageData(svgString) {
  return new Promise((resolve, reject) => {
    // Strip XML declaration — browsers require SVG blob URLs to start with <svg
    const cleaned = cleanSvgForExport(svgString).replace(/^\s*<\?xml[^?]*\?>\s*/i, "");
    const { width: natW, height: natH } = parseSvgDimensions(cleaned);
    const scale = Math.min(1, 520 / natW);
    const cw = Math.round(natW * scale);
    const ch = Math.round(natH * scale);
    const canvas = document.createElement("canvas");
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, cw, ch);
    const img = new Image();
    const blob = new Blob([cleaned], { type: "image/svg+xml;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    img.onload = () => {
      ctx.drawImage(img, 0, 0, cw, ch);
      window.URL.revokeObjectURL(url);
      canvas.toBlob(pb => {
        if (!pb) return reject(new Error("canvas toBlob failed"));
        pb.arrayBuffer().then(buf => resolve({ data: buf, width: cw, height: ch })).catch(reject);
      }, "image/png");
    };
    img.onerror = () => { window.URL.revokeObjectURL(url); reject(new Error("SVG load failed")); };
    img.src = url;
  });
}

export function questionImageHtml(visuals, stripAnswers = true) {
  if (!visuals?.length) return "";
  return visuals.map(v => {
    if (v._resolvedSvg) {
      const svgClean = cleanSvgForExport(v._resolvedSvg, stripAnswers).replace(/^\s*<\?xml[^?]*\?>\s*/i, "");
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgClean)}`;
      return `<div class="visual"><img src="${dataUrl}" alt="Question visual"></div>`;
    }
    if (v._resolvedUrl) {
      return `<div class="visual"><img src="${escapeHtml(v._resolvedUrl)}" alt="Question visual"></div>`;
    }
    return "";
  }).join("");
}

// ═══════════════════════════════════════════════════════════════
// Visual resolution — fetch question_visual_assets and resolve each to
// inline SVG or a public storage URL. Extracted from App.exportQuestions
// so the quiz export renders images identically.
// ═══════════════════════════════════════════════════════════════

export async function resolveQuestionVisuals(rows, { REST, STORAGE, hdr, token }) {
  const visMap = {};
  const qIds = rows.map(r => r.id).filter(Boolean);
  for (let i = 0; i < qIds.length; i += 100) {
    const chunk = qIds.slice(i, i + 100);
    const vr = await fetch(
      `${REST}/question_visual_assets?question_id=in.(${chunk.map(encodeURIComponent).join(",")})&select=*,visual_assets(*)`,
      { headers: hdr(token) }
    );
    if (vr.ok) {
      (await vr.json()).forEach(v => {
        if (!visMap[v.question_id]) visMap[v.question_id] = [];
        visMap[v.question_id].push(v);
      });
    }
  }

  const looksLikeSvg = (text, contentType) =>
    contentType?.includes("svg") ||
    text.trim().startsWith("<svg") ||
    (text.trim().startsWith("<?xml") && text.includes("<svg"));

  const resolveAsset = async (v) => {
    const a = v.visual_assets || v;

    // Inline SVG stored directly in the DB row
    const inlineSvg = a.svg || a.svg_markup || a.svg_text || a.svg_content || a.content || a.markup || a.data;
    if (inlineSvg && typeof inlineSvg === "string" && (inlineSvg.trim().startsWith("<svg") || inlineSvg.trim().startsWith("<?xml"))) {
      return { _resolvedSvg: inlineSvg };
    }

    // Use assetSources() — same URL-building logic the app uses for display
    const candidates = (assetSources(a, STORAGE) || []).filter(u => !u.startsWith("/"));
    for (const url of candidates) {
      try {
        const fr = await fetch(url);
        if (!fr.ok) continue;
        const contentType = fr.headers.get("content-type") || "";
        const text = await fr.text();
        if (looksLikeSvg(text, contentType)) return { _resolvedSvg: text };
        return { _resolvedUrl: url };
      } catch { continue; }
    }
    return {};
  };

  return Promise.all(rows.map(async r => {
    // Mirror the app: questionInlineVisualAssets(row) + visMap[row.id]
    const raw = [...questionInlineVisualAssets(r), ...(visMap[r.id] || [])];
    const visuals = await Promise.all(raw.map(async v => ({ ...v, ...(await resolveAsset(v)) })));
    return { ...r, _visuals: visuals };
  }));
}

// ═══════════════════════════════════════════════════════════════
// DOCX export — layout preserved byte-for-byte from App.jsx.
// ═══════════════════════════════════════════════════════════════

export async function questionsToDocx(rows) {
  const children = [];
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  children.push(new Paragraph({ text: "Question Bank Export", heading: HeadingLevel.TITLE }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `${rows.length} question${rows.length !== 1 ? "s" : ""} — ${date}`, color: "64748B" })],
  }));
  children.push(new Paragraph({ text: "" }));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    children.push(new Paragraph({
      children: [
        new TextRun({ text: `${i + 1}. `, bold: true }),
        new TextRun({ text: `[${row.subject || ""}]`, color: "2563EB", bold: true }),
        new TextRun({ text: `  ${row.topic || ""}${row.subtopic ? ` > ${row.subtopic}` : ""}  |  ${row.difficulty_level || ""}  |  ${row.status || ""}`, color: "64748B", size: 18 }),
      ],
    }));
    children.push(new Paragraph({
      children: textRunsForSegments(row.question_text || "", row.choice_a),
      indent: { left: 360 },
    }));
    // Embed visual assets
    for (const v of (row._visuals || [])) {
      const svg = v._resolvedSvg;
      if (svg) {
        try {
          const { data, width, height } = await svgToImageData(svg);
          children.push(new Paragraph({
            children: [new ImageRun({ data, transformation: { width, height } })],
            indent: { left: 360 },
          }));
        } catch { /* skip image if conversion fails */ }
      }
    }
    ["a", "b", "c", "d", "e"].forEach(l => {
      const choice = row[`choice_${l}`];
      if (!choice) return;
      const correct = row.correct_answer?.toLowerCase() === l;
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `${l.toUpperCase()}. `, bold: true, color: correct ? "16A34A" : undefined }),
          new TextRun({ text: latexToPlainText(choice), color: correct ? "16A34A" : undefined }),
          ...(correct ? [new TextRun({ text: "  ✓", bold: true, color: "16A34A" })] : []),
        ],
        indent: { left: 720 },
      }));
    });
    if (row.stimulus_title || row.stimulus_text) {
      if (row.stimulus_title) {
        children.push(new Paragraph({
          children: [
            new TextRun({ text: "Passage: ", bold: true, italics: true }),
            new TextRun({ text: row.stimulus_title, italics: true }),
          ],
          indent: { left: 360 },
        }));
      }
      if (row.stimulus_text) {
        row.stimulus_text.split(/\n+/).filter(Boolean).forEach(para => {
          children.push(new Paragraph({
            children: textRunsForSegments(para, undefined, { size: 20, color: "334155" }),
            indent: { left: 360 },
          }));
        });
      }
    }
    children.push(new Paragraph({ text: "" }));
  }
  const doc = new Document({ sections: [{ properties: {}, children }] });
  return await Packer.toBlob(doc);
}
