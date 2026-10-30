import { useId, useMemo, useState } from "react";
import { validateMathItem } from "./mathValidation";

// One row per classification code is stored for every subtopic, matching the
// existing shape of subtopic_classification_importance. New categories are
// seeded at the lowest importance so they never skew exam weighting until a
// teacher tunes them.
const CLASSIFICATION_CODES = ["BMA", "HAMS", "EA", "ITCS", "SM", "HSSC", "ETT", "SNC"];
const TAX_TABLE = "subtopic_classification_importance";
const SCHOOLS = ["UPCAT", "ACET", "DCAT", "USTET"];

function splitKey(value) {
  return String(value || "").split("|||");
}

// Persist a full (subject, topic, subtopic) triple to the taxonomy table,
// inserting only the classification-code rows that are not already present.
async function persistTriple(rest, authHeaders, subject, topic, subtopic) {
  const q = `subject=eq.${encodeURIComponent(subject)}&topic=eq.${encodeURIComponent(topic)}&subtopic=eq.${encodeURIComponent(subtopic)}&select=classification_code`;
  const er = await fetch(`${rest}/${TAX_TABLE}?${q}`, { headers: authHeaders });
  if (!er.ok) throw new Error(await er.text());
  const have = new Set((await er.json()).map(x => x.classification_code));
  const rows = CLASSIFICATION_CODES.filter(c => !have.has(c)).map(code => ({
    subject, topic, subtopic, classification_code: code, importance_label: "Low", importance_weight: 1,
  }));
  if (!rows.length) return;
  const r = await fetch(`${rest}/${TAX_TABLE}`, {
    method: "POST", headers: { ...authHeaders, Prefer: "return=minimal" }, body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(await r.text());
}

// Topics available under a subject, from merged taxonomy key lists ("s|||t").
function topicsUnder(taxonomy, subject) {
  return [...new Set((taxonomy?.topics || [])
    .map(splitKey).filter(p => p[0] === subject && p[1]).map(p => p[1]))].sort();
}
function subtopicsUnder(taxonomy, subject, topic) {
  return [...new Set((taxonomy?.subtopics || [])
    .map(splitKey).filter(p => p[0] === subject && p[1] === topic && p[2]).map(p => p[2]))].sort();
}

function buildTree(classOpts, fallbackOpts, counts) {
  const tree = {};
  const subject = name => {
    if (!name) return null;
    if (!tree[name]) tree[name] = { name, topics: {}, count: 0 };
    return tree[name];
  };
  const topic = (s, t) => {
    const subj = subject(s);
    if (!subj || !t) return null;
    if (!subj.topics[t]) subj.topics[t] = { name: t, subtopics: {}, count: 0 };
    return subj.topics[t];
  };
  const subtopic = (s, t, st) => {
    const top = topic(s, t);
    if (!top || !st) return null;
    if (!top.subtopics[st]) top.subtopics[st] = { name: st, count: 0 };
    return top.subtopics[st];
  };

  [classOpts, fallbackOpts].filter(Boolean).forEach(src => {
    (src.subjects || []).forEach(subject);
    (src.topics || []).forEach(k => { const [s, t] = splitKey(k); topic(s, t); });
    (src.subtopics || []).forEach(k => { const [s, t, st] = splitKey(k); subtopic(s, t, st); });
  });

  // Surface any subject/topic that only exists on questions (e.g. Logic, whose
  // questions carry no topic/subtopic), then apply live question counts.
  const subjects = counts?.subjects || {};
  const topics = counts?.topics || {};
  const subtopics = counts?.subtopics || {};
  Object.keys(subjects).forEach(subject);
  Object.keys(topics).forEach(k => { const [s, t] = splitKey(k); topic(s, t); });
  Object.keys(subtopics).forEach(k => { const [s, t, st] = splitKey(k); subtopic(s, t, st); });
  Object.values(tree).forEach(subj => {
    subj.count = subjects[subj.name] || 0;
    Object.values(subj.topics).forEach(top => {
      top.count = topics[`${subj.name}|||${top.name}`] || 0;
      Object.values(top.subtopics).forEach(leaf => {
        leaf.count = subtopics[`${subj.name}|||${top.name}|||${leaf.name}`] || 0;
      });
    });
  });

  return Object.values(tree)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(s => ({
      ...s,
      topics: Object.values(s.topics)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(t => ({ ...t, subtopics: Object.values(t.subtopics).sort((a, b) => a.name.localeCompare(b.name)) })),
    }));
}

export default function CategoryManager({ session, rest, headers, classOpts, fallbackOpts, counts, onChanged, onGenerateAI }) {
  const tree = useMemo(() => buildTree(classOpts, fallbackOpts, counts), [classOpts, fallbackOpts, counts]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // Creation modal: { kind: "subject"|"topic"|"subtopic", subject, topic }
  const [addForm, setAddForm] = useState(null);
  // Add-questions modal scope: { subject, topic, subtopic }
  const [qScope, setQScope] = useState(null);

  function toggle(key) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // Remove an empty category (taxonomy rows only). We block deletion while any
  // questions still carry the label, since those questions would keep the
  // category alive in the bank — move them first.
  async function deleteScope(kind, subject, topic, subtopic, count) {
    if (count > 0) {
      setMsg(`Error: “${subtopic || topic || subject}” still has ${count} question${count === 1 ? "" : "s"}. Move or delete them first.`);
      return;
    }
    const label = [subject, topic, subtopic].filter(Boolean).join(" › ");
    if (!window.confirm(`Delete ${kind} “${label}”? This removes the empty category.`)) return;
    setBusy(true); setMsg("");
    const parts = [`subject=eq.${encodeURIComponent(subject)}`];
    if (topic) parts.push(`topic=eq.${encodeURIComponent(topic)}`);
    if (subtopic) parts.push(`subtopic=eq.${encodeURIComponent(subtopic)}`);
    try {
      const r = await fetch(`${rest}/${TAX_TABLE}?${parts.join("&")}`, {
        method: "DELETE", headers: { ...headers(session.access_token), Prefer: "return=minimal" },
      });
      if (!r.ok) throw new Error(await r.text());
      setMsg(`Deleted “${label}”.`);
      await onChanged?.();
    } catch (e) {
      setMsg("Error: " + e.message);
    }
    setBusy(false);
  }

  async function afterCreate(subject, topic) {
    setMsg(`Created under “${subject} › ${topic}”.`);
    setExpanded(prev => new Set(prev).add(`s:${subject}`).add(`t:${subject}|||${topic}`));
    setAddForm(null);
    await onChanged?.();
  }

  const allSubjects = tree.map(s => s.name);

  return (
    <div style={S.page}>
      <div style={S.head}>
        <div>
          <h1 style={S.h1}>Categories</h1>
          <p style={S.sub}>Create subjects, topics, and subtopics — they appear here right away, even with zero questions. Open a subtopic to add questions.</p>
        </div>
        <button onClick={() => setAddForm({ kind: "subject", subject: "", topic: "", subtopic: "" })} style={S.primary}>+ New Subject</button>
      </div>

      {msg && <div style={{ ...S.msg, color: msg.startsWith("Error") ? "#ef4444" : "#22c55e" }}>{msg}</div>}

      <div style={S.body}>
        {tree.length === 0 && <div style={S.empty}>No categories yet. Click “New Subject” to create your first one.</div>}
        {tree.map(subject => {
          const sKey = `s:${subject.name}`;
          const sOpen = expanded.has(sKey);
          return (
            <div key={subject.name} style={S.subjectCard}>
              <div style={S.row}>
                <button onClick={() => toggle(sKey)} style={S.caret}>{sOpen ? "▾" : "▸"}</button>
                <span style={S.subjectName}>{subject.name}</span>
                <span style={S.count}>{subject.count} q</span>
                <span style={S.spacer} />
                <button onClick={() => setAddForm({ kind: "topic", subject: subject.name, topic: "", subtopic: "" })} style={S.ghost}>+ Topic</button>
                <DeleteBtn disabled={busy || subject.count > 0} onClick={() => deleteScope("subject", subject.name, "", "", subject.count)} title={subject.count > 0 ? "Has questions — move them first" : "Delete subject"} />
              </div>
              {sOpen && subject.topics.map(topic => {
                const tKey = `t:${subject.name}|||${topic.name}`;
                const tOpen = expanded.has(tKey);
                return (
                  <div key={topic.name} style={S.topicWrap}>
                    <div style={S.row}>
                      <button onClick={() => toggle(tKey)} style={S.caret}>{tOpen ? "▾" : "▸"}</button>
                      <span style={S.topicName}>{topic.name}</span>
                      <span style={S.count}>{topic.count} q</span>
                      <span style={S.spacer} />
                      <button onClick={() => setAddForm({ kind: "subtopic", subject: subject.name, topic: topic.name, subtopic: "" })} style={S.ghost}>+ Subtopic</button>
                      <DeleteBtn disabled={busy || topic.count > 0} onClick={() => deleteScope("topic", subject.name, topic.name, "", topic.count)} title={topic.count > 0 ? "Has questions — move them first" : "Delete topic"} />
                    </div>
                    {tOpen && topic.subtopics.map(st => (
                      <div key={st.name} style={S.subtopicRow}>
                        <span style={S.dot}>•</span>
                        <span style={S.subtopicName}>{st.name}</span>
                        <span style={S.count}>{st.count} q</span>
                        <span style={S.spacer} />
                        <button onClick={() => setQScope({ subject: subject.name, topic: topic.name, subtopic: st.name })} style={S.addQ}>+ Add questions</button>
                        <DeleteBtn disabled={busy || st.count > 0} onClick={() => deleteScope("subtopic", subject.name, topic.name, st.name, st.count)} title={st.count > 0 ? "Has questions — move them first" : "Delete subtopic"} />
                      </div>
                    ))}
                    {tOpen && topic.subtopics.length === 0 && <div style={S.hint}>No subtopics yet.</div>}
                  </div>
                );
              })}
              {sOpen && subject.topics.length === 0 && <div style={S.hint}>No topics yet.</div>}
            </div>
          );
        })}
      </div>

      {addForm && (
        <CategoryCreateModal
          session={session}
          rest={rest}
          headers={headers}
          subjects={allSubjects}
          fixed={addForm}
          onClose={() => setAddForm(null)}
          onCreated={afterCreate}
        />
      )}

      {qScope && (
        <AddQuestionsModal
          scope={qScope}
          session={session}
          rest={rest}
          headers={headers}
          onClose={() => setQScope(null)}
          onChanged={onChanged}
          onGenerateAI={s => { setQScope(null); onGenerateAI?.(s); }}
        />
      )}
    </div>
  );
}

// ── Create subject / topic / subtopic (self-persisting) ─────────────
// `fixed` = { kind, subject, topic }. kind controls title + which fields are
// locked. Usable from the Categories tab and the Question Bank toolbar.
export function CategoryCreateModal({ session, rest, headers, subjects = [], fixed, onClose, onCreated }) {
  const kind = fixed?.kind || "subject";
  const [subject, setSubject] = useState(fixed?.subject || "");
  const [topic, setTopic] = useState(fixed?.topic || "");
  const [subtopic, setSubtopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const listId = useId();
  const title = kind === "topic" ? "New Topic" : kind === "subtopic" ? "New Subtopic" : "New Category";
  const note = kind === "subtopic"
    ? "Add a subtopic under this topic."
    : kind === "topic"
      ? "A topic is created with its first subtopic."
      : "A new subject/topic is created together with its first subtopic. Pick an existing subject to add under it, or type a new one.";
  const lockSubject = kind === "topic" || kind === "subtopic";
  const lockTopic = kind === "subtopic";
  const ready = subject.trim() && topic.trim() && subtopic.trim();

  async function create() {
    if (!ready) { setErr("Subject, topic, and subtopic are all required."); return; }
    setBusy(true); setErr("");
    try {
      await persistTriple(rest, headers(session.access_token), subject.trim(), topic.trim(), subtopic.trim());
      await onCreated?.(subject.trim(), topic.trim(), subtopic.trim());
      onClose?.();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <button onClick={onClose} style={S.close}>✕</button>
        <h2 style={S.modalTitle}>{title}</h2>
        <p style={S.modalNote}>{note}</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Subject">
            <input list={listId} value={subject} disabled={lockSubject} onChange={e => setSubject(e.target.value)}
              placeholder="e.g. Mathematics" style={{ ...S.input, opacity: lockSubject ? 0.6 : 1 }} />
            <datalist id={listId}>{subjects.map(s => <option key={s} value={s} />)}</datalist>
          </Field>
          <Field label="Topic">
            <input value={topic} disabled={lockTopic} onChange={e => setTopic(e.target.value)}
              placeholder="e.g. Algebra" style={{ ...S.input, opacity: lockTopic ? 0.6 : 1 }} />
          </Field>
          <Field label="Subtopic">
            <input value={subtopic} onChange={e => setSubtopic(e.target.value)} autoFocus
              placeholder="e.g. Quadratic Equations" style={S.input} />
          </Field>
        </div>
        <div style={S.preview}>{[subject, topic, subtopic].filter(Boolean).join(" › ") || "Fill in the fields above"}</div>
        {err && <div style={{ marginTop: 10, fontSize: 12, color: "#ef4444" }}>Error: {err}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button onClick={create} disabled={busy || !ready} style={{ ...S.primary, opacity: busy || !ready ? 0.55 : 1 }}>
            {busy ? "Saving..." : "Create"}
          </button>
          <button onClick={onClose} disabled={busy} style={S.cancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── Add questions to a subtopic (menu → create / pick existing / AI) ─
// When `taxonomy` is provided the teacher first picks the topic/subtopic via
// dropdowns (used from the Question Bank); when omitted the scope is fixed
// (used from the Categories tab).
export function AddQuestionsModal({ scope: initialScope, taxonomy, subjects, session, rest, headers, onClose, onChanged, onGenerateAI }) {
  const [mode, setMode] = useState("menu");
  const [sel, setSel] = useState({
    subject: initialScope?.subject || "",
    topic: initialScope?.topic || "",
    subtopic: initialScope?.subtopic || "",
  });
  const picking = Boolean(taxonomy);
  const ready = Boolean(sel.subject && sel.topic);
  const scope = { subject: sel.subject, topic: sel.topic, subtopic: sel.subtopic };
  const topicOpts = picking ? topicsUnder(taxonomy, sel.subject) : [];
  const subtopicOpts = picking ? subtopicsUnder(taxonomy, sel.subject, sel.topic) : [];

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={{ ...S.modal, width: mode === "existing" ? 620 : 480 }} onClick={e => e.stopPropagation()}>
        <button onClick={onClose} style={S.close}>✕</button>
        <h2 style={S.modalTitle}>Add questions</h2>

        {picking && mode === "menu" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, margin: "4px 0 14px" }}>
            <Field label="Subject">
              <select value={sel.subject} onChange={e => setSel({ subject: e.target.value, topic: "", subtopic: "" })} style={S.input}>
                <option value="">Select…</option>
                {(subjects || []).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Topic">
              <select value={sel.topic} disabled={!sel.subject} onChange={e => setSel(p => ({ ...p, topic: e.target.value, subtopic: "" }))} style={{ ...S.input, opacity: sel.subject ? 1 : 0.5 }}>
                <option value="">Select…</option>
                {topicOpts.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Subtopic">
              <select value={sel.subtopic} disabled={!sel.topic} onChange={e => setSel(p => ({ ...p, subtopic: e.target.value }))} style={{ ...S.input, opacity: sel.topic ? 1 : 0.5 }}>
                <option value="">All / none</option>
                {subtopicOpts.map(st => <option key={st} value={st}>{st}</option>)}
              </select>
            </Field>
          </div>
        )}
        {!picking && <p style={S.modalNote}>{`${scope.subject} › ${scope.topic}${scope.subtopic ? ` › ${scope.subtopic}` : ""}`}</p>}

        {mode === "menu" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 6 }}>
            {picking && !ready && <div style={S.hint}>Choose a subject and topic to continue.</div>}
            <button onClick={() => ready && onGenerateAI(scope)} disabled={!ready} style={{ ...S.bigChoice, opacity: ready ? 1 : 0.5, cursor: ready ? "pointer" : "not-allowed" }}>
              <span style={S.bigChoiceTitle}>✨ Generate 10 with AI</span>
              <span style={S.bigChoiceSub}>Open the AI generator pre-set to this scope.</span>
            </button>
            <button onClick={() => ready && setMode("create")} disabled={!ready} style={{ ...S.bigChoice, opacity: ready ? 1 : 0.5, cursor: ready ? "pointer" : "not-allowed" }}>
              <span style={S.bigChoiceTitle}>✎ Create a new question</span>
              <span style={S.bigChoiceSub}>Write a brand-new multiple-choice question by hand.</span>
            </button>
            <button onClick={() => ready && setMode("existing")} disabled={!ready} style={{ ...S.bigChoice, opacity: ready ? 1 : 0.5, cursor: ready ? "pointer" : "not-allowed" }}>
              <span style={S.bigChoiceTitle}>↳ Move existing questions here</span>
              <span style={S.bigChoiceSub}>Search the bank and reassign questions to this scope.</span>
            </button>
          </div>
        )}
        {mode === "create" && (
          <CreateQuestion scope={scope} session={session} rest={rest} headers={headers}
            onBack={() => setMode("menu")} onSaved={onChanged} />
        )}
        {mode === "existing" && (
          <PickExisting scope={scope} session={session} rest={rest} headers={headers}
            onBack={() => setMode("menu")} onMoved={onChanged} />
        )}
      </div>
    </div>
  );
}

function CreateQuestion({ scope, session, rest, headers, onBack, onSaved }) {
  const blank = { question_text: "", choice_a: "", choice_b: "", choice_c: "", choice_d: "", correct_answer: "a", difficulty_level: "medium", source_school: "UPCAT", status: "active" };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  async function save() {
    if (!f.question_text.trim()) { setMsg("Error: question text is required."); return; }
    if (!f.choice_a.trim() || !f.choice_b.trim() || !f.choice_c.trim() || !f.choice_d.trim()) { setMsg("Error: all four choices are required."); return; }
    setBusy(true); setMsg("");
    const body = {
      subject: scope.subject, topic: scope.topic, subtopic: scope.subtopic || null,
      question_text: f.question_text, choice_a: f.choice_a, choice_b: f.choice_b,
      choice_c: f.choice_c, choice_d: f.choice_d, choice_e: null,
      correct_answer: f.correct_answer, difficulty_level: f.difficulty_level,
      source_school: f.source_school, status: f.status,
    };
    const v = validateMathItem(body);
    if (v.checked && !v.valid) body.status = "needs_human_review";
    try {
      const r = await fetch(`${rest}/questions`, {
        method: "POST",
        headers: { ...headers(session.access_token), Prefer: "return=minimal" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      setMsg(v.checked && !v.valid ? `Saved; flagged needs_human_review. ${v.reason}` : "Question added.");
      setF(blank);
      await onSaved?.();
    } catch (e) {
      setMsg("Error: " + e.message);
    }
    setBusy(false);
  }

  return (
    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 10 }}>
      <Field label="Question text"><textarea rows={3} value={f.question_text} onChange={e => set("question_text", e.target.value)} style={{ ...S.input, resize: "vertical" }} /></Field>
      {["a", "b", "c", "d"].map(l => (
        <div key={l} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => set("correct_answer", l)} title="Mark correct"
            style={{ ...S.letter, background: f.correct_answer === l ? "#16a34a" : "#1a2236", color: f.correct_answer === l ? "#fff" : "#94a3b8" }}>{l.toUpperCase()}</button>
          <input value={f[`choice_${l}`]} onChange={e => set(`choice_${l}`, e.target.value)} placeholder={`Choice ${l.toUpperCase()}`} style={S.input} />
        </div>
      ))}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <Field label="Difficulty"><select value={f.difficulty_level} onChange={e => set("difficulty_level", e.target.value)} style={S.input}>{["easy", "medium", "hard"].map(x => <option key={x} value={x}>{x}</option>)}</select></Field>
        <Field label="School"><select value={f.source_school} onChange={e => set("source_school", e.target.value)} style={S.input}>{SCHOOLS.map(x => <option key={x} value={x}>{x}</option>)}</select></Field>
        <Field label="Status"><select value={f.status} onChange={e => set("status", e.target.value)} style={S.input}>{["active", "draft", "retired", "needs_human_review"].map(x => <option key={x} value={x}>{x}</option>)}</select></Field>
      </div>
      {msg && <div style={{ fontSize: 12, color: msg.startsWith("Error") ? "#ef4444" : "#22c55e" }}>{msg}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={save} disabled={busy} style={{ ...S.primary, opacity: busy ? 0.55 : 1 }}>{busy ? "Saving..." : "Add question"}</button>
        <button onClick={onBack} disabled={busy} style={S.cancel}>Back</button>
      </div>
    </div>
  );
}

function PickExisting({ scope, session, rest, headers, onBack, onMoved }) {
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState([]);
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function search() {
    setBusy(true); setMsg("");
    const p = new URLSearchParams();
    p.set("select", "id,question_text,subject,topic,subtopic,difficulty_level");
    p.set("order", "subject.asc,topic.asc");
    p.set("limit", "40");
    const t = term.trim();
    if (t) p.set("question_text", `ilike.*${t}*`);
    else p.set("subject", `eq.${scope.subject}`);
    try {
      const r = await fetch(`${rest}/questions?${p.toString()}`, { headers: headers(session.access_token) });
      if (!r.ok) throw new Error(await r.text());
      setRows(await r.json());
    } catch (e) { setMsg("Error: " + e.message); }
    setBusy(false);
  }

  function toggle(id) {
    setPicked(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function move() {
    if (!picked.size) return;
    setBusy(true); setMsg("");
    const body = { subject: scope.subject, topic: scope.topic, subtopic: scope.subtopic || null };
    try {
      for (const id of picked) {
        const r = await fetch(`${rest}/questions?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH", headers: { ...headers(session.access_token), Prefer: "return=minimal" }, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(await r.text());
      }
      setMsg(`Moved ${picked.size} question${picked.size === 1 ? "" : "s"} here.`);
      setPicked(new Set());
      setRows(rows.filter(q => !picked.has(q.id)));
      await onMoved?.();
    } catch (e) { setMsg("Error: " + e.message); }
    setBusy(false);
  }

  return (
    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={term} onChange={e => setTerm(e.target.value)} onKeyDown={e => e.key === "Enter" && search()}
          placeholder={`Search text (blank = all “${scope.subject}”)`} style={S.input} />
        <button onClick={search} disabled={busy} style={{ ...S.cancel, whiteSpace: "nowrap" }}>{busy ? "..." : "Search"}</button>
      </div>
      <div style={{ maxHeight: 300, overflow: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map(q => (
          <label key={q.id} style={{ ...S.pickRow, borderColor: picked.has(q.id) ? "#f59e0b" : "#1a2236" }}>
            <input type="checkbox" checked={picked.has(q.id)} onChange={() => toggle(q.id)} style={{ accentColor: "#f59e0b", marginTop: 3 }} />
            <span>
              <span style={{ color: "#e2e8f0", fontSize: 12 }}>{(q.question_text || "").slice(0, 120) || "(no text)"}</span>
              <span style={{ display: "block", color: "#475569", fontSize: 10, marginTop: 2 }}>{q.subject} › {q.topic}{q.subtopic ? ` › ${q.subtopic}` : ""} · {q.difficulty_level}</span>
            </span>
          </label>
        ))}
        {!rows.length && <div style={S.hint}>Search to find questions to move here.</div>}
      </div>
      {msg && <div style={{ fontSize: 12, color: msg.startsWith("Error") ? "#ef4444" : "#22c55e" }}>{msg}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={move} disabled={busy || !picked.size} style={{ ...S.primary, opacity: busy || !picked.size ? 0.55 : 1 }}>Move {picked.size || ""} here</button>
        <button onClick={onBack} disabled={busy} style={S.cancel}>Back</button>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return <div><label style={S.label}>{label}</label>{children}</div>;
}

function DeleteBtn({ onClick, disabled, title }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      style={{ ...S.del, opacity: disabled ? 0.3 : 1, cursor: disabled ? "not-allowed" : "pointer" }}>🗑</button>
  );
}

const S = {
  page: { flex: 1, overflow: "auto", background: "#090e18", color: "#e2e8f0", fontFamily: "'DM Sans',system-ui,sans-serif" },
  head: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, padding: "20px 24px", borderBottom: "1px solid #1a2236" },
  h1: { margin: 0, fontSize: 22, fontWeight: 800, color: "#f1f5f9" },
  sub: { margin: "6px 0 0", color: "#64748b", fontSize: 13, maxWidth: 640, lineHeight: 1.5 },
  body: { padding: "16px 24px", display: "flex", flexDirection: "column", gap: 10 },
  empty: { color: "#475569", textAlign: "center", padding: 40, border: "1px dashed #1a2236", borderRadius: 10 },
  msg: { padding: "8px 24px", fontSize: 13, fontWeight: 600 },
  subjectCard: { background: "#0f1629", border: "1px solid #1a2236", borderRadius: 10, padding: "6px 8px" },
  row: { display: "flex", alignItems: "center", gap: 8, padding: "6px 6px" },
  caret: { background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 12, width: 18 },
  subjectName: { fontWeight: 800, fontSize: 15, color: "#f1f5f9" },
  topicWrap: { marginLeft: 22, borderLeft: "1px solid #1a2236", paddingLeft: 8 },
  topicName: { fontWeight: 700, fontSize: 13, color: "#cbd5e1" },
  subtopicRow: { display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", marginLeft: 26 },
  subtopicName: { fontSize: 12, color: "#94a3b8" },
  dot: { color: "#334155", width: 10 },
  count: { fontSize: 10, fontWeight: 700, color: "#475569", background: "#0a0f1a", border: "1px solid #1a2236", borderRadius: 10, padding: "1px 7px" },
  spacer: { flex: 1 },
  hint: { color: "#475569", fontSize: 11, marginLeft: 30, padding: "2px 0 6px" },
  primary: { padding: "9px 18px", background: "#f59e0b", border: "none", borderRadius: 8, color: "#090e18", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  ghost: { padding: "4px 10px", background: "transparent", border: "1px solid #253048", borderRadius: 6, color: "#94a3b8", fontSize: 11, cursor: "pointer" },
  addQ: { padding: "4px 10px", background: "transparent", border: "1px solid #f59e0b", borderRadius: 6, color: "#f59e0b", fontSize: 11, fontWeight: 600, cursor: "pointer" },
  del: { padding: "4px 8px", background: "transparent", border: "1px solid #3f1d2b", borderRadius: 6, color: "#f87171", fontSize: 11 },
  cancel: { padding: "9px 16px", background: "#1a2236", border: "1px solid #253048", borderRadius: 8, color: "#94a3b8", fontSize: 13, cursor: "pointer" },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 },
  modal: { background: "#0f1629", border: "1px solid #1a2236", borderRadius: 14, padding: "24px 26px", width: 480, maxWidth: "95vw", maxHeight: "90vh", overflow: "auto", position: "relative" },
  close: { position: "absolute", top: 14, right: 14, background: "#1a2236", border: "none", borderRadius: 6, color: "#64748b", fontSize: 16, width: 30, height: 30, cursor: "pointer" },
  modalTitle: { margin: "0 0 4px", fontSize: 18, fontWeight: 800, color: "#f1f5f9" },
  modalNote: { margin: "0 0 16px", fontSize: 12, color: "#64748b", lineHeight: 1.5 },
  label: { color: "#475569", fontSize: 10, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase" },
  input: { padding: "9px 12px", background: "#0a0f1a", border: "1px solid #1e293b", borderRadius: 6, color: "#e2e8f0", fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box", marginTop: 4, fontFamily: "inherit" },
  letter: { width: 30, height: 30, flexShrink: 0, borderRadius: 6, border: "none", fontWeight: 800, fontSize: 12, cursor: "pointer" },
  preview: { marginTop: 14, padding: "10px 12px", background: "#0a0f1a", border: "1px solid #1a2236", borderRadius: 8, fontSize: 13, color: "#f59e0b", fontWeight: 600 },
  bigChoice: { display: "flex", flexDirection: "column", gap: 3, textAlign: "left", padding: "12px 14px", background: "#0a0f1a", border: "1px solid #253048", borderRadius: 10, cursor: "pointer" },
  bigChoiceTitle: { color: "#f1f5f9", fontSize: 14, fontWeight: 700 },
  bigChoiceSub: { color: "#64748b", fontSize: 12 },
  pickRow: { display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 10px", background: "#0a0f1a", border: "1px solid #1a2236", borderRadius: 8, cursor: "pointer" },
};
