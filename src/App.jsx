import { useState, useEffect, useCallback, useRef, useId } from "react";
import ExamBuilder from "./ExamBuilder";
import QuizBuilder from "./QuizBuilder";
import ResultsExport from "./ResultsExport";
import QuestionGenerator from "./QuestionGenerator";
import CategoryManager, { CategoryCreateModal, AddQuestionsModal } from "./CategoryManager";
import { ChoiceContent, MathContent } from "./mathContent";
import { validateMathItem } from "./mathValidation";
import { VisualAssetPreview, questionInlineVisualAssets } from "./visualContent";
import { loadClassificationOptions } from "./classificationOptions";
import { QuestionWithUnderline } from "./questionText";
import { generateQuestionsHtml, questionsToDocx, resolveQuestionVisuals } from "./questionExport";
import { useQuestionGeneration } from "./useQuestionGeneration";
import { prepareQuestionImport, commitQuestionImport, importTemplateCsv } from "./questionImport";

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const REST = `${URL?.replace(/\/$/, "")}/rest/v1`;
const AUTH = `${URL?.replace(/\/$/, "")}/auth/v1`;
const FUNCTIONS = `${URL?.replace(/\/$/, "")}/functions/v1`;
const STORAGE = `${URL?.replace(/\/$/, "")}/storage/v1/object/public`;
const STORAGE_API = `${URL?.replace(/\/$/, "")}/storage/v1/object`;
const VISUAL_BUCKET = "question-visuals";
const hdr = (t) => ({ apikey: KEY, Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

// Turns an uploaded file's name into a storage-safe slug.
function sanitizeFileName(name) {
  return String(name || "file")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "file";
}

// asset_type for the visual_assets row. The DB CHECK constraint
// (visual_assets_asset_type_check) only permits image | figure | diagram | chart,
// so anything that isn't an image is stored as the generic "figure". The real
// file format (pdf/svg/video/audio/…) is recovered at render time from the file
// extension in storage_path, so the viewer still picks the correct renderer.
function assetTypeForFile(file) {
  const mime = file?.type || "";
  if (mime.startsWith("image/")) return "image";
  return "figure";
}
const PS = 24;
const QUESTION_SEARCH_COLUMNS = ["question_text", "choice_a", "choice_b", "choice_c", "choice_d", "choice_e", "correct_answer"];

function cleanQuestionSearchTerm(value) {
  return String(value || "")
    .trim()
    .replace(/[(),]/g, " ")
    .replace(/\s+/g, " ");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildQuestionSearchFilter(search) {
  const term = cleanQuestionSearchTerm(search);
  if (!term) return "";
  if (UUID_RE.test(term)) return "";
  return `(${QUESTION_SEARCH_COLUMNS.map((col) => `${col}.ilike.*${term}*`).join(",")})`;
}

// ═══════════════════════════════════════════════════════════════
// MATH RENDERER
// ═══════════════════════════════════════════════════════════════
// Converts plain-text math notation into styled HTML spans.
// Handles: x^2 → x², sqrt(x) → √x̄, fractions, Greek letters.

function renderMath(text) {
  if (text === null) return text;
  if (!text) return text;
  let result = String(text);

  // sqrt(content) → √content with overline
  result = result.replace(/sqrt\(([^)]+)\)/g, (_, inner) =>
    `<span style="white-space:nowrap">√<span style="text-decoration:overline;text-decoration-thickness:1px">${inner}</span></span>`
  );

  // Grouped exponent: x^(expr) → x<sup>expr</sup>
  result = result.replace(/\^{?\(([^)]+)\)}?/g, '<sup>$1</sup>');

  // Simple exponent: x^2, x^10, x^n (1-2 chars after ^)
  result = result.replace(/\^(\d+|[a-zA-Z])/g, '<sup>$1</sup>');

  // 4th-root, nth-root
  result = result.replace(/(\d+)(?:th|nd|rd|st)-root/g, '<sup>$1</sup>√');

  return result;
}

export function MathText({ children, style, subject }) {
  renderMath(null);
  return <MathContent value={children} style={style} subject={subject} />;
}

// ═══════════════════════════════════════════════════════════════
// UNDERLINE DETECTOR
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// SEG MARKUP RENDERER (Error Identification)
// ═══════════════════════════════════════════════════════════════

const SEGC = {
  A: { bg: "#ef444418", border: "#ef4444", text: "#fca5a5" },
  B: { bg: "#3b82f618", border: "#3b82f6", text: "#93c5fd" },
  C: { bg: "#22c55e18", border: "#22c55e", text: "#86efac" },
  D: { bg: "#f59e0b18", border: "#f59e0b", text: "#fcd34d" },
};

function cleanSegmentDisplayText(value) {
  return String(value || "")
    .replace(/\s*(?:←|<-|â†)\s*error\b/gi, "")
    .replace(/\s*\[error\]/gi, "")
    .replace(/\s*\(error\)/gi, "")
    .replace(/\s+\berror\b(?=\s|$)/gi, "")
    .replace(/\s{2,}/g, " ");
}

function SegMarkup({ markup }) {
  if (!markup) return null;
  const parts = [];
  const rx = /<seg\s+choice='([A-D])'>(.*?)<\/seg>/g;
  let m, last = 0;
  while ((m = rx.exec(markup)) !== null) {
    if (m.index > last) parts.push({ t: "t", c: cleanSegmentDisplayText(markup.slice(last, m.index)) });
    parts.push({ t: "s", ch: m[1], c: cleanSegmentDisplayText(m[2]) });
    last = rx.lastIndex;
  }
  if (last < markup.length) parts.push({ t: "t", c: cleanSegmentDisplayText(markup.slice(last)) });

  return (
    <div style={{ fontSize: 15, lineHeight: 2.6, color: "#cbd5e1" }}>
      {parts.map((p, i) => {
        if (p.t === "t") return <span key={i}>{p.c}</span>;
        const c = SEGC[p.ch];
        return (
          <span key={i} style={{
            borderBottom: `2px solid ${c.border}`,
            padding: "12px 3px 1px", margin: "0 2px", color: "inherit",
            fontWeight: 400, position: "relative", display: "inline-block",
            lineHeight: 1.45,
          }}>
            <span style={{ position: "absolute", top: 0, left: 3, fontSize: 9, lineHeight: 1, fontWeight: 700, color: c.border }}>{p.ch}</span>
            {p.c}
          </span>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════

function readStoredSession() {
  try {
    const p = JSON.parse(localStorage.getItem("admin_session") || "null");
    if (p?.access_token && p.exp > Date.now() / 1000) return p;
    localStorage.removeItem("admin_session");
  } catch { localStorage.removeItem("admin_session"); }
  return null;
}

function makeSession(d, fallbackUser) {
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    exp: Math.floor(Date.now() / 1000) + d.expires_in,
    user: d.user || fallbackUser,
  };
}

function useAuth() {
  const [s, setS] = useState(readStoredSession);
  const timerRef = useRef(null);

  function saveAndSet(sess) {
    localStorage.setItem("admin_session", JSON.stringify(sess));
    setS(sess);
  }

  async function refresh(currentSession) {
    if (!currentSession?.refresh_token) return;
    try {
      const r = await fetch(`${AUTH}/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: KEY },
        body: JSON.stringify({ refresh_token: currentSession.refresh_token }),
      });
      if (!r.ok) { localStorage.removeItem("admin_session"); setS(null); return; }
      saveAndSet(makeSession(await r.json(), currentSession.user));
    } catch { /* network error — keep existing session, will retry next cycle */ }
  }

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (!s?.exp || !s?.refresh_token) return;
    // Always go through the timer, even when the token is already due. Calling
    // refresh() inline would setState synchronously inside the effect body and
    // cascade a render; a 0ms timeout defers it to the next tick instead.
    const msUntilRefresh = Math.max(0, (s.exp - 300) * 1000 - Date.now());
    timerRef.current = setTimeout(() => refresh(s), msUntilRefresh);
    return () => clearTimeout(timerRef.current);
  }, [s?.exp]);

  async function login(email, pw) {
    const r = await fetch(`${AUTH}/token?grant_type=password`, {
      method: "POST", headers: { "Content-Type": "application/json", apikey: KEY },
      body: JSON.stringify({ email, password: pw }),
    });
    if (!r.ok) { const e = await r.json(); throw new Error(e.error_description || "Login failed"); }
    saveAndSet(makeSession(await r.json()));
  }

  function logout() {
    clearTimeout(timerRef.current);
    localStorage.removeItem("admin_session");
    setS(null);
  }

  return { session: s, loading: false, login, logout };
}

const QUESTION_CSV_COLUMNS = [
  ["id", "id"],
  ["subject", "subject"],
  ["topic", "topic"],
  ["subtopic", "subtopic"],
  ["difficulty_level", "difficulty_level"],
  ["status", "status"],
  ["source_school", "source_school"],
  ["correct_answer", "correct_answer"],
  ["question_text", "question_text"],
  ["choice_a", "choice_a"],
  ["choice_b", "choice_b"],
  ["choice_c", "choice_c"],
  ["choice_d", "choice_d"],
  ["choice_e", "choice_e"],
  ["render_markup", "render_markup"],
  ["stimulus_id", "stimulus_id"],
  ["instruction_id", "instruction_id"],
];

function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

const STIMULUS_CSV_COLUMNS = [
  ["stimulus_title", "stimulus_title"],
  ["stimulus_type", "stimulus_type"],
  ["stimulus_text", "stimulus_text"],
];

function questionsToCsv(rows, extraColumns = []) {
  const columns = [...QUESTION_CSV_COLUMNS, ...extraColumns];
  const lines = [columns.map(([, label]) => csvEscape(label)).join(",")];
  rows.forEach((row) => {
    lines.push(columns.map(([key]) => csvEscape(row?.[key])).join(","));
  });
  return `\ufeff${lines.join("\r\n")}`;
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const href = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  window.URL.revokeObjectURL(href);
}

function downloadBlob(filename, blob) {
  const href = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  window.URL.revokeObjectURL(href);
}

function buildQuestionQuery(filters, search, offset, limit) {
  const p = new URLSearchParams();
  p.set("select", "*");
  p.set("order", "subject.asc,topic.asc,subtopic.asc");
  p.set("limit", String(limit));
  p.set("offset", String(offset));
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== "all") p.set(k, `eq.${v}`);
  });
  const term = cleanQuestionSearchTerm(search);
  if (UUID_RE.test(term)) {
    p.set("id", `eq.${term}`);
  } else {
    const searchFilter = buildQuestionSearchFilter(search);
    if (searchFilter) p.set("or", searchFilter);
  }
  return p;
}

// ═══════════════════════════════════════════════════════════════
// APP
// ═══════════════════════════════════════════════════════════════

export default function App() {
  const { session, loading: authLd, login, logout } = useAuth();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [authErr, setAuthErr] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  const [questions, setQuestions] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);

  const [filters, setFilters] = useState({
    subject: "all", topic: "all", subtopic: "all",
    source_school: "all", difficulty_level: "all", status: "all",
  });
  const [search, setSearch] = useState("");
  const [opts, setOpts] = useState({ subjects: [], topics: [], subtopics: [] });
  const [classOpts, setClassOpts] = useState({ subjects: [], topics: [], subtopics: [], source: "" });
  const [liveDiagnosticOpts, setLiveDiagnosticOpts] = useState({ subjects: [], topics: [], subtopics: [], source: "" });
  const tmr = useRef(null);

  const [sel, setSel] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [msg, setMsg] = useState("");
  const [stats, setStats] = useState(null);
  const [view, setView] = useState("bank");

  // Owned here, not inside QuestionGenerator: switching tabs unmounts that
  // component, and an in-flight AI batch must survive that. See
  // src/useQuestionGeneration.js.
  const gen = useQuestionGeneration({ session, rest: REST, functionsBase: FUNCTIONS, headers: hdr });
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [moveForm, setMoveForm] = useState({
    subject: "",
    topic: "",
    subtopic: "",
    customSubject: "",
    customTopic: "",
    customSubtopic: "",
  });
  const [moveBusy, setMoveBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState("");
  const [bulkDifficulty, setBulkDifficulty] = useState("");
  const [visualMap, setVisualMap] = useState({});
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const [uploadAlt, setUploadAlt] = useState("");
  const fileRef = useRef(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportFormat, setExportFormat] = useState("csv");
  const [importPreview, setImportPreview] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importDraftOnly, setImportDraftOnly] = useState(true);
  const importRef = useRef(null);
  const [catCounts, setCatCounts] = useState({});
  const [requestedScope, setRequestedScope] = useState(null);
  const [bankCreateOpen, setBankCreateOpen] = useState(false);
  const [bankAddQOpen, setBankAddQOpen] = useState(false);

const loadMeta = useCallback(async () => {
  if (!session) return;
    const META_PAGE_SIZE = 1000;
    const d = [];
    let offset = 0;
    let totalRows = null;

    while (true) {
      const r = await fetch(
        `${REST}/questions?select=subject,topic,subtopic&limit=${META_PAGE_SIZE}&offset=${offset}`,
        { headers: { ...hdr(session.access_token), Prefer: "count=exact" } }
      );

      if (!r.ok) {
        console.error("Failed to load question metadata", await r.text());
        return;
      }

      const rows = await r.json();
      const range = r.headers.get("content-range");
      const rangeTotal = range?.split("/")[1];
      if (rangeTotal && rangeTotal !== "*") totalRows = Number(rangeTotal);

      d.push(...rows);
      offset += rows.length;

      if (rows.length === 0) break;
      if (totalRows !== null && d.length >= totalRows) break;
      if (rows.length < META_PAGE_SIZE && totalRows === null) break;
    }

    setOpts({
      subjects: [...new Set(d.map(q => q.subject).filter(Boolean))].sort(),
      topics: [...new Set(
        d
          .filter(q => q.subject && q.topic)
          .map(q => `${q.subject}|||${q.topic}`)
      )].sort(),
      subtopics: [...new Set(
        d
          .filter(q => q.subject && q.topic && q.subtopic)
          .map(q => `${q.subject}|||${q.topic}|||${q.subtopic}`)
      )].sort(),
    });

    const bySub = {};
    const byTopic = {};
    const bySubtopic = {};
    d.forEach(q => {
      if (!q.subject) return;
      bySub[q.subject] = (bySub[q.subject] || 0) + 1;
      if (q.topic) {
        const tk = `${q.subject}|||${q.topic}`;
        byTopic[tk] = (byTopic[tk] || 0) + 1;
        if (q.subtopic) {
          const sk = `${q.subject}|||${q.topic}|||${q.subtopic}`;
          bySubtopic[sk] = (bySubtopic[sk] || 0) + 1;
        }
      }
    });

    setCatCounts({ subjects: bySub, topics: byTopic, subtopics: bySubtopic });
    setStats({ total: totalRows ?? d.length, bySub });
}, [session]);

useEffect(() => {
  const run = async () => { await loadMeta(); };
  run();
}, [loadMeta]);

const loadClassOpts = useCallback(async () => {
  if (!session) return;
  const parsed = await loadClassificationOptions(REST, hdr(session.access_token));
  setClassOpts(parsed);
}, [session]);

useEffect(() => {
  const run = async () => { await loadClassOpts(); };
  run();
}, [loadClassOpts]);

useEffect(() => {
  if (!session) return;
  let cancelled = false;
  const h = hdr(session.access_token);
  async function loadLiveDiagnosticOptions() {
    try {
      const activeRes = await fetch(`${REST}/diagnostic_templates?select=id&is_active=eq.true`, { headers: h });
      if (!activeRes.ok) throw new Error(await activeRes.text());
      const activeTemplates = await activeRes.json();
      const activeIds = (Array.isArray(activeTemplates) ? activeTemplates : []).map(t => t.id).filter(Boolean);
      if (!activeIds.length) throw new Error("No active diagnostic templates found.");

      const PAGE = 1000;
      const rows = [];
      let offset = 0;
      while (true) {
        const params = new URLSearchParams();
        params.set("select", "question_id,questions(subject,topic,subtopic)");
        params.set("template_id", `in.(${activeIds.map(encodeURIComponent).join(",")})`);
        params.set("limit", String(PAGE));
        params.set("offset", String(offset));
        const res = await fetch(`${REST}/diagnostic_template_questions?${params}`, { headers: h });
        if (!res.ok) throw new Error(await res.text());
        const pageRows = await res.json();
        if (!Array.isArray(pageRows) || !pageRows.length) break;
        rows.push(...pageRows);
        if (pageRows.length < PAGE) break;
        offset += pageRows.length;
      }

      const subjects = [];
      const topics = [];
      const subtopics = [];
      rows.forEach(row => {
        const q = row.questions || {};
        if (!q.subject) return;
        subjects.push(q.subject);
        if (q.topic) topics.push(`${q.subject}|||${q.topic}`);
        if (q.topic && q.subtopic) subtopics.push(`${q.subject}|||${q.topic}|||${q.subtopic}`);
      });

      if (!cancelled) {
        setLiveDiagnosticOpts({
          subjects: [...new Set(subjects)].sort(),
          topics: [...new Set(topics)].sort(),
          subtopics: [...new Set(subtopics)].sort(),
          source: "active diagnostic templates",
        });
      }
    } catch (e) {
      console.warn("Live diagnostic taxonomy unavailable; generator will use fallbacks.", e);
      if (!cancelled) setLiveDiagnosticOpts({ subjects: [], topics: [], subtopics: [], source: "" });
    }
  }
  loadLiveDiagnosticOptions();
  return () => { cancelled = true; };
}, [session]);

const fetchQ = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    const p = buildQuestionQuery(filters, search, page * PS, PS);
    const r = await fetch(`${REST}/questions?${p}`, { headers: { ...hdr(session.access_token), Prefer: "count=exact" } });
    const d = await r.json();
    const rng = r.headers.get("content-range");
    setQuestions(d);
    setTotal(rng ? parseInt(rng.split("/")[1]) : d.length);
    setBusy(false);
  }, [session, filters, page, search]);

  useEffect(() => {
    const run = async () => { await fetchQ(); };
    run();
  }, [fetchQ]);

  useEffect(() => {
    if (!session) return;
    const ids = [...new Set(questions.map(q => q.id).filter(Boolean))];
    if (!ids.length) return;
    let cancelled = false;
    async function loadVisuals() {
      const missing = ids.filter(id => !visualMap[id]);
      if (!missing.length) return;
      try {
        const encoded = missing.map(encodeURIComponent).join(",");
        const r = await fetch(`${REST}/question_visual_assets?question_id=in.(${encoded})&select=*,visual_assets(*)`, {
          headers: hdr(session.access_token),
        });
        if (!r.ok || cancelled) return;
        const rows = await r.json();
        if (cancelled) return;
        const grouped = Object.fromEntries(missing.map(id => [id, []]));
        (Array.isArray(rows) ? rows : []).forEach(row => {
          if (grouped[row.question_id]) grouped[row.question_id].push(row);
        });
        setVisualMap(prev => ({ ...prev, ...grouped }));
      } catch (e) {
        console.error(e);
      }
    }
    loadVisuals();
    return () => { cancelled = true; };
  }, [session, questions, visualMap]);

  async function pickQ(q) {
    setEditing(false); setMsg(""); setUploadMsg(""); setUploadAlt("");
    const full = { ...q, _stim: null, _inst: null, _vis: [] };
    const h = hdr(session.access_token);
    try {
      if (q.stimulus_id) { const r = await fetch(`${REST}/stimuli?id=eq.${q.stimulus_id}&limit=1`, { headers: h }); full._stim = (await r.json())[0]; }
      if (q.instruction_id) { const r = await fetch(`${REST}/instructions?id=eq.${q.instruction_id}&limit=1`, { headers: h }); full._inst = (await r.json())[0]; }
      const r = await fetch(`${REST}/question_visual_assets?question_id=eq.${q.id}&select=*,visual_assets(*)`, { headers: h });
      full._vis = await r.json();
    } catch (e) { console.error(e); }
    setSel(full);
    setForm({
      question_text: full.question_text, choice_a: full.choice_a, choice_b: full.choice_b,
      choice_c: full.choice_c, choice_d: full.choice_d, choice_e: full.choice_e || "",
      correct_answer: full.correct_answer, difficulty_level: full.difficulty_level,
      source_school: full.source_school, subject: full.subject, topic: full.topic,
      subtopic: full.subtopic, status: full.status, render_markup: full.render_markup || "",
      instruction_code: full._inst?.code || "", instruction_text: full._inst?.instruction_text || "",
      stimulus_type: full._stim?.stimulus_type || "", stimulus_title: full._stim?.stimulus_title || "",
      stimulus_text: full._stim?.stimulus_text || "",
    });
  }

  async function save() {
    setSaving(true); setMsg("");
    const body = {
      question_text: form.question_text,
      choice_a: form.choice_a,
      choice_b: form.choice_b,
      choice_c: form.choice_c,
      choice_d: form.choice_d,
      choice_e: form.choice_e,
      correct_answer: form.correct_answer,
      difficulty_level: form.difficulty_level,
      source_school: form.source_school,
      subject: form.subject,
      topic: form.topic,
      subtopic: form.subtopic,
      status: form.status,
      render_markup: form.render_markup,
    };
    if (!body.choice_e) body.choice_e = null;
    if (!body.render_markup) body.render_markup = null;
    const mathValidation = validateMathItem(body);
    if (mathValidation.checked && !mathValidation.valid) {
      body.status = "needs_human_review";
    }
    const r = await fetch(`${REST}/questions?id=eq.${sel.id}`, {
      method: "PATCH", headers: { ...hdr(session.access_token), Prefer: "return=representation" },
      body: JSON.stringify(body),
    });
    if (!r.ok) { setMsg("Error: " + await r.text()); setSaving(false); return; }
    const u = (await r.json())[0];
    let updatedInst = sel._inst || null;
    if (sel.instruction_id && sel._inst) {
      const ir = await fetch(`${REST}/instructions?id=eq.${encodeURIComponent(sel.instruction_id)}`, {
        method: "PATCH",
        headers: { ...hdr(session.access_token), Prefer: "return=representation" },
        body: JSON.stringify({
          code: form.instruction_code || null,
          instruction_text: form.instruction_text || null,
        }),
      });
      if (!ir.ok) { setMsg("Error: " + await ir.text()); setSaving(false); return; }
      updatedInst = (await ir.json())[0] || updatedInst;
    }
    let updatedStim = sel._stim || null;
    if (sel.stimulus_id && sel._stim) {
      const sr = await fetch(`${REST}/stimuli?id=eq.${encodeURIComponent(sel.stimulus_id)}`, {
        method: "PATCH",
        headers: { ...hdr(session.access_token), Prefer: "return=representation" },
        body: JSON.stringify({
          stimulus_type: form.stimulus_type || null,
          stimulus_title: form.stimulus_title || null,
          stimulus_text: form.stimulus_text || null,
        }),
      });
      if (!sr.ok) { setMsg("Error: " + await sr.text()); setSaving(false); return; }
      updatedStim = (await sr.json())[0] || updatedStim;
    }
    setMsg(mathValidation.checked && !mathValidation.valid ? `Saved; flagged needs_human_review. ${mathValidation.reason}` : "Saved");
    setEditing(false); setSel(prev => ({ ...prev, ...u, _inst: updatedInst, _stim: updatedStim })); fetchQ(); loadMeta();
    setSaving(false);
  }

  // Re-pull the visual assets linked to a question and sync both the open
  // detail panel and the grid's visual cache.
  async function refreshVisuals(qid) {
    const r = await fetch(`${REST}/question_visual_assets?question_id=eq.${encodeURIComponent(qid)}&select=*,visual_assets(*)`, { headers: hdr(session.access_token) });
    const rows = r.ok ? await r.json() : [];
    setSel(prev => (prev && prev.id === qid ? { ...prev, _vis: rows } : prev));
    setVisualMap(prev => ({ ...prev, [qid]: rows }));
  }

  // Uploads a figure of any format to storage, records it as a visual_asset,
  // and links it to the current question so it stays attached permanently.
  async function uploadVisual(file) {
    if (!file || !sel?.id) return;
    setUploadBusy(true); setUploadMsg("");
    const token = session.access_token;
    try {
      const dot = file.name.lastIndexOf(".");
      const ext = dot > -1 ? file.name.slice(dot).toLowerCase() : "";
      const base = sanitizeFileName(dot > -1 ? file.name.slice(0, dot) : file.name);
      const objectPath = `${sel.id}/${Date.now()}-${base}${ext}`;
      const storagePath = `${VISUAL_BUCKET}/${objectPath}`;

      const up = await fetch(`${STORAGE_API}/${VISUAL_BUCKET}/${objectPath}`, {
        method: "POST",
        headers: {
          apikey: KEY,
          Authorization: `Bearer ${token}`,
          "Content-Type": file.type || "application/octet-stream",
          "x-upsert": "true",
        },
        body: file,
      });
      if (!up.ok) throw new Error(`Storage upload failed: ${await up.text()}`);

      const vaRes = await fetch(`${REST}/visual_assets`, {
        method: "POST",
        headers: { ...hdr(token), Prefer: "return=representation" },
        body: JSON.stringify({
          storage_path: storagePath,
          asset_type: assetTypeForFile(file),
          asset_key: base,
          alt_text: uploadAlt.trim() || null,
        }),
      });
      if (!vaRes.ok) throw new Error(`Asset record failed: ${await vaRes.text()}`);
      const va = (await vaRes.json())[0];

      const linkRes = await fetch(`${REST}/question_visual_assets`, {
        method: "POST",
        headers: { ...hdr(token), Prefer: "return=minimal" },
        body: JSON.stringify({ question_id: sel.id, visual_asset_id: va.id }),
      });
      if (!linkRes.ok) throw new Error(`Linking to question failed: ${await linkRes.text()}`);

      await refreshVisuals(sel.id);
      setUploadAlt("");
      setUploadMsg("Figure attached to this question.");
    } catch (e) {
      setUploadMsg("Error: " + (e?.message || String(e)));
    } finally {
      setUploadBusy(false);
    }
  }

  // Detaches a figure: removes the link, the asset record, and the stored file.
  async function removeVisual(link) {
    if (!sel?.id || !link?.id) return;
    if (!window.confirm("Remove this figure from the question?")) return;
    const token = session.access_token;
    const asset = link.visual_assets;
    setUploadBusy(true); setUploadMsg("");
    try {
      const ld = await fetch(`${REST}/question_visual_assets?id=eq.${encodeURIComponent(link.id)}`, { method: "DELETE", headers: { ...hdr(token), Prefer: "return=minimal" } });
      if (!ld.ok) throw new Error(await ld.text());
      if (asset?.id) {
        await fetch(`${REST}/visual_assets?id=eq.${encodeURIComponent(asset.id)}`, { method: "DELETE", headers: { ...hdr(token), Prefer: "return=minimal" } });
        if (asset.storage_path && !/^https?:\/\//i.test(asset.storage_path)) {
          await fetch(`${STORAGE_API}/${asset.storage_path.replace(/^\/+/, "")}`, { method: "DELETE", headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
        }
      }
      await refreshVisuals(sel.id);
      setUploadMsg("Figure removed.");
    } catch (e) {
      setUploadMsg("Error: " + (e?.message || String(e)));
    } finally {
      setUploadBusy(false);
    }
  }

  async function deleteQuestion() {
    if (!sel?.id) return;
    const label = sel.question_text ? sel.question_text.slice(0, 80) : sel.id;
    if (!window.confirm(`Delete this question permanently?\n\n${label}`)) return;

    setDeleting(true);
    setMsg("");
    const id = encodeURIComponent(sel.id);
    const h = hdr(session.access_token);
    try {
      const linkDeletes = [
        fetch(`${REST}/diagnostic_template_questions?question_id=eq.${id}`, { method: "DELETE", headers: { ...h, Prefer: "return=minimal" } }),
        fetch(`${REST}/question_visual_assets?question_id=eq.${id}`, { method: "DELETE", headers: { ...h, Prefer: "return=minimal" } }),
      ];
      const linkResults = await Promise.all(linkDeletes);
      const failedLink = linkResults.find(r => !r.ok);
      if (failedLink) throw new Error(await failedLink.text());

      const r = await fetch(`${REST}/questions?id=eq.${id}`, {
        method: "DELETE",
        headers: { ...h, Prefer: "return=minimal" },
      });
      if (!r.ok) throw new Error(await r.text());

      setQuestions(prev => prev.filter(q => q.id !== sel.id));
      setSelectedIds(prev => {
        const next = new Set(prev);
        next.delete(sel.id);
        return next;
      });
      setVisualMap(prev => {
        const next = { ...prev };
        delete next[sel.id];
        return next;
      });
      setTotal(prev => Math.max(0, prev - 1));
      setSel(null);
      setEditing(false);
      await fetchQ();
      await loadMeta();
    } catch (e) {
      setMsg("Error: " + e.message);
    }
    setDeleting(false);
  }

  // Merge live question taxonomy with the saved classification taxonomy so newly
  // created (still empty) categories are selectable in the bank right away.
  const bankSubjects = [...new Set([...Object.keys(stats?.bySub || {}), ...classOpts.subjects].filter(Boolean))].sort();
  const bankTopics = [...new Set([...opts.topics, ...classOpts.topics])];
  const bankSubtopics = [...new Set([...opts.subtopics, ...classOpts.subtopics])];
  const fTopics = [...new Set(bankTopics.filter(t => filters.subject === "all" || t.startsWith(filters.subject + "|||")).map(t => t.split("|||")[1]))].sort();
  const fSubs = [...new Set(bankSubtopics.filter(s => {
    const p = s.split("|||");
    return (filters.subject === "all" || p[0] === filters.subject) && (filters.topic === "all" || p[1] === filters.topic);
  }).map(s => s.split("|||")[2]))].sort();
  const selectedCount = selectedIds.size;
  const selectedSubject = moveForm.subject === "__custom" ? moveForm.customSubject.trim() : moveForm.subject;
  const selectedTopic = moveForm.topic === "__custom" ? moveForm.customTopic.trim() : moveForm.topic;
  const selectedSubtopic = moveForm.subtopic === "__custom" ? moveForm.customSubtopic.trim() : moveForm.subtopic;
  const editSubjectOptions = [...new Set([...classOpts.subjects, form.subject].filter(Boolean))].sort();
  const editTopicOptions = [...new Set([
    ...classOpts.topics
      .map(t => t.split("|||"))
      .filter(p => !form.subject || p[0] === form.subject)
      .map(p => p[1])
      .filter(Boolean),
    form.topic,
  ].filter(Boolean))].sort();
  const editSubtopicOptions = [...new Set([
    ...classOpts.subtopics
      .map(s => s.split("|||"))
      .filter(p => (!form.subject || p[0] === form.subject) && (!form.topic || !p[1] || p[1] === form.topic))
      .map(p => p[2])
      .filter(Boolean),
    form.subtopic,
  ].filter(Boolean))].sort();
  const moveTopics = [...new Set(classOpts.topics
    .filter(t => selectedSubject && t.startsWith(selectedSubject + "|||"))
    .map(t => t.split("|||")[1]))];
  const moveSubtopics = [...new Set(classOpts.subtopics
    .filter(s => {
      const p = s.split("|||");
      return selectedSubject && selectedTopic && p[0] === selectedSubject && p[1] === selectedTopic;
    })
    .map(s => s.split("|||")[2]))];
  const pageSelected = questions.length > 0 && questions.every(q => selectedIds.has(q.id));
  const pages = Math.ceil(total / PS);
  function setF(k, v) {
    const n = { ...filters, [k]: v };
    if (k === "subject") { n.topic = "all"; n.subtopic = "all"; }
    if (k === "topic") n.subtopic = "all";
    setFilters(n); setPage(0);
  }
  function setMoveField(k, v) {
    setBulkMsg("");
    setMoveForm(prev => {
      const next = { ...prev, [k]: v };
      if (k === "subject") {
        next.topic = "";
        next.subtopic = "";
        next.customTopic = "";
        next.customSubtopic = "";
      }
      if (k === "topic") {
        next.subtopic = "";
        next.customSubtopic = "";
      }
      return next;
    });
  }
  function toggleQ(qid) {
    setBulkMsg("");
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(qid)) next.delete(qid);
      else next.add(qid);
      return next;
    });
  }
  function selectPage() {
    setBulkMsg("");
    setSelectedIds(prev => {
      const next = new Set(prev);
      questions.forEach(q => next.add(q.id));
      return next;
    });
  }
  function clearSelection() {
    setBulkMsg("");
    setSelectedIds(new Set());
  }
  async function moveSelected() {
    const subject = selectedSubject;
    const topic = selectedTopic;
    const subtopic = selectedSubtopic;
    if (!selectedCount) return;
    if (!subject || !topic) {
      setBulkMsg("Choose a subject and topic before moving questions.");
      return;
    }
    const label = `${subject} > ${topic}${subtopic ? ` > ${subtopic}` : ""}`;
    if (!window.confirm(`Move ${selectedCount} question${selectedCount === 1 ? "" : "s"} to ${label}?`)) return;

    setMoveBusy(true);
    setBulkMsg("");
    const ids = [...selectedIds];
    const body = { subject, topic, subtopic: subtopic || null };

    const token = session.access_token;
    try {
      for (const id of ids) {
        const r = await fetch(`${REST}/questions?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { ...hdr(token), Prefer: "return=minimal" },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(await r.text());
      }
      setBulkMsg(`Moved ${selectedCount} question${selectedCount === 1 ? "" : "s"} to ${label}.`);
      setSelectedIds(new Set());
      await fetchQ();
      await loadMeta();
    } catch (e) {
      setBulkMsg("Error: " + e.message);
    }
    setMoveBusy(false);
  }

  async function setDifficultySelected() {
    if (!selectedCount || !bulkDifficulty) return;
    if (!window.confirm(`Set ${selectedCount} question${selectedCount === 1 ? "" : "s"} to ${bulkDifficulty}?`)) return;
    setMoveBusy(true);
    setBulkMsg("");
    const ids = [...selectedIds];
    const diff = bulkDifficulty;
    const token = session.access_token;
    try {
      for (const id of ids) {
        const r = await fetch(`${REST}/questions?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { ...hdr(token), Prefer: "return=minimal" },
          body: JSON.stringify({ difficulty_level: diff }),
        });
        if (!r.ok) throw new Error(await r.text());
      }
      setBulkMsg(`Set ${selectedCount} question${selectedCount === 1 ? "" : "s"} to ${diff}.`);
      setSelectedIds(new Set());
      setBulkDifficulty("");
      await fetchQ();
    } catch (e) {
      setBulkMsg("Error: " + e.message);
    }
    setMoveBusy(false);
  }

  async function exportQuestions() {
    setBulkMsg("");
    setExportBusy(true);

    const token = session.access_token;
    const selected = selectedCount > 0;

    try {
      let rows = [];

      if (selected) {
        const ids = [...selectedIds];
        const order = new Map(ids.map((id, index) => [id, index]));
        const chunkSize = 100;
        for (let i = 0; i < ids.length; i += chunkSize) {
          const chunk = ids.slice(i, i + chunkSize);
          const r = await fetch(
            `${REST}/questions?id=in.(${chunk.map(encodeURIComponent).join(",")})&select=*`,
            { headers: { ...hdr(token), Prefer: "count=exact" } }
          );
          if (!r.ok) throw new Error(await r.text());
          const batch = await r.json();
          rows.push(...batch);
        }
        rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      } else {
        const pageSize = 1000;
        let offset = 0;
        while (true) {
          const p = buildQuestionQuery(filters, search, offset, pageSize);
          const r = await fetch(`${REST}/questions?${p}`, { headers: { ...hdr(token), Prefer: "count=exact" } });
          if (!r.ok) throw new Error(await r.text());
          const batch = await r.json();
          rows.push(...batch);
          if (batch.length < pageSize) break;
          offset += batch.length;
        }
      }

      if (!rows.length) {
        setBulkMsg("No questions to export.");
        return;
      }

      // Fetch and join stimulus (passage) data for reading questions
      let extraColumns = [];
      const stimulusIds = [...new Set(rows.map((r) => r.stimulus_id).filter(Boolean))];
      if (stimulusIds.length) {
        const stimuliMap = new Map();
        for (let i = 0; i < stimulusIds.length; i += 100) {
          const chunk = stimulusIds.slice(i, i + 100);
          const sr = await fetch(
            `${REST}/stimuli?id=in.(${chunk.map(encodeURIComponent).join(",")})&select=id,stimulus_title,stimulus_type,stimulus_text`,
            { headers: hdr(token) }
          );
          if (!sr.ok) throw new Error(await sr.text());
          (await sr.json()).forEach((s) => stimuliMap.set(s.id, s));
        }
        rows = rows.map((row) => {
          if (!row.stimulus_id) return row;
          const stim = stimuliMap.get(row.stimulus_id);
          return {
            ...row,
            stimulus_title: stim?.stimulus_title ?? "",
            stimulus_type: stim?.stimulus_type ?? "",
            stimulus_text: stim?.stimulus_text ?? "",
          };
        });
        extraColumns = STIMULUS_CSV_COLUMNS;
      }

      // Fetch and resolve visual assets (only needed for Word/PDF)
      if (exportFormat !== "csv") {
        rows = await resolveQuestionVisuals(rows, { REST, STORAGE, hdr, token });
      }

      const stamp = new Date().toISOString().slice(0, 10);
      const scope = selected ? `selected-${rows.length}` : `filtered-${rows.length}`;
      const base = `question-bank-${scope}-${stamp}`;

      if (exportFormat === "csv") {
        downloadTextFile(`${base}.csv`, questionsToCsv(rows, extraColumns), "text/csv;charset=utf-8;");
      } else if (exportFormat === "docx") {
        const blob = await questionsToDocx(rows);
        downloadBlob(`${base}.docx`, blob);
      } else {
        const html = generateQuestionsHtml(rows);
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        const url = window.URL.createObjectURL(blob);
        window.open(url, "_blank");
        // print is triggered by window.onload inside the HTML itself
        setTimeout(() => window.URL.revokeObjectURL(url), 60000);
      }

      const fmt = exportFormat === "pdf" ? "PDF" : exportFormat.toUpperCase();
      setBulkMsg(`Exported ${rows.length} question${rows.length === 1 ? "" : "s"} to ${fmt}.`);
    } catch (e) {
      setBulkMsg("Error: " + e.message);
    }

    setExportBusy(false);
  }

  // ═══════════════════════════════════════════════════════════════
  // BULK CSV IMPORT
  // ═══════════════════════════════════════════════════════════════
  // Two phases, deliberately: parse+validate writes nothing and runs entirely
  // in the browser (src/questionImport.js), so the operator sees every problem
  // before a single row reaches the database. commitImport is the only part
  // that writes, and only for rows that came back clean.

  function runImportPreview(text, fileName, forceDraft) {
    const result = prepareQuestionImport(text, {
      forceDraft,
      knownSubjects: bankSubjects,
      knownTopics: [...new Set(bankTopics.map(t => t.split("|||")[1]).filter(Boolean))],
      knownSubtopics: [...new Set(bankSubtopics.map(st => st.split("|||")[2]).filter(Boolean))],
    });
    setImportPreview({ ...result, text, fileName });
  }

  async function handleImportFile(file) {
    if (!file) return;
    setBulkMsg("");
    setImportResult(null);
    try {
      const text = await file.text();
      runImportPreview(text, file.name, importDraftOnly);
    } catch (e) {
      setBulkMsg("Error: could not read that file — " + e.message);
    }
  }

  function closeImport() {
    setImportPreview(null);
    setImportResult(null);
  }

  async function commitImport() {
    if (!importPreview?.ok || importBusy) return;
    if (!importPreview.summary.ready) return;

    setImportBusy(true);
    setBulkMsg("");

    const result = await commitQuestionImport(importPreview.rows, {
      rest: REST,
      headers: hdr(session.access_token),
    });

    setImportResult(result);
    setImportPreview(prev => (prev ? { ...prev, rows: [], committed: true } : prev));
    const parts = [];
    if (result.inserted) parts.push(`${result.inserted} created`);
    if (result.updated) parts.push(`${result.updated} updated`);
    if (result.failed) parts.push(`${result.failed} failed`);
    setBulkMsg(parts.length ? `Import: ${parts.join(", ")}.` : "Import wrote nothing.");
    setImportBusy(false);
    await Promise.all([fetchQ(), loadMeta()]);
  }

  const dc = { easy: "#22c55e", medium: "#eab308", hard: "#ef4444" };
  const sc = { active: "#3b82f6", retired: "#64748b", draft: "#a855f7", needs_human_review: "#f97316" };

  // ── LOGIN ──
  if (authLd) return <div style={css.page}><p style={{ color: "#94a3b8" }}>Loading...</p></div>;
  if (!session) return (
    <div style={css.page}>
      <div style={css.loginCard}>
        <h1 style={{ color: "#f8fafc", fontSize: 22, margin: "0 0 4px" }}>Question Bank</h1>
        <p style={{ color: "#64748b", fontSize: 13, margin: "0 0 24px" }}>Sign in to manage questions.</p>
        <label style={css.label}>Email</label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@example.com" style={css.inp}
          onKeyDown={e => { if (e.key === "Enter") document.getElementById("_pw")?.focus(); }} />
        <label style={{ ...css.label, marginTop: 14 }}>Password</label>
        <input id="_pw" type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="••••••••" style={css.inp}
          onKeyDown={e => { if (e.key === "Enter") document.getElementById("_go")?.click(); }} />
        <button id="_go" disabled={authBusy || !email || !pw} onClick={async () => {
          setAuthBusy(true); setAuthErr("");
          try { await login(email, pw); } catch (e) { setAuthErr(e.message); }
          setAuthBusy(false);
        }} style={{ ...css.btn, marginTop: 20, width: "100%", opacity: authBusy ? 0.6 : 1 }}>
          {authBusy ? "Signing in..." : "Sign In"}
        </button>
        {authErr && <p style={{ color: "#ef4444", fontSize: 13, marginTop: 10 }}>{authErr}</p>}
      </div>
    </div>
  );

  // ── DETAIL MODAL ──
  const modal = sel && (
    <div style={css.overlay} onClick={() => { setSel(null); setEditing(false); }}>
      <div style={css.modal} onClick={e => e.stopPropagation()}>
        <button onClick={() => { setSel(null); setEditing(false); }} style={css.closeBtn}>✕</button>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          <Badge c={dc[sel.difficulty_level]}>{sel.difficulty_level}</Badge>
          <Badge c={sc[sel.status]}>{sel.status}</Badge>
        </div>

        <p style={{ color: "#64748b", fontSize: 12, margin: "0 0 16px" }}>
          <span style={{ color: "#f59e0b", fontWeight: 600 }}>{sel.subject}</span>
          <span style={{ color: "#334155" }}> → </span>
          <span style={{ color: "#94a3b8" }}>{sel.topic}</span>
          <span style={{ color: "#334155" }}> → </span>
          <span style={{ color: "#94a3b8" }}>{sel.subtopic}</span>
        </p>

        <div style={{ overflow: "auto", maxHeight: "calc(90vh - 120px)", paddingRight: 4 }}>
          {/* Instruction */}
          {sel._inst && (
            <div style={css.block}>
              <div style={css.bLabel}>Instruction — {sel._inst.code}</div>
              <MathContent value={sel._inst.instruction_text} subject={sel.subject} style={{ color: "#94a3b8", fontSize: 13, lineHeight: 1.6 }} />
            </div>
          )}

          {/* Stimulus / Passage */}
          {sel._stim && (
            <div style={{ ...css.block, maxHeight: 280, overflow: "auto" }}>
              <div style={css.bLabel}>
                Passage — {sel._stim.stimulus_type}
                {sel._stim.stimulus_title && ` — ${sel._stim.stimulus_title}`}
              </div>
              <MathContent value={sel._stim.stimulus_text} subject={sel.subject} style={{ color: "#cbd5e1", fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap" }} />
            </div>
          )}

          {/* Figures shown while viewing; upload / manage lives at the bottom of Edit mode */}
          {!editing && sel._vis?.length > 0 && (
            <div style={css.block}>
              <div style={css.bLabel}>Figures ({sel._vis.length})</div>
              <VisualAssetPreview assets={sel._vis} storageBase={STORAGE} />
            </div>
          )}

          {!editing ? (
            <>
              {/* Inline / visualMap visuals for questions that carry SVG data directly */}
              {!sel._vis?.length && visualMap[sel.id]?.length > 0 && (
                <VisualAssetPreview assets={visualMap[sel.id]} storageBase={STORAGE} />
              )}
              <VisualAssetPreview assets={questionInlineVisualAssets(sel)} storageBase={STORAGE} />

              {/* QUESTION DISPLAY */}
              {sel.render_markup ? (
                <div style={{ marginBottom: 16, textAlign: "center" }}>
                  <div style={{ ...css.bLabel, marginBottom: 8 }}>Question (segments highlighted by answer choice)</div>
                  <SegMarkup markup={sel.render_markup} correctAnswer={sel.correct_answer} />
                </div>
              ) : (
                <div style={{ marginBottom: 16, textAlign: "center" }}>
                  <QuestionWithUnderline
                    text={sel.question_text}
                    choiceA={sel.choice_a}
                    subject={sel.subject}
                    style={{ fontSize: 16, color: "#f1f5f9", lineHeight: 1.7, fontWeight: 500, textAlign: "center" }}
                  />
                </div>
              )}

              {/* CHOICES */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 20 }}>
                {["a", "b", "c", "d", "e"].map(l => {
                  const txt = sel[`choice_${l}`];
                  if (!txt) return null;
                  const ok = sel.correct_answer === l;
                  return (
                    <div key={l} style={{
                      display: "flex", alignItems: "flex-start", gap: 10,
                      padding: "10px 14px", borderRadius: 8,
                      background: ok ? "#16a34a12" : "#0a0f1a",
                      border: ok ? "1px solid #16a34a30" : "1px solid #1a2236",
                    }}>
                      <span style={{
                        width: 24, height: 24, borderRadius: "50%", flexShrink: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 11, fontWeight: 700,
                        background: ok ? "#16a34a" : "#1e293b", color: ok ? "#fff" : "#64748b",
                      }}>{l.toUpperCase()}</span>
                      <span style={{ color: ok ? "#4ade80" : "#cbd5e1", fontSize: 14, lineHeight: 1.5, paddingTop: 2 }}>
                        <ChoiceContent value={txt} subject={sel.subject} />
                      </span>
                    </div>
                  );
                })}
              </div>

              <div style={{ fontSize: 10, color: "#1e293b", fontFamily: "monospace", marginBottom: 16, wordBreak: "break-all" }}>{sel.id}</div>
              <button onClick={() => setEditing(true)} style={css.btn}>Edit Question</button>
            </>
          ) : (
            /* EDIT MODE */
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Inp label="Question Text" value={form.question_text} multi onChange={v => setForm({ ...form, question_text: v })} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Sel label="Difficulty" value={form.difficulty_level} opts={["easy", "medium", "hard"]} onChange={v => setForm({ ...form, difficulty_level: v })} />
                <Sel label="Status" value={form.status} opts={["active", "retired", "draft", "needs_human_review"]} onChange={v => setForm({ ...form, status: v })} />
                <Sel label="Correct Answer" value={form.correct_answer} opts={["a", "b", "c", "d", "e"]} onChange={v => setForm({ ...form, correct_answer: v })} />
              </div>
              <Combo label="Subject" value={form.subject || ""} opts={editSubjectOptions} placeholder="Pick an existing subject or type a new one" onChange={v => setForm({ ...form, subject: v })} />
              <Combo label="Topic" value={form.topic || ""} opts={editTopicOptions} placeholder="Pick an existing topic or type a new one" onChange={v => setForm({ ...form, topic: v })} />
              <Combo label="Subtopic" value={form.subtopic || ""} opts={editSubtopicOptions} placeholder="Pick an existing subtopic or type a new one" onChange={v => setForm({ ...form, subtopic: v })} />
              {["a", "b", "c", "d", "e"].map(l => (
                <Inp key={l} label={`Choice ${l.toUpperCase()}${l === "e" ? " (optional)" : ""}`}
                  value={form[`choice_${l}`]} onChange={v => setForm({ ...form, [`choice_${l}`]: v })} />
              ))}
              <Inp label="Render Markup (optional)" value={form.render_markup} multi onChange={v => setForm({ ...form, render_markup: v })} />
              {sel._inst && (
                <>
                  <Inp label="Instruction Code" value={form.instruction_code} onChange={v => setForm({ ...form, instruction_code: v })} />
                  <Inp label="Instruction Text" value={form.instruction_text} multi onChange={v => setForm({ ...form, instruction_text: v })} />
                </>
              )}
              {sel._stim && (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <Inp label="Passage Type" value={form.stimulus_type} onChange={v => setForm({ ...form, stimulus_type: v })} />
                    <Inp label="Passage Title" value={form.stimulus_title} onChange={v => setForm({ ...form, stimulus_title: v })} />
                  </div>
                  <Inp label="Passage Text" value={form.stimulus_text} multi onChange={v => setForm({ ...form, stimulus_text: v })} />
                </>
              )}

              {/* Figures / Visual Assets — upload any format; stays attached to the question */}
              <div style={css.block}>
                <div style={css.bLabel}>Figures{sel._vis?.length ? ` (${sel._vis.length})` : ""}</div>
                {sel._vis?.length > 0 && (
                  <>
                    <VisualAssetPreview assets={sel._vis} storageBase={STORAGE} />
                    {sel._vis.map(v => {
                      const a = v.visual_assets;
                      return (
                        <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid #1a2236" }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, color: "#94a3b8" }}>
                              <span style={{ fontWeight: 500, color: "#e2e8f0" }}>{a?.asset_key}</span> — {a?.asset_type}
                            </div>
                            <div style={{ fontSize: 11, color: "#334155", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a?.storage_path}</div>
                            {a?.alt_text && <div style={{ fontSize: 11, color: "#475569", fontStyle: "italic" }}>Alt: {a.alt_text}</div>}
                          </div>
                          <button onClick={() => removeVisual(v)} disabled={uploadBusy}
                            style={{ padding: "4px 10px", fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: uploadBusy ? "default" : "pointer", background: "#7f1d1d", border: "1px solid #b91c1c", color: "#fee2e2", opacity: uploadBusy ? 0.6 : 1 }}>
                            Remove
                          </button>
                        </div>
                      );
                    })}
                  </>
                )}

                <div style={{ marginTop: sel._vis?.length ? 12 : 0, display: "flex", flexDirection: "column", gap: 8 }}>
                  <input
                    type="text"
                    value={uploadAlt}
                    onChange={e => setUploadAlt(e.target.value)}
                    placeholder="Alt text / caption (optional)"
                    disabled={uploadBusy}
                    style={{ padding: "9px 12px", background: "#0a0f1a", border: "1px solid #1e293b", borderRadius: 6, color: "#e2e8f0", fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box", fontFamily: "inherit" }}
                  />
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <input
                      ref={fileRef}
                      type="file"
                      disabled={uploadBusy}
                      onChange={e => { const f = e.target.files?.[0]; if (f) uploadVisual(f); e.target.value = ""; }}
                      style={{ fontSize: 12, color: "#94a3b8" }}
                    />
                    {uploadBusy && <span style={{ fontSize: 12, color: "#f59e0b" }}>Uploading…</span>}
                  </div>
                  <div style={{ fontSize: 11, color: "#475569" }}>
                    Any format — image (JPG/PNG/WebP/GIF), SVG, PDF, video, audio, or other files. The figure is stored and stays attached to this question, displayed like generated diagrams.
                  </div>
                  {uploadMsg && <p style={{ color: uploadMsg.startsWith("Error") ? "#ef4444" : "#22c55e", fontSize: 12, margin: 0 }}>{uploadMsg}</p>}
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button onClick={save} disabled={saving} style={{ ...css.btn, background: "#16a34a", opacity: saving ? 0.6 : 1 }}>
                  {saving ? "Saving..." : "Save Changes"}
                </button>
                <button onClick={() => { setEditing(false); setMsg(""); }}
                  disabled={saving || deleting}
                  style={{ ...css.btn, background: "transparent", border: "1px solid #334155", color: "#94a3b8", opacity: saving || deleting ? 0.6 : 1 }}>Cancel</button>
                <button onClick={deleteQuestion} disabled={saving || deleting}
                  style={{ ...css.btn, background: "#7f1d1d", border: "1px solid #b91c1c", color: "#fee2e2", marginLeft: "auto", opacity: saving || deleting ? 0.6 : 1 }}>
                  {deleting ? "Deleting..." : "Delete Question"}
                </button>
              </div>
              {msg && <p style={{ color: msg.startsWith("E") ? "#ef4444" : "#22c55e", fontSize: 13, margin: 0 }}>{msg}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // ── IMPORT PREVIEW MODAL ──
  // Dry run: everything shown here is computed locally and nothing has been
  // written yet. "Blocked" rows are skipped entirely; the rest go up on confirm.
  const importIssueRows = (importPreview?.rows || []).filter(r => r.errors.length || r.warnings.length);
  const importModal = importPreview && (
    <div style={css.overlay} onClick={() => { if (!importBusy) closeImport(); }}>
      <div style={{ ...css.modal, width: 760 }} onClick={e => e.stopPropagation()}>
        <button onClick={closeImport} disabled={importBusy}
          style={{ ...css.closeBtn, opacity: importBusy ? 0.4 : 1 }}>x</button>

        <h2 style={{ fontSize: 17, margin: "0 40px 2px 0", color: "#f1f5f9" }}>
          {importResult ? "Import finished" : "Import questions from CSV"}
        </h2>
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 14 }}>
          {importPreview.fileName}
          {importPreview.delimiter === "\t" ? " — tab-separated" : importPreview.delimiter === ";" ? " — semicolon-separated" : ""}
        </div>

        <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
          {importResult ? (
            <div style={css.block}>
              <div style={{ fontSize: 13, color: "#e2e8f0", marginBottom: 8 }}>
                <strong style={{ color: "#22c55e" }}>{importResult.inserted}</strong> created ·{" "}
                <strong style={{ color: "#38bdf8" }}>{importResult.updated}</strong> updated ·{" "}
                <strong style={{ color: importResult.failed ? "#ef4444" : "#475569" }}>{importResult.failed}</strong> failed
              </div>
              {importResult.inserted > 0 && (
                <p style={{ fontSize: 12, color: "#94a3b8", margin: "0 0 8px" }}>
                  New questions were saved as drafts. Filter Status = draft to review and activate them.
                </p>
              )}
              {importResult.log.map((line, i) => (
                <div key={i} style={{ fontSize: 11, color: "#fca5a5", fontFamily: "monospace", marginBottom: 4, wordBreak: "break-word" }}>{line}</div>
              ))}
            </div>
          ) : importPreview.fatal ? (
            <div style={{ ...css.block, borderColor: "#7f1d1d" }}>
              <div style={{ color: "#fca5a5", fontSize: 13 }}>{importPreview.fatal}</div>
              <p style={{ fontSize: 12, color: "#64748b", margin: "10px 0 0" }}>
                Export a subject to CSV to see the exact column names this reads, or download the blank template below.
              </p>
            </div>
          ) : (
            <>
              <div style={{ ...css.block, display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
                <Stat label="rows" value={importPreview.summary.total} color="#cbd5e1" />
                <Stat label="new questions" value={importPreview.summary.inserts} color="#22c55e" />
                <Stat label="updates" value={importPreview.summary.updates} color="#38bdf8" />
                <Stat label="blocked" value={importPreview.summary.blocked} color={importPreview.summary.blocked ? "#ef4444" : "#475569"} />
                <Stat label="warnings" value={importPreview.summary.withWarnings} color={importPreview.summary.withWarnings ? "#f59e0b" : "#475569"} />
              </div>

              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#94a3b8", marginBottom: 12, cursor: "pointer" }}>
                <input type="checkbox" checked={importDraftOnly} disabled={importBusy}
                  onChange={e => { setImportDraftOnly(e.target.checked); runImportPreview(importPreview.text, importPreview.fileName, e.target.checked); }} />
                New questions land as drafts (recommended — nothing reaches students until a human activates it)
              </label>

              {importPreview.unknownHeaders.length > 0 && (
                <div style={{ fontSize: 11, color: "#f59e0b", marginBottom: 10 }}>
                  Ignored unrecognized column{importPreview.unknownHeaders.length === 1 ? "" : "s"}: {importPreview.unknownHeaders.join(", ")}
                </div>
              )}

              {importIssueRows.length === 0 ? (
                <div style={{ fontSize: 12, color: "#22c55e" }}>Every row passed validation.</div>
              ) : (
                <div style={css.block}>
                  <div style={css.bLabel}>Rows needing attention</div>
                  {importIssueRows.slice(0, 100).map(r => (
                    <div key={r.row} style={{ borderTop: "1px solid #1a2236", padding: "7px 0" }}>
                      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>
                        Row {r.row} · {r.errors.length ? "skipped" : r.action === "update" ? "update" : "new"}
                        {r.payload.question_text ? ` · ${r.payload.question_text.slice(0, 70)}${r.payload.question_text.length > 70 ? "..." : ""}` : ""}
                      </div>
                      {r.errors.map((err, i) => (
                        <div key={`e${i}`} style={{ fontSize: 12, color: "#fca5a5" }}>· {err}</div>
                      ))}
                      {r.warnings.map((warn, i) => (
                        <div key={`w${i}`} style={{ fontSize: 12, color: "#fbbf24" }}>· {warn}</div>
                      ))}
                    </div>
                  ))}
                  {importIssueRows.length > 100 && (
                    <div style={{ fontSize: 11, color: "#64748b", paddingTop: 8 }}>
                      ...and {importIssueRows.length - 100} more rows with issues.
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14, flexShrink: 0 }}>
          {!importResult && importPreview.ok && (
            <button onClick={commitImport} disabled={importBusy || importPreview.summary.ready === 0}
              style={{ ...css.btn, background: "#16a34a", opacity: importBusy || importPreview.summary.ready === 0 ? 0.55 : 1 }}>
              {importBusy
                ? "Importing..."
                : `Import ${importPreview.summary.ready} row${importPreview.summary.ready === 1 ? "" : "s"}`}
            </button>
          )}
          <button onClick={closeImport} disabled={importBusy}
            style={{ ...css.btn, background: "transparent", border: "1px solid #334155", color: "#94a3b8", opacity: importBusy ? 0.6 : 1 }}>
            {importResult ? "Close" : "Cancel"}
          </button>
          {!importResult && (
            <button onClick={() => downloadTextFile("question-import-template.csv", importTemplateCsv(), "text/csv;charset=utf-8;")}
              style={{ ...css.ghost, marginLeft: "auto" }}>
              Download blank template
            </button>
          )}
        </div>
      </div>
    </div>
  );

  // ── MAIN DASHBOARD ──
  return (
    <div style={css.shell}>
      {modal}
      {view === "bank" && importModal}
      {view === "bank" && bankCreateOpen && (
        <CategoryCreateModal
          session={session}
          rest={REST}
          headers={hdr}
          subjects={bankSubjects}
          fixed={{ kind: "subject", subject: filters.subject !== "all" ? filters.subject : "" }}
          onClose={() => setBankCreateOpen(false)}
          onCreated={async () => { await Promise.all([loadMeta(), loadClassOpts()]); }}
        />
      )}
      {view === "bank" && bankAddQOpen && (
        <AddQuestionsModal
          scope={{ subject: filters.subject !== "all" ? filters.subject : "", topic: filters.topic !== "all" ? filters.topic : "", subtopic: filters.subtopic !== "all" ? filters.subtopic : "" }}
          taxonomy={{ topics: bankTopics, subtopics: bankSubtopics }}
          subjects={bankSubjects}
          session={session}
          rest={REST}
          headers={hdr}
          onClose={() => setBankAddQOpen(false)}
          onChanged={async () => { await Promise.all([fetchQ(), loadMeta(), loadClassOpts()]); }}
          onGenerateAI={(scope) => { setBankAddQOpen(false); setRequestedScope(scope); setView("generator"); }}
        />
      )}

      <header style={css.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ color: "#f59e0b", fontWeight: 800, fontSize: 14, letterSpacing: -0.3 }}>PLATFORM</span>
          <div style={{ display: "flex", gap: 2 }}>
            <button onClick={() => setView("bank")} style={{
              padding: "5px 12px", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer",
              background: view === "bank" ? "#1a2236" : "transparent",
              color: view === "bank" ? "#f1f5f9" : "#475569",
            }}>
              Question Bank
              {stats && <span style={{ fontSize: 10, marginLeft: 6, color: "#334155" }}>{stats.total.toLocaleString()}</span>}
            </button>
            <button onClick={() => setView("builder")} style={{
              padding: "5px 12px", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer",
              background: view === "builder" ? "#1a2236" : "transparent",
              color: view === "builder" ? "#f1f5f9" : "#475569",
            }}>
              Exam Builder
            </button>
            <button onClick={() => setView("quizzes")} style={{
              padding: "5px 12px", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer",
              background: view === "quizzes" ? "#1a2236" : "transparent",
              color: view === "quizzes" ? "#f1f5f9" : "#475569",
            }}>
              Quizzes
            </button>
            <button onClick={() => setView("results")} style={{
              padding: "5px 12px", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer",
              background: view === "results" ? "#1a2236" : "transparent",
              color: view === "results" ? "#f1f5f9" : "#475569",
            }}>
              Results
            </button>
            <button onClick={() => setView("categories")} style={{
              padding: "5px 12px", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer",
              background: view === "categories" ? "#1a2236" : "transparent",
              color: view === "categories" ? "#f1f5f9" : "#475569",
            }}>
              Categories
            </button>
            <button onClick={() => setView("generator")} style={{
              padding: "5px 12px", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer",
              background: view === "generator" ? "#1a2236" : "transparent",
              color: view === "generator" ? "#f1f5f9" : "#475569",
            }}>
              AI Generator
            </button>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "#475569", fontSize: 12 }}>{session.user?.email}</span>
          <button onClick={logout} style={css.ghost}>Sign out</button>
        </div>
      </header>

      {view === "builder" && <ExamBuilder session={session} />}
      {view === "quizzes" && <QuizBuilder session={session} />}
      {view === "results" && <ResultsExport session={session} rest={REST} />}

      {view === "categories" && (
        <CategoryManager
          session={session}
          rest={REST}
          headers={hdr}
          classOpts={classOpts}
          fallbackOpts={opts}
          counts={catCounts}
          onChanged={async () => { await Promise.all([loadMeta(), loadClassOpts()]); }}
          onGenerateAI={(scope) => { setRequestedScope(scope); setView("generator"); }}
        />
      )}

      {view === "generator" && (
        <QuestionGenerator
          gen={gen}
          liveOpts={liveDiagnosticOpts}
          classOpts={classOpts}
          fallbackOpts={opts}
          requestedScope={requestedScope}
          onScopeConsumed={() => setRequestedScope(null)}
          onUploaded={() => { fetchQ(); loadMeta(); }}
        />
      )}

      {view === "bank" && <>
      {stats && (
        <div style={css.tabs}>
          <button onClick={() => setF("subject", "all")}
            style={{ ...css.tab, borderColor: filters.subject === "all" ? "#f59e0b" : "transparent", color: filters.subject === "all" ? "#f1f5f9" : "#475569" }}>
            All ({stats.total})
          </button>
          {bankSubjects.map(s => (
            <button key={s} onClick={() => setF("subject", s)}
              style={{ ...css.tab, borderColor: filters.subject === s ? "#f59e0b" : "transparent", color: filters.subject === s ? "#f1f5f9" : "#475569" }}>
              {s} ({stats.bySub[s] || 0})
            </button>
          ))}
        </div>
      )}

      {/* Filters */}
      <div style={css.filterRow}>
        <input type="text" placeholder="Search stems, choices, or paste question ID..." value={search}
          onChange={e => { setSearch(e.target.value); clearTimeout(tmr.current); tmr.current = setTimeout(() => setPage(0), 400); }}
          style={{ ...css.inp, width: 220, padding: "7px 12px", fontSize: 13, marginTop: 0 }} />
        <DD l="Topic" v={filters.topic} o={fTopics} c={v => setF("topic", v)} />
        <DD l="Subtopic" v={filters.subtopic} o={fSubs} c={v => setF("subtopic", v)} />
        <DD l="Difficulty" v={filters.difficulty_level} o={["easy", "medium", "hard"]} c={v => setF("difficulty_level", v)} />
        <DD l="Status" v={filters.status} o={["active", "retired", "draft", "needs_human_review"]} c={v => setF("status", v)} />
        <button onClick={() => setBankCreateOpen(true)}
          style={{ ...css.ghost, borderColor: "#f59e0b", color: "#f59e0b", fontWeight: 600 }}>
          + Add Topic / Subtopic
        </button>
        <button onClick={() => setBankAddQOpen(true)}
          style={{ ...css.ghost, borderColor: "#f59e0b", color: "#f59e0b", fontWeight: 600 }}>
          + Add Questions
        </button>
        <button onClick={selectPage} disabled={questions.length === 0 || pageSelected} style={{ ...css.ghost, opacity: questions.length === 0 || pageSelected ? 0.5 : 1 }}>
          {pageSelected ? "Page selected" : "Select page"}
        </button>
        {selectedCount > 0 && (
          <button onClick={clearSelection} style={css.ghost}>Clear selection ({selectedCount})</button>
        )}
        {Object.values(filters).some(v => v !== "all") && (
          <button onClick={() => { setFilters({ subject: "all", topic: "all", subtopic: "all", source_school: "all", difficulty_level: "all", status: "all" }); setPage(0); }}
            style={css.ghost}>Clear</button>
        )}
        <select
          value={exportFormat}
          onChange={e => setExportFormat(e.target.value)}
          disabled={exportBusy || busy}
          style={{ padding: "5px 8px", background: "#0a0f1a", border: "1px solid #1a2236", borderRadius: 6, color: "#94a3b8", fontSize: 11, outline: "none", cursor: "pointer" }}
        >
          <option value="csv">CSV</option>
          <option value="docx">Word (.docx)</option>
          <option value="pdf">PDF (print)</option>
        </select>
        <button onClick={exportQuestions} disabled={exportBusy || busy || (!selectedCount && total === 0)}
          style={{ ...css.ghost, opacity: exportBusy || busy || (!selectedCount && total === 0) ? 0.5 : 1 }}>
          {exportBusy ? "Exporting..." : selectedCount > 0 ? `Export selected (${selectedCount})` : "Export filtered"}
        </button>
        <input ref={importRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
          style={{ display: "none" }}
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; handleImportFile(f); }} />
        <button onClick={() => importRef.current?.click()} disabled={importBusy || busy}
          style={{ ...css.ghost, borderColor: "#334155", color: "#94a3b8", opacity: importBusy || busy ? 0.5 : 1 }}>
          Import CSV
        </button>
      </div>

      {selectedCount > 0 && (
        <div style={css.bulkBar}>
          <div style={{ color: "#cbd5e1", fontSize: 12, fontWeight: 700, minWidth: 120 }}>
            {selectedCount} selected
          </div>
          <select value={moveForm.subject} onChange={e => setMoveField("subject", e.target.value)} style={css.bulkSelect}>
            <option value="">Move to subject...</option>
            {classOpts.subjects.map(s => <option key={s} value={s}>{s}</option>)}
            <option value="__custom">New subject...</option>
          </select>
          {moveForm.subject === "__custom" && (
            <input value={moveForm.customSubject} onChange={e => setMoveField("customSubject", e.target.value)}
              placeholder="New subject" style={css.bulkInput} />
          )}
          <select value={moveForm.topic} onChange={e => setMoveField("topic", e.target.value)}
            disabled={!selectedSubject} style={{ ...css.bulkSelect, opacity: !selectedSubject ? 0.5 : 1 }}>
            <option value="">Move to topic...</option>
            {moveTopics.map(t => <option key={t} value={t}>{t}</option>)}
            <option value="__custom">New topic...</option>
          </select>
          {moveForm.topic === "__custom" && (
            <input value={moveForm.customTopic} onChange={e => setMoveField("customTopic", e.target.value)}
              placeholder="New topic" style={css.bulkInput} />
          )}
          <select value={moveForm.subtopic} onChange={e => setMoveField("subtopic", e.target.value)}
            disabled={!selectedSubject || !selectedTopic} style={{ ...css.bulkSelect, opacity: !selectedSubject || !selectedTopic ? 0.5 : 1 }}>
            <option value="">No subtopic</option>
            {moveSubtopics.map(st => <option key={st} value={st}>{st}</option>)}
            <option value="__custom">New subtopic...</option>
          </select>
          {moveForm.subtopic === "__custom" && (
            <input value={moveForm.customSubtopic} onChange={e => setMoveField("customSubtopic", e.target.value)}
              placeholder="New subtopic" style={css.bulkInput} />
          )}
          <button onClick={moveSelected} disabled={moveBusy || !selectedSubject || !selectedTopic}
            style={{ ...css.btn, padding: "7px 14px", fontSize: 12, opacity: moveBusy || !selectedSubject || !selectedTopic ? 0.55 : 1 }}>
            {moveBusy ? "Moving..." : "Move selected"}
          </button>
          <span style={{ width: 1, background: "#253048", alignSelf: "stretch", flexShrink: 0 }} />
          <select value={bulkDifficulty} onChange={e => { setBulkDifficulty(e.target.value); setBulkMsg(""); }} style={css.bulkSelect}>
            <option value="">Set difficulty...</option>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
          <button onClick={setDifficultySelected} disabled={moveBusy || !bulkDifficulty}
            style={{ ...css.btn, padding: "7px 14px", fontSize: 12, opacity: moveBusy || !bulkDifficulty ? 0.55 : 1 }}>
            Set difficulty
          </button>
        </div>
      )}

      {bulkMsg && (
        <div style={{ ...css.bulkMsg, color: bulkMsg.startsWith("Error") ? "#ef4444" : "#22c55e" }}>{bulkMsg}</div>
      )}

      {/* Card grid */}
      <div style={css.gridWrap}>
        {busy ? <p style={{ color: "#334155", textAlign: "center", padding: 40 }}>Loading...</p> :
          questions.length === 0 ? <p style={{ color: "#334155", textAlign: "center", padding: 40 }}>No questions match your filters.</p> : (
            <div style={css.grid}>
              {questions.map(q => {
                const checked = selectedIds.has(q.id);
                const qVisuals = [...questionInlineVisualAssets(q), ...(visualMap[q.id] || [])];
                return (
                <div key={q.id} onClick={() => pickQ(q)} style={{ ...css.card, borderColor: checked ? "#f59e0b" : "#1a2236", background: checked ? "#121b2f" : "#0f1629" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = checked ? "#f59e0b" : "#334155"; e.currentTarget.style.transform = "translateY(-1px)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = checked ? "#f59e0b" : "#1a2236"; e.currentTarget.style.transform = "none"; }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input type="checkbox" checked={checked} onChange={() => toggleQ(q.id)}
                        onClick={e => e.stopPropagation()} style={{ accentColor: "#f59e0b", cursor: "pointer" }} />
                      <Badge c={dc[q.difficulty_level]}>{q.difficulty_level}</Badge>
                    </div>
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: "#f59e0b" }}>{q.correct_answer.toUpperCase()}</span>
                      <Badge c={sc[q.status]}>{q.status}</Badge>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: "#475569", marginBottom: 6, lineHeight: 1.4 }}>
                    <span style={{ color: "#64748b", fontWeight: 500 }}>{q.topic}</span>
                    <span style={{ color: "#334155" }}> → </span><span>{q.subtopic}</span>
                  </div>
                  <VisualAssetPreview assets={qVisuals} storageBase={STORAGE} compact />
                  <div style={{
                    fontSize: 13, color: "#cbd5e1", lineHeight: 1.5,
                    display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical",
                    overflow: "hidden", flex: 1, textAlign: "center",
                  }}>
                    <QuestionWithUnderline text={q.question_text} choiceA={q.choice_a} subject={q.subject} style={{ textAlign: "center" }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginTop: 10, paddingTop: 8, borderTop: "1px solid #1a2236" }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      {q.stimulus_id && <span title="Has passage" style={{ fontSize: 12 }}>📄</span>}
                      {q.instruction_id && <span title="Has instruction" style={{ fontSize: 12 }}>📋</span>}
                      {q.render_markup && <span title="Has seg markup" style={{ fontSize: 12 }}>🏷️</span>}
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          )}
      </div>

      {total > 0 && (
        <div style={css.pager}>
          <span style={{ color: "#334155", fontSize: 12 }}>{page * PS + 1}–{Math.min((page + 1) * PS, total)} of {total.toLocaleString()}</span>
          <div style={{ display: "flex", gap: 4 }}>
            <button disabled={page === 0} onClick={() => setPage(p => p - 1)} style={css.pgBtn}>← Prev</button>
            <span style={{ padding: "5px 10px", color: "#475569", fontSize: 12 }}>{page + 1}/{pages}</span>
            <button disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)} style={css.pgBtn}>Next →</button>
          </div>
        </div>
      )}
      </>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SMALL COMPONENTS
// ═══════════════════════════════════════════════════════════════

function DD({ l, v, o, c }) {
  return <select value={v} onChange={e => c(e.target.value)} style={{
    padding: "6px 8px", background: "#0a0f1a", border: "1px solid #1a2236",
    borderRadius: 6, color: v === "all" ? "#334155" : "#94a3b8", fontSize: 12, outline: "none", cursor: "pointer", maxWidth: 170,
  }}><option value="all">All {l}</option>{o.map(x => <option key={x} value={x}>{x}</option>)}</select>;
}

function Badge({ c, children }) {
  return <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: c + "18", color: c, textTransform: "uppercase", letterSpacing: 0.3 }}>{children}</span>;
}

function Inp({ label, value, onChange, multi }) {
  const s = { padding: "9px 12px", background: "#0a0f1a", border: "1px solid #1e293b", borderRadius: 6, color: "#e2e8f0", fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box", marginTop: 4, fontFamily: "inherit" };
  return <div><label style={css.label}>{label}</label>{multi
    ? <textarea rows={4} value={value || ""} onChange={e => onChange(e.target.value)} style={{ ...s, resize: "vertical" }} />
    : <input type="text" value={value || ""} onChange={e => onChange(e.target.value)} style={s} />
  }</div>;
}

function Sel({ label, value, opts, onChange }) {
  const options = [...new Set([value, ...opts].filter(v => v !== undefined && v !== null))];
  return <div><label style={css.label}>{label}</label><select value={value} onChange={e => onChange(e.target.value)} style={{
    width: "100%", padding: "9px 12px", background: "#0a0f1a", border: "1px solid #1e293b",
    borderRadius: 6, color: "#e2e8f0", fontSize: 13, outline: "none", marginTop: 4, cursor: "pointer",
  }}>{options.map(o => <option key={o} value={o}>{o || "None"}</option>)}</select></div>;
}

// Editable dropdown: suggests existing values but also lets the teacher type a brand-new one.
function Combo({ label, value, opts, onChange, placeholder }) {
  const listId = useId();
  const options = [...new Set(opts.filter(Boolean))].sort();
  const isNew = value && !options.includes(value);
  return (
    <div>
      <label style={css.label}>{label}</label>
      <input
        type="text"
        list={listId}
        value={value || ""}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        style={{ padding: "9px 12px", background: "#0a0f1a", border: "1px solid #1e293b", borderRadius: 6, color: "#e2e8f0", fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box", marginTop: 4, fontFamily: "inherit" }}
      />
      <datalist id={listId}>
        {options.map(o => <option key={o} value={o} />)}
      </datalist>
      {isNew && <div style={{ color: "#22c55e", fontSize: 10, fontWeight: 600, letterSpacing: 0.3, marginTop: 3 }}>+ New “{value}” will be created</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════

// Small labelled number used by the import preview header.
function Stat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 19, fontWeight: 700, color, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
    </div>
  );
}

const css = {
  page: { minHeight: "100vh", background: "#090e18", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans',system-ui,sans-serif" },
  shell: { minHeight: "100vh", background: "#090e18", fontFamily: "'DM Sans',system-ui,sans-serif", color: "#e2e8f0", display: "flex", flexDirection: "column" },
  loginCard: { background: "#0f1629", border: "1px solid #1a2236", borderRadius: 12, padding: "32px 28px", width: 360, maxWidth: "90vw" },
  header: { background: "#0f1629", borderBottom: "1px solid #1a2236", padding: "10px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 },
  tabs: { background: "#0f1629", borderBottom: "1px solid #1a2236", padding: "0 24px", display: "flex", gap: 0, flexShrink: 0, overflow: "auto" },
  tab: { padding: "10px 16px", background: "none", border: "none", borderBottom: "2px solid transparent", fontSize: 13, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap", transition: "all 0.15s" },
  filterRow: { background: "#0b1120", borderBottom: "1px solid #1a2236", padding: "8px 24px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", flexShrink: 0 },
  bulkBar: { background: "#111827", borderBottom: "1px solid #253048", padding: "10px 24px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", flexShrink: 0 },
  bulkSelect: { padding: "7px 9px", background: "#0a0f1a", border: "1px solid #334155", borderRadius: 6, color: "#cbd5e1", fontSize: 12, outline: "none", cursor: "pointer", maxWidth: 190 },
  bulkInput: { padding: "7px 10px", background: "#090e18", border: "1px solid #334155", borderRadius: 6, color: "#e2e8f0", fontSize: 12, outline: "none", width: 170, boxSizing: "border-box" },
  bulkMsg: { background: "#0b1120", borderBottom: "1px solid #1a2236", padding: "7px 24px", fontSize: 12, flexShrink: 0 },
  gridWrap: { flex: 1, overflow: "auto", padding: "16px 24px" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 },
  card: { background: "#0f1629", border: "1px solid #1a2236", borderRadius: 10, padding: "14px 16px", cursor: "pointer", transition: "all 0.15s", display: "flex", flexDirection: "column", minHeight: 140 },
  pager: { background: "#0f1629", borderTop: "1px solid #1a2236", padding: "8px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 },
  pgBtn: { padding: "5px 12px", background: "#1a2236", border: "1px solid #253048", borderRadius: 6, color: "#94a3b8", fontSize: 12, cursor: "pointer" },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 },
  modal: { background: "#0f1629", border: "1px solid #1a2236", borderRadius: 14, padding: "24px 28px", width: 660, maxWidth: "95vw", maxHeight: "90vh", position: "relative", display: "flex", flexDirection: "column" },
  closeBtn: { position: "absolute", top: 14, right: 14, background: "#1a2236", border: "none", borderRadius: 6, color: "#64748b", fontSize: 16, width: 30, height: 30, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2 },
  block: { background: "#090e18", border: "1px solid #1a2236", borderRadius: 8, padding: 14, marginBottom: 14 },
  bLabel: { color: "#334155", fontSize: 10, fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 },
  label: { color: "#475569", fontSize: 10, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase" },
  inp: { padding: "10px 12px", background: "#090e18", border: "1px solid #1a2236", borderRadius: 6, color: "#e2e8f0", fontSize: 14, outline: "none", display: "block", width: "100%", boxSizing: "border-box", marginTop: 5 },
  btn: { padding: "10px 22px", background: "#f59e0b", border: "none", borderRadius: 8, color: "#090e18", fontSize: 14, fontWeight: 700, cursor: "pointer" },
  ghost: { padding: "5px 12px", background: "transparent", border: "1px solid #1e293b", borderRadius: 6, color: "#64748b", fontSize: 11, cursor: "pointer" },
};
