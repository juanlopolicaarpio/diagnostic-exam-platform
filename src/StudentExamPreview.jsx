import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChoiceContent, MathContent } from "./mathContent";
import { VisualAssetPreview, questionInlineVisualAssets } from "./visualContent";
import { QuestionWithUnderline } from "./questionText";

const URL_BASE = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, "");
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const REST = `${URL_BASE}/rest/v1`;
const FUNCTIONS = `${URL_BASE}/functions/v1`;
const STORAGE = `${URL_BASE}/storage/v1/object/public`;

const STUDENT_EMAIL = "admin preview account";
const ARCHIVE_TEMPLATE_CODE = "__DELETED_EXAM_SESSIONS__";
const SECTION_ORDER = ["language", "reading", "math", "science", "social_studies", "logic"];
const SECTION_LABELS = {
  math: "Math",
  science: "Science",
  language: "Language",
  reading: "Reading",
  social_studies: "Social Studies",
  logic: "Logic / Abstract Reasoning",
};
const SECTION_MINUTES = {
  math: 60,
  science: 60,
  language: 45,
  reading: 45,
  social_studies: 25,
  logic: 25,
};
const DIFFICULTY_PILL = {
  easy: { bg: "#f0fdf4", border: "#a7f3d0", color: "#15803d", label: "Easy" },
  medium: { bg: "#fffbeb", border: "#fde68a", color: "#b45309", label: "Medium" },
  hard: { bg: "#fef2f2", border: "#fecaca", color: "#b91c1c", label: "Hard" },
};

function difficultyPillMeta(value) {
  const key = String(value || "").trim().toLowerCase();
  return DIFFICULTY_PILL[key === "difficult" ? "hard" : key] || null;
}

