import { useCallback, useEffect, useMemo, useState } from "react";
import { MathContent, ChoiceContent } from "./mathContent";
import { VisualAssetPreview, questionInlineVisualAssets } from "./visualContent";
import { QuestionWithUnderline } from "./questionText";
import { generateQuizHtml, resolveQuestionVisuals } from "./questionExport";
import { loadClassificationOptions } from "./classificationOptions";

const URL_BASE = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const REST = `${URL_BASE?.replace(/\/$/, "")}/rest/v1`;
const STORAGE = `${URL_BASE?.replace(/\/$/, "")}/storage/v1/object/public`;
const hdr = (t) => ({ apikey: KEY, Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

const DRAFTS_KEY = "quiz_builder_drafts";

// Subjects a teacher can draw a quiz section from. Finer-grained than the
// diagnostic builder (English / Filipino split) since quizzes are flexible.
const SUBJECT_CATALOG = [
  { key: "math", label: "Math", subjects: ["Mathematics"] },
  { key: "science", label: "Science", subjects: ["Science"] },
  { key: "english", label: "English", subjects: ["English Language"] },
  { key: "filipino", label: "Filipino", subjects: ["Filipino Language"] },
  { key: "reading", label: "Reading", subjects: ["Reading"] },
  { key: "social_studies", label: "Social Studies", subjects: ["Social Studies"] },
  { key: "logic", label: "Logic / Abstract Reasoning", subjects: ["Logic/Abstract Reasoning"] },
];

const catalogFor = (k) => SUBJECT_CATALOG.find((c) => c.key === k) || SUBJECT_CATALOG[0];

// Distinct topics / subtopics available for a set of bank subjects, read from the
// classification options (`subject|||topic` and `subject|||topic|||subtopic`).
function topicsForSubjects(classOpts, subjects) {
  const set = new Set();
  (classOpts.topics || []).forEach((t) => {
    const [subj, topic] = t.split("|||");
    if (subjects.includes(subj) && topic) set.add(topic);
  });
  return [...set].sort();
}
function subtopicsForSubjects(classOpts, subjects, topic) {
  const set = new Set();
  (classOpts.subtopics || []).forEach((s) => {
    const [subj, tp, st] = s.split("|||");
    if (subjects.includes(subj) && (!topic || tp === topic) && st) set.add(st);
  });
  return [...set].sort();
}

function topicPlanTotal(topic) {
  return topic.subtopics?.length
    ? topic.subtopics.reduce((sum, st) => sum + Number(st.count || 0), 0)
    : Number(topic.count || 0);
}

function sectionTarget(section) {
  const plan = Array.isArray(section.topicPlan) ? section.topicPlan : [];
  const planned = plan.reduce((sum, topic) => sum + topicPlanTotal(topic), 0);
  return planned > 0 ? planned : Number(section.count || 0);
}

function buildSectionSlots(section) {
  const plan = Array.isArray(section.topicPlan) ? section.topicPlan : [];
  const slots = [];
  plan.forEach((topic, topicIndex) => {
    const topicName = topic.name || "";
    const subtopics = Array.isArray(topic.subtopics) ? topic.subtopics : [];
    if (subtopics.length) {
      subtopics.forEach((subtopic, subtopicIndex) => {
        const target = Number(subtopic.count || 0);
        if (target > 0) {
          slots.push({
            id: `${section.id}|||${topicIndex}|||${subtopicIndex}`,
            topic: topicName,
            subtopic: subtopic.name || "",
            target,
          });
        }
      });
    } else {
      const target = Number(topic.count || 0);
      if (target > 0) {
        slots.push({
          id: `${section.id}|||${topicIndex}|||`,
          topic: topicName,
          subtopic: "",
          target,
        });
      }
    }
  });

  if (slots.length) return slots;
  const target = Number(section.count || 0);
  return target > 0 ? [{ id: `${section.id}|||default`, topic: section.topic || "", subtopic: section.subtopic || "", target }] : [];
}

function clampTopicPlanSubtopics(topic) {
  const topicCount = Number(topic.count || 0);
  const subtopics = Array.isArray(topic.subtopics) ? topic.subtopics : [];
  let used = 0;
  return subtopics.map((st) => {
    const count = Math.max(0, Math.min(Number(st.count || 0), Math.max(0, topicCount - used)));
    used += count;
    return { ...st, count };
  });
}

function slugCode(name) {
  const base = String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `quiz-${base || "untitled"}-${Math.random().toString(36).slice(2, 6)}`;
}

// Section ids are generated at module scope so they stay stable and don't
// introduce an impure call inside a component render.
let sectionSeq = Date.now();
function nextSectionId() {
  sectionSeq += 1;
  return `s${sectionSeq.toString(36)}`;
}

// ── Local drafts (a single localStorage object keyed by quiz code) ──
function readDrafts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function writeDraft(payload) {
  const all = readDrafts();
  all[payload.code] = { ...payload, updatedAt: new Date().toISOString() };
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
}
function deleteDraft(code) {
  const all = readDrafts();
  delete all[code];
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
}

async function fetchQuestionPages(token, params) {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const p = new URLSearchParams(params);
    p.set("limit", String(pageSize));
    p.set("offset", String(offset));
    const r = await fetch(`${REST}/questions?${p}`, { headers: hdr(token) });
    if (!r.ok) throw new Error(await r.text());
    const page = await r.json();
    rows.push(...(Array.isArray(page) ? page : []));
    if (!Array.isArray(page) || page.length < pageSize) break;
  }
  return rows;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Attach passage / instruction text and resolve visuals so preview and PDF
// render exactly like the question-bank export.
async function hydrateForExport(rows, token) {
  const stimIds = [...new Set(rows.map((r) => r.stimulus_id).filter(Boolean))];
  const instIds = [...new Set(rows.map((r) => r.instruction_id).filter(Boolean))];
  const stimMap = new Map();
  const instMap = new Map();

  for (let i = 0; i < stimIds.length; i += 100) {
    const chunk = stimIds.slice(i, i + 100);
    const r = await fetch(`${REST}/stimuli?id=in.(${chunk.map(encodeURIComponent).join(",")})&select=id,stimulus_title,stimulus_type,stimulus_text`, { headers: hdr(token) });
    if (r.ok) (await r.json()).forEach((s) => stimMap.set(s.id, s));
  }
  for (let i = 0; i < instIds.length; i += 100) {
    const chunk = instIds.slice(i, i + 100);
    const r = await fetch(`${REST}/instructions?id=in.(${chunk.map(encodeURIComponent).join(",")})&select=id,instruction_text`, { headers: hdr(token) });
    if (r.ok) (await r.json()).forEach((s) => instMap.set(s.id, s));
  }

  const withText = rows.map((row) => {
    const stim = row.stimulus_id ? stimMap.get(row.stimulus_id) : null;
    const inst = row.instruction_id ? instMap.get(row.instruction_id) : null;
    return {
      ...row,
      stimulus_title: stim?.stimulus_title ?? "",
      stimulus_text: stim?.stimulus_text ?? "",
      instruction_text: inst?.instruction_text ?? "",
    };
  });
  return resolveQuestionVisuals(withText, { REST, STORAGE, hdr, token });
}

function openPrintDocument(html) {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = window.URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => window.URL.revokeObjectURL(url), 60000);
}

// ═══════════════════════════════════════════════════════════════
// MANAGER — list of quizzes + drafts
// ═══════════════════════════════════════════════════════════════
export default function QuizManager({ session }) {
  const token = session.access_token;
  const [view, setView] = useState("list"); // list | editor
  const [quizzes, setQuizzes] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // { code, quizId, draft }
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [busyMsg, setBusyMsg] = useState("");

  const refreshDrafts = useCallback(() => {
    setDrafts(Object.values(readDrafts()).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")));
  }, []);

  const loadQuizzes = useCallback(async () => {
    setLoading(true);
    refreshDrafts();
    try {
      const r = await fetch(`${REST}/quizzes?select=*&order=created_at.desc`, { headers: hdr(token) });
      const data = r.ok ? await r.json() : [];
      setQuizzes(Array.isArray(data) ? data : []);
    } catch {
      setQuizzes([]);
    }
    setLoading(false);
  }, [token, refreshDrafts]);

  useEffect(() => { void Promise.resolve().then(loadQuizzes); }, [loadQuizzes]);

  function createQuiz() {
    const name = newName.trim();
    if (!name) return;
    const code = slugCode(name);
    const draft = { code, title: name, description: "", sections: [], selections: {} };
    writeDraft(draft);
    refreshDrafts();
    setShowNew(false);
    setNewName("");
    setEditing({ code, quizId: null, draft });
    setView("editor");
  }

  function resumeDraft(d) {
    setEditing({ code: d.code, quizId: null, draft: d });
    setView("editor");
  }

  async function editQuiz(q) {
    setBusyMsg(`Loading ${q.title}…`);
    try {
      const r = await fetch(`${REST}/quiz_questions?quiz_id=eq.${q.id}&select=section_name,display_order,questions(*)&order=display_order.asc`, { headers: hdr(token) });
      const rows = r.ok ? await r.json() : [];
      const savedSections = Array.isArray(q.settings?.sections) ? q.settings.sections : [];
      // Rebuild sections; if settings were lost, infer from distinct section_name.
      let sections = savedSections;
      if (!sections.length) {
        const seen = [];
        rows.forEach((row) => { if (!seen.includes(row.section_name)) seen.push(row.section_name); });
        sections = seen.map((label, i) => ({ id: `s${i}`, catalogKey: "math", label, count: 0 }));
      }
      const selections = {};
      sections.forEach((s) => { selections[s.id] = []; });
      rows.forEach((row) => {
        if (!row.questions) return;
        const sec = sections.find((s) => s.label === row.section_name) || sections[0];
        if (sec) (selections[sec.id] = selections[sec.id] || []).push(row.questions);
      });
      const draft = { code: q.code, title: q.title, description: q.description || "", sections, selections };
      setEditing({ code: q.code, quizId: q.id, draft });
      setView("editor");
    } catch (e) {
      setBusyMsg("Error: " + e.message);
      return;
    }
    setBusyMsg("");
  }

  async function togglePublish(q) {
    try {
      await fetch(`${REST}/quizzes?id=eq.${q.id}`, {
        method: "PATCH",
        headers: { ...hdr(token), Prefer: "return=minimal" },
        body: JSON.stringify({ is_published: !q.is_published, updated_at: new Date().toISOString() }),
      });
      loadQuizzes();
    } catch (e) {
      setBusyMsg("Error: " + e.message);
    }
  }

  async function deleteQuiz(q) {
    if (!window.confirm(`Delete quiz "${q.title}"? This cannot be undone.`)) return;
    try {
      await fetch(`${REST}/quiz_questions?quiz_id=eq.${q.id}`, { method: "DELETE", headers: hdr(token) });
      await fetch(`${REST}/quizzes?id=eq.${q.id}`, { method: "DELETE", headers: hdr(token) });
      loadQuizzes();
    } catch (e) {
      setBusyMsg("Error: " + e.message);
    }
  }

  if (view === "editor" && editing) {
    return (
      <QuizEditor
        session={session}
        code={editing.code}
        quizId={editing.quizId}
        initialDraft={editing.draft}
        onBack={() => { setView("list"); setEditing(null); refreshDrafts(); }}
        onSaved={() => { setView("list"); setEditing(null); loadQuizzes(); }}
      />
    );
  }

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "28px 32px", background: "#090e18", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      {showNew && (
        <Modal onClose={() => setShowNew(false)}>
          <h3 style={H3}>New Quiz</h3>
          <p style={P}>Name your quiz. A local draft appears immediately — nothing is saved to the database until you hit Save.</p>
          <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createQuiz(); }} placeholder="e.g. Grade 9 Algebra Quiz 1" style={{ ...INPUT, width: "100%", marginBottom: 12 }} />
          <div style={ROW}>
            <button onClick={createQuiz} style={BTN}>Create Draft</button>
            <button onClick={() => setShowNew(false)} style={BTN2}>Cancel</button>
          </div>
        </Modal>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <h2 style={{ color: "#f1f5f9", fontSize: 18, fontWeight: 800, margin: 0 }}>Quizzes</h2>
          <p style={{ color: "#475569", fontSize: 12, margin: "4px 0 0" }}>Build any-size quizzes from the question bank. Preview and export a student test + answer key.</p>
        </div>
        <button onClick={() => { setShowNew(true); setNewName(""); }} style={BTN}>New Quiz</button>
      </div>
      {busyMsg && <div style={{ ...MSG, color: busyMsg.startsWith("Error") ? "#ef4444" : "#94a3b8", marginBottom: 12 }}>{busyMsg}</div>}

      {loading ? (
        <div style={EMPTY}>Loading quizzes…</div>
      ) : (
        <div style={GRID}>
          {drafts.map((d) => {
            const total = Object.values(d.selections || {}).reduce((a, list) => a + (list?.length || 0), 0);
            const target = (d.sections || []).reduce((a, s) => a + (Number(s.count) || 0), 0);
            return (
              <div key={d.code} style={{ ...CARD, borderColor: "#f59e0b55" }}>
                <div style={CARD_HEAD}>
                  <div style={CARD_TITLE} title={d.title}>{d.title}</div>
                  <span style={{ ...PILL, color: "#f59e0b" }}>DRAFT</span>
                </div>
                <div style={CARD_SUB}>{total}{target ? ` / ${target}` : ""} questions · {(d.sections || []).length} section{(d.sections || []).length === 1 ? "" : "s"}</div>
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <button onClick={() => resumeDraft(d)} style={BTN}>Resume Draft</button>
                </div>
                <button onClick={() => { deleteDraft(d.code); refreshDrafts(); }} style={{ ...DANGER_BTN, width: "100%" }}>Discard Draft</button>
              </div>
            );
          })}
          {quizzes.map((q) => (
            <div key={q.id} style={{ ...CARD, borderColor: q.is_published ? "#22c55e33" : "#1a2236" }}>
              <div style={CARD_HEAD}>
                <div style={CARD_TITLE} title={q.title}>{q.title}</div>
                <span style={{ ...PILL, color: q.is_published ? "#22c55e" : "#64748b" }}>{q.is_published ? "PUBLISHED" : "DRAFT"}</span>
              </div>
              <div style={CARD_SUB}>{q.total_questions ?? "?"} questions</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                <button onClick={() => editQuiz(q)} style={BTN2}>Edit</button>
                <button onClick={() => togglePublish(q)} style={{ ...BTN2, borderColor: q.is_published ? "#7f1d1d" : "#22c55e55", color: q.is_published ? "#fca5a5" : "#22c55e" }}>
                  {q.is_published ? "Unpublish" : "Publish"}
                </button>
              </div>
              <button onClick={() => deleteQuiz(q)} style={{ ...DANGER_BTN, width: "100%" }}>Delete</button>
            </div>
          ))}
          {!drafts.length && !quizzes.length && <div style={EMPTY}>No quizzes yet. Create one to get started.</div>}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EDITOR — sections + counts, auto-pick, manual browse, save, export
// ═══════════════════════════════════════════════════════════════
function QuizEditor({ session, code, quizId: initialQuizId, initialDraft, onBack, onSaved }) {
  const token = session.access_token;
  const [title, setTitle] = useState(initialDraft.title || "");
  const [description] = useState(initialDraft.description || "");
  const [sections, setSections] = useState(initialDraft.sections || []);
  const [selections, setSelections] = useState(initialDraft.selections || {});
  const [quizId, setQuizId] = useState(initialQuizId || null);
  const [activeSectionId, setActiveSectionId] = useState((initialDraft.sections || [])[0]?.id || null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [exportBusy, setExportBusy] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [classOpts, setClassOpts] = useState({ subjects: [], topics: [], subtopics: [] });

  useEffect(() => {
    loadClassificationOptions(REST, hdr(token)).then(setClassOpts).catch(() => {});
  }, [token]);

  // Persist the draft continuously.
  useEffect(() => {
    writeDraft({ code, title, description, sections, selections });
  }, [code, title, description, sections, selections]);

  const totalSelected = useMemo(
    () => Object.values(selections).reduce((a, list) => a + (list?.length || 0), 0),
    [selections]
  );

  function addSection(catalogKey) {
    const cat = catalogFor(catalogKey);
    const id = nextSectionId();
    setSections((prev) => [...prev, { id, catalogKey, label: cat.label, count: 5, topic: "", subtopic: "", topicPlan: [] }]);
    setSelections((prev) => ({ ...prev, [id]: [] }));
    setActiveSectionId(id);
  }
  function updateSection(id, patch) {
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }
  function removeSection(id) {
    setSections((prev) => prev.filter((s) => s.id !== id));
    setSelections((prev) => { const next = { ...prev }; delete next[id]; return next; });
    if (activeSectionId === id) setActiveSectionId(null);
  }

  async function pickQuestionsForSection(sec, excludeIds = new Set()) {
    const cat = catalogFor(sec.catalogKey);
    const subjFilter = cat.subjects.length > 1 ? `in.(${cat.subjects.join(",")})` : `eq.${cat.subjects[0]}`;
    const slots = buildSectionSlots(sec);
    const picked = [];
    const notes = [];
    const usedIds = new Set(excludeIds);

    for (const slot of slots) {
      const params = { select: "*", status: "eq.active", subject: subjFilter };
      if (slot.topic) params.topic = `eq.${slot.topic}`;
      if (slot.subtopic) params.subtopic = `eq.${slot.subtopic}`;
      const rows = (await fetchQuestionPages(token, params)).filter((row) => !usedIds.has(row.id));
      let slotPicked;
      if (sec.catalogKey === "reading" && !slot.topic && !slot.subtopic) {
        // In broad Reading sections, keep passage groups together like the diagnostic flow.
        const byStim = new Map();
        rows.filter((r) => r.stimulus_id).forEach((r) => {
          if (!byStim.has(r.stimulus_id)) byStim.set(r.stimulus_id, []);
          byStim.get(r.stimulus_id).push(r);
        });
        slotPicked = [];
        for (const stimId of shuffle([...byStim.keys()])) {
          if (slotPicked.length >= slot.target) break;
          slotPicked.push(...byStim.get(stimId).slice(0, Math.max(1, slot.target - slotPicked.length)));
        }
        slotPicked.sort((a, b) => (a.stimulus_id || "").localeCompare(b.stimulus_id || "") || (a.id || "").localeCompare(b.id || ""));
      } else {
        slotPicked = shuffle(rows).slice(0, slot.target);
      }
      slotPicked.forEach((q) => usedIds.add(q.id));
      picked.push(...slotPicked);
      if (slotPicked.length < slot.target) {
        const label = [slot.topic || "all topics", slot.subtopic].filter(Boolean).join(" / ");
        notes.push(`${label}: only ${slotPicked.length} of ${slot.target}`);
      }
    }

    return { picked, notes };
  }

  async function autoPickSection(sec) {
    setAutoBusy(true);
    setSaveMsg("");
    try {
      const excludeIds = new Set();
      Object.entries(selections).forEach(([sectionId, list]) => {
        if (sectionId !== sec.id) (list || []).forEach((q) => excludeIds.add(q.id));
      });
      const { picked, notes } = await pickQuestionsForSection(sec, excludeIds);
      setSelections((prev) => ({ ...prev, [sec.id]: picked }));
      setSaveMsg(notes.length ? `${sec.label}: ${notes.join("; ")} available in the bank.` : `${sec.label}: picked ${picked.length} question${picked.length === 1 ? "" : "s"}.`);
    } catch (e) {
      setSaveMsg("Error: " + e.message);
    }
    setAutoBusy(false);
  }

  async function autoPickAll() {
    setAutoBusy(true);
    setSaveMsg("");
    try {
      const nextSelections = {};
      const usedIds = new Set();
      const allNotes = [];
      for (const sec of sections) {
        const { picked, notes } = await pickQuestionsForSection(sec, usedIds);
        nextSelections[sec.id] = picked;
        picked.forEach((q) => usedIds.add(q.id));
        if (notes.length) allNotes.push(`${sec.label}: ${notes.join("; ")}`);
      }
      setSelections((prev) => ({ ...prev, ...nextSelections }));
      setSaveMsg(allNotes.length ? `${allNotes.join(" | ")} available in the bank.` : `Auto-picked ${usedIds.size} questions across all sections.`);
    } catch (e) {
      setSaveMsg("Error: " + e.message);
    }
    setAutoBusy(false);
  }

  function removeQuestion(sectionId, qid) {
    setSelections((prev) => ({ ...prev, [sectionId]: (prev[sectionId] || []).filter((q) => q.id !== qid) }));
  }
  function addQuestion(sectionId, q) {
    setSelections((prev) => {
      const list = prev[sectionId] || [];
      if (list.some((x) => x.id === q.id)) return prev;
      return { ...prev, [sectionId]: [...list, q] };
    });
  }

  // Flatten selections in section order into an ordered question list.
  const orderedRows = useMemo(() => {
    const out = [];
    sections.forEach((s) => (selections[s.id] || []).forEach((q) => out.push({ ...q, _section: s })));
    return out;
  }, [sections, selections]);

  async function saveQuiz() {
    if (!title.trim()) { setSaveMsg("Give the quiz a title first."); return; }
    setSaving(true);
    setSaveMsg("");
    try {
      const settings = {
        sections: sections.map((s) => ({
          id: s.id,
          catalogKey: s.catalogKey,
          label: s.label,
          count: sectionTarget(s),
          topic: s.topic || "",
          subtopic: s.subtopic || "",
          topicPlan: (Array.isArray(s.topicPlan) ? s.topicPlan : []).map((topic) => ({
            name: topic.name || "",
            count: Number(topic.count) || 0,
            subtopics: (Array.isArray(topic.subtopics) ? topic.subtopics : []).map((st) => ({ name: st.name || "", count: Number(st.count) || 0 })),
          })),
        })),
      };
      let id = quizId;
      const body = {
        title: title.trim(),
        description: description.trim() || null,
        total_questions: totalSelected,
        settings,
        updated_at: new Date().toISOString(),
      };
      if (!id) {
        const createRes = await fetch(`${REST}/quizzes`, {
          method: "POST",
          headers: { ...hdr(token), Prefer: "return=representation" },
          body: JSON.stringify({ code, created_by: session.user?.id || null, is_published: false, ...body }),
        });
        if (!createRes.ok) throw new Error(await createRes.text());
        const created = await createRes.json();
        id = Array.isArray(created) ? created[0].id : created.id;
        setQuizId(id);
      } else {
        const patchRes = await fetch(`${REST}/quizzes?id=eq.${id}`, {
          method: "PATCH",
          headers: { ...hdr(token), Prefer: "return=minimal" },
          body: JSON.stringify(body),
        });
        if (!patchRes.ok) throw new Error(await patchRes.text());
      }

      // Rewrite the question list.
      const del = await fetch(`${REST}/quiz_questions?quiz_id=eq.${id}`, { method: "DELETE", headers: hdr(token) });
      if (!del.ok) throw new Error(await del.text());

      let order = 0;
      const rows = sections.flatMap((s) =>
        (selections[s.id] || []).map((q) => ({ quiz_id: id, question_id: q.id, section_name: s.label, display_order: ++order }))
      );
      if (rows.length) {
        const ins = await fetch(`${REST}/quiz_questions`, {
          method: "POST",
          headers: { ...hdr(token), Prefer: "return=minimal" },
          body: JSON.stringify(rows),
        });
        if (!ins.ok) throw new Error(await ins.text());
      }

      deleteDraft(code);
      setSaveMsg("Saved.");
      setTimeout(() => onSaved(), 600);
    } catch (e) {
      setSaveMsg("Error: " + e.message);
    }
    setSaving(false);
  }

  async function exportPdf(showAnswers) {
    if (!orderedRows.length) { setSaveMsg("Add some questions before exporting."); return; }
    setExportBusy(showAnswers ? "key" : "test");
    setSaveMsg("");
    try {
      const hydrated = await hydrateForExport(orderedRows, token);
      const html = generateQuizHtml(hydrated, {
        title: title.trim() || "Quiz",
        subtitle: `${hydrated.length} question${hydrated.length === 1 ? "" : "s"}`,
        showAnswers,
        stripSvgAnswers: !showAnswers,
      });
      openPrintDocument(html);
    } catch (e) {
      setSaveMsg("Error: " + e.message);
    }
    setExportBusy("");
  }

  const activeSection = sections.find((s) => s.id === activeSectionId) || null;

  return (
    <div style={PAGE}>
      <div style={TOPBAR}>
        <button onClick={onBack} style={BTN2}>← Back</button>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Quiz title" style={{ ...INPUT, minWidth: 240 }} />
        <span style={{ color: "#64748b", fontSize: 12 }}>{totalSelected} question{totalSelected === 1 ? "" : "s"}</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setPreviewOpen(true)} disabled={!orderedRows.length} style={{ ...BTN2, opacity: orderedRows.length ? 1 : 0.5 }}>Preview</button>
        <button onClick={() => exportPdf(false)} disabled={!!exportBusy || !orderedRows.length} style={{ ...BTN2, opacity: exportBusy || !orderedRows.length ? 0.6 : 1 }}>{exportBusy === "test" ? "Preparing…" : "Export Student Test"}</button>
        <button onClick={() => exportPdf(true)} disabled={!!exportBusy || !orderedRows.length} style={{ ...BTN2, opacity: exportBusy || !orderedRows.length ? 0.6 : 1 }}>{exportBusy === "key" ? "Preparing…" : "Export Answer Key"}</button>
        <button onClick={saveQuiz} disabled={saving} style={{ ...BTN, opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save Quiz"}</button>
      </div>
      {saveMsg && <div style={{ ...MSG, color: saveMsg.startsWith("Error") ? "#ef4444" : "#94a3b8", padding: "6px 20px" }}>{saveMsg}</div>}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Section planner */}
        <div style={SIDEBAR}>
          <div style={{ ...LABEL, marginBottom: 8 }}>Sections</div>
          {sections.map((s) => {
            const count = (selections[s.id] || []).length;
            const target = sectionTarget(s);
            const done = target > 0 && count >= target;
            return (
              <button key={s.id} onClick={() => setActiveSectionId(s.id)} style={{ ...SECTION_BTN, borderColor: activeSectionId === s.id ? "#f59e0b" : "#1a2236" }}>
                <span style={{ color: "#e2e8f0", fontWeight: 700, fontSize: 12 }}>{s.label}</span>
                <span style={{ color: done ? "#22c55e" : "#94a3b8", fontSize: 11 }}>{count}/{target}</span>
              </button>
            );
          })}
          <div style={{ ...LABEL, margin: "12px 0 6px" }}>Add section</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {SUBJECT_CATALOG.map((c) => (
              <button key={c.key} onClick={() => addSection(c.key)} style={ADD_CHIP}>+ {c.label}</button>
            ))}
          </div>
          {sections.length > 0 && (
            <button onClick={autoPickAll} disabled={autoBusy} style={{ ...BTN, width: "100%", marginTop: 16, opacity: autoBusy ? 0.6 : 1 }}>
              {autoBusy ? "Auto-picking…" : "Auto-pick all sections"}
            </button>
          )}
        </div>

        {/* Section detail */}
        <div style={MAIN}>
          {!activeSection ? (
            <div style={EMPTY}>Add a section on the left (e.g. Math), set how many questions, then auto-pick — or browse the bank to add questions yourself.</div>
          ) : (
            <SectionEditor
              key={activeSection.id}
              token={token}
              section={activeSection}
              classOpts={classOpts}
              selected={selections[activeSection.id] || []}
              autoBusy={autoBusy}
              onUpdate={(patch) => updateSection(activeSection.id, patch)}
              onRemoveSection={() => removeSection(activeSection.id)}
              onAutoPick={() => autoPickSection(activeSection)}
              onAdd={(q) => addQuestion(activeSection.id, q)}
              onRemove={(qid) => removeQuestion(activeSection.id, qid)}
            />
          )}
        </div>
      </div>

      {previewOpen && (
        <QuizPreview
          token={token}
          title={title.trim() || "Quiz"}
          sections={sections}
          selections={selections}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}

// ── One section: count control + auto-pick + manual browser ──
function SectionEditor({ token, section, classOpts, selected, autoBusy, onUpdate, onRemoveSection, onAutoPick, onAdd, onRemove }) {
  const cat = catalogFor(section.catalogKey);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [bank, setBank] = useState([]);
  const [loadingBank, setLoadingBank] = useState(false);
  const [difficulty, setDifficulty] = useState("all");
  const [search, setSearch] = useState("");
  const selectedIds = new Set(selected.map((q) => q.id));

  const topicOptions = useMemo(() => topicsForSubjects(classOpts, cat.subjects), [classOpts, cat.subjects]);
  const subtopicOptions = useMemo(() => subtopicsForSubjects(classOpts, cat.subjects, section.topic), [classOpts, cat.subjects, section.topic]);
  const topicPlan = Array.isArray(section.topicPlan) ? section.topicPlan : [];
  const plannedTarget = topicPlan.reduce((sum, topic) => sum + topicPlanTotal(topic), 0);

  function addTopicBucket() {
    onUpdate({ topicPlan: [...topicPlan, { name: "", count: 0, subtopics: [] }] });
  }

  function updateTopicBucket(index, patch) {
    const nextPlan = topicPlan.map((topic, i) => {
      if (i !== index) return topic;
      const next = { ...topic, ...patch };
      if (Object.prototype.hasOwnProperty.call(patch, "count")) {
        next.count = Math.max(0, Number(patch.count || 0));
        next.subtopics = clampTopicPlanSubtopics(next);
      }
      return next;
    });
    onUpdate({ topicPlan: nextPlan, count: Math.max(0, nextPlan.reduce((sum, topic) => sum + topicPlanTotal(topic), 0)) });
  }

  function removeTopicBucket(index) {
    const nextPlan = topicPlan.filter((_, i) => i !== index);
    onUpdate({ topicPlan: nextPlan, count: nextPlan.length ? nextPlan.reduce((sum, topic) => sum + topicPlanTotal(topic), 0) : section.count });
  }

  function addSubtopicBucket(topicIndex) {
    const nextPlan = topicPlan.map((topic, i) => i === topicIndex
      ? { ...topic, subtopics: [...(topic.subtopics || []), { name: "", count: 0 }] }
      : topic);
    onUpdate({ topicPlan: nextPlan });
  }

  function updateSubtopicBucket(topicIndex, subtopicIndex, patch) {
    const nextPlan = topicPlan.map((topic, i) => {
      if (i !== topicIndex) return topic;
      const next = {
        ...topic,
        subtopics: (topic.subtopics || []).map((st, j) => j === subtopicIndex
          ? { ...st, ...patch, count: Object.prototype.hasOwnProperty.call(patch, "count") ? Math.max(0, Number(patch.count || 0)) : st.count }
          : st),
      };
      const subtopicTotal = next.subtopics.reduce((sum, st) => sum + Number(st.count || 0), 0);
      if (subtopicTotal > Number(next.count || 0)) next.count = subtopicTotal;
      next.subtopics = clampTopicPlanSubtopics(next);
      return next;
    });
    onUpdate({ topicPlan: nextPlan, count: nextPlan.reduce((sum, topic) => sum + topicPlanTotal(topic), 0) });
  }

  function removeSubtopicBucket(topicIndex, subtopicIndex) {
    const nextPlan = topicPlan.map((topic, i) => i === topicIndex
      ? { ...topic, subtopics: (topic.subtopics || []).filter((_, j) => j !== subtopicIndex) }
      : topic);
    onUpdate({ topicPlan: nextPlan, count: nextPlan.reduce((sum, topic) => sum + topicPlanTotal(topic), 0) });
  }

  const loadBank = useCallback(async () => {
    setLoadingBank(true);
    try {
      const subjFilter = cat.subjects.length > 1 ? `in.(${cat.subjects.join(",")})` : `eq.${cat.subjects[0]}`;
      const params = { select: "*", status: "eq.active", subject: subjFilter, order: "topic.asc,id.asc" };
      if (difficulty !== "all") params.difficulty_level = `eq.${difficulty}`;
      if (section.topic) params.topic = `eq.${section.topic}`;
      if (section.subtopic) params.subtopic = `eq.${section.subtopic}`;
      const rows = await fetchQuestionPages(token, params);
      setBank(rows);
    } catch {
      setBank([]);
    }
    setLoadingBank(false);
  }, [token, cat.subjects, difficulty, section.topic, section.subtopic]);

  useEffect(() => { if (browseOpen) void Promise.resolve().then(loadBank); }, [browseOpen, loadBank]);

  const filteredBank = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return bank;
    return bank.filter((q) => `${q.question_text} ${q.topic} ${q.subtopic}`.toLowerCase().includes(term));
  }, [bank, search]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
        <input value={section.label} onChange={(e) => onUpdate({ label: e.target.value })} style={{ ...INPUT, fontWeight: 700, minWidth: 200 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "#64748b", fontSize: 12 }}>Target</span>
          <input type="number" min={0} value={section.count} onChange={(e) => onUpdate({ count: Math.max(0, parseInt(e.target.value || "0", 10)) })} style={{ ...INPUT, width: 70 }} />
        </div>
        {!!topicPlan.length && <span style={{ color: "#64748b", fontSize: 12 }}>Planned target: {plannedTarget}</span>}
        <button onClick={onAutoPick} disabled={autoBusy} style={{ ...BTN, opacity: autoBusy ? 0.6 : 1 }}>{autoBusy ? "…" : "Auto-pick"}</button>
        <button onClick={() => setBrowseOpen((v) => !v)} style={BTN2}>{browseOpen ? "Hide bank" : "Browse bank"}</button>
        <div style={{ flex: 1 }} />
        <button onClick={onRemoveSection} style={DANGER_BTN}>Remove section</button>
      </div>

      {/* Narrow this section to a specific topic / subtopic (optional) */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ ...LABEL, marginRight: 2 }}>Narrow by</span>
        <select
          value={section.topic || ""}
          onChange={(e) => onUpdate({ topic: e.target.value, subtopic: "" })}
          style={{ ...SELECT, maxWidth: 260 }}
        >
          <option value="">All topics</option>
          {topicOptions.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select
          value={section.subtopic || ""}
          onChange={(e) => onUpdate({ subtopic: e.target.value })}
          disabled={!subtopicOptions.length}
          style={{ ...SELECT, maxWidth: 260, opacity: subtopicOptions.length ? 1 : 0.5 }}
        >
          <option value="">All subtopics</option>
          {subtopicOptions.map((st) => <option key={st} value={st}>{st}</option>)}
        </select>
        <span style={{ color: "#475569", fontSize: 12 }}>Used when no topic plan is added.</span>
      </div>

      <div style={{ ...PANEL, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
          <div>
            <div style={LABEL}>Topic Plan</div>
            <div style={{ color: "#94a3b8", fontSize: 12 }}>Set question counts per topic, then add subtopics when you want a more exact quiz mix.</div>
          </div>
          <button onClick={addTopicBucket} style={BTN2}>Add Topic Bucket</button>
        </div>
        {!topicPlan.length ? (
          <div style={{ color: "#475569", fontSize: 12 }}>No topic buckets. Auto-pick will use the section target and narrow-by filters above.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {topicPlan.map((topic, topicIndex) => {
              const subtopics = topic.subtopics || [];
              const subtopicTotal = subtopics.reduce((sum, st) => sum + Number(st.count || 0), 0);
              const topicSubtopicOptions = subtopicsForSubjects(classOpts, cat.subjects, topic.name);
              return (
                <div key={topicIndex} style={{ background: "#090e18", border: "1px solid #1a2236", borderRadius: 8, padding: 10 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1fr) 86px auto", gap: 8, alignItems: "center" }}>
                    <input value={topic.name || ""} onChange={(e) => updateTopicBucket(topicIndex, { name: e.target.value })} placeholder="Topic" list={`quiz-topic-${section.id}-${topicIndex}`} style={INPUT} />
                    <datalist id={`quiz-topic-${section.id}-${topicIndex}`}>
                      {topicOptions.map((t) => <option key={t} value={t} />)}
                    </datalist>
                    <input type="number" min={0} value={topic.count || 0} onChange={(e) => updateTopicBucket(topicIndex, { count: Number(e.target.value || 0) })} style={{ ...INPUT, width: 86 }} />
                    <button onClick={() => removeTopicBucket(topicIndex)} style={DANGER_BTN}>Remove</button>
                  </div>
                  <div style={{ color: subtopics.length && subtopicTotal !== Number(topic.count || 0) ? "#f59e0b" : "#64748b", fontSize: 12, marginTop: 8 }}>
                    {subtopics.length ? `Subtopics allocated: ${subtopicTotal} / ${Number(topic.count || 0)}` : "No subtopics added. This topic count is used directly."}
                  </div>
                  {!!subtopics.length && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                      {subtopics.map((subtopic, subtopicIndex) => (
                        <div key={subtopicIndex} style={{ display: "grid", gridTemplateColumns: "20px minmax(180px, 1fr) 86px auto", gap: 8, alignItems: "center" }}>
                          <span style={{ color: "#334155", textAlign: "center" }}>-</span>
                          <input value={subtopic.name || ""} onChange={(e) => updateSubtopicBucket(topicIndex, subtopicIndex, { name: e.target.value })} placeholder="Subtopic" list={`quiz-subtopic-${section.id}-${topicIndex}-${subtopicIndex}`} style={INPUT} />
                          <datalist id={`quiz-subtopic-${section.id}-${topicIndex}-${subtopicIndex}`}>
                            {topicSubtopicOptions.map((st) => <option key={st} value={st} />)}
                          </datalist>
                          <input type="number" min={0} value={subtopic.count || 0} onChange={(e) => updateSubtopicBucket(topicIndex, subtopicIndex, { count: Number(e.target.value || 0) })} style={{ ...INPUT, width: 86 }} />
                          <button onClick={() => removeSubtopicBucket(topicIndex, subtopicIndex)} style={DANGER_BTN}>Remove</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <button onClick={() => addSubtopicBucket(topicIndex)} style={{ ...BTN2, marginTop: 10 }}>Add Subtopic</button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ ...LABEL, marginBottom: 8 }}>Selected ({selected.length})</div>
      {!selected.length ? (
        <div style={{ ...EMPTY, textAlign: "left", padding: "12px 0" }}>Nothing picked yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
          {selected.map((q, i) => (
            <QuestionRow key={q.id} q={q} index={i} onAction={() => onRemove(q.id)} actionLabel="Remove" actionDanger />
          ))}
        </div>
      )}

      {browseOpen && (
        <div style={{ ...PANEL, marginTop: 8 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} style={SELECT}>
              <option value="all">All difficulties</option>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search text / topic…" style={{ ...INPUT, flex: 1, minWidth: 160 }} />
          </div>
          {loadingBank ? (
            <div style={EMPTY}>Loading bank…</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 460, overflow: "auto" }}>
              {filteredBank.slice(0, 200).map((q) => (
                <QuestionRow
                  key={q.id}
                  q={q}
                  onAction={() => onAdd(q)}
                  actionLabel={selectedIds.has(q.id) ? "Added" : "Add"}
                  actionDisabled={selectedIds.has(q.id)}
                />
              ))}
              {!filteredBank.length && <div style={EMPTY}>No matching questions.</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function QuestionRow({ q, index, onAction, actionLabel, actionDanger, actionDisabled }) {
  return (
    <div style={{ ...QROW }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: "#64748b", fontSize: 10, marginBottom: 3 }}>
          {typeof index === "number" ? `${index + 1}. ` : ""}{q.subject} · {q.topic}{q.subtopic ? ` · ${q.subtopic}` : ""} · {q.difficulty_level}
        </div>
        <div style={{ color: "#e2e8f0", fontSize: 12.5, lineHeight: 1.4 }}>
          <QuestionWithUnderline text={q.question_text} choiceA={q.choice_a} subject={q.subject} />
        </div>
      </div>
      <button
        onClick={onAction}
        disabled={actionDisabled}
        style={{ ...(actionDanger ? DANGER_BTN : BTN2), flexShrink: 0, opacity: actionDisabled ? 0.5 : 1 }}
      >
        {actionLabel}
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// PREVIEW — self-contained, renders questions as the student sees them
// ═══════════════════════════════════════════════════════════════
function QuizPreview({ token, title, sections, selections, onClose }) {
  const [showAnswers, setShowAnswers] = useState(false);
  const [stimMap, setStimMap] = useState({});
  const [instMap, setInstMap] = useState({});

  const rows = useMemo(() => {
    const out = [];
    sections.forEach((s) => (selections[s.id] || []).forEach((q) => out.push({ q, section: s })));
    return out;
  }, [sections, selections]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stimIds = [...new Set(rows.map((r) => r.q.stimulus_id).filter(Boolean))];
      const instIds = [...new Set(rows.map((r) => r.q.instruction_id).filter(Boolean))];
      const sm = {};
      const im = {};
      if (stimIds.length) {
        const r = await fetch(`${REST}/stimuli?id=in.(${stimIds.map(encodeURIComponent).join(",")})&select=id,stimulus_title,stimulus_text`, { headers: hdr(token) });
        if (r.ok) (await r.json()).forEach((s) => { sm[s.id] = s; });
      }
      if (instIds.length) {
        const r = await fetch(`${REST}/instructions?id=in.(${instIds.map(encodeURIComponent).join(",")})&select=id,instruction_text`, { headers: hdr(token) });
        if (r.ok) (await r.json()).forEach((s) => { im[s.id] = s; });
      }
      if (!cancelled) { setStimMap(sm); setInstMap(im); }
    })();
    return () => { cancelled = true; };
  }, [rows, token]);

  return (
    <div style={PREVIEW_OVERLAY} onClick={onClose}>
      <div style={PREVIEW_SHEET} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, position: "sticky", top: 0, background: "#f8fafc", paddingBottom: 12, borderBottom: "1px solid #e2e8f0" }}>
          <h2 style={{ margin: 0, color: "#0f172a", fontSize: 20 }}>{title}</h2>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: "#334155", fontSize: 13 }}>
              <input type="checkbox" checked={showAnswers} onChange={(e) => setShowAnswers(e.target.checked)} /> Show answers
            </label>
            <button onClick={onClose} style={{ ...BTN2, color: "#334155", borderColor: "#cbd5e1" }}>Close</button>
          </div>
        </div>

        {!rows.length && <div style={{ color: "#64748b" }}>No questions to preview.</div>}
        {rows.map(({ q, section }, i) => {
          const prev = rows[i - 1];
          const newSection = !prev || prev.section.id !== section.id;
          const stim = q.stimulus_id ? stimMap[q.stimulus_id] : null;
          const samePassage = prev && prev.q.stimulus_id && prev.q.stimulus_id === q.stimulus_id;
          const inst = q.instruction_id ? instMap[q.instruction_id] : null;
          return (
            <div key={`${section.id}-${q.id}`}>
              {newSection && <div style={PV_SECTION}>{section.label}</div>}
              {stim && !samePassage && (
                <div style={PV_PASSAGE}>
                  {stim.stimulus_title && <div style={{ fontWeight: 700, fontStyle: "italic", marginBottom: 4 }}>{stim.stimulus_title}</div>}
                  <MathContent value={stim.stimulus_text} subject={q.subject} />
                </div>
              )}
              <div style={PV_Q}>
                {inst?.instruction_text && <div style={{ fontStyle: "italic", color: "#475569", fontSize: 13, marginBottom: 6 }}><MathContent value={inst.instruction_text} subject={q.subject} /></div>}
                <div style={{ display: "flex", gap: 8 }}>
                  <span style={{ fontWeight: 800, color: "#0f172a" }}>{i + 1}.</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: "#0f172a", fontSize: 14.5, lineHeight: 1.5, marginBottom: 8 }}>
                      <QuestionWithUnderline text={q.question_text} choiceA={q.choice_a} subject={q.subject} />
                    </div>
                    <VisualAssetPreview assets={questionInlineVisualAssets(q)} storageBase={STORAGE} />
                    {["a", "b", "c", "d", "e"].filter((l) => q[`choice_${l}`]).map((l) => {
                      const correct = showAnswers && q.correct_answer?.toLowerCase() === l;
                      return (
                        <div key={l} style={{ display: "flex", gap: 8, margin: "3px 0", color: correct ? "#15803d" : "#334155", fontWeight: correct ? 700 : 400, fontSize: 14 }}>
                          <span style={{ fontWeight: 700 }}>{l.toUpperCase()}.</span>
                          <span style={{ flex: 1 }}><ChoiceContent value={q[`choice_${l}`]} subject={q.subject} /></span>
                          {correct && <span>✓</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// UI atoms + styles
// ═══════════════════════════════════════════════════════════════
function Modal({ children, onClose }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(2,6,16,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={onClose}>
      <div style={{ background: "#0f1629", border: "1px solid #1a2236", borderRadius: 12, padding: 24, width: 420, maxWidth: "90vw" }} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

const PAGE = { display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", fontFamily: "'DM Sans',system-ui,sans-serif", color: "#e2e8f0", background: "#090e18" };
const TOPBAR = { background: "#0b1120", borderBottom: "1px solid #1a2236", padding: "10px 20px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0, flexWrap: "wrap" };
const SIDEBAR = { width: 260, borderRight: "1px solid #1a2236", padding: 16, overflow: "auto", background: "#0b1120", flexShrink: 0 };
const MAIN = { flex: 1, minWidth: 0, padding: 20, overflow: "auto" };
const GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 14, marginTop: 16 };
const CARD = { background: "#0f1629", border: "1px solid #1a2236", borderRadius: 8, padding: "16px 18px" };
const CARD_HEAD = { display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8, alignItems: "flex-start" };
const CARD_TITLE = { color: "#f1f5f9", fontSize: 14, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 };
const CARD_SUB = { color: "#64748b", fontSize: 12, marginBottom: 14 };
const PANEL = { background: "#0b1120", border: "1px solid #1a2236", borderRadius: 8, padding: 12 };
const SECTION_BTN = { width: "100%", display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", background: "#0f1629", border: "1px solid #1a2236", borderRadius: 8, padding: "9px 10px", marginBottom: 8, cursor: "pointer", textAlign: "left" };
const ADD_CHIP = { background: "#0f1629", border: "1px solid #253048", borderRadius: 999, color: "#94a3b8", fontSize: 11, fontWeight: 700, padding: "5px 9px", cursor: "pointer" };
const QROW = { display: "flex", gap: 10, alignItems: "center", background: "#0f1629", border: "1px solid #1a2236", borderRadius: 8, padding: "8px 10px" };
const ROW = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };
const H3 = { margin: "0 0 10px", color: "#f1f5f9", fontSize: 17, fontWeight: 900 };
const P = { color: "#94a3b8", fontSize: 13, lineHeight: 1.7, margin: "0 0 16px" };
const EMPTY = { color: "#475569", fontSize: 13, padding: "32px 0", textAlign: "center" };
const LABEL = { display: "block", color: "#64748b", fontSize: 10, fontWeight: 900, textTransform: "uppercase", letterSpacing: 0.5 };
const MSG = { fontSize: 12, marginTop: 8 };
const PILL = { color: "#94a3b8", background: "#1a2236", borderRadius: 4, padding: "2px 6px", fontSize: 10, fontWeight: 800, flexShrink: 0 };
const INPUT = { boxSizing: "border-box", padding: "8px 10px", background: "#090e18", border: "1px solid #334155", borderRadius: 7, color: "#e2e8f0", fontSize: 12, outline: "none", fontFamily: "inherit" };
const SELECT = { padding: "8px 10px", background: "#090e18", border: "1px solid #334155", borderRadius: 7, color: "#e2e8f0", fontSize: 12, outline: "none" };
const BTN = { padding: "8px 13px", background: "#f59e0b", border: "none", borderRadius: 7, color: "#090e18", fontSize: 12, fontWeight: 900, cursor: "pointer" };
const BTN2 = { padding: "7px 11px", background: "transparent", border: "1px solid #334155", borderRadius: 7, color: "#94a3b8", fontSize: 12, fontWeight: 800, cursor: "pointer" };
const DANGER_BTN = { padding: "7px 11px", background: "#450a0a", border: "1px solid #7f1d1d", borderRadius: 7, color: "#fecaca", fontSize: 12, fontWeight: 800, cursor: "pointer" };
const PREVIEW_OVERLAY = { position: "fixed", inset: 0, background: "rgba(2,6,16,0.8)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 120, padding: "24px 16px", overflow: "auto" };
const PREVIEW_SHEET = { background: "#f8fafc", borderRadius: 12, padding: 28, width: "100%", maxWidth: 820, color: "#0f172a" };
const PV_SECTION = { fontWeight: 900, fontSize: 13, textTransform: "uppercase", letterSpacing: 1, color: "#b45309", margin: "20px 0 10px", borderBottom: "2px solid #f59e0b", paddingBottom: 4 };
const PV_PASSAGE = { background: "#fff", border: "1px solid #e2e8f0", borderLeft: "3px solid #cbd5e1", borderRadius: 6, padding: "10px 14px", margin: "10px 0", fontSize: 14, lineHeight: 1.6, color: "#1e293b" };
const PV_Q = { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "14px 16px", marginBottom: 10 };
