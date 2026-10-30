import { useCallback, useEffect, useMemo, useState } from "react";

const PAGE_SIZE = 500;

function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadTextFile(name, text, type = "text/csv;charset=utf-8;") {
  const blob = new Blob([text], { type });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => window.URL.revokeObjectURL(url), 5000);
}

function shortId(value) {
  const text = String(value || "");
  return text ? `${text.slice(0, 8)}...${text.slice(-4)}` : "";
}

function fmtDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function fmtScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return num.toFixed(num % 1 === 0 ? 0 : 1);
}

function pct(value) {
  const text = fmtScore(value);
  return text ? `${text}%` : "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function makeHeaders(token) {
  return { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function inFilter(ids) {
  return `in.(${ids.map(encodeURIComponent).join(",")})`;
}

async function fetchBySession(rest, token, table, sessionId, select, order = "") {
  const headers = makeHeaders(token);
  const params = new URLSearchParams();
  params.set("select", select);
  params.set("session_id", `eq.${sessionId}`);
  if (order) params.set("order", order);
  return fetchJson(`${rest}/${table}?${params}`, headers);
}

function resultCsvRows(session, result) {
  const base = {
    session_id: session.id,
    student_user_id: session.user_id,
    status: session.status,
    started_at: session.started_at,
    completed_at: session.completed_at,
    overall_score: result.readiness?.overall_score ?? "",
    readiness_tier: result.readiness?.tier ?? "",
  };

  const rows = [];
  (result.subjects || []).forEach((r) => rows.push({ ...base, grain: "subject", subject: r.subject, topic: "", subtopic: "", label: r.subject, raw_correct: r.raw_correct, raw_total: r.raw_total, score: r.weighted_score, band: "" }));
  (result.topics || []).forEach((r) => rows.push({ ...base, grain: "topic", subject: r.subject, topic: r.topic, subtopic: "", label: r.topic, raw_correct: r.raw_correct, raw_total: r.raw_total, score: r.weighted_score, band: "" }));
  (result.subtopics || []).forEach((r) => rows.push({ ...base, grain: "subtopic", subject: r.subject, topic: r.topic, subtopic: r.subtopic, label: r.subtopic, raw_correct: r.raw_correct, raw_total: r.raw_total, score: r.perf_score, band: r.mastery_band }));
  (result.classifications || []).forEach((r) => rows.push({ ...base, grain: "classification", subject: "", topic: "", subtopic: "", label: r.name || r.code, raw_correct: "", raw_total: "", score: r.fit_score, band: `rank ${r.rank ?? ""}` }));
  (result.predictions || []).forEach((r) => rows.push({ ...base, grain: "university_prediction", subject: "", topic: "", subtopic: "", label: r.university, raw_correct: "", raw_total: "", score: r.predictive_index, band: r.profile }));

  const rec = result.recommendations || {};
  if (rec.study_focus) rows.push({ ...base, grain: "recommendation", subject: "", topic: "", subtopic: "", label: "Study focus", raw_correct: "", raw_total: "", score: "", band: rec.study_focus });
  return rows;
}

function rowsToCsv(rows) {
  const columns = ["session_id", "student_user_id", "status", "started_at", "completed_at", "overall_score", "readiness_tier", "grain", "subject", "topic", "subtopic", "label", "raw_correct", "raw_total", "score", "band"];
  return [columns.map(csvEscape).join(","), ...rows.map((row) => columns.map((col) => csvEscape(row[col])).join(","))].join("\n");
}

function summaryToCsv(sessions) {
  const columns = ["student_user_id", "session_id", "status", "started_at", "completed_at", "overall_score", "readiness_tier", "primary_recommendation"];
  const rows = sessions.map((s) => ({
    student_user_id: s.user_id,
    session_id: s.id,
    status: s.status,
    started_at: s.started_at,
    completed_at: s.completed_at,
    overall_score: s.readiness?.overall_score ?? "",
    readiness_tier: s.readiness?.tier ?? "",
    primary_recommendation: s.recommendation?.primary_classification_code ?? "",
  }));
  return [columns.map(csvEscape).join(","), ...rows.map((row) => columns.map((col) => csvEscape(row[col])).join(","))].join("\n");
}

function tableHtml(rows, columns) {
  if (!rows?.length) return `<div class="empty">No data.</div>`;
  return `<table><thead><tr>${columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map(([key]) => `<td>${escapeHtml(row[key])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function resultReportHtml(session, result) {
  const rec = result.recommendations || {};
  const title = `Diagnostic Results - ${shortId(session.user_id)}`;
  const subjects = (result.subjects || []).map((s) => ({ ...s, score: pct(s.weighted_score), raw: `${s.raw_correct}/${s.raw_total}` }));
  const topics = (result.topics || []).map((s) => ({ ...s, score: pct(s.weighted_score), raw: `${s.raw_correct}/${s.raw_total}` }));
  const subtopics = (result.subtopics || []).map((s) => ({ ...s, score: pct(s.perf_score), raw: `${s.raw_correct}/${s.raw_total}`, band: s.mastery_band || "" }));
  const classifications = (result.classifications || []).map((c) => ({ ...c, fit: fmtScore(c.fit_score), rank: c.rank ?? "" }));
  const predictions = (result.predictions || []).map((p) => ({ ...p, score: pct(p.predictive_index), profile: p.profile || "" }));

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font-family:Arial,sans-serif;color:#172033;margin:.6in;font-size:10.5pt}
h1{font-size:22pt;margin:0;color:#170142}h2{font-size:13pt;margin:22px 0 8px;color:#170142}.muted{color:#64748b}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0}.metric{border:1px solid #dbe3ef;border-radius:8px;padding:12px}.metric b{display:block;font-size:18pt;color:#0f172a;margin-top:4px}.callout{background:#eff7ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px;margin:14px 0;line-height:1.5}table{width:100%;border-collapse:collapse;margin-top:8px;page-break-inside:auto}th,td{border-bottom:1px solid #e2e8f0;padding:6px 7px;text-align:left;vertical-align:top}th{background:#f8fafc;color:#475569;font-size:9pt;text-transform:uppercase}.section{page-break-inside:avoid}.chips span{display:inline-block;border:1px solid #dbe3ef;border-radius:6px;padding:4px 8px;margin:3px;background:#f8fafc}.empty{color:#94a3b8;padding:8px 0}@media print{body{margin:.45in}.no-print{display:none}.section{break-inside:avoid}}
</style>
<script>window.onload=function(){window.print();}</script></head><body>
<h1>Diagnostic Results</h1>
<div class="muted">Student user: ${escapeHtml(session.user_id)} &nbsp; | &nbsp; Session: ${escapeHtml(session.id)}</div>
<div class="muted">Started: ${escapeHtml(fmtDate(session.started_at))} &nbsp; | &nbsp; Completed: ${escapeHtml(fmtDate(session.completed_at))}</div>
<div class="grid">
<div class="metric">Overall Score<b>${escapeHtml(fmtScore(result.readiness?.overall_score))}</b></div>
<div class="metric">Readiness Tier<b>${escapeHtml(result.readiness?.tier || "")}</b></div>
<div class="metric">Primary Fit<b>${escapeHtml(rec.primary?.code || rec.primary_classification_code || "")}</b></div>
<div class="metric">Questions<b>${escapeHtml(session.total_questions || "")}</b></div>
</div>
${result.readiness?.message ? `<div class="callout">${escapeHtml(result.readiness.message)}</div>` : ""}
${rec.study_focus ? `<div class="callout"><strong>Study focus:</strong> ${escapeHtml(rec.study_focus)}</div>` : ""}
<div class="section"><h2>Subject Performance</h2>${tableHtml(subjects, [["subject", "Subject"], ["raw", "Raw"], ["score", "Score"]])}</div>
<div class="section"><h2>Topic Performance</h2>${tableHtml(topics, [["subject", "Subject"], ["topic", "Topic"], ["raw", "Raw"], ["score", "Score"]])}</div>
<div class="section"><h2>Subtopic Performance</h2>${tableHtml(subtopics, [["subject", "Subject"], ["topic", "Topic"], ["subtopic", "Subtopic"], ["raw", "Raw"], ["score", "Score"], ["band", "Band"]])}</div>
<div class="section"><h2>Course Fit Rankings</h2>${tableHtml(classifications, [["rank", "Rank"], ["code", "Code"], ["name", "Name"], ["fit", "Fit Score"]])}</div>
<div class="section"><h2>University Predictions</h2>${tableHtml(predictions, [["university", "University"], ["score", "Prediction"], ["profile", "Profile"]])}</div>
${rec.strengths?.length ? `<div class="section"><h2>Strengths</h2><div class="chips">${rec.strengths.map((s) => `<span>${escapeHtml(s)}</span>`).join("")}</div></div>` : ""}
${rec.weaknesses?.length ? `<div class="section"><h2>Priority Gaps</h2><div class="chips">${rec.weaknesses.map((s) => `<span>${escapeHtml(s)}</span>`).join("")}</div></div>` : ""}
</body></html>`;
}

function openPrintHtml(html) {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = window.URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => window.URL.revokeObjectURL(url), 60000);
}

export default function ResultsExport({ session, rest }) {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedResult, setSelectedResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");

  const token = session?.access_token;
  const selectedSession = useMemo(() => sessions.find((item) => item.id === selectedId) || null, [sessions, selectedId]);
  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((item) => [item.id, item.user_id, item.readiness?.tier, item.recommendation?.primary_classification_code].some((value) => String(value || "").toLowerCase().includes(q)));
  }, [query, sessions]);

  const loadSessions = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setMessage("");
    try {
      const headers = makeHeaders(token);
      const params = new URLSearchParams();
      params.set("select", "id,user_id,template_id,status,started_at,completed_at,total_questions");
      params.set("status", "eq.completed");
      params.set("order", "completed_at.desc.nullslast");
      params.set("limit", String(PAGE_SIZE));
      const baseSessions = await fetchJson(`${rest}/diagnostic_sessions?${params}`, headers);
      const ids = baseSessions.map((item) => item.id);
      let readiness = [];
      let recommendations = [];
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        readiness = readiness.concat(await fetchJson(`${rest}/session_readiness_tiers?select=session_id,overall_score,readiness_tier&session_id=${inFilter(chunk)}`, headers));
        recommendations = recommendations.concat(await fetchJson(`${rest}/session_recommendations?select=session_id,primary_classification_code&session_id=${inFilter(chunk)}`, headers));
      }
      const readinessBySession = new Map(readiness.map((row) => [row.session_id, { overall_score: Number(row.overall_score), tier: row.readiness_tier }]));
      const recommendationBySession = new Map(recommendations.map((row) => [row.session_id, row]));
      setSessions(baseSessions.map((item) => ({
        ...item,
        readiness: readinessBySession.get(item.id) || null,
        recommendation: recommendationBySession.get(item.id) || null,
      })));
    } catch (err) {
      setMessage(`Could not load completed sessions: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [rest, token]);

  async function loadResult(sessionId) {
    if (!token || !sessionId) return null;
    setDetailLoading(true);
    setMessage("");
    try {
      const [readinessRows, subjects, topics, subtopics, classifications, recRows, predictions, percentiles] = await Promise.all([
        fetchBySession(rest, token, "session_readiness_tiers", sessionId, "overall_score,readiness_tier"),
        fetchBySession(rest, token, "session_subject_scores", sessionId, "subject,raw_correct,raw_total,weighted_score", "subject.asc"),
        fetchBySession(rest, token, "session_topic_scores", sessionId, "subject,topic,raw_correct,raw_total,weighted_score", "subject.asc,topic.asc"),
        fetchBySession(rest, token, "session_subtopic_scores", sessionId, "subject,topic,subtopic,raw_correct,raw_total,perf_score,mastery_band", "subject.asc,topic.asc,subtopic.asc"),
        fetchBySession(rest, token, "session_classification_scores", sessionId, "classification_code,wps_score,ctr_score,fit_score,fit_rank,course_classifications(name)", "fit_rank.asc"),
        fetchBySession(rest, token, "session_recommendations", sessionId, "primary_classification_code,alternative_classification_codes,strengths,weaknesses,study_focus"),
        fetchBySession(rest, token, "session_university_predictions", sessionId, "university_code,predictive_index,profile_label", "predictive_index.desc"),
        fetchBySession(rest, token, "session_percentiles", sessionId, "target_type,target_code,percentile_rank"),
      ]);
      const readiness = readinessRows[0] || null;
      const classificationsMapped = (classifications || []).map((c) => ({
        code: c.classification_code,
        name: c.course_classifications?.name || c.classification_code,
        wps: Number(c.wps_score),
        ctr: Number(c.ctr_score),
        fit_score: Number(c.fit_score),
        rank: c.fit_rank,
      }));
      const rec = recRows[0] || null;
      const primary = classificationsMapped.find((c) => c.code === rec?.primary_classification_code);
      const result = {
        readiness: readiness ? { overall_score: Number(readiness.overall_score), tier: readiness.readiness_tier, message: "" } : null,
        subjects: (subjects || []).map((s) => ({ ...s, weighted_score: Number(s.weighted_score) })),
        topics: (topics || []).map((s) => ({ ...s, weighted_score: Number(s.weighted_score) })),
        subtopics: (subtopics || []).map((s) => ({ ...s, perf_score: Number(s.perf_score) })),
        classifications: classificationsMapped,
        recommendations: rec ? {
          primary: { code: rec.primary_classification_code, name: primary?.name || rec.primary_classification_code, fit_score: primary?.fit_score || 0 },
          alternatives: rec.alternative_classification_codes || [],
          strengths: rec.strengths || [],
          weaknesses: rec.weaknesses || [],
          study_focus: rec.study_focus || "",
        } : {},
        predictions: (predictions || []).map((p) => ({ university: p.university_code, predictive_index: Number(p.predictive_index), profile: p.profile_label })),
        percentiles: (percentiles || []).map((p) => ({ target: p.target_type, code: p.target_code, percentile_rank: p.percentile_rank })),
      };
      setSelectedResult(result);
      return result;
    } catch (err) {
      setMessage(`Could not load session results: ${err.message}`);
      return null;
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      loadSessions();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadSessions]);

  async function exportSelectedCsv() {
    if (!selectedSession) return;
    const result = selectedResult || await loadResult(selectedSession.id);
    if (!result) return;
    const stamp = new Date().toISOString().slice(0, 10);
    downloadTextFile(`student-results-${shortId(selectedSession.user_id)}-${stamp}.csv`, rowsToCsv(resultCsvRows(selectedSession, result)));
    setMessage("Exported detailed result CSV.");
  }

  async function printSelectedPdf() {
    if (!selectedSession) return;
    const result = selectedResult || await loadResult(selectedSession.id);
    if (!result) return;
    openPrintHtml(resultReportHtml(selectedSession, result));
    setMessage("Opened print-ready report. Choose Save as PDF in the print dialog.");
  }

  return (
    <main style={R.page}>
      <section style={R.panel}>
        <div style={R.toolbar}>
          <div>
            <h1 style={R.title}>Student Results</h1>
            <p style={R.copy}>Export completed diagnostic sessions as a CSV summary, detailed session CSV, or print-ready PDF report.</p>
          </div>
          <div style={R.actions}>
            <button onClick={loadSessions} disabled={loading} style={R.btn}>{loading ? "Refreshing..." : "Refresh"}</button>
            <button
              onClick={() => downloadTextFile(`student-results-summary-${new Date().toISOString().slice(0, 10)}.csv`, summaryToCsv(filteredSessions))}
              disabled={!filteredSessions.length}
              style={{ ...R.btn, opacity: filteredSessions.length ? 1 : 0.45 }}
            >
              Export Summary CSV
            </button>
          </div>
        </div>

        <div style={R.filterRow}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search session, user ID, tier, or recommendation..." style={R.input} />
          <span style={R.count}>{filteredSessions.length} completed session{filteredSessions.length === 1 ? "" : "s"}</span>
        </div>

        {message && <div style={R.message}>{message}</div>}

        <div style={R.grid}>
          <div style={R.list}>
            <div style={R.listHeader}>
              <span>Student</span>
              <span>Completed</span>
              <span>Score</span>
              <span>Tier</span>
            </div>
            {filteredSessions.map((item) => (
              <button key={item.id} onClick={() => { setSelectedId(item.id); setSelectedResult(null); }} style={{ ...R.row, ...(selectedId === item.id ? R.rowActive : {}) }}>
                <span title={item.user_id}>{shortId(item.user_id)}</span>
                <span>{fmtDate(item.completed_at)}</span>
                <span>{fmtScore(item.readiness?.overall_score)}</span>
                <span>{item.readiness?.tier || ""}</span>
              </button>
            ))}
            {!loading && !filteredSessions.length && <div style={R.empty}>No completed sessions found.</div>}
          </div>

          <aside style={R.detail}>
            {selectedSession ? (
              <>
                <div style={R.detailLabel}>Selected Session</div>
                <div style={R.detailTitle}>{shortId(selectedSession.user_id)}</div>
                <div style={R.meta}>Session: {selectedSession.id}</div>
                <div style={R.meta}>Completed: {fmtDate(selectedSession.completed_at)}</div>
                <div style={R.metrics}>
                  <div><span>Score</span><strong>{fmtScore(selectedSession.readiness?.overall_score)}</strong></div>
                  <div><span>Tier</span><strong>{selectedSession.readiness?.tier || "-"}</strong></div>
                  <div><span>Primary</span><strong>{selectedSession.recommendation?.primary_classification_code || "-"}</strong></div>
                </div>
                <div style={R.detailActions}>
                  <button onClick={() => loadResult(selectedSession.id)} disabled={detailLoading} style={R.btn}>{detailLoading ? "Loading..." : "Load Details"}</button>
                  <button onClick={exportSelectedCsv} disabled={detailLoading} style={R.btn}>Export Detail CSV</button>
                  <button onClick={printSelectedPdf} disabled={detailLoading} style={R.primaryBtn}>Print PDF Report</button>
                </div>
                {selectedResult && (
                  <div style={R.preview}>
                    <div style={R.detailLabel}>Loaded Detail</div>
                    <div>{selectedResult.subjects?.length || 0} subjects</div>
                    <div>{selectedResult.topics?.length || 0} topics</div>
                    <div>{selectedResult.subtopics?.length || 0} subtopics</div>
                    <div>{selectedResult.classifications?.length || 0} course fits</div>
                  </div>
                )}
              </>
            ) : (
              <div style={R.empty}>Select a completed session to export a detailed CSV or PDF report.</div>
            )}
          </aside>
        </div>
      </section>
    </main>
  );
}

const R = {
  page: { flex: 1, overflow: "auto", background: "#0a0f1a", padding: 24 },
  panel: { maxWidth: 1240, margin: "0 auto" },
  toolbar: { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", marginBottom: 18 },
  title: { margin: 0, color: "#f8fafc", fontSize: 24, fontWeight: 800 },
  copy: { color: "#64748b", fontSize: 13, margin: "5px 0 0", lineHeight: 1.5 },
  actions: { display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" },
  btn: { padding: "8px 12px", border: "1px solid #1a2236", borderRadius: 6, background: "#111827", color: "#cbd5e1", cursor: "pointer", fontSize: 12, fontWeight: 700 },
  primaryBtn: { padding: "8px 12px", border: "1px solid #f59e0b", borderRadius: 6, background: "#f59e0b", color: "#170142", cursor: "pointer", fontSize: 12, fontWeight: 800 },
  filterRow: { display: "flex", gap: 12, alignItems: "center", marginBottom: 12 },
  input: { width: 360, maxWidth: "60vw", padding: "9px 12px", background: "#111827", border: "1px solid #1a2236", borderRadius: 6, color: "#e5e7eb", outline: "none", fontSize: 13 },
  count: { color: "#64748b", fontSize: 12 },
  message: { marginBottom: 12, padding: "10px 12px", border: "1px solid #1a2236", borderRadius: 6, color: "#cbd5e1", background: "#111827", fontSize: 12 },
  grid: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 360px", gap: 16, alignItems: "start" },
  list: { border: "1px solid #1a2236", borderRadius: 8, overflow: "hidden", background: "#0f1629" },
  listHeader: { display: "grid", gridTemplateColumns: "1.2fr 1.5fr .6fr 1fr", gap: 10, padding: "10px 14px", background: "#111827", color: "#64748b", fontSize: 11, fontWeight: 800, textTransform: "uppercase" },
  row: { width: "100%", display: "grid", gridTemplateColumns: "1.2fr 1.5fr .6fr 1fr", gap: 10, padding: "12px 14px", background: "transparent", border: "none", borderTop: "1px solid #1a2236", color: "#cbd5e1", textAlign: "left", cursor: "pointer", fontSize: 12, alignItems: "center" },
  rowActive: { background: "#1a2236", color: "#f8fafc" },
  detail: { border: "1px solid #1a2236", borderRadius: 8, background: "#0f1629", padding: 16, minHeight: 220, color: "#cbd5e1" },
  detailLabel: { color: "#64748b", fontSize: 11, fontWeight: 800, textTransform: "uppercase", marginBottom: 6 },
  detailTitle: { color: "#f8fafc", fontSize: 20, fontWeight: 800, marginBottom: 8 },
  meta: { color: "#94a3b8", fontSize: 12, lineHeight: 1.6, overflowWrap: "anywhere" },
  metrics: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, margin: "14px 0" },
  detailActions: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 },
  preview: { marginTop: 16, padding: 12, border: "1px solid #1a2236", borderRadius: 6, background: "#111827", color: "#94a3b8", fontSize: 12, lineHeight: 1.7 },
  empty: { padding: 16, color: "#64748b", fontSize: 13 },
};