function authHeaders(token) {
  return { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function normalizeSection(value) {
  const key = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (key === "social") return "social_studies";
  if (key === "abstract_reasoning") return "logic";
  return SECTION_ORDER.includes(key) ? key : SECTION_ORDER[0];
}

function getQuestionId(q) {
  return q?.session_question_id;
}

function normalizeQuestionRow(row, section, index) {
  return {
    ...row,
    section_name: section,
    _previewKey: row.session_question_id || `${section}-${row.display_order || index + 1}`,
    _vis: row.visual_assets || [],
  };
}

function getDirectQuestionId(q) {
  if (q?.question_id) return q.question_id;
  if (q?.question?.id) return q.question.id;
  if (q?.questions?.id) return q.questions.id;
  if (q?.id && !q?.session_question_id) return q.id;
  return null;
}

function mergeVisualAssets(...lists) {
  const merged = [];
  const seen = new Set();
  lists.flat().filter(Boolean).forEach(asset => {
    const raw = asset.visual_assets || asset;
    const key = asset.id || raw.id || raw.asset_key || raw.storage_path || raw.file_path || raw.path || JSON.stringify(asset);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(asset);
  });
  return merged;
}

function getAnswerKey(q) {
  return getQuestionId(q) || q?._previewKey;
}

function getChoiceValue(q, letter) {
  const lower = letter.toLowerCase();
  return q?.choices?.[lower] || q?.choices?.[letter.toUpperCase()] || q?.[`choice_${lower}`] || "";
}

function getChoiceA(q) {
  return getChoiceValue(q, "a");
}

function getAvailableAnswerLetters(q) {
  return ["A", "B", "C", "D", "E"].filter(letter => getChoiceValue(q, letter));
}

function getQuestionText(q) {
  return q?.question_text || "";
}

// For render_markup questions the full question_text is not shown.
// If the question is an error-identification type, show a clear directive.
function getSegInstruction(q) {
  if (!q?.render_markup) return null;
  const text = String(q?.question_text || "").trim();
  if (/find the error in the sentence\.?/i.test(text)) {
    return "Select the underlined word or phrase that contains a grammatical error.";
  }
  return null;
}

function getRenderSubject(q) {
  const sectionSubject = SECTION_LABELS[sectionFromQuestion(q)];
  return q?.subject || q?.subject_name || q?.course_subject || sectionSubject;
}

function resultNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pct(value) {
  return `${Math.round(Math.max(0, Math.min(100, resultNumber(value))))}%`;
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatPreviewError(message) {
  const text = String(message || "The live preview could not be prepared.").trim();
  const sectionMatch = text.match(/Section\s+"?([^".]+)"?\s+is not available yet\.\s+Current section:\s*([^.\s]+)/i);
  if (sectionMatch) {
    const requested = SECTION_LABELS[normalizeSection(sectionMatch[1])] || sectionMatch[1];
    const current = SECTION_LABELS[normalizeSection(sectionMatch[2])] || sectionMatch[2];
    return `The ${requested} section has not been set up yet. You are currently viewing ${current}.`;
  }
  return text;
}

function isReadyToFinalizeError(message) {
  return /ready_to_finalize|ready to finalize/i.test(String(message || ""));
}

function isSectionLockedError(message) {
  return /section .*already been submitted|already submitted and locked|section has been submitted|submitted and locked/i.test(String(message || ""));
}

function isSectionMismatchError(message) {
  return /cannot submit section .*current section:/i.test(String(message || ""));
}

function currentSectionFromMismatchError(message) {
  const match = String(message || "").match(/current section:\s*([a-z_ -]+)/i);
  return match ? normalizeSection(match[1]) : null;
}

function isAnswerRepairableError(message) {
  return isReadyToFinalizeError(message) || /session status|question is locked|section has been submitted/i.test(String(message || ""));
}

function sectionIsCompleted(row) {
  return row?.status === "completed" || Boolean(row?.submitted_at);
}

function submittedMapFromSectionRows(rows) {
  const map = {};
  (Array.isArray(rows) ? rows : []).forEach(row => {
    if (sectionIsCompleted(row)) map[normalizeSection(row.section_name)] = "submitted";
  });
  return map;
}

function firstIncompleteSection(rows) {
  const bySection = Object.fromEntries((Array.isArray(rows) ? rows : []).map(row => [normalizeSection(row.section_name), row]));
  return SECTION_ORDER.find(item => !sectionIsCompleted(bySection[item]));
}

function sectionFromQuestion(q) {
  if (q.section || q.section_name || q.exam_section) return normalizeSection(q.section || q.section_name || q.exam_section);
  const subject = String(q.subject || "").toLowerCase();
  if (subject.includes("math")) return "math";
  if (subject.includes("science")) return "science";
  if (subject.includes("english") || subject.includes("filipino") || subject.includes("language")) return "language";
  if (subject.includes("reading")) return "reading";
  if (subject.includes("social")) return "social_studies";
  if (subject.includes("logic") || subject.includes("abstract")) return "logic";
  return "math";
}

const SEGMENT_COLORS = {
  A: { border: "#ef4444" },
  B: { border: "#3b82f6" },
  C: { border: "#22c55e" },
  D: { border: "#f59e0b" },
};

function cleanSegmentDisplayText(value) {
  return String(value || "")
    .replace(/\s*(?:<-)\s*error\b/gi, "")
    .replace(/\s*\[error\]/gi, "")
    .replace(/\s*\(error\)/gi, "")
    .replace(/\s+\berror\b(?=\s|$)/gi, "")
    .replace(/\s{2,}/g, " ");
}

function SegMarkup({ markup }) {
  if (!markup) return null;
  const parts = [];
  const rx = /<seg\s+choice='([A-D])'>(.*?)<\/seg>/g;
  let match;
  let last = 0;
  while ((match = rx.exec(markup)) !== null) {
    if (match.index > last) parts.push({ type: "text", content: cleanSegmentDisplayText(markup.slice(last, match.index)) });
    parts.push({ type: "segment", choice: match[1], content: cleanSegmentDisplayText(match[2]) });
    last = rx.lastIndex;
  }
  if (last < markup.length) parts.push({ type: "text", content: cleanSegmentDisplayText(markup.slice(last)) });

  return (
    <div style={{ fontSize: 16, lineHeight: 2.3, color: "#13233d" }}>
      {parts.map((part, i) => {
        if (part.type === "text") return <span key={i}>{part.content}</span>;
        const color = SEGMENT_COLORS[part.choice]?.border || "#64748b";
        return (
          <span key={i} style={{
            borderBottom: `2px solid ${color}`,
            padding: "12px 3px 1px",
            margin: "0 2px",
            color: "inherit",
            fontWeight: 400,
            position: "relative",
            display: "inline-block",
            lineHeight: 1.45,
          }}>
            <span style={{ position: "absolute", top: 0, left: 3, fontSize: 9, lineHeight: 1, fontWeight: 700, color }}>{part.choice}</span>
            {part.content}
          </span>
        );
      })}
    </div>
  );
}

function shortCode(code) {
  const s = String(code || "");
  if (s.length <= 5) return s;
  return s.split(/[\s_\-]+/).filter(Boolean).map(w => w[0]).join("").toUpperCase().slice(0, 4);
}

export function ResultsView({ resultModel, template, onReset, onClose, adminToken, mockQuestions }) {
  const [practiceMode, setPracticeMode] = useState(null);

  if (practiceMode) {
    return (
      <PracticeQuiz
        subject={practiceMode.subject}
        topic={practiceMode.topic}
        subtopic={practiceMode.subtopic}
        label={practiceMode.label}
        adminToken={adminToken}
        onBack={() => setPracticeMode(null)}
        mockQuestions={mockQuestions}
      />
    );
  }

  if (!resultModel) return null;

  const rec = resultModel.recommendations;
  const TIER = {
    "Advanced":      { color: "#059669", track: "#d1fae5", label: "#065f46" },
    "Proficient":    { color: "#2563eb", track: "#dbeafe", label: "#1e40af" },
    "Developing":    { color: "#2E93FF", track: "#EFF7FF", label: "#170142" },
    "Not Yet Ready": { color: "#dc2626", track: "#fee2e2", label: "#991b1b" },
  };
  const tierMeta = TIER[resultModel.tier] || { color: "#64748b", track: "#f1f5f9", label: "#334155" };

  const masteryColor = { "Advanced": "#059669", "Proficient": "#2563eb", "Developing": "#d97706", "Needs Improvement": "#dc2626" };
  const masteryBg = { "Advanced": "#f0fdf4", "Proficient": "#eff6ff", "Developing": "#fffbeb", "Needs Improvement": "#fff1f2" };
  const masteryBorder = { "Advanced": "#a7f3d0", "Proficient": "#bfdbfe", "Developing": "#fde68a", "Needs Improvement": "#fecdd3" };
  const profileColor = { "High Probability": "#059669", "Moderate Probability": "#d97706", "Low Probability": "#dc2626" };
  const profileBg = { "High Probability": "#f0fdf4", "Moderate Probability": "#fffbeb", "Low Probability": "#fff1f2" };
  const profileBorder = { "High Probability": "#a7f3d0", "Moderate Probability": "#fde68a", "Low Probability": "#fecdd3" };

  const scoreColorFn = (s) => s >= 70 ? "#059669" : s >= 40 ? "#d97706" : "#dc2626";

  const GAUGE_R = 90; const GAUGE_CX = 110; const GAUGE_CY = 115;
  const circ = 2 * Math.PI * GAUGE_R;
  const arcLen = circ * 0.75;
  const fill = arcLen * Math.min(1, Math.max(0, resultModel.readinessScore / 100));
  const gaugeTransform = `rotate(135 ${GAUGE_CX} ${GAUGE_CY})`;

  const gapCount = rec.weaknesses?.length || 0;

  return (
    <div style={{ ...S.page, background: "#f0f4f8" }}>
      <header style={{ ...S.topbar, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#170142", fontFamily: "'Sora', system-ui, sans-serif" }}>{template?.code || "Exam"} — Results</div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2, fontFamily: "'Sora', system-ui, sans-serif" }}>{resultModel.startedAt && new Date(resultModel.startedAt).toLocaleString()}</div>
        </div>
        <div style={S.actions}>
          <button onClick={onReset} style={{ ...S.ghost, border: "1px solid #170142", color: "#170142" }}>Retake preview</button>
          <button onClick={onClose} style={S.ghost}>Exit</button>
        </div>
      </header>

      <main style={{ padding: "24px 28px", maxWidth: 1200, margin: "0 auto" }}>

        {/* ── HERO: Full-width score + readiness ── */}
        <div style={{ ...SR.card, marginBottom: 20, display: "grid", gridTemplateColumns: "auto 1fr", gap: 32, alignItems: "center" }}>
          <div style={{ textAlign: "center", flexShrink: 0 }}>
            <svg width="220" height="210" viewBox="0 0 220 230" style={{ display: "block", margin: "0 auto" }}>
              <circle cx={GAUGE_CX} cy={GAUGE_CY} r={GAUGE_R} fill="none" stroke={tierMeta.track} strokeWidth="24"
                strokeDasharray={`${arcLen} ${circ - arcLen}`} strokeLinecap="round" transform={gaugeTransform} />
              <circle cx={GAUGE_CX} cy={GAUGE_CY} r={GAUGE_R} fill="none" stroke={tierMeta.color} strokeWidth="24"
                strokeDasharray={`${fill} ${circ - fill}`} strokeLinecap="round" transform={gaugeTransform}
                style={{ transition: "stroke-dasharray 0.6s ease" }} />
              <text x={GAUGE_CX} y={GAUGE_CY - 8} textAnchor="middle" fontSize="58" fontWeight="900" fill="#0f172a" fontFamily="'Sora',system-ui,sans-serif">{Math.round(resultModel.readinessScore)}</text>
              <text x={GAUGE_CX} y={GAUGE_CY + 18} textAnchor="middle" fontSize="13" fill="#94a3b8" fontFamily="'Sora',system-ui,sans-serif">out of 100</text>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1, color: "#94a3b8", marginBottom: 10 }}>Readiness Score</div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "6px 16px", borderRadius: 999, background: tierMeta.track, marginBottom: 16 }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: tierMeta.color, flexShrink: 0 }} />
              <span style={{ fontSize: 16, fontWeight: 900, color: tierMeta.label }}>{resultModel.tier || "Score"}</span>
            </div>
            {resultModel.overallPercentile !== null && (
              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>
                Top <strong style={{ color: "#0f172a" }}>{100 - resultModel.overallPercentile}%</strong> of test takers &nbsp;·&nbsp; P{resultModel.overallPercentile}
              </div>
            )}
            <div style={{ padding: "16px 20px", borderRadius: 12, background: tierMeta.track, border: `1px solid ${tierMeta.color}40`, maxWidth: 500 }}>
              <div style={{ fontSize: 15, fontWeight: 900, color: tierMeta.label, marginBottom: 5 }}>{resultModel.tier || "Your result"}</div>
              {gapCount > 0 ? (
                <div style={{ fontSize: 13, color: tierMeta.label, lineHeight: 1.55 }}>
                  You have <strong>{gapCount} priority gap{gapCount !== 1 ? "s" : ""}</strong> to address. Work through the subject breakdown below to start closing them.
                </div>
              ) : resultModel.readinessMessage ? (
                <div style={{ fontSize: 13, color: tierMeta.label, lineHeight: 1.55 }}>{resultModel.readinessMessage}</div>
              ) : null}
            </div>
            {resultModel.readinessMessage && gapCount > 0 && (
              <div style={{ marginTop: 10, padding: "10px 14px", background: "#f8fafc", borderRadius: 10, fontSize: 12, color: "#475569", lineHeight: 1.65, maxWidth: 500 }}>
                {resultModel.readinessMessage}
              </div>
            )}
          </div>
        </div>

        {/* ── Study Focus ── */}
        {rec.study_focus && (
          <div style={{ marginBottom: 20, padding: "18px 24px", background: "#EFF7FF", border: "1px solid rgba(46,147,255,0.25)", borderRadius: 14, display: "flex", alignItems: "flex-start", gap: 16 }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, background: "rgba(46,147,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#170142" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.8, color: "#2E93FF", marginBottom: 5 }}>Study Focus</div>
              <div style={{ fontSize: 14, color: "#170142", lineHeight: 1.65, fontWeight: 500 }}>{rec.study_focus}</div>
            </div>
          </div>
        )}

        {/* ── Top Course Fit ── */}
        {resultModel.primary && (
          <div style={{ ...SR.card, marginBottom: 20 }}>
            <div style={SR.sectionLabel}>Top Course Fit</div>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 14, marginBottom: rec.alternatives?.length > 0 ? 18 : 0 }}>
              <div style={{ width: 52, height: 52, borderRadius: 14, background: tierMeta.track, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 900, color: tierMeta.label, flexShrink: 0 }}>
                {shortCode(resultModel.primary.code)}
              </div>
              <div>
                <div style={{ fontSize: 22, fontWeight: 900, color: "#0f172a", lineHeight: 1.2 }}>{resultModel.primary.name}</div>
                <div style={{ fontSize: 14, color: tierMeta.color, fontWeight: 800, marginTop: 3 }}>Fit score: {+(resultModel.primary.fit_score || 0).toFixed(1)}</div>
              </div>
            </div>
            {rec.alternatives?.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>Also a strong fit</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {rec.alternatives.map(a => (
                    <div key={a.code} style={{ padding: "10px 16px", borderRadius: 10, background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                      <div style={{ fontWeight: 800, color: "#0f172a", fontSize: 13 }}>{a.name}</div>
                      <div style={{ color: "#64748b", fontSize: 12, marginTop: 2 }}>Fit: {+(a.fit_score || 0).toFixed(1)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Subject Performance ── */}
        <div style={{ ...SR.card, marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 6 }}>
            <div style={SR.sectionLabel}>Subject Performance</div>
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              {[["#dc2626", "Below 40%"], ["#d97706", "40–69%"], ["#059669", "70%+"]].map(([color, label]) => (
                <span key={label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748b" }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: "inline-block", flexShrink: 0 }} />
                  {label}
                </span>
              ))}
            </div>
          </div>
          <div style={{ color: "#64748b", fontSize: 12, marginBottom: 16 }}>Click a topic or subtopic to open Adaptive Learning practice questions for that area.</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
            {resultModel.subjects.map(subj => {
              const scoreColor = scoreColorFn(subj.weighted_score || 0);
              const subjectTopics = subj.topics.filter(t => t.topic);
              return (
                <div key={subj.subject} style={{ background: "#f8fafc", borderRadius: 12, padding: "16px 20px", border: "1px solid #e8edf4" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                    <div>
                      <div style={{ fontWeight: 900, color: "#170142", fontSize: 15 }}>{subj.subject}</div>
                      {subj.percentile !== null && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>P{subj.percentile}</div>}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 24, fontWeight: 900, color: scoreColor, lineHeight: 1 }}>{Math.round(subj.weighted_score || 0)}%</div>
                      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{subj.raw_correct}/{subj.raw_total} correct</div>
                    </div>
                  </div>
                  <div style={{ height: 10, background: "#e2e8f0", borderRadius: 999, overflow: "hidden", marginBottom: 12 }}>
                    <div style={{ height: "100%", width: `${Math.min(100, subj.weighted_score || 0)}%`, background: scoreColor, borderRadius: 999, transition: "width 0.5s ease" }} />
                  </div>
                  {subjectTopics.length > 0 && (
                    <details style={{ marginTop: 2 }}>
                      <summary style={{ cursor: "pointer", color: "#2E93FF", fontSize: 12, fontWeight: 800, userSelect: "none" }}>
                        Adaptive Learning topics ({subjectTopics.length})
                      </summary>
                      <div style={{ marginTop: 10 }}>
                        {subjectTopics.map(topic => {
                          const tc = scoreColorFn(topic.weighted_score || 0);
                          const subs = resultModel.subtopicsByKey[`${topic.subject}|||${topic.topic}`] || [];
                          return (
                            <div key={topic.topic} style={{ marginBottom: 10 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                                <button onClick={() => setPracticeMode({ subject: subj.subject, topic: topic.topic, label: topic.topic })} title={`Practice ${topic.topic}`} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 12, fontWeight: 700, color: "#2E93FF", textDecoration: "underline", textUnderlineOffset: 2, textAlign: "left", fontFamily: "inherit" }}>{topic.topic}</button>
                                <span style={{ fontSize: 11, color: "#94a3b8", flexShrink: 0, marginLeft: 8 }}>{topic.raw_correct}/{topic.raw_total}</span>
                              </div>
                              <div style={{ height: 4, background: "#e2e8f0", borderRadius: 999, overflow: "hidden", marginBottom: subs.length ? 6 : 0 }}>
                                <div style={{ height: "100%", width: `${Math.min(100, topic.weighted_score || 0)}%`, background: tc, borderRadius: 999 }} />
                              </div>
                              {subs.length > 0 && (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, paddingLeft: 8, marginTop: 4 }}>
                                  {subs.filter(st => st.subtopic).map(st => (
                                    <button key={st.subtopic} onClick={() => setPracticeMode({ subject: st.subject, topic: st.topic, subtopic: st.subtopic, label: st.subtopic })} title={`Practice ${st.subtopic}`} style={{
                                      maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                      padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: "pointer",
                                      background: masteryBg[st.mastery_band] || "#f8fafc",
                                      border: `1px solid ${masteryBorder[st.mastery_band] || "#e2e8f0"}`,
                                      color: masteryColor[st.mastery_band] || "#64748b",
                                      fontFamily: "inherit",
                                    }}>
                                      {st.subtopic} <span style={{ opacity: 0.65 }}>· {st.raw_correct}/{st.raw_total}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Strengths & Gaps ── */}
        {(rec.strengths?.length > 0 || rec.weaknesses?.length > 0) && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
            {rec.strengths?.length > 0 && (
              <div style={SR.card}>
                <div style={{ ...SR.sectionLabel, color: "#065f46" }}>Strengths</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
                  {rec.strengths.map((s, i) => (
                    <span key={i} style={{ padding: "5px 10px", borderRadius: 6, background: "#f0fdf4", border: "1px solid #a7f3d0", color: "#065f46", fontSize: 12, fontWeight: 700 }}>{s}</span>
                  ))}
                </div>
              </div>
            )}
            {rec.weaknesses?.length > 0 && (
              <div style={SR.card}>
                <div style={{ ...SR.sectionLabel, color: "#9f1239" }}>Priority Gaps</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
                  {rec.weaknesses.map((w, i) => (
                    <span key={i} style={{ padding: "5px 10px", borderRadius: 6, background: "#fff1f2", border: "1px solid #fecdd3", color: "#9f1239", fontSize: 12, fontWeight: 700 }}>{w}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── University Predictions + Course Fit ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
          <div style={SR.card}>
            <div style={SR.sectionLabel}>University Predictions</div>
            <div style={{ marginTop: 4, fontSize: 12, color: "#94a3b8", marginBottom: 14 }}>Improving your subject scores will increase your admission chances.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {resultModel.predictions.map(p => (
                <div key={p.university} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderRadius: 10, background: profileBg[p.profile] || "#f8fafc", border: `1px solid ${profileBorder[p.profile] || "#e2e8f0"}` }}>
                  <span style={{ fontWeight: 900, color: "#0f172a", fontSize: 14, marginRight: 12 }}>{p.university}</span>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 18, fontWeight: 900, color: profileColor[p.profile] || "#64748b" }}>{+(p.predictive_index || 0).toFixed(1)}%</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: profileColor[p.profile] || "#64748b" }}>{p.profile}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div style={SR.card}>
            <div style={SR.sectionLabel}>Course Fit Rankings</div>
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
              {[...resultModel.classifications].sort((a, b) => b.fit_score - a.fit_score).map((c, i) => (
                <div key={c.code}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5, gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span style={{ width: 24, height: 24, borderRadius: 6, background: i === 0 ? tierMeta.color : "#e2e8f0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 900, color: i === 0 ? "#fff" : "#64748b", flexShrink: 0 }}>{i + 1}</span>
                      <span style={{ fontSize: 13, fontWeight: 800, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                      <span style={{ fontSize: 14, fontWeight: 900, color: i === 0 ? tierMeta.color : "#334155" }}>{+(c.fit_score || 0).toFixed(1)}</span>
                      {c.percentile !== null && <span style={{ fontSize: 10, color: "#94a3b8", background: "#f1f5f9", padding: "2px 6px", borderRadius: 4, whiteSpace: "nowrap" }}>P{c.percentile}</span>}
                    </div>
                  </div>
                  <div style={{ height: 5, background: "#e8edf4", borderRadius: 999, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(100, ((c.fit_score || 0) / 30) * 100)}%`, background: i === 0 ? tierMeta.color : "#cbd5e1", borderRadius: 999 }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

      </main>
    </div>
  );
}

export default function StudentExamPreview({ adminSession, template, onClose, onEditQuestion, initialResults }) {
  const storageKey = `student_preview_${template?.id || template?.code || "draft"}`;
  const [studentSession, setStudentSession] = useState(null);
  const [mode, setMode] = useState(initialResults ? "live" : "loading");
  const [status, setStatus] = useState("Signing in to student preview...");
  const [error, setError] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [grouped, setGrouped] = useState(() => Object.fromEntries(SECTION_ORDER.map(section => [section, []])));
  const [section, setSection] = useState(SECTION_ORDER[0]);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [marked, setMarked] = useState({});
  const [submitted, setSubmitted] = useState({});
  const [started, setStarted] = useState(false);
  const [remaining, setRemaining] = useState({});
  const [results, setResults] = useState(initialResults || null);
  const [busy, setBusy] = useState(false);
  const [practiceMode, setPracticeMode] = useState(null); // { subject, topic, subtopic, label }
  const pendingSave = useRef({});
  // Which template we've already booted. bootPreview is destructive (it archives
  // sessions, re-assembles the exam and clears every answer), so it must run once
  // per template — not every time its identity changes. It depends on adminSession,
  // which gets a brand-new object each time the admin token refreshes, and that
  // would otherwise restart the exam mid-attempt.
  const bootedFor = useRef(null);
  // Always-current admin token. loginStudent copies adminSession.access_token into
  // studentSession at boot, so that copy goes stale when the token rotates.
  const liveTokenRef = useRef(adminSession?.access_token || null);

  const activeQuestions = grouped[section] || [];
  const current = activeQuestions[index] || null;
  const sections = SECTION_ORDER;
  const answeredCount = activeQuestions.filter(q => answers[getAnswerKey(q)]).length;
  const markedCount = activeQuestions.filter(q => marked[getAnswerKey(q)]).length;
  const unansweredCount = Math.max(0, activeQuestions.length - answeredCount);
  const canSubmitActiveSection = activeQuestions.length > 0 && unansweredCount === 0;
  const allSubmitted = sections.length > 0 && sections.every(item => submitted[item]);

  const loginStudent = useCallback(async () => {
    if (!adminSession?.access_token) throw new Error("Admin session is required for student preview.");
    return { token: adminSession.access_token, user: adminSession.user, email: STUDENT_EMAIL };
  }, [adminSession]);

  const callFunction = useCallback(async (token, path, options = {}) => {
    const res = await fetch(`${FUNCTIONS}${path}`, {
      ...options,
      headers: { ...authHeaders(token), ...(options.headers || {}) },
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(data?.message || data?.error_description || data?.error || text || `${path} failed`);
    return data;
  }, []);

  // Prepare sessions for this template so assemble-exam can reuse exactly one via
  // reset:true. Patch the most-recent session to in_progress (assemble-exam reuses it),
  // Move all existing sessions for this template to the archive template so assemble-exam
  // sees a clean slate and doesn't hit the retake limit. Sessions can't be deleted (RLS
  // blocks it), so they're re-parented to a dummy template that the retake check ignores —
  // the same approach deleteTemplate uses.
  const resetStudentPreviewSessions = useCallback(async (studentToken, templateId) => {
    if (!templateId) return;
    const h = { apikey: KEY, Authorization: `Bearer ${studentToken}`, "Content-Type": "application/json", Prefer: "return=minimal" };

    // Find or create the archive template.
    const archiveCheckRes = await fetch(
      `${REST}/diagnostic_templates?code=eq.${encodeURIComponent(ARCHIVE_TEMPLATE_CODE)}&select=id&limit=1`,
      { headers: h }
    );
    if (!archiveCheckRes.ok) throw new Error(await archiveCheckRes.text() || "Could not inspect archive template.");
    const archiveRows = await archiveCheckRes.json();
    let archiveId = Array.isArray(archiveRows) ? archiveRows[0]?.id : null;

    if (!archiveId) {
      const createRes = await fetch(`${REST}/diagnostic_templates`, {
        method: "POST",
        headers: { ...h, Prefer: "return=representation" },
        body: JSON.stringify({ code: ARCHIVE_TEMPLATE_CODE, version: 1, total_questions: 0, is_active: false }),
      });
      if (!createRes.ok) throw new Error(await createRes.text() || "Could not create archive template.");
      const created = await createRes.json();
      archiveId = Array.isArray(created) ? created[0]?.id : created?.id;
    }
    if (!archiveId) throw new Error("Could not resolve archive template.");

    // Re-parent all sessions for this template to the archive.
    const sessRes = await fetch(
      `${REST}/diagnostic_sessions?select=id&template_id=eq.${encodeURIComponent(templateId)}`,
      { headers: h }
    );
    if (!sessRes.ok) throw new Error(await sessRes.text() || "Could not inspect existing preview sessions.");
    const sessions = await sessRes.json();
    const list = Array.isArray(sessions) ? sessions : [];
    if (!list.length) return;

    const idList = list.map(s => encodeURIComponent(s.id)).join(",");
    const moveRes = await fetch(`${REST}/diagnostic_sessions?id=in.(${idList})`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ template_id: archiveId }),
    });
    if (!moveRes.ok) throw new Error(await moveRes.text() || "Could not archive existing preview sessions.");
  }, []);

  const unlockLiveQuestions = useCallback(async (token, sid, targetSection = null) => {
    const sectionFilter = targetSection ? `&section_name=eq.${encodeURIComponent(targetSection)}` : "";
    const res = await fetch(`${REST}/session_questions?session_id=eq.${encodeURIComponent(sid)}${sectionFilter}`, {
      method: "PATCH",
      headers: { ...authHeaders(token), Prefer: "return=minimal" },
      body: JSON.stringify({ locked: false }),
    });
    if (!res.ok) throw new Error(await res.text() || "Could not unlock preview questions.");
  }, []);

  const resetLiveSectionTimer = useCallback(async (token, sid, targetSection) => {
    const res = await fetch(`${REST}/session_sections?session_id=eq.${encodeURIComponent(sid)}&section_name=eq.${encodeURIComponent(targetSection)}`, {
      method: "PATCH",
      headers: { ...authHeaders(token), Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "in_progress",
        started_at: new Date().toISOString(),
        submitted_at: null,
      }),
    });
    if (!res.ok) throw new Error(await res.text() || `${SECTION_LABELS[targetSection]} timer reset failed.`);
    try {
      await unlockLiveQuestions(token, sid, targetSection);
    } catch {
      // Fall through to the full-session unlock below.
    }
    await unlockLiveQuestions(token, sid);
  }, [unlockLiveQuestions]);

  const resetLivePreviewSession = useCallback(async (token, sid) => {
    const sessionRes = await fetch(`${REST}/diagnostic_sessions?id=eq.${encodeURIComponent(sid)}`, {
      method: "PATCH",
      headers: { ...authHeaders(token), Prefer: "return=minimal" },
      body: JSON.stringify({ status: "in_progress", current_section: SECTION_ORDER[0] }),
    });
    if (!sessionRes.ok) throw new Error(await sessionRes.text() || "Could not reset preview session state.");

    const sectionsRes = await fetch(`${REST}/session_sections?session_id=eq.${encodeURIComponent(sid)}`, {
      method: "PATCH",
      headers: { ...authHeaders(token), Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "not_started",
        started_at: null,
        submitted_at: null,
      }),
    });
    if (!sectionsRes.ok) throw new Error(await sectionsRes.text() || "Could not reset preview section state.");
    await unlockLiveQuestions(token, sid);
  }, [unlockLiveQuestions]);

  const forceLiveCurrentSection = useCallback(async (token, sid, nextSection) => {
    const sessionRes = await fetch(`${REST}/diagnostic_sessions?id=eq.${encodeURIComponent(sid)}`, {
      method: "PATCH",
      headers: { ...authHeaders(token), Prefer: "return=minimal" },
      body: JSON.stringify({ status: "in_progress", current_section: nextSection }),
    });
    if (!sessionRes.ok) throw new Error(await sessionRes.text() || `${SECTION_LABELS[nextSection]} could not be activated.`);
    await resetLiveSectionTimer(token, sid, nextSection);
  }, [resetLiveSectionTimer]);

  const fetchLiveSectionRows = useCallback(async (token, sid) => {
    const res = await fetch(
      `${REST}/session_sections?select=section_name,status,submitted_at&session_id=eq.${encodeURIComponent(sid)}`,
      { headers: authHeaders(token) }
    );
    if (!res.ok) throw new Error(await res.text() || "Could not read live section state.");
    return res.json();
  }, []);

  const fetchLiveSession = useCallback(async (token, sid) => {
    const res = await fetch(
      `${REST}/diagnostic_sessions?select=id,status,current_section&id=eq.${encodeURIComponent(sid)}&limit=1`,
      { headers: authHeaders(token) }
    );
    if (!res.ok) throw new Error(await res.text() || "Could not read live session state.");
    const rows = await res.json();
    return Array.isArray(rows) ? rows[0] : null;
  }, []);

  const loadSectionBundle = useCallback(async (token, sid, targetSection, options = {}) => {
    if (options.resetTimer) await resetLiveSectionTimer(token, sid, targetSection);
    const bundle = await callFunction(token, `/get-question-bundle?session_id=${encodeURIComponent(sid)}&section=${targetSection}`);
    const rows = bundle?.questions || bundle?.items || bundle?.data || [];
    if (!rows.length) throw new Error(`${SECTION_LABELS[targetSection] || targetSection} returned no questions.`);
    return {
      questions: rows.map((row, rowIndex) => normalizeQuestionRow(row, targetSection, rowIndex)),
      timeRemaining: Number.isFinite(Number(bundle.time_remaining_seconds))
        ? Number(bundle.time_remaining_seconds)
        : Number(bundle.time_limit_seconds || (SECTION_MINUTES[targetSection] || 30) * 60),
    };
  }, [callFunction, resetLiveSectionTimer]);

  // SVG lives in questions.svg_content. The edge function may omit it.
  // We resolve it via session_questions (sq.id → sq.question_id → questions.svg_content)
  // because q.session_question_id is the only reliable FK we have from the edge fn response.
  const attachVisuals = useCallback(async (adminToken, questions) => {
    const sqIds = [...new Set(questions.map(q => q.session_question_id).filter(Boolean))];
    const directIds = questions.map(getDirectQuestionId).filter(Boolean);
    if (!sqIds.length && !directIds.length) return questions;
    try {
      const hdrs = { apikey: KEY, Authorization: `Bearer ${adminToken}` };
      // Step 1: session_question_id → actual questions.id
      const sqToQ = {};
      if (sqIds.length) {
        const sqRes = await fetch(
          `${REST}/session_questions?select=id,question_id&id=in.(${sqIds.map(encodeURIComponent).join(",")})`,
          { headers: hdrs }
        );
        if (sqRes.ok) {
          const sqRows = await sqRes.json();
          (Array.isArray(sqRows) ? sqRows : []).forEach(r => { sqToQ[r.id] = r.question_id; });
        }
      }

      const qIds = [...new Set([...directIds, ...Object.values(sqToQ)])].filter(Boolean);
      if (!qIds.length) return questions;

      // Step 2: questions.id → svg_content + stimulus_id
      const qRes = await fetch(
        `${REST}/questions?select=id,svg_content,stimulus_id,difficulty_level&id=in.(${qIds.map(encodeURIComponent).join(",")})`,
        { headers: hdrs }
      );
      const svgMap = {};
      const stimIdMap = {}; // qId → stimulus_id
      const diffMap = {}; // qId → difficulty_level
      // Seed stimIdMap from question rows directly (edge fn already provides stimulus_id)
      questions.forEach(q => {
        const qId = getDirectQuestionId(q) || sqToQ[q.session_question_id];
        if (qId && q.stimulus_id) stimIdMap[qId] = q.stimulus_id;
      });
      if (qRes.ok) {
        const qRows = await qRes.json();
        (Array.isArray(qRows) ? qRows : []).forEach(r => {
          if (r.svg_content) svgMap[r.id] = r.svg_content;
          if (r.stimulus_id) stimIdMap[r.id] = r.stimulus_id;
          if (r.difficulty_level) diffMap[r.id] = r.difficulty_level;
        });
      }

      // Step 3: fetch stimuli for all referenced stimulus_ids
      const stimIds = [...new Set(Object.values(stimIdMap))];
      const stimMap = {};
      if (stimIds.length) {
        const sr = await fetch(
          `${REST}/stimuli?select=id,stimulus_title,stimulus_type,stimulus_text&id=in.(${stimIds.map(encodeURIComponent).join(",")})`,
          { headers: hdrs }
        );
        if (sr.ok) {
          const stims = await sr.json();
          (Array.isArray(stims) ? stims : []).forEach(s => { stimMap[s.id] = s; });
        }
      }

      const visualMap = {};
      const visRes = await fetch(
        `${REST}/question_visual_assets?question_id=in.(${qIds.map(encodeURIComponent).join(",")})&select=*,visual_assets(*)`,
        { headers: hdrs }
      );
      if (visRes.ok) {
        const visRows = await visRes.json();
        (Array.isArray(visRows) ? visRows : []).forEach(row => {
          if (!visualMap[row.question_id]) visualMap[row.question_id] = [];
          visualMap[row.question_id].push(row);
        });
      }

      return questions.map(q => {
        const qId = getDirectQuestionId(q) || sqToQ[q.session_question_id];
        const svg = qId ? svgMap[qId] : null;
        const visuals = qId ? visualMap[qId] || [] : [];
        const stimId = qId ? stimIdMap[qId] : null;
        const rawStim = q.stimulus || (stimId ? stimMap[stimId] || null : null);
        // Edge fn returns {text, title, type}; DB returns {stimulus_text, stimulus_title, stimulus_type}. Normalize both.
        const stimulus = rawStim ? {
          ...rawStim,
          stimulus_text: rawStim.stimulus_text ?? rawStim.text ?? null,
          stimulus_title: rawStim.stimulus_title ?? rawStim.title ?? null,
          stimulus_type: rawStim.stimulus_type ?? rawStim.type ?? null,
        } : null;
        return {
          ...q,
          question_id: q.question_id || qId,
          svg_content: q.svg_content || svg,
          difficulty_level: q.difficulty_level || (qId ? diffMap[qId] : null) || null,
          _vis: mergeVisualAssets(q._vis || [], visuals),
          stimulus,
        };
      });
    } catch {
      return questions;
    }
  }, []);

  const moveToBackendNextSection = useCallback(async () => {
    const [liveSession, rows] = await Promise.all([
      fetchLiveSession(adminSession.access_token, sessionId),
      fetchLiveSectionRows(adminSession.access_token, sessionId),
    ]);
    const backendCurrentSection = liveSession?.current_section && SECTION_ORDER.includes(normalizeSection(liveSession.current_section))
      ? normalizeSection(liveSession.current_section)
      : null;
    const nextSubmitted = submittedMapFromSectionRows(rows);
    if (backendCurrentSection) delete nextSubmitted[backendCurrentSection];
    setSubmitted(nextSubmitted);
    const nextSection = backendCurrentSection || firstIncompleteSection(rows);

    if (!nextSection) {
      setStatus("All sections are submitted. Finalizing exam...");
      await finalizeExam();
      return true;
    }

    await forceLiveCurrentSection(adminSession.access_token, sessionId, nextSection);
    const loaded = grouped[nextSection]?.length
      ? { questions: grouped[nextSection], timeRemaining: remaining[nextSection] }
      : await loadSectionBundle(liveTokenRef.current, sessionId, nextSection);
    const nextQs = grouped[nextSection]?.length
      ? loaded.questions
      : await attachVisuals(adminSession.access_token, loaded.questions);
    setGrouped(prev => ({ ...prev, [nextSection]: nextQs }));
    setRemaining(prev => ({ ...prev, [nextSection]: loaded.timeRemaining }));
    setSection(nextSection);
    setIndex(0);
    setStatus(`Moved to ${SECTION_LABELS[nextSection]}.`);
    return true;
  }, [
    adminSession,
    attachVisuals,
    fetchLiveSession,
    fetchLiveSectionRows,
    forceLiveCurrentSection,
    grouped,
    loadSectionBundle,
    remaining,
    sessionId,
    studentSession,
  ]);

  const showLiveSection = useCallback(async (nextSection) => {
    const loaded = grouped[nextSection]?.length
      ? { questions: grouped[nextSection], timeRemaining: remaining[nextSection] }
      : await loadSectionBundle(liveTokenRef.current, sessionId, nextSection);
    const nextQs = grouped[nextSection]?.length
      ? loaded.questions
      : await attachVisuals(adminSession.access_token, loaded.questions);
    setGrouped(prev => ({ ...prev, [nextSection]: nextQs }));
    setRemaining(prev => ({ ...prev, [nextSection]: loaded.timeRemaining }));
    setSection(nextSection);
    setIndex(0);
    setStatus(`Moved to ${SECTION_LABELS[nextSection]}.`);
  }, [
    adminSession,
    attachVisuals,
    grouped,
    loadSectionBundle,
    remaining,
    sessionId,
  ]);

  const syncToBackendCurrentSection = useCallback(async (message) => {
    const nextSection = currentSectionFromMismatchError(message);
    if (!nextSection) return false;
    await resetLiveSectionTimer(adminSession.access_token, sessionId, nextSection);
    const loaded = grouped[nextSection]?.length
      ? { questions: grouped[nextSection], timeRemaining: remaining[nextSection] }
      : await loadSectionBundle(liveTokenRef.current, sessionId, nextSection);
    const nextQs = grouped[nextSection]?.length
      ? loaded.questions
      : await attachVisuals(adminSession.access_token, loaded.questions);
    setGrouped(prev => ({ ...prev, [nextSection]: nextQs }));
    setRemaining(prev => ({ ...prev, [nextSection]: loaded.timeRemaining }));
    setSection(nextSection);
    setIndex(0);
    setStatus(`Moved to ${SECTION_LABELS[nextSection]}.`);
    return true;
  }, [
    adminSession,
    attachVisuals,
    grouped,
    loadSectionBundle,
    remaining,
    resetLiveSectionTimer,
    sessionId,
  ]);

  const submitAnswerChoice = useCallback(async (sessionQuestionId, choice, targetSection) => {
    return callFunction(liveTokenRef.current, "/submit-answer", {
      method: "POST",
      body: JSON.stringify({
        session_id: sessionId,
        session_question_id: sessionQuestionId,
        selected_answer: choice.toLowerCase(),
        section: targetSection,
      }),
    });
  }, [callFunction, sessionId]);

  const repairAnswerSection = useCallback(async (targetSection, message = "") => {
    if (isReadyToFinalizeError(message)) {
      await resetLivePreviewSession(adminSession.access_token, sessionId);
    }
    await forceLiveCurrentSection(adminSession.access_token, sessionId, targetSection);
  }, [adminSession, forceLiveCurrentSection, resetLivePreviewSession, sessionId]);

  const bootPreview = useCallback(async () => {
    setMode("loading");
    setError("");
    setResults(null);
    try {
      const student = await loginStudent();
      setStudentSession(student);
      setStatus("Resetting student session...");
      await resetStudentPreviewSessions(student.token, template?.id);
      setStatus("Assembling student exam...");
      const assembled = await callFunction(student.token, "/assemble-exam", {
        method: "POST",
        body: JSON.stringify({ template_id: template?.id, template_code: template?.code, reset: true }),
      });
      const sid = assembled?.session_id || assembled?.id || assembled?.exam_session_id;
      if (!sid) throw new Error("Assemble exam did not return a session_id.");
      setSessionId(sid);
      // Force current_section to the first section — assemble-exam may have resumed an old
      // session with current_section=null or a stale value, which causes submit-section to reject.
      await resetLivePreviewSession(adminSession.access_token, sid);
      const firstSection = SECTION_ORDER[0];
      const firstBundle = await loadSectionBundle(student.token, sid, firstSection, { resetTimer: true });
      const firstQs = await attachVisuals(adminSession.access_token, firstBundle.questions);
      setGrouped({ ...Object.fromEntries(SECTION_ORDER.map(item => [item, []])), [firstSection]: firstQs });
      setSection(firstSection);
      setIndex(0);
      setAnswers({});
      setMarked({});
      setSubmitted({});
      setStarted(false);
      setRemaining({
        ...Object.fromEntries(SECTION_ORDER.map(item => [item, (SECTION_MINUTES[item] || 30) * 60])),
        [firstSection]: firstBundle.timeRemaining,
      });
      setMode("live");
      setStatus("Live student exam preview");
    } catch (e) {
      setError(e.message);
      setMode("error");
    }
  }, [callFunction, loadSectionBundle, attachVisuals, loginStudent, resetStudentPreviewSessions, resetLivePreviewSession, template, adminSession]);

  useEffect(() => {
    if (initialResults) return;
    if (bootedFor.current === template?.id) return;
    bootedFor.current = template?.id;
    const timer = window.setTimeout(() => {
      bootPreview();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [bootPreview, initialResults, template?.id]);

  // studentSession's token is captured once at boot, but the admin token rotates
  // roughly hourly. Now that a rotation no longer reboots the preview, API calls
  // read the token from this ref instead of the frozen copy — otherwise it expires
  // mid-exam and every submit-answer / submit-section call starts failing with 401.
  useEffect(() => {
    liveTokenRef.current = adminSession?.access_token || null;
  }, [adminSession?.access_token]);

  useEffect(() => {
    if (!started || results || submitted[section]) return undefined;
    const timer = window.setInterval(() => {
      setRemaining(prev => {
        const next = Math.max(0, (prev[section] || 0) - 1);
        if (next === 0) {
          window.setTimeout(() => submitSection(section, true), 0);
        }
        return { ...prev, [section]: next };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  // submitSection intentionally stays outside the dependency list so this interval
  // is controlled by the active section timer state, not by draft answer saves.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, results, section, submitted]);

  useEffect(() => {
    if (mode === "loading" || mode === "error") return;
    localStorage.setItem(storageKey, JSON.stringify({ section, index, answers, marked, submitted, started, remaining }));
  }, [answers, index, marked, mode, remaining, section, started, storageKey, submitted]);

  function goSection(nextSection) {
    if (!grouped[nextSection]?.length) return;
    setSection(nextSection);
    setIndex(0);
  }

  async function saveAnswer(q, choice) {
    const id = getQuestionId(q);
    const answerKey = getAnswerKey(q);
    if (!answerKey) return;
    if (!id || !studentSession?.token || !sessionId) {
      setError("Live exam session is required before saving an answer.");
      return;
    }
    setError("");
    if (pendingSave.current[answerKey] === choice) return;
    pendingSave.current[answerKey] = choice;
    setAnswers(prev => ({ ...prev, [answerKey]: choice }));
    try {
      try {
        await submitAnswerChoice(id, choice, section);
      } catch (e) {
        if (!isAnswerRepairableError(e.message)) throw e;
        await repairAnswerSection(section, e.message);
        await submitAnswerChoice(id, choice, section);
      }
    } catch (e) {
      setAnswers(prev => {
        const copy = { ...prev };
        delete copy[answerKey];
        return copy;
      });
      setError(e.message || "Answer could not be saved.");
    } finally {
      delete pendingSave.current[answerKey];
    }
  }

  async function randomizeSectionAnswers() {
    if (!activeQuestions.length || busy || submitted[section]) return;
    setBusy(true);
    setError("");
    if (!studentSession?.token || !sessionId) {
      setError("Live exam session is required before saving randomized answers.");
      setBusy(false);
      return;
    }
    const nextAnswers = {};
    const requests = [];
    activeQuestions.forEach(q => {
      const letters = getAvailableAnswerLetters(q);
      if (!letters.length) return;
      const answerKey = getAnswerKey(q);
      if (!answerKey) return;
      const id = getQuestionId(q);
      if (!id) return;
      const choice = letters[Math.floor(Math.random() * letters.length)];
      nextAnswers[answerKey] = choice;
      requests.push({ id, choice });
    });
    try {
      if (!requests.length) throw new Error("No answerable live questions were found in this section.");
      setAnswers(prev => ({ ...prev, ...nextAnswers }));
      let results = await Promise.allSettled(requests.map(({ id, choice }) => submitAnswerChoice(id, choice, section)));
      let failed = results.filter(result => result.status === "rejected");
      if (failed.some(result => isAnswerRepairableError(result.reason?.message))) {
        await repairAnswerSection(section, failed.find(result => isAnswerRepairableError(result.reason?.message))?.reason?.message);
        results = await Promise.allSettled(requests.map(({ id, choice }) => submitAnswerChoice(id, choice, section)));
        failed = results.filter(result => result.status === "rejected");
      }
      if (failed.length) {
        setAnswers(prev => {
          const copy = { ...prev };
          Object.keys(nextAnswers).forEach(key => { delete copy[key]; });
          return copy;
        });
        throw new Error(failed[0].reason?.message || `${failed.length} answers could not be saved.`);
      }
    } catch (e) {
      setError(e.message || "Randomized answers could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function submitSection(targetSection = section, automatic = false) {
    if (submitted[targetSection]) return;
    const targetQuestions = grouped[targetSection] || [];
    const missing = targetQuestions.filter(q => !answers[getAnswerKey(q)]).length;
    if (!automatic && missing > 0) {
      setError(`Answer all ${targetQuestions.length} questions before submitting this section. ${missing} ${missing === 1 ? "question is" : "questions are"} still blank.`);
      return;
    }
    setBusy(true);
    setError("");
    const submitLiveSection = () => callFunction(liveTokenRef.current, "/submit-section", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId, section_name: targetSection, auto_submitted: automatic }),
    });
    const advanceFromSubmitResult = async (submitResult) => {
      setSubmitted(prev => ({ ...prev, [targetSection]: "submitted" }));
      if (submitResult?.exam_complete || !submitResult?.next_section?.name) {
        setStatus("All sections are submitted. Finalizing exam...");
        await finalizeExam();
        return;
      }
      await showLiveSection(normalizeSection(submitResult.next_section.name));
    };
    try {
      if (!studentSession?.token || !sessionId) throw new Error("Live exam session is required before submitting a section.");
      const submitResult = await submitLiveSection();
      await advanceFromSubmitResult(submitResult);
      setBusy(false);
      return;
    } catch (e) {
      if (isReadyToFinalizeError(e.message) || isSectionLockedError(e.message) || isSectionMismatchError(e.message)) {
        try {
          if (isReadyToFinalizeError(e.message)) {
            setStatus("All sections are submitted. Finalizing exam...");
            await finalizeExam();
            setBusy(false);
            return;
          }
          if (isSectionMismatchError(e.message) && await syncToBackendCurrentSection(e.message)) {
            setSubmitted(prev => ({ ...prev, [targetSection]: "submitted" }));
            setBusy(false);
            return;
          }
          const rows = await fetchLiveSectionRows(adminSession.access_token, sessionId);
          const bySection = Object.fromEntries(rows.map(row => [normalizeSection(row.section_name), row]));
          if (!sectionIsCompleted(bySection[targetSection])) {
            await forceLiveCurrentSection(adminSession.access_token, sessionId, targetSection);
            await submitLiveSection();
          }
          await moveToBackendNextSection();
          setBusy(false);
          return;
        } catch (advanceError) {
          setError(advanceError.message || "Section state could not be repaired.");
        }
        setBusy(false);
        return;
      }
      setError(e.message || "Section submission failed.");
      setBusy(false);
      return;
    }
  }

  async function finalizeExam() {
    setBusy(true);
    setError("");
    try {
      if (!studentSession?.token || !sessionId) throw new Error("Live exam session is required before scoring.");
      await callFunction(liveTokenRef.current, "/finalize-exam", {
        method: "POST",
        body: JSON.stringify({ session_id: sessionId }),
      });
      const liveResults = await callFunction(liveTokenRef.current, `/get-results?session_id=${encodeURIComponent(sessionId)}`);
      setResults(liveResults);
    } catch (e) {
      setError(e.message || "Final scoring failed.");
    } finally {
      setBusy(false);
    }
  }

  function resetPreview() {
    localStorage.removeItem(storageKey);
    setAnswers({});
    setMarked({});
    setSubmitted({});
    setStarted(false);
    setResults(null);
    setIndex(0);
    setRemaining(Object.fromEntries(SECTION_ORDER.map(item => [item, (SECTION_MINUTES[item] || 30) * 60])));
    bootPreview();
  }

  // Dead in this component — exam deletion is driven from ExamBuilder, which has
  // its own copy of this logic. Kept only because the archive/reparent sequence
  // below is the reference implementation the comment above refers to. Delete
  // both this and ExamBuilder's copy once that flow is extracted to a module.
  // eslint-disable-next-line no-unused-vars
  async function deleteTemplate() {
    if (!template?.id || !window.confirm(`Delete exam "${template?.code}"? This cannot be undone.`)) return;
    const adminH = { apikey: KEY, Authorization: `Bearer ${adminSession.access_token}`, "Content-Type": "application/json", Prefer: "return=minimal" };
    if (template.code === ARCHIVE_TEMPLATE_CODE) {
      alert("The internal deleted-session archive cannot be deleted.");
      return;
    }

    const ensureArchiveTemplate = async () => {
      const existingRes = await fetch(`${REST}/diagnostic_templates?code=eq.${encodeURIComponent(ARCHIVE_TEMPLATE_CODE)}&select=id&limit=1`, {
        headers: authHeaders(adminSession.access_token),
      });
      if (!existingRes.ok) throw new Error(await existingRes.text() || "Could not inspect archive template.");
      const existing = await existingRes.json();
      if (Array.isArray(existing) && existing[0]?.id) return existing[0].id;

      const createRes = await fetch(`${REST}/diagnostic_templates`, {
        method: "POST",
        headers: { ...authHeaders(adminSession.access_token), Prefer: "return=representation" },
        body: JSON.stringify({
          code: ARCHIVE_TEMPLATE_CODE,
          version: 1,
          total_questions: 0,
          is_active: false,
        }),
      });
      if (!createRes.ok) throw new Error(await createRes.text() || "Could not create archive template.");
      const created = await createRes.json();
      return Array.isArray(created) ? created[0]?.id : created?.id;
    };

    let archiveTemplateId = null;
    try {
      archiveTemplateId = await ensureArchiveTemplate();
    } catch (error) {
      alert(`Delete failed while preparing session archive: ${error.message}`);
      return;
    }
    if (!archiveTemplateId) {
      alert("Delete failed: could not resolve the deleted-session archive template.");
      return;
    }

    const moveSessionsForToken = async (token) => {
      const actorH = { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=minimal" };
      const sessRes = await fetch(`${REST}/diagnostic_sessions?select=id&template_id=eq.${encodeURIComponent(template.id)}`, { headers: actorH });
      if (!sessRes.ok) throw new Error(await sessRes.text() || "Could not inspect diagnostic sessions.");
      const sessions = await sessRes.json();
      if (!Array.isArray(sessions) || !sessions.length) return;

      const idList = sessions.map(s => encodeURIComponent(s.id)).join(",");
      const res = await fetch(`${REST}/diagnostic_sessions?id=in.(${idList})`, {
        method: "PATCH",
        headers: actorH,
        body: JSON.stringify({ template_id: archiveTemplateId }),
      });
      if (!res.ok) throw new Error(`Could not detach diagnostic sessions: ${await res.text() || res.status}`);
    };

    try {
      await moveSessionsForToken(adminSession.access_token);
      if (studentSession?.token) await moveSessionsForToken(liveTokenRef.current);
    } catch (error) {
      alert(`Delete failed while cleaning exam sessions: ${error.message}`);
      return;
    }

    await fetch(`${REST}/diagnostic_template_questions?template_id=eq.${encodeURIComponent(template.id)}`, { method: "DELETE", headers: adminH });
    const delRes = await fetch(`${REST}/diagnostic_templates?id=eq.${encodeURIComponent(template.id)}`, { method: "DELETE", headers: adminH });
    if (!delRes.ok) {
      const msg = await delRes.text();
      alert(`Delete failed: ${msg || delRes.status}`);
      return;
    }
    onClose();
  }

  const resultModel = useMemo(() => {
    if (!results) return null;
    const pctMap = {};
    (results.percentiles || []).forEach(p => { pctMap[`${p.target}:${p.code}`] = p.percentile_rank; });
    const topicsBySubject = {};
    (results.topics || []).forEach(t => {
      // Logic/Abstract Reasoning rows have topic="" in the DB — fall back to the subject
      // name so the adaptive learning button still appears and passes the t.topic filter.
      const topic = t.topic || t.subject;
      if (!topicsBySubject[t.subject]) topicsBySubject[t.subject] = [];
      topicsBySubject[t.subject].push({ ...t, topic });
    });
    const subtopicsByKey = {};
    (results.subtopics || []).forEach(st => {
      if (!st.subtopic) return; // skip rows with no subtopic name (e.g. Logic placeholder rows)
      const topic = st.topic || st.subject;
      const key = `${st.subject}|||${topic}`;
      if (!subtopicsByKey[key]) subtopicsByKey[key] = [];
      subtopicsByKey[key].push({ ...st, topic });
    });
    return {
      readinessScore: results.readiness?.overall_score ?? 0,
      tier: results.readiness?.tier ?? "",
      readinessMessage: results.readiness?.message ?? "",
      overallPercentile: pctMap["overall:overall"] ?? null,
      subjects: (results.subjects || []).map(s => ({
        ...s,
        percentile: pctMap[`subject:${s.subject}`] ?? null,
        topics: topicsBySubject[s.subject] || [],
      })),
      topicsBySubject,
      subtopicsByKey,
      classifications: (results.classifications || []).map(c => ({
        ...c,
        percentile: pctMap[`classification:${c.code}`] ?? null,
      })),
      predictions: results.predictions || [],
      recommendations: results.recommendations || {},
      primary: results.recommendations?.primary || null,
      alternatives: results.recommendations?.alternatives || [],
      startedAt: results.started_at || null,
      completedAt: results.completed_at || null,
    };
  }, [results]);

  if (mode === "loading" || mode === "error") {
    const isError = mode === "error";
    return (
      <div style={S.page}>
        <div style={{ ...S.loadingPanel, ...(isError ? S.errorPanel : {}) }}>
          <button onClick={onClose} style={S.closeBtn}>Close</button>
          <div style={S.brand}>STUDENT PREVIEW</div>
          <div style={isError ? S.errorHeadingRow : undefined}>
            {isError && <span style={S.errorIcon}>!</span>}
            <h1 style={{ ...S.loadingTitle, ...(isError ? S.errorTitle : {}) }}>
              {isError ? "Preview could not start" : "Preparing exam preview"}
            </h1>
          </div>
          <p style={isError ? S.errorMessage : S.muted}>{isError ? formatPreviewError(error) : status}</p>
          {isError && <button onClick={bootPreview} style={S.primary}>Retry</button>}
        </div>
      </div>
    );
  }

  if (resultModel) return <ResultsView resultModel={resultModel} template={template} onReset={resetPreview} onClose={onClose} adminToken={adminSession.access_token} />;

  if (practiceMode && resultModel) {
    return (
      <PracticeQuiz
        subject={practiceMode.subject}
        topic={practiceMode.topic}
        subtopic={practiceMode.subtopic}
        label={practiceMode.label}
        adminToken={adminSession.access_token}
        onBack={() => setPracticeMode(null)}
      />
    );
  }

  if (resultModel) {
    const rec = resultModel.recommendations;
    const TIER = {
      "Advanced":      { color: "#059669", track: "#d1fae5", label: "#065f46" },
      "Proficient":    { color: "#2563eb", track: "#dbeafe", label: "#1e40af" },
      "Developing":    { color: "#2E93FF", track: "#EFF7FF", label: "#170142" },
      "Not Yet Ready": { color: "#dc2626", track: "#fee2e2", label: "#991b1b" },
    };
    const tierMeta = TIER[resultModel.tier] || { color: "#64748b", track: "#f1f5f9", label: "#334155" };

    const masteryColor = { "Advanced": "#059669", "Proficient": "#2563eb", "Developing": "#d97706", "Needs Improvement": "#dc2626" };
    const masteryBg = { "Advanced": "#f0fdf4", "Proficient": "#eff6ff", "Developing": "#fffbeb", "Needs Improvement": "#fff1f2" };
    const masteryBorder = { "Advanced": "#a7f3d0", "Proficient": "#bfdbfe", "Developing": "#fde68a", "Needs Improvement": "#fecdd3" };
    const profileColor = { "High Probability": "#059669", "Moderate Probability": "#d97706", "Low Probability": "#dc2626" };
    const profileBg = { "High Probability": "#f0fdf4", "Moderate Probability": "#fffbeb", "Low Probability": "#fff1f2" };
    const profileBorder = { "High Probability": "#a7f3d0", "Moderate Probability": "#fde68a", "Low Probability": "#fecdd3" };

    // Unified thresholds: red <40%, amber 40–69%, green 70%+
    const scoreColorFn = (s) => s >= 70 ? "#059669" : s >= 40 ? "#d97706" : "#dc2626";

    // SVG gauge — thicker arc (24px), larger score number
    const GAUGE_R = 90; const GAUGE_CX = 110; const GAUGE_CY = 115;
    const circ = 2 * Math.PI * GAUGE_R;
    const arcLen = circ * 0.75;
    const fill = arcLen * Math.min(1, Math.max(0, resultModel.readinessScore / 100));
    const gaugeTransform = `rotate(135 ${GAUGE_CX} ${GAUGE_CY})`;

    const gapCount = rec.weaknesses?.length || 0;

    return (
      <div style={{ ...S.page, background: "#f0f4f8" }}>
        {/* Topbar */}
        <header style={{ ...S.topbar, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#170142", fontFamily: "'Sora', system-ui, sans-serif" }}>{template?.code || "Exam"} — Results</div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2, fontFamily: "'Sora', system-ui, sans-serif" }}>{resultModel.startedAt && new Date(resultModel.startedAt).toLocaleString()}</div>
          </div>
          <div style={S.actions}>
            <button onClick={resetPreview} style={{ ...S.ghost, border: "1px solid #170142", color: "#170142" }}>Retake preview</button>
            <button onClick={onClose} style={S.ghost}>Exit</button>
          </div>
        </header>

        <main style={{ padding: "24px 28px", maxWidth: 1200, margin: "0 auto" }}>

          {/* ── HERO: Full-width score + readiness ── */}
          <div style={{ ...SR.card, marginBottom: 20, display: "grid", gridTemplateColumns: "auto 1fr", gap: 32, alignItems: "center" }}>
            {/* Gauge — thicker arc, larger number */}
            <div style={{ textAlign: "center", flexShrink: 0 }}>
              <svg width="220" height="210" viewBox="0 0 220 230" style={{ display: "block", margin: "0 auto" }}>
                <circle cx={GAUGE_CX} cy={GAUGE_CY} r={GAUGE_R} fill="none" stroke={tierMeta.track} strokeWidth="24"
                  strokeDasharray={`${arcLen} ${circ - arcLen}`} strokeLinecap="round" transform={gaugeTransform} />
                <circle cx={GAUGE_CX} cy={GAUGE_CY} r={GAUGE_R} fill="none" stroke={tierMeta.color} strokeWidth="24"
                  strokeDasharray={`${fill} ${circ - fill}`} strokeLinecap="round" transform={gaugeTransform}
                  style={{ transition: "stroke-dasharray 0.6s ease" }} />
                <text x={GAUGE_CX} y={GAUGE_CY - 8} textAnchor="middle" fontSize="58" fontWeight="900" fill="#0f172a" fontFamily="'Sora',system-ui,sans-serif">{Math.round(resultModel.readinessScore)}</text>
                <text x={GAUGE_CX} y={GAUGE_CY + 18} textAnchor="middle" fontSize="13" fill="#94a3b8" fontFamily="'Sora',system-ui,sans-serif">out of 100</text>
              </svg>
            </div>

            {/* Readiness meta + actionable CTA */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1, color: "#94a3b8", marginBottom: 10 }}>Readiness Score</div>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "6px 16px", borderRadius: 999, background: tierMeta.track, marginBottom: 16 }}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: tierMeta.color, flexShrink: 0 }} />
                <span style={{ fontSize: 16, fontWeight: 900, color: tierMeta.label }}>{resultModel.tier || "Score"}</span>
              </div>
              {resultModel.overallPercentile !== null && (
                <div style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>
                  Top <strong style={{ color: "#0f172a" }}>{100 - resultModel.overallPercentile}%</strong> of test takers &nbsp;·&nbsp; P{resultModel.overallPercentile}
                </div>
              )}
              {/* CTA: tier + next step */}
              <div style={{ padding: "16px 20px", borderRadius: 12, background: tierMeta.track, border: `1px solid ${tierMeta.color}40`, maxWidth: 500 }}>
                <div style={{ fontSize: 15, fontWeight: 900, color: tierMeta.label, marginBottom: 5 }}>{resultModel.tier || "Your result"}</div>
                {gapCount > 0 ? (
                  <div style={{ fontSize: 13, color: tierMeta.label, lineHeight: 1.55 }}>
                    You have <strong>{gapCount} priority gap{gapCount !== 1 ? "s" : ""}</strong> to address. Work through the subject breakdown below to start closing them.
                  </div>
                ) : resultModel.readinessMessage ? (
                  <div style={{ fontSize: 13, color: tierMeta.label, lineHeight: 1.55 }}>{resultModel.readinessMessage}</div>
                ) : null}
              </div>
              {resultModel.readinessMessage && gapCount > 0 && (
                <div style={{ marginTop: 10, padding: "10px 14px", background: "#f8fafc", borderRadius: 10, fontSize: 12, color: "#475569", lineHeight: 1.65, maxWidth: 500 }}>
                  {resultModel.readinessMessage}
                </div>
              )}
            </div>
          </div>

          {/* ── Study Focus: full-width banner ── */}
          {rec.study_focus && (
            <div style={{ marginBottom: 20, padding: "18px 24px", background: "#EFF7FF", border: "1px solid rgba(46,147,255,0.25)", borderRadius: 14, display: "flex", alignItems: "flex-start", gap: 16 }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, background: "rgba(46,147,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#170142" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                </svg>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.8, color: "#2E93FF", marginBottom: 5 }}>Study Focus</div>
                <div style={{ fontSize: 14, color: "#170142", lineHeight: 1.65, fontWeight: 500 }}>{rec.study_focus}</div>
              </div>
            </div>
          )}

          {/* ── Top Course Fit ── */}
          {resultModel.primary && (
            <div style={{ ...SR.card, marginBottom: 20 }}>
              <div style={SR.sectionLabel}>Top Course Fit</div>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 14, marginBottom: rec.alternatives?.length > 0 ? 18 : 0 }}>
                <div style={{ width: 52, height: 52, borderRadius: 14, background: tierMeta.track, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 900, color: tierMeta.label, flexShrink: 0 }}>
                  {shortCode(resultModel.primary.code)}
                </div>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: "#0f172a", lineHeight: 1.2 }}>{resultModel.primary.name}</div>
                  <div style={{ fontSize: 14, color: tierMeta.color, fontWeight: 800, marginTop: 3 }}>Fit score: {+(resultModel.primary.fit_score || 0).toFixed(1)}</div>
                </div>
              </div>
              {rec.alternatives?.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>Also a strong fit</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {rec.alternatives.map(a => (
                      <div key={a.code} style={{ padding: "10px 16px", borderRadius: 10, background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                        <div style={{ fontWeight: 800, color: "#0f172a", fontSize: 13 }}>{a.name}</div>
                        <div style={{ color: "#64748b", fontSize: 12, marginTop: 2 }}>Fit: {+(a.fit_score || 0).toFixed(1)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Subject breakdown ── */}
          <div style={{ ...SR.card, marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 6 }}>
              <div style={SR.sectionLabel}>Subject Performance</div>
              {/* Color legend */}
              <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                {[["#dc2626", "Below 40%"], ["#d97706", "40–69%"], ["#059669", "70%+"]].map(([color, label]) => (
                  <span key={label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#64748b" }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: "inline-block", flexShrink: 0 }} />
                    {label}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ color: "#64748b", fontSize: 12, marginBottom: 16 }}>Click a topic or subtopic to open Adaptive Learning practice questions for that area.</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
              {resultModel.subjects.map(subj => {
                const scoreColor = scoreColorFn(subj.weighted_score || 0);
                const subjectTopics = subj.topics.filter(t => t.topic);
                return (
                  <div key={subj.subject} style={{ background: "#f8fafc", borderRadius: 12, padding: "16px 20px", border: "1px solid #e8edf4" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                      <div>
                        <div style={{ fontWeight: 900, color: "#170142", fontSize: 15 }}>{subj.subject}</div>
                        {subj.percentile !== null && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>P{subj.percentile}</div>}
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 24, fontWeight: 900, color: scoreColor, lineHeight: 1 }}>{Math.round(subj.weighted_score || 0)}%</div>
                        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{subj.raw_correct}/{subj.raw_total} correct</div>
                      </div>
                    </div>
                    <div style={{ height: 10, background: "#e2e8f0", borderRadius: 999, overflow: "hidden", marginBottom: 12 }}>
                      <div style={{ height: "100%", width: `${Math.min(100, subj.weighted_score || 0)}%`, background: scoreColor, borderRadius: 999, transition: "width 0.5s ease" }} />
                    </div>
                    {subjectTopics.length > 0 && (
                      <details style={{ marginTop: 2 }}>
                        <summary style={{ cursor: "pointer", color: "#2E93FF", fontSize: 12, fontWeight: 800, userSelect: "none" }}>
                          Adaptive Learning topics ({subjectTopics.length})
                        </summary>
                        <div style={{ marginTop: 10 }}>
                          {subjectTopics.map(topic => {
                            const tc = scoreColorFn(topic.weighted_score || 0);
                            const subs = resultModel.subtopicsByKey[`${topic.subject}|||${topic.topic}`] || [];
                            return (
                              <div key={topic.topic} style={{ marginBottom: 10 }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                                  <button onClick={() => setPracticeMode({ subject: subj.subject, topic: topic.topic, label: topic.topic })} title={`Practice ${topic.topic}`} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 12, fontWeight: 700, color: "#2E93FF", textDecoration: "underline", textUnderlineOffset: 2, textAlign: "left", fontFamily: "inherit" }}>{topic.topic}</button>
                                  <span style={{ fontSize: 11, color: "#94a3b8", flexShrink: 0, marginLeft: 8 }}>{topic.raw_correct}/{topic.raw_total}</span>
                                </div>
                                <div style={{ height: 4, background: "#e2e8f0", borderRadius: 999, overflow: "hidden", marginBottom: subs.length ? 6 : 0 }}>
                                  <div style={{ height: "100%", width: `${Math.min(100, topic.weighted_score || 0)}%`, background: tc, borderRadius: 999 }} />
                                </div>
                                {subs.length > 0 && (
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, paddingLeft: 8, marginTop: 4 }}>
                                    {subs.filter(st => st.subtopic).map(st => (
                                      <button key={st.subtopic} onClick={() => setPracticeMode({ subject: st.subject, topic: st.topic, subtopic: st.subtopic, label: st.subtopic })} title={`Practice ${st.subtopic}`} style={{
                                        maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                        padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: "pointer",
                                        background: masteryBg[st.mastery_band] || "#f8fafc",
                                        border: `1px solid ${masteryBorder[st.mastery_band] || "#e2e8f0"}`,
                                        color: masteryColor[st.mastery_band] || "#64748b",
                                        fontFamily: "inherit",
                                      }}>
                                        {st.subtopic} <span style={{ opacity: 0.65 }}>· {st.raw_correct}/{st.raw_total}</span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Strengths & Gaps ── */}
          {(rec.strengths?.length > 0 || rec.weaknesses?.length > 0) && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
              {rec.strengths?.length > 0 && (
                <div style={SR.card}>
                  <div style={{ ...SR.sectionLabel, color: "#065f46" }}>Strengths</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
                    {rec.strengths.map((s, i) => (
                      <span key={i} style={{ padding: "5px 10px", borderRadius: 6, background: "#f0fdf4", border: "1px solid #a7f3d0", color: "#065f46", fontSize: 12, fontWeight: 700 }}>{s}</span>
                    ))}
                  </div>
                </div>
              )}
              {rec.weaknesses?.length > 0 && (
                <div style={SR.card}>
                  <div style={{ ...SR.sectionLabel, color: "#9f1239" }}>Priority Gaps</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
                    {rec.weaknesses.map((w, i) => (
                      <span key={i} style={{ padding: "5px 10px", borderRadius: 6, background: "#fff1f2", border: "1px solid #fecdd3", color: "#9f1239", fontSize: 12, fontWeight: 700 }}>{w}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── University Predictions + Course Fit ── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
            <div style={SR.card}>
              <div style={SR.sectionLabel}>University Predictions</div>
              <div style={{ marginTop: 4, fontSize: 12, color: "#94a3b8", marginBottom: 14 }}>Improving your subject scores will increase your admission chances.</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {resultModel.predictions.map(p => (
                  <div key={p.university} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderRadius: 10, background: profileBg[p.profile] || "#f8fafc", border: `1px solid ${profileBorder[p.profile] || "#e2e8f0"}` }}>
                    <span style={{ fontWeight: 900, color: "#0f172a", fontSize: 14, marginRight: 12 }}>{p.university}</span>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: 18, fontWeight: 900, color: profileColor[p.profile] || "#64748b" }}>{+(p.predictive_index || 0).toFixed(1)}%</div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: profileColor[p.profile] || "#64748b" }}>{p.profile}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={SR.card}>
              <div style={SR.sectionLabel}>Course Fit Rankings</div>
              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                {[...resultModel.classifications].sort((a, b) => b.fit_score - a.fit_score).map((c, i) => (
                  <div key={c.code}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5, gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span style={{ width: 24, height: 24, borderRadius: 6, background: i === 0 ? tierMeta.color : "#e2e8f0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 900, color: i === 0 ? "#fff" : "#64748b", flexShrink: 0 }}>{i + 1}</span>
                        <span style={{ fontSize: 13, fontWeight: 800, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                        <span style={{ fontSize: 14, fontWeight: 900, color: i === 0 ? tierMeta.color : "#334155" }}>{+(c.fit_score || 0).toFixed(1)}</span>
                        {c.percentile !== null && <span style={{ fontSize: 10, color: "#94a3b8", background: "#f1f5f9", padding: "2px 6px", borderRadius: 4, whiteSpace: "nowrap" }}>P{c.percentile}</span>}
                      </div>
                    </div>
                    <div style={{ height: 5, background: "#e8edf4", borderRadius: 999, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${Math.min(100, ((c.fit_score || 0) / 30) * 100)}%`, background: i === 0 ? tierMeta.color : "#cbd5e1", borderRadius: 999 }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

        </main>
      </div>
    );
  }

  return (
    <div style={S.page}>
      <header style={S.topbar}>
        <div>
          <div style={S.topTitle}>{template?.code || "Exam Preview"}</div>
          <div style={S.smallMuted}>{status} as {STUDENT_EMAIL}</div>
        </div>
        <div style={S.actions}>
          <button onClick={resetPreview} style={S.ghost}>Reset preview</button>
          <button onClick={onClose} style={S.ghost}>Exit preview</button>
        </div>
      </header>

      {!started ? (
        <main style={S.startPanel}>
          <div style={S.kicker}>Diagnostic Exam</div>
          <h1 style={S.startTitle}>Ready to begin</h1>
          <p style={S.muted}>This preview uses the student account automatically and opens the full exam workflow without showing an admin login.</p>
          <div style={S.sectionCards}>
            {sections.map(item => (
              <div key={item} style={{ ...S.sectionCard, ...(!grouped[item]?.length ? S.sectionCardLocked : {}) }}>
                <strong>{SECTION_LABELS[item]}</strong>
                <span>{grouped[item]?.length ? `${grouped[item].length} questions` : "Loads after prior section"}</span>
              </div>
            ))}
          </div>
          <button onClick={() => setStarted(true)} style={{ ...S.primary, ...S.startButton }}>Start exam</button>
        </main>
      ) : (
        <main style={S.examLayout}>
          <section style={S.questionPanel}>
            <div style={S.sectionTabs}>
              {sections.map(item => (
                <button
                  key={item}
                  disabled={!grouped[item]?.length}
                  onClick={() => goSection(item)}
                  style={{ ...S.sectionTab, ...(!grouped[item]?.length ? S.sectionTabLocked : {}), ...(section === item ? S.sectionTabActive : {}) }}>
                  {SECTION_LABELS[item]}
                </button>
              ))}
            </div>
            <div style={S.questionHeader}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h1 style={S.questionTitle}>Question {index + 1} of {activeQuestions.length}</h1>
                {onEditQuestion && current && difficultyPillMeta(current.difficulty_level) && (() => {
                  const meta = difficultyPillMeta(current.difficulty_level);
                  return (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 999, background: meta.bg, border: `1px solid ${meta.border}`, color: meta.color, fontSize: 11, fontWeight: 800, letterSpacing: 0.3, textTransform: "uppercase" }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: meta.color, flexShrink: 0 }} />
                      {meta.label}
                    </span>
                  );
                })()}
              </div>
              {onEditQuestion ? (
                <button
                  onClick={() => { const qid = current && getDirectQuestionId(current); if (qid) onEditQuestion(qid); }}
                  style={S.markBtn}
                  disabled={!current || !getDirectQuestionId(current)}>
                  Edit Question
                </button>
              ) : (
                <button
                  onClick={() => current && setMarked(prev => ({ ...prev, [getAnswerKey(current)]: !prev[getAnswerKey(current)] }))}
                  style={{ ...S.markBtn, ...(current && marked[getAnswerKey(current)] ? S.markedBtn : {}) }}>
                  {current && marked[getAnswerKey(current)] ? "Marked" : "Mark for review"}
                </button>
              )}
            </div>
            {current ? (
              <QuestionBlock question={current} value={answers[getAnswerKey(current)]} onChoose={choice => saveAnswer(current, choice)} />
            ) : (
              <div style={S.empty}>No question in this section.</div>
            )}
            <div style={S.navRow}>
              <button disabled={index === 0} onClick={() => setIndex(i => Math.max(0, i - 1))} style={S.navBtn}>Back</button>
              <button disabled={index >= activeQuestions.length - 1} onClick={() => setIndex(i => Math.min(activeQuestions.length - 1, i + 1))} style={S.primary}>Next</button>
            </div>
          </section>

          <aside style={S.sidePanel}>
            {/* Brand dark header: section info + timer */}
            <div style={S.sidePanelHeader}>
              <div style={S.sectionMeta}>SECTION {SECTION_ORDER.indexOf(section) + 1} OF {sections.length}</div>
              <div style={S.sectionNameBig}>{SECTION_LABELS[section]}</div>
              <div style={S.timerLabel}>TIME REMAINING</div>
              <div style={S.timerWhite}>{formatTime(remaining[section])}</div>
              <div style={S.savedPill}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#4ade80", flexShrink: 0 }} />
                All changes saved
              </div>
            </div>
            {/* Question Navigator */}
            <div style={S.navigatorBody}>
              <div style={S.navigatorLabel}>Question Navigator</div>
              <div style={S.gridMenu}>
                {activeQuestions.map((q, i) => {
                  const id = getAnswerKey(q);
                  const state = answers[id] ? "answered" : marked[id] ? "marked" : "blank";
                  return (
                    <button key={id || i} onClick={() => setIndex(i)} style={{ ...S.qCell, ...S[`q_${state}`], ...(i === index ? S.qActive : {}) }}>
                      {i + 1}
                    </button>
                  );
                })}
              </div>
              <ScoreRow label="Answered" score={activeQuestions.length ? (answeredCount / activeQuestions.length) * 100 : 0} meta={`${answeredCount}/${activeQuestions.length}`} />
              <ScoreRow label="Marked" score={activeQuestions.length ? (markedCount / activeQuestions.length) * 100 : 0} meta={`${markedCount}/${activeQuestions.length}`} />
              <div style={{ ...S.statusList, marginTop: 14 }}>
                {sections.map(item => <span key={item} style={S.statusPill}>{SECTION_LABELS[item]}: {submitted[item] || "open"}</span>)}
              </div>
              {error && <div style={S.inlineError}>{error}</div>}
              {!canSubmitActiveSection && !submitted[section] && (
                <div style={S.inlineNote}>Complete every question in this section before submitting. {unansweredCount} remaining.</div>
              )}
              <button disabled={busy || submitted[section]} onClick={randomizeSectionAnswers} style={{ ...S.testBtn, opacity: busy || submitted[section] ? 0.55 : 1 }}>
                {busy ? "Saving..." : "Random answer section"}
              </button>
              <button disabled={busy || submitted[section] || !canSubmitActiveSection} onClick={() => submitSection(section)} style={{ ...S.primary, width: "100%", opacity: busy || submitted[section] || !canSubmitActiveSection ? 0.55 : 1 }}>
                Submit section
              </button>
              <button disabled={busy || !allSubmitted} onClick={finalizeExam} style={{ ...S.finalBtn, opacity: busy || !allSubmitted ? 0.55 : 1 }}>
                Show final results
              </button>
            </div>
          </aside>
        </main>
      )}
    </div>
  );
}

function QuestionBlock({ question, value, onChoose }) {
  const qVisuals = [...(question._vis || []), ...questionInlineVisualAssets(question)];
  const visualKey = question.question_id || question.session_question_id || question._previewKey || question.id || "active-question";
  const letters = ["a", "b", "c", "d", "e"].filter(letter => getChoiceValue(question, letter));
  const renderSubject = getRenderSubject(question);
  const questionText = getQuestionText(question);
  return (
    <div style={S.examRender}>
      {question.stimulus && (
        <div style={{ ...S.examBlock, maxHeight: 280, overflow: "auto" }}>
          {question.stimulus.stimulus_title && (
            <div style={S.examLabel}>{question.stimulus.stimulus_title}</div>
          )}
          <MathContent value={question.stimulus.stimulus_text} subject={renderSubject} style={{ color: "#334155", fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap" }} />
        </div>
      )}

      <VisualAssetPreview key={visualKey} assets={qVisuals} storageBase={STORAGE} />

      <div style={S.examPrompt}>
        {question.render_markup ? (
          <>
            {getSegInstruction(question) && (
              <div style={{ fontSize: 14, color: "#475569", marginBottom: 8, fontStyle: "italic" }}>
                {getSegInstruction(question)}
              </div>
            )}
            <SegMarkup markup={question.render_markup} />
          </>
        ) : (
          <QuestionWithUnderline
            text={questionText}
            choiceA={getChoiceA(question)}
            subject={renderSubject}
            style={{ fontSize: 18, color: "#13233d", lineHeight: 1.65, fontWeight: 500, textAlign: "left" }}
          />
        )}
      </div>

      <div style={S.examChoices}>
        {letters.map(letter => (
          <button
            key={letter}
            onClick={() => onChoose(letter.toUpperCase())}
            style={{ ...S.examChoice, ...(value === letter.toUpperCase() ? S.examChoiceSelected : {}) }}>
            <span style={{ ...S.examChoiceLetter, ...(value === letter.toUpperCase() ? S.examChoiceLetterSelected : {}) }}>{letter.toUpperCase()}</span>
            <span style={S.examChoiceText}>
              <ChoiceContent value={getChoiceValue(question, letter)} subject={renderSubject} style={{ fontSize: 16, lineHeight: 1.45 }} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ScoreRow({ label, score, meta }) {
  return (
    <div style={S.scoreRow}>
      <div style={S.scoreText}><span>{label}</span><strong>{meta || pct(score)}</strong></div>
      <div style={S.progress}><span style={{ ...S.progressFill, width: pct(score) }} /></div>
    </div>
  );
}


function PracticeQuiz({ subject, topic, subtopic, label, adminToken, onBack, mockQuestions }) {
  const [questions, setQuestions] = useState(() =>
    mockQuestions ? [...mockQuestions].sort(() => Math.random() - 0.5).slice(0, 10) : []
  );
  const [loading, setLoading] = useState(!mockQuestions);
  const [loadError, setLoadError] = useState(null);
  const [idx, setIdx] = useState(0);
  const [chosen, setChosen] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [score, setScore] = useState(0);
  const [history, setHistory] = useState([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (mockQuestions) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        // Prefer a non-expired local session; check both the admin builder key and the results portal key
        const freshToken = (() => {
          try {
            const now = Math.floor(Date.now() / 1000);
            for (const key of ["admin_session", "results_session"]) {
              const s = JSON.parse(localStorage.getItem(key) || "null");
              if (s?.access_token && (!s.exp || s.exp > now)) return s.access_token;
            }
            return adminToken;
          } catch { return adminToken; }
        })();
        const res = await fetch(`${FUNCTIONS}/get-practice-questions`, {
          method: "POST",
          headers: { apikey: KEY, Authorization: `Bearer ${freshToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ subject, topic, subtopic, limit: 10 }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `${res.status}`);
        if (cancelled) return;
        // Edge function returns stimulus + instruction already joined; _vis kept for render compat
        setQuestions((data.questions || []).map(q => ({ ...q, _vis: [] })));
      } catch (e) {
        if (!cancelled) setLoadError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [subject, topic, subtopic, adminToken, mockQuestions]);

  function choose(letter) {
    if (revealed) return;
    setChosen(letter);
  }

  function confirm() {
    if (!chosen || revealed) return;
    const q = questions[idx];
    const correct = (q.correct_answer || "").toUpperCase();
    const isRight = chosen.toUpperCase() === correct;
    if (isRight) setScore(s => s + 1);
    setHistory(h => [...h, { question: q, chosen, correct, isRight }]);
    setRevealed(true);
  }

  function next() {
    if (idx + 1 >= questions.length) {
      setDone(true);
    } else {
      setIdx(i => i + 1);
      setChosen(null);
      setRevealed(false);
    }
  }

  if (loading) return (
    <div style={{ position: "fixed", inset: 0, background: "#f0f9ff", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 }}>
      <div style={{ textAlign: "center", color: "#0f172a" }}>
        <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>Loading practice questions…</div>
        <div style={{ color: "#64748b", fontSize: 14 }}>{label}</div>
      </div>
    </div>
  );

  if (loadError) return (
    <div style={{ position: "fixed", inset: 0, background: "#f0f9ff", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ color: "#dc2626", fontWeight: 800, fontSize: 18, marginBottom: 10 }}>Could not load questions</div>
        <div style={{ color: "#64748b", fontSize: 14, marginBottom: 18 }}>{loadError}</div>
        <button onClick={onBack} style={PQ.backBtn}>Back to results</button>
      </div>
    </div>
  );

  if (questions.length === 0) return (
    <div style={{ position: "fixed", inset: 0, background: "#f0f9ff", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontWeight: 800, fontSize: 18, color: "#0f172a", marginBottom: 8 }}>No practice questions yet</div>
        <div style={{ color: "#64748b", fontSize: 14, marginBottom: 18 }}>We don't have questions tagged for "{label}" yet.</div>
        <button onClick={onBack} style={PQ.backBtn}>Back to results</button>
      </div>
    </div>
  );

  if (done) {
    const pct = Math.round((score / questions.length) * 100);
    const color = pct >= 70 ? "#059669" : pct >= 40 ? "#d97706" : "#dc2626";
    return (
      <div style={{ position: "fixed", inset: 0, overflowY: "auto", background: "#f0f9ff", zIndex: 1100 }}>
        <div style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px" }}>
          <button onClick={onBack} style={PQ.backBtn}>← Back to results</button>
          <div style={{ ...PQ.card, textAlign: "center", marginTop: 20, marginBottom: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1, color: "#94a3b8", marginBottom: 8 }}>Practice complete</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#0f172a", marginBottom: 16 }}>{label}</div>
            <div style={{ fontSize: 72, fontWeight: 900, color, lineHeight: 1, marginBottom: 4 }}>{pct}%</div>
            <div style={{ fontSize: 16, color: "#64748b" }}>{score} / {questions.length} correct</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {history.map((h, i) => {
              const letters = ["a", "b", "c", "d", "e"].filter(l => getChoiceValue(h.question, l));
              const renderSubject = getRenderSubject(h.question);
              const qVisuals = [...(h.question._vis || []), ...questionInlineVisualAssets(h.question)];
              const reviewVisualKey = h.question.question_id || h.question.session_question_id || h.question.id || i;
              return (
                <div key={i} style={{ ...PQ.card, borderLeft: `4px solid ${h.isRight ? "#059669" : "#dc2626"}` }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                    <span style={{ width: 22, height: 22, borderRadius: 999, background: h.isRight ? "#059669" : "#dc2626", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 900, flexShrink: 0 }}>{h.isRight ? "✓" : "✗"}</span>
                    <span style={{ fontSize: 12, fontWeight: 800, color: "#64748b" }}>Question {i + 1}</span>
                  </div>
                  <div style={{ fontSize: 15, color: "#0f172a", lineHeight: 1.6, marginBottom: 12, fontWeight: 500 }}>
                    <VisualAssetPreview key={reviewVisualKey} assets={qVisuals} storageBase={STORAGE} />
                    {h.question.render_markup ? (
                      <>
                        {getSegInstruction(h.question) && (
                          <div style={{ fontSize: 13, color: "#475569", marginBottom: 6, fontStyle: "italic" }}>
                            {getSegInstruction(h.question)}
                          </div>
                        )}
                        <SegMarkup markup={h.question.render_markup} />
                      </>
                    ) : (
                      <QuestionWithUnderline
                        text={getQuestionText(h.question)}
                        choiceA={getChoiceA(h.question)}
                        subject={renderSubject}
                        style={{ fontSize: 15, color: "#0f172a", lineHeight: 1.6, fontWeight: 500 }}
                      />
                    )}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {letters.map(l => {
                      const isChosen = l.toUpperCase() === h.chosen;
                      const isCorrect = l.toUpperCase() === h.correct;
                      let bg = "#f8fafc", border = "#e2e8f0", color2 = "#334155";
                      if (isCorrect) { bg = "#f0fdf4"; border = "#22c55e"; color2 = "#065f46"; }
                      else if (isChosen && !isCorrect) { bg = "#fff1f2"; border = "#f43f5e"; color2 = "#9f1239"; }
                      return (
                        <div key={l} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 12px", borderRadius: 8, background: bg, border: `1px solid ${border}` }}>
                          <span style={{ width: 22, height: 22, borderRadius: 4, background: isCorrect ? "#059669" : isChosen ? "#f43f5e" : "#e2e8f0", color: (isCorrect || isChosen) ? "#fff" : "#64748b", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 900, flexShrink: 0 }}>{l.toUpperCase()}</span>
                          <span style={{ fontSize: 13, color: color2, lineHeight: 1.45 }}>
                            <ChoiceContent value={getChoiceValue(h.question, l)} subject={renderSubject} style={{ fontSize: 13 }} />
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ textAlign: "center", marginTop: 24 }}>
            <button onClick={onBack} style={PQ.primaryBtn}>Back to results</button>
          </div>
        </div>
      </div>
    );
  }

  const q = questions[idx];
  const letters = ["a", "b", "c", "d", "e"].filter(l => getChoiceValue(q, l));
  const correct = (q.correct_answer || "").toUpperCase();
  const renderSubject = getRenderSubject(q);
  const qVisuals = [...(q._vis || []), ...questionInlineVisualAssets(q)];
  const visualKey = q.question_id || q.session_question_id || q.id || idx;

  return (
    <div style={{ position: "fixed", inset: 0, overflowY: "auto", background: "#f0f9ff", zIndex: 1100 }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 20px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <button onClick={onBack} style={PQ.backBtn}>← Back to results</button>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#64748b" }}>
            {idx + 1} / {questions.length}
            <span style={{ marginLeft: 10, padding: "2px 8px", borderRadius: 4, background: "#f0eeff", color: "#1d1148", fontSize: 11, fontWeight: 700 }}>{label}</span>
          </div>
        </div>
        {/* Progress bar */}
        <div style={{ height: 6, background: "#e8edf4", borderRadius: 999, marginBottom: 20, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${((idx) / questions.length) * 100}%`, background: "#1d1148", borderRadius: 999, transition: "width 0.3s" }} />
        </div>
        {/* Question card */}
        <div style={PQ.card}>
          {q.stimulus && (
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 14, marginBottom: 14 }}>
              {q.stimulus.stimulus_title && (
                <div style={{ color: "#64748b", fontSize: 10, fontWeight: 800, marginBottom: 6, textTransform: "uppercase" }}>{q.stimulus.stimulus_title}</div>
              )}
              <MathContent value={q.stimulus.stimulus_text} subject={renderSubject} style={{ color: "#334155", fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap" }} />
            </div>
          )}
          <VisualAssetPreview key={visualKey} assets={qVisuals} storageBase={STORAGE} />
          <div style={{ fontSize: 18, color: "#0f172a", lineHeight: 1.65, marginBottom: 20, fontWeight: 500 }}>
            {q.render_markup ? (
              <>
                {getSegInstruction(q) && (
                  <div style={{ fontSize: 14, color: "#475569", marginBottom: 8, fontStyle: "italic" }}>
                    {getSegInstruction(q)}
                  </div>
                )}
                <SegMarkup markup={q.render_markup} />
              </>
            ) : (
              <QuestionWithUnderline text={getQuestionText(q)} choiceA={getChoiceA(q)} subject={renderSubject} style={{ fontSize: 18, color: "#13233d", lineHeight: 1.65, fontWeight: 500 }} />
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
            {letters.map(l => {
              let bg = "#ffffff", border = "#dbe3ed", color3 = "#13233d", letterBg = "#e2e8f0", letterColor = "#334155";
              if (revealed) {
                const isCorrect = l.toUpperCase() === correct;
                const isChosen = l.toUpperCase() === chosen;
                if (isCorrect) { bg = "#f0fdf4"; border = "#22c55e"; color3 = "#065f46"; letterBg = "#059669"; letterColor = "#fff"; }
                else if (isChosen) { bg = "#fff1f2"; border = "#f43f5e"; color3 = "#9f1239"; letterBg = "#f43f5e"; letterColor = "#fff"; }
              } else if (chosen === l.toUpperCase()) {
                bg = "#f0eeff"; border = "#1d1148"; letterBg = "#1d1148"; letterColor = "#fff";
              }
              return (
                <button key={l} onClick={() => choose(l.toUpperCase())} disabled={revealed} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 8, background: bg, border: `1px solid ${border}`, cursor: revealed ? "default" : "pointer", textAlign: "left", fontFamily: "inherit", width: "100%", boxSizing: "border-box" }}>
                  <span style={{ width: 28, height: 28, borderRadius: 6, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 900, background: letterBg, color: letterColor }}>{l.toUpperCase()}</span>
                  <span style={{ fontSize: 16, color: color3, lineHeight: 1.45 }}>
                    <ChoiceContent value={getChoiceValue(q, l)} subject={renderSubject} style={{ fontSize: 16 }} />
                  </span>
                </button>
              );
            })}
          </div>
          {!revealed ? (
            <button onClick={confirm} disabled={!chosen} style={{ ...PQ.primaryBtn, opacity: chosen ? 1 : 0.45, width: "100%" }}>Confirm answer</button>
          ) : (
            <div>
              <div style={{ padding: "12px 16px", borderRadius: 8, marginBottom: 14, background: chosen === correct ? "#f0fdf4" : "#fff1f2", border: `1px solid ${chosen === correct ? "#22c55e" : "#f43f5e"}` }}>
                <span style={{ fontWeight: 900, fontSize: 15, color: chosen === correct ? "#059669" : "#dc2626" }}>
                  {chosen === correct ? "Correct!" : `Incorrect. Correct answer: ${correct}`}
                </span>
              </div>
              <button onClick={next} style={{ ...PQ.primaryBtn, width: "100%" }}>
                {idx + 1 >= questions.length ? "See results" : "Next question →"}
              </button>
            </div>
          )}
        </div>
        {/* Score tally */}
        <div style={{ textAlign: "center", marginTop: 16, fontSize: 13, color: "#64748b", fontWeight: 700 }}>
          Score so far: {score} / {history.length} correct
        </div>
      </div>
    </div>
  );
}

const PQ = {
  card: { background: "#ffffff", borderRadius: 14, padding: "24px 26px", boxShadow: "0 2px 12px rgba(15,23,42,0.08)", border: "1px solid #e2e8f0" },
  backBtn: { padding: "8px 14px", border: "1px solid #cbd5e1", background: "#ffffff", color: "#334155", borderRadius: 7, fontSize: 13, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" },
  primaryBtn: { padding: "12px 20px", border: "none", background: "#1d1148", color: "#ffffff", borderRadius: 8, fontSize: 14, fontWeight: 900, cursor: "pointer", fontFamily: "inherit" },
};

const S = {
  page: { position: "fixed", inset: 0, overflowY: "auto", background: "#f8fafc", color: "#13233d", fontFamily: "'DM Sans', system-ui, sans-serif", paddingTop: 20, boxSizing: "border-box", zIndex: 1000 },
  topbar: { minHeight: 76, padding: "14px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, borderBottom: "1px solid #e8edf4", background: "#ffffff", boxSizing: "border-box" },
  brand: { color: "#1d1148", fontSize: 12, fontWeight: 900, letterSpacing: 0.8 },
  topTitle: { color: "#13233d", fontSize: 20, fontWeight: 900, marginTop: 0, letterSpacing: 0 },
  smallMuted: { color: "#64748b", fontSize: 12, marginTop: 6 },
  actions: { display: "flex", gap: 8, alignItems: "center" },
  ghost: { padding: "8px 12px", border: "1px solid #cbd5e1", background: "#ffffff", color: "#334155", borderRadius: 6, fontSize: 12, fontWeight: 800, cursor: "pointer" },
  primary: { padding: "10px 18px", border: "none", background: "#1d1148", color: "#ffffff", borderRadius: 7, fontSize: 13, fontWeight: 900, cursor: "pointer" },
  finalBtn: { marginTop: 8, width: "100%", padding: "10px 18px", border: "none", background: "#f59e0b", color: "#000000", borderRadius: 7, fontSize: 13, fontWeight: 900, cursor: "pointer" },
  loadingPanel: { position: "relative", width: 520, maxWidth: "calc(100vw - 40px)", margin: "15vh auto 0", padding: 28, background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 12, boxShadow: "0 18px 50px rgba(15,23,42,0.12)" },
  errorPanel: { borderColor: "#fecaca", borderLeft: "5px solid #dc2626", background: "#fffafa" },
  errorHeadingRow: { display: "flex", alignItems: "center", gap: 12, marginTop: 8, marginBottom: 8 },
  errorIcon: { width: 30, height: 30, borderRadius: 999, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: "#dc2626", color: "#ffffff", fontSize: 18, fontWeight: 900, lineHeight: 1 },
  errorTitle: { color: "#dc2626", margin: 0 },
  errorMessage: { color: "#7f1d1d", fontSize: 14, lineHeight: 1.6, margin: "0 0 18px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 7, padding: 12 },
  closeBtn: { position: "absolute", top: 14, right: 14, ...{ padding: "6px 10px", border: "1px solid #cbd5e1", background: "#ffffff", color: "#334155", borderRadius: 6, fontSize: 12, fontWeight: 800, cursor: "pointer" } },
  loadingTitle: { margin: "8px 0", fontSize: 26, letterSpacing: 0, color: "#13233d" },
  muted: { color: "#64748b", fontSize: 14, lineHeight: 1.6, margin: "0 0 18px" },
  startPanel: { maxWidth: 880, margin: "44px auto", padding: "36px 44px", background: "#ffffff", border: "1px solid #e8edf4", borderRadius: 12, boxSizing: "border-box" },
  kicker: { color: "#1d1148", fontSize: 11, fontWeight: 900, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 10 },
  startTitle: { margin: "0 0 14px", fontSize: 32, letterSpacing: 0, color: "#13233d", fontWeight: 900 },
  sectionCards: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 14, margin: "26px auto 0" },
  sectionCard: { width: 180, minHeight: 100, boxSizing: "border-box", padding: 16, border: "1px solid #e8edf4", borderRadius: 10, background: "#f8fafc", display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "center", gap: 8, color: "#334155", fontSize: 12, textAlign: "left" },
  sectionCardLocked: { color: "#94a3b8", background: "#f8fafc", borderColor: "#edf2f7" },
  startButton: { marginTop: 30 },
  examLayout: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: 18, padding: 24, alignItems: "start" },
  questionPanel: { background: "#ffffff", border: "1px solid #e8edf4", borderRadius: 12, minHeight: "calc(100vh - 118px)", padding: 22 },
  sidePanel: { background: "#ffffff", border: "1px solid #e8edf4", borderRadius: 12, overflow: "hidden", position: "sticky", top: 18 },
  sidePanelHeader: { background: "#1d1148", padding: "20px 18px 18px" },
  sectionMeta: { fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.2, color: "rgba(255,255,255,0.5)", marginBottom: 6 },
  sectionNameBig: { fontSize: 18, fontWeight: 900, color: "#ffffff", lineHeight: 1.25, marginBottom: 16 },
  timerLabel: { fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.2, color: "rgba(255,255,255,0.5)", marginBottom: 4 },
  timerWhite: { color: "#ffffff", fontSize: 42, fontWeight: 900, fontVariantNumeric: "tabular-nums", letterSpacing: 0, lineHeight: 1 },
  savedPill: { display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 999, background: "rgba(34,197,94,0.18)", color: "#4ade80", fontSize: 11, fontWeight: 700, marginTop: 12 },
  navigatorBody: { padding: "14px 16px" },
  navigatorLabel: { fontSize: 11, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 },
  sectionTabs: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18 },
  sectionTab: { padding: "7px 10px", border: "1px solid #dbe3ed", background: "#f8fafc", color: "#475569", borderRadius: 6, fontSize: 12, fontWeight: 800, cursor: "pointer" },
  sectionTabLocked: { opacity: 0.48, cursor: "not-allowed" },
  sectionTabActive: { background: "#1d1148", borderColor: "#1d1148", color: "#ffffff" },
  questionHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, marginBottom: 12 },
  questionTitle: { margin: 0, fontSize: 22, letterSpacing: 0, color: "#13233d", fontWeight: 900 },
  markBtn: { padding: "8px 12px", border: "1px solid #cbd5e1", background: "#ffffff", color: "#334155", borderRadius: 6, fontSize: 12, fontWeight: 800, cursor: "pointer" },
  markedBtn: { background: "#fef3c7", borderColor: "#f59e0b", color: "#92400e" },
  callout: { padding: 12, marginBottom: 12, background: "#f0fdfa", border: "1px solid #99f6e4", borderRadius: 8, color: "#115e59", fontSize: 13, lineHeight: 1.55 },
  stimulus: { padding: 16, marginBottom: 16, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, color: "#334155", fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap" },
  prompt: { fontSize: 18, lineHeight: 1.65, color: "#13233d", marginBottom: 18 },
  choices: { display: "grid", gap: 10 },
  choice: { width: "100%", display: "grid", gridTemplateColumns: "34px minmax(0,1fr)", alignItems: "start", gap: 10, textAlign: "left", padding: 14, border: "1px solid #dbe3ed", borderRadius: 8, background: "#ffffff", color: "#13233d", fontSize: 15, lineHeight: 1.5, cursor: "pointer" },
  choiceActive: { borderColor: "#1d1148", background: "#f0eeff", boxShadow: "0 0 0 1px #1d1148 inset" },
  choiceLetter: { width: 28, height: 28, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 6, background: "#e2e8f0", color: "#334155", fontWeight: 900, fontSize: 12 },
  examRender: { marginBottom: 18 },
  examBlock: { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 14, marginBottom: 14 },
  examLabel: { color: "#64748b", fontSize: 10, fontWeight: 800, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 },
  examPrompt: { color: "#13233d", fontSize: 18, lineHeight: 1.65, marginBottom: 16, whiteSpace: "pre-wrap", textAlign: "left" },
  examChoices: { display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 },
  examChoice: { width: "100%", boxSizing: "border-box", minHeight: 62, display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 10, background: "#ffffff", border: "1px solid #dbe3ed", textAlign: "left", cursor: "pointer", fontFamily: "inherit" },
  examChoiceSelected: { background: "#f0eeff", border: "1px solid #1d1148", boxShadow: "0 0 0 1px #1d1148 inset" },
  examChoiceLetter: { width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 900, background: "#e8edf4", color: "#334155" },
  examChoiceLetterSelected: { background: "#1d1148", color: "#ffffff" },
  examChoiceText: { minHeight: 28, display: "flex", alignItems: "center", color: "#13233d", fontSize: 16, lineHeight: 1.45, paddingTop: 0 },
  navRow: { display: "flex", justifyContent: "space-between", gap: 10, borderTop: "1px solid #e8edf4", paddingTop: 18, marginTop: 24 },
  navBtn: { padding: "10px 18px", border: "1px solid #cbd5e1", background: "#ffffff", color: "#334155", borderRadius: 7, fontSize: 13, fontWeight: 900, cursor: "pointer" },
  timer: { color: "#13233d", fontSize: 34, fontWeight: 900, fontVariantNumeric: "tabular-nums", letterSpacing: 0 },
  scoreRow: { marginTop: 12 },
  scoreText: { display: "flex", justifyContent: "space-between", color: "#334155", fontSize: 12, fontWeight: 800, marginBottom: 6 },
  progress: { height: 6, background: "#e2e8f0", borderRadius: 999, overflow: "hidden" },
  progressFill: { display: "block", height: "100%", background: "#1d1148", borderRadius: 999 },
  gridMenu: { display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 5, marginBottom: 14 },
  qCell: { aspectRatio: "1", border: "1px solid #cbd5e1", borderRadius: 6, background: "#ffffff", color: "#13233d", fontWeight: 900, cursor: "pointer", fontSize: 11 },
  q_answered: { background: "#dcfce7", borderColor: "#22c55e", color: "#166534" },
  q_marked: { background: "#fef3c7", borderColor: "#f59e0b", color: "#92400e" },
  q_blank: { background: "#ffffff", color: "#13233d" },
  qActive: { outline: "2px solid #1d1148", outlineOffset: 1 },
  statusList: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 },
  statusPill: { padding: "4px 7px", borderRadius: 999, background: "#f1f5f9", color: "#475569", fontSize: 10, fontWeight: 800 },
  inlineError: { padding: 10, marginBottom: 10, border: "1px solid #fecaca", background: "#fef2f2", color: "#991b1b", borderRadius: 7, fontSize: 12, lineHeight: 1.45 },
  inlineNote: { padding: 10, marginBottom: 10, border: "1px solid #bfdbfe", background: "#eff6ff", color: "#1e40af", borderRadius: 7, fontSize: 12, lineHeight: 1.45 },
  testBtn: { width: "100%", padding: "10px 18px", border: "1px solid #7c3aed", background: "#f5f3ff", color: "#6d28d9", borderRadius: 7, fontSize: 13, fontWeight: 900, cursor: "pointer", marginBottom: 8 },
  empty: { color: "#64748b", textAlign: "center", padding: 40 },
  resultsGrid: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16, padding: 24 },
  panel: { background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8, padding: 20 },
  readiness: { fontSize: 54, fontWeight: 900, color: "#13233d", letterSpacing: 0, margin: "6px 0" },
  resultStats: { display: "flex", gap: 14, marginTop: 12, color: "#475569", fontSize: 13 },
  reco: { padding: 12, border: "1px solid #e2e8f0", borderRadius: 8, background: "#f8fafc", color: "#334155", fontSize: 13, lineHeight: 1.5, marginTop: 8 },
  tags: { display: "flex", flexWrap: "wrap", gap: 7, marginTop: 10 },
  tag: { padding: "5px 9px", borderRadius: 999, background: "#EFF7FF", color: "#2E93FF", fontSize: 11, fontWeight: 800 },
};

const SR = {
  card: { background: "#ffffff", borderRadius: 16, padding: "20px 22px", boxShadow: "0 1px 4px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04)", border: "1px solid #e8edf4" },
  sectionLabel: { fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1, color: "#94a3b8" },
};
