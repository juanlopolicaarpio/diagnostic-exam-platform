import { useEffect, useMemo, useState } from "react";
import { ChoiceContent } from "./mathContent";
import { QuestionWithUnderline } from "./questionText";
import { MAX_TOTAL, planWaves, svgLooksSafe } from "./useQuestionGeneration";

const SUBJECT_ORDER = [
  "Mathematics",
  "Science",
  "English Language",
  "Reading",
  "Social Studies",
  "Filipino Language",
  "Logic/Abstract Reasoning",
];

function splitKey(value) {
  return String(value || "").split("|||");
}

function hasOptions(opts) {
  return Boolean((opts?.subjects || []).length || (opts?.topics || []).length || (opts?.subtopics || []).length);
}

function buildTree(liveOpts, classOpts, fallbackOpts) {
  const tree = {};
  const addSubject = (subject) => {
    if (!subject) return;
    if (!tree[subject]) tree[subject] = { subject, topics: {} };
  };
  const addTopic = (subject, topic) => {
    if (!subject || !topic) return;
    addSubject(subject);
    if (!tree[subject].topics[topic]) tree[subject].topics[topic] = { subject, topic, subtopics: [] };
  };
  const addSubtopic = (subject, topic, subtopic) => {
    if (!subject || !subtopic) return;
    const safeTopic = topic || subject;
    addTopic(subject, safeTopic);
    if (!tree[subject].topics[safeTopic].subtopics.includes(subtopic)) {
      tree[subject].topics[safeTopic].subtopics.push(subtopic);
    }
  };

  const sources = hasOptions(liveOpts) ? [liveOpts] : [classOpts, fallbackOpts].filter(Boolean);
  sources.forEach(source => {
    (source.subjects || []).forEach(addSubject);
    (source.topics || []).forEach(key => {
      const [subject, topic] = splitKey(key);
      addTopic(subject, topic);
    });
    (source.subtopics || []).forEach(key => {
      const [subject, topic, subtopic] = splitKey(key);
      addSubtopic(subject, topic, subtopic);
    });
  });

  return Object.values(tree)
    .sort((a, b) => {
      const ai = SUBJECT_ORDER.indexOf(a.subject);
      const bi = SUBJECT_ORDER.indexOf(b.subject);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.subject.localeCompare(b.subject);
    })
    .map(subject => ({
      ...subject,
      topics: Object.values(subject.topics)
        .sort((a, b) => a.topic.localeCompare(b.topic))
        .map(topic => ({ ...topic, subtopics: topic.subtopics.sort((a, b) => a.localeCompare(b)) })),
    }));
}

function useCompactLayout() {
  const [compact, setCompact] = useState(() => typeof window !== "undefined" ? window.innerWidth < 900 : false);
  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth < 900);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return compact;
}

export default function QuestionGenerator({ gen, liveOpts, classOpts, fallbackOpts, requestedScope, onScopeConsumed, onUploaded }) {
  const compact = useCompactLayout();
  const tree = useMemo(() => buildTree(liveOpts, classOpts, fallbackOpts), [liveOpts, classOpts, fallbackOpts]);
  const taxonomySource = hasOptions(liveOpts) ? "Live diagnostic exam" : "Fallback taxonomy";

  // Scope + form inputs are local; the generated questions and the in-flight
  // request live in `gen`, which is owned by App so this tab can unmount
  // without killing a running batch.
  const [selected, setSelected] = useState(() => gen.scope || null);
  const [split, setSplit] = useState({ easy: 3, medium: 4, hard: 3 });
  const [standards, setStandards] = useState("");
  const [improveText, setImproveText] = useState({});

  const { questions, busy, progress, msg, improving, uploading } = gen;
  const splitTotal = Number(split.easy) + Number(split.medium) + Number(split.hard);
  const waveCount = planWaves(split).length;
  const overCap = splitTotal > MAX_TOTAL;
  const canGenerate = Boolean(selected) && splitTotal > 0 && !overCap && !busy;

  function selectScope(subject, topic, subtopic = "") {
    setSelected({ subject, topic, subtopic, label: subtopic || topic });
    gen.setMsg("");
  }

  // When the Categories tab sends us here for a specific subtopic, preselect it.
  useEffect(() => {
    if (!requestedScope) return;
    selectScope(requestedScope.subject, requestedScope.topic, requestedScope.subtopic || "");
    onScopeConsumed?.();
  }, [requestedScope, onScopeConsumed]);

  const updateQuestion = gen.updateQuestion;

  async function generate() {
    await gen.generate({ selected, split, standards });
  }

  async function improve(index) {
    const ok = await gen.improve(index, improveText[index]);
    if (ok) setImproveText(prev => ({ ...prev, [index]: "" }));
  }

  async function upload() {
    await gen.upload(onUploaded);
  }

  return (
    <div style={G.page}>
      <div style={{ ...G.hero, gridTemplateColumns: compact ? "1fr" : G.hero.gridTemplateColumns, padding: compact ? "18px 14px" : G.hero.padding }}>
        <div>
          <div style={G.kicker}>AI Question Studio</div>
          <h1 style={G.title}>Adaptive Learning Generator</h1>
          <div style={G.copy}>Choose the same topic and subtopic structure used by the diagnostic results, generate verified drafts, edit them, then upload approved items to the bank.</div>
        </div>
        <div style={G.controls}>
          <label style={G.label}>Difficulty split</label>
          <div style={G.splitRow}>
            {["easy", "medium", "hard"].map(key => (
              <div key={key} style={G.stepper}>
                <span style={G.stepperLabel}>{key}</span>
                <input type="number" min="0" max={MAX_TOTAL} value={split[key]}
                  onChange={e => setSplit(s => ({ ...s, [key]: Math.max(0, Number(e.target.value) || 0) }))}
                  style={G.num} />
              </div>
            ))}
            <span style={{ ...G.total, color: overCap ? "#dc2626" : "#059669" }}>{splitTotal}</span>
          </div>
          <div style={G.hint}>
            {overCap
              ? `Maximum ${MAX_TOTAL} per run.`
              : splitTotal === 0
                ? "Set how many of each difficulty you want."
                : `${splitTotal} question${splitTotal === 1 ? "" : "s"} in ${waveCount} wave${waveCount === 1 ? "" : "s"}. Results appear as each wave finishes.`}
          </div>
          <textarea value={standards} onChange={e => setStandards(e.target.value)} placeholder="Optional extra standards for this batch..." style={G.standardBox} />

          {busy && progress ? (
            <>
              <div style={G.progressTrack}>
                <div style={{ ...G.progressFill, width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
              </div>
              <div style={G.hint}>
                Wave {progress.wave} of {progress.waves} · {progress.done}/{progress.total} verified so far.
                You can switch tabs — this keeps running.
              </div>
              <button onClick={gen.cancel} style={{ ...G.primary, background: "#7f1d1d" }}>Stop after this wave</button>
            </>
          ) : (
            <button onClick={generate} disabled={!canGenerate} style={{ ...G.primary, opacity: canGenerate ? 1 : 0.5 }}>
              {splitTotal > 0 && !overCap ? `Generate ${splitTotal} question${splitTotal === 1 ? "" : "s"}` : "Generate"}
            </button>
          )}
        </div>
      </div>

      {msg && <div style={{ ...G.message, margin: compact ? "12px 14px 0" : G.message.margin, color: msg.startsWith("Error") ? "#991b1b" : "#065f46", background: msg.startsWith("Error") ? "#fef2f2" : "#f0fdf4", borderColor: msg.startsWith("Error") ? "#fecaca" : "#bbf7d0" }}>{msg}</div>}

      <div style={{ ...G.layout, gridTemplateColumns: compact ? "1fr" : G.layout.gridTemplateColumns, padding: compact ? 14 : G.layout.padding }}>
        <section style={G.panel}>
          <div style={G.sectionLabel}>Subject Performance</div>
          <div style={G.help}>{taxonomySource}. Click a topic or subtopic to generate teacher-reviewed bank questions for that area.</div>
          <div style={G.subjectGrid}>
            {tree.map(subject => (
              <div key={subject.subject} style={G.subjectCard}>
                <div style={G.subjectTitle}>{subject.subject}</div>
                <details open={subject.topics.length <= 4} style={{ marginTop: 8 }}>
                  <summary style={G.summary}>Adaptive Learning topics ({subject.topics.length})</summary>
                  <div style={G.topicList}>
                    {subject.topics.map(topic => (
                      <div key={topic.topic} style={G.topicBlock}>
                        <button onClick={() => selectScope(subject.subject, topic.topic)} style={G.topicBtn}>{topic.topic}</button>
                        {topic.subtopics.length > 0 && (
                          <div style={G.subtopics}>
                            {topic.subtopics.map(subtopic => {
                              const active = selected?.subject === subject.subject && selected?.topic === topic.topic && selected?.subtopic === subtopic;
                              return (
                                <button key={subtopic} onClick={() => selectScope(subject.subject, topic.topic, subtopic)} style={{ ...G.subtopicBtn, borderColor: active ? "#2E93FF" : "#dbe3ed", background: active ? "#EFF7FF" : "#ffffff", color: active ? "#170142" : "#475569" }}>
                                  {subtopic}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            ))}
          </div>
        </section>

        <section style={G.drafts}>
          <div style={{ ...G.draftHeader, flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center" }}>
            <div>
              <div style={G.sectionLabel}>Generated Drafts</div>
              <div style={G.selected}>{selected ? `${selected.subject} / ${selected.topic}${selected.subtopic ? ` / ${selected.subtopic}` : ""}` : "No topic selected"}</div>
            </div>
            <button onClick={upload} disabled={uploading || !questions.length || busy} style={{ ...G.upload, opacity: uploading || !questions.length || busy ? 0.5 : 1 }}>
              {uploading ? "Uploading..." : `Upload ${questions.length || ""} as drafts`}
            </button>
          </div>

          {!questions.length ? (
            <div style={G.empty}>Generated questions will appear here for teacher editing.</div>
          ) : (
            <div style={G.questionList}>
              {questions.map((q, index) => (
                <div key={index} style={G.questionCard}>
                  <div style={G.cardTop}>
                    <span style={G.index}>Question {index + 1}</span>
                    <select value={q.difficulty_level} onChange={e => updateQuestion(index, "difficulty_level", e.target.value)} style={G.select}>
                      <option value="easy">easy</option>
                      <option value="medium">medium</option>
                      <option value="hard">hard</option>
                    </select>
                  </div>
                  <textarea value={q.question_text} onChange={e => updateQuestion(index, "question_text", e.target.value)} style={G.questionInput} />
                  {q.stimulus_text && (
                    <div style={G.contextBox}>
                      <div style={G.contextLabel}>Reading passage</div>
                      {q.stimulus_id && <div style={G.contextNote}>Using existing passage ID {q.stimulus_id}</div>}
                      <input value={q.stimulus_title} onChange={e => updateQuestion(index, "stimulus_title", e.target.value)} placeholder="Passage title" style={G.contextInput} />
                      <textarea value={q.stimulus_text} onChange={e => updateQuestion(index, "stimulus_text", e.target.value)} style={G.contextText} />
                    </div>
                  )}
                  {q.svg_content && (
                    <div style={G.contextBox}>
                      <div style={G.contextLabel}>Generated SVG</div>
                      {svgLooksSafe(q.svg_content) ? (
                        <div style={G.svgPreview} dangerouslySetInnerHTML={{ __html: q.svg_content }} />
                      ) : (
                        <div style={G.svgWarning}>SVG did not pass the local safety check.</div>
                      )}
                      <textarea value={q.svg_content} onChange={e => updateQuestion(index, "svg_content", e.target.value)} style={G.contextText} />
                    </div>
                  )}
                  <div style={G.preview}>
                    <QuestionWithUnderline text={q.question_text} choiceA={q.choice_a} subject={q.subject} style={{ color: "#13233d", fontSize: 15, lineHeight: 1.6 }} />
                  </div>
                  {["a", "b", "c", "d"].map(letter => (
                    <div key={letter} style={G.choiceRow}>
                      <span style={{ ...G.choiceLetter, background: q.correct_answer === letter ? "#059669" : "#e2e8f0", color: q.correct_answer === letter ? "#ffffff" : "#334155" }}>{letter.toUpperCase()}</span>
                      <input value={q[`choice_${letter}`]} onChange={e => updateQuestion(index, `choice_${letter}`, e.target.value)} style={G.choiceInput} />
                      <button onClick={() => updateQuestion(index, "correct_answer", letter)} style={G.correctBtn}>Correct</button>
                    </div>
                  ))}
                  <div style={G.answerLine}>
                    Correct answer: <strong>{q.correct_answer.toUpperCase()}</strong>
                  </div>
                  <div style={{ ...G.aiBox, gridTemplateColumns: compact ? "1fr" : G.aiBox.gridTemplateColumns }}>
                    <textarea value={improveText[index] || ""} onChange={e => setImproveText(prev => ({ ...prev, [index]: e.target.value }))} placeholder="Tell AI what to improve for this question..." style={G.aiInput} />
                    <button onClick={() => improve(index)} disabled={improving === index} style={G.aiBtn}>{improving === index ? "Improving..." : "Improve with AI"}</button>
                  </div>
                  <div style={G.choicePreview}>
                    {["a", "b", "c", "d"].map(letter => (
                      <div key={letter} style={G.previewChoice}>
                        <span style={G.choiceLetter}>{letter.toUpperCase()}</span>
                        <ChoiceContent value={q[`choice_${letter}`]} subject={q.subject} style={{ fontSize: 13 }} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const G = {
  page: { flex: 1, overflow: "auto", background: "#f0f4f8", color: "#13233d", fontFamily: "'DM Sans', system-ui, sans-serif" },
  hero: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 420px", gap: 24, padding: "24px 28px", background: "#ffffff", borderBottom: "1px solid #e8edf4" },
  kicker: { color: "#2E93FF", fontSize: 11, fontWeight: 900, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 },
  title: { margin: 0, color: "#170142", fontSize: 32, fontWeight: 900, letterSpacing: 0 },
  copy: { marginTop: 10, color: "#64748b", fontSize: 14, lineHeight: 1.6, maxWidth: 720 },
  controls: { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 14 },
  label: { display: "block", color: "#64748b", fontSize: 10, fontWeight: 900, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 },
  splitRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  stepper: { display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", border: "1px solid #dbe3ed", borderRadius: 6, background: "#ffffff" },
  stepperLabel: { fontSize: 11, color: "#475569", fontWeight: 800, textTransform: "capitalize" },
  num: { width: 44, border: "1px solid #cbd5e1", borderRadius: 5, padding: "5px 4px", color: "#13233d", background: "#ffffff", fontSize: 13 },
  total: { fontWeight: 900, fontSize: 13, marginLeft: 2 },
  hint: { marginTop: 8, color: "#64748b", fontSize: 11, lineHeight: 1.5 },
  progressTrack: { marginTop: 10, height: 6, borderRadius: 999, background: "#e2e8f0", overflow: "hidden" },
  progressFill: { height: "100%", background: "#2E93FF", transition: "width 240ms ease" },
  standardBox: { width: "100%", minHeight: 58, marginTop: 10, resize: "vertical", border: "1px solid #dbe3ed", borderRadius: 6, padding: 10, boxSizing: "border-box", fontFamily: "inherit", color: "#13233d", background: "#ffffff" },
  primary: { marginTop: 10, width: "100%", padding: "11px 16px", border: "none", background: "#1d1148", color: "#ffffff", borderRadius: 7, fontWeight: 900, cursor: "pointer" },
  message: { margin: "14px 28px 0", padding: "10px 14px", border: "1px solid", borderRadius: 8, fontSize: 13, fontWeight: 700 },
  layout: { display: "grid", gridTemplateColumns: "minmax(360px, 0.9fr) minmax(440px, 1.1fr)", gap: 18, padding: 28, alignItems: "start" },
  panel: { background: "#ffffff", border: "1px solid #e8edf4", borderRadius: 8, padding: 18 },
  drafts: { background: "#ffffff", border: "1px solid #e8edf4", borderRadius: 8, padding: 18 },
  sectionLabel: { fontSize: 11, fontWeight: 900, textTransform: "uppercase", letterSpacing: 1, color: "#94a3b8" },
  help: { color: "#64748b", fontSize: 12, marginTop: 6, marginBottom: 14 },
  subjectGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 },
  subjectCard: { background: "#f8fafc", borderRadius: 8, padding: "14px 16px", border: "1px solid #e8edf4" },
  subjectTitle: { fontWeight: 900, color: "#170142", fontSize: 15 },
  summary: { cursor: "pointer", color: "#2E93FF", fontSize: 12, fontWeight: 800, userSelect: "none" },
  topicList: { marginTop: 10 },
  topicBlock: { marginBottom: 10 },
  topicBtn: { background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 12, fontWeight: 800, color: "#2E93FF", textDecoration: "underline", textUnderlineOffset: 2, textAlign: "left", fontFamily: "inherit" },
  subtopics: { display: "flex", flexWrap: "wrap", gap: 5, paddingLeft: 8, marginTop: 6 },
  subtopicBtn: { maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "4px 8px", borderRadius: 4, fontSize: 10, fontWeight: 800, cursor: "pointer", border: "1px solid #dbe3ed", fontFamily: "inherit" },
  draftHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 },
  selected: { color: "#170142", fontSize: 14, fontWeight: 900, marginTop: 4 },
  upload: { padding: "9px 14px", border: "none", background: "#f59e0b", color: "#090e18", borderRadius: 7, fontSize: 13, fontWeight: 900, cursor: "pointer" },
  empty: { color: "#64748b", textAlign: "center", padding: 40, background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 8 },
  questionList: { display: "flex", flexDirection: "column", gap: 14 },
  questionCard: { border: "1px solid #e2e8f0", borderRadius: 8, padding: 14, background: "#ffffff" },
  cardTop: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  index: { fontSize: 12, color: "#170142", fontWeight: 900 },
  select: { border: "1px solid #cbd5e1", borderRadius: 6, padding: "5px 8px", color: "#13233d", background: "#ffffff", fontWeight: 700 },
  questionInput: { width: "100%", minHeight: 74, border: "1px solid #dbe3ed", borderRadius: 6, padding: 10, boxSizing: "border-box", resize: "vertical", fontFamily: "inherit", color: "#13233d", background: "#ffffff" },
  preview: { padding: 10, background: "#f8fafc", borderRadius: 6, margin: "8px 0 10px" },
  contextBox: { padding: 10, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, margin: "8px 0 10px" },
  contextLabel: { color: "#64748b", fontSize: 10, fontWeight: 900, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 7 },
  contextNote: { color: "#475569", fontSize: 11, fontWeight: 800, marginBottom: 8 },
  contextInput: { width: "100%", border: "1px solid #dbe3ed", borderRadius: 6, padding: "8px 9px", color: "#13233d", background: "#ffffff", boxSizing: "border-box", marginBottom: 8 },
  contextText: { width: "100%", minHeight: 92, border: "1px solid #dbe3ed", borderRadius: 6, padding: 9, color: "#13233d", background: "#ffffff", boxSizing: "border-box", fontFamily: "inherit", resize: "vertical" },
  svgPreview: { background: "#ffffff", border: "1px solid #dbe3ed", borderRadius: 6, padding: 8, marginBottom: 8, overflow: "auto", maxHeight: 280 },
  svgWarning: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 6, padding: 9, marginBottom: 8, fontSize: 12, fontWeight: 800 },
  choiceRow: { display: "grid", gridTemplateColumns: "30px minmax(0,1fr) auto", gap: 8, alignItems: "center", marginBottom: 7 },
  choiceLetter: { width: 26, height: 26, borderRadius: 6, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 900, background: "#e2e8f0", color: "#334155", flexShrink: 0 },
  choiceInput: { border: "1px solid #dbe3ed", borderRadius: 6, padding: "8px 9px", color: "#13233d", background: "#ffffff", minWidth: 0 },
  correctBtn: { border: "1px solid #cbd5e1", borderRadius: 6, background: "#ffffff", color: "#475569", fontSize: 11, fontWeight: 800, cursor: "pointer", padding: "8px 9px" },
  answerLine: { color: "#475569", fontSize: 12, marginTop: 8, marginBottom: 10 },
  aiBox: { display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 8, alignItems: "stretch" },
  aiInput: { minHeight: 46, resize: "vertical", border: "1px solid #dbe3ed", borderRadius: 6, padding: 9, fontFamily: "inherit", color: "#13233d", background: "#ffffff" },
  aiBtn: { border: "none", borderRadius: 7, background: "#1d1148", color: "#ffffff", padding: "0 13px", fontWeight: 900, cursor: "pointer" },
  choicePreview: { display: "grid", gap: 6, marginTop: 10 },
  previewChoice: { display: "flex", gap: 8, alignItems: "center", padding: "7px 9px", borderRadius: 6, background: "#f8fafc", color: "#334155", fontSize: 13 },
};
