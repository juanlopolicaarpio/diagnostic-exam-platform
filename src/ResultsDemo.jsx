import { useState } from "react";
import { ResultsView } from "./StudentExamPreview";

const URL_BASE = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, "");
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const AUTH_URL = `${URL_BASE}/auth/v1`;
const STORAGE_KEY = "results_session";

// ─── Mock results data ───────────────────────────────────────────

const RAW = {
  started_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  completed_at: new Date().toISOString(),
  readiness: {
    overall_score: 61,
    tier: "Developing",
    message: "You're on the right track. Focus on strengthening Logic and Social Studies to boost your readiness significantly.",
  },
  percentiles: [
    { target: "overall", code: "overall", percentile_rank: 54 },
    { target: "subject", code: "Mathematics", percentile_rank: 47 },
    { target: "subject", code: "Science", percentile_rank: 58 },
    { target: "subject", code: "English Language", percentile_rank: 75 },
    { target: "subject", code: "Filipino Language", percentile_rank: 68 },
    { target: "subject", code: "Reading", percentile_rank: 55 },
    { target: "subject", code: "Social Studies", percentile_rank: 38 },
    { target: "subject", code: "Logic/Abstract Reasoning", percentile_rank: 31 },
    { target: "classification", code: "BMA", percentile_rank: 62 },
    { target: "classification", code: "HAMS", percentile_rank: 58 },
    { target: "classification", code: "EA", percentile_rank: 44 },
    { target: "classification", code: "ITCS", percentile_rank: 48 },
    { target: "classification", code: "SM", percentile_rank: 50 },
    { target: "classification", code: "HSSC", percentile_rank: 67 },
    { target: "classification", code: "ETT", percentile_rank: 60 },
    { target: "classification", code: "SNC", percentile_rank: 52 },
  ],
  subjects: [
    { subject: "Mathematics", weighted_score: 52, raw_correct: 21, raw_total: 40 },
    { subject: "Science", weighted_score: 65, raw_correct: 26, raw_total: 40 },
    { subject: "English Language", weighted_score: 75, raw_correct: 15, raw_total: 20 },
    { subject: "Filipino Language", weighted_score: 70, raw_correct: 7, raw_total: 10 },
    { subject: "Reading", weighted_score: 60, raw_correct: 18, raw_total: 30 },
    { subject: "Social Studies", weighted_score: 47, raw_correct: 7, raw_total: 15 },
    { subject: "Logic/Abstract Reasoning", weighted_score: 40, raw_correct: 6, raw_total: 15 },
  ],
  topics: [
    { subject: "Mathematics", topic: "Algebra", weighted_score: 52, raw_correct: 11, raw_total: 21 },
    { subject: "Mathematics", topic: "Geometry", weighted_score: 40, raw_correct: 4, raw_total: 10 },
    { subject: "Mathematics", topic: "Statistics & Probability", weighted_score: 67, raw_correct: 2, raw_total: 3 },
    { subject: "Science", topic: "Earth Systems", weighted_score: 60, raw_correct: 3, raw_total: 5 },
    { subject: "Science", topic: "Acids and Bases", weighted_score: 67, raw_correct: 2, raw_total: 3 },
    { subject: "Science", topic: "Atomic Structure", weighted_score: 67, raw_correct: 2, raw_total: 3 },
    { subject: "Science", topic: "Cell Biology", weighted_score: 50, raw_correct: 1, raw_total: 2 },
    { subject: "Science", topic: "Genetics", weighted_score: 50, raw_correct: 1, raw_total: 2 },
    { subject: "Science", topic: "Evolution", weighted_score: 50, raw_correct: 1, raw_total: 2 },
    { subject: "Science", topic: "Universe & Solar System", weighted_score: 100, raw_correct: 2, raw_total: 2 },
    { subject: "English Language", topic: "Advanced Grammar & Syntax", weighted_score: 75, raw_correct: 6, raw_total: 8 },
    { subject: "English Language", topic: "Vocabulary & Word Study", weighted_score: 71, raw_correct: 5, raw_total: 7 },
    { subject: "English Language", topic: "Core Grammar", weighted_score: 80, raw_correct: 4, raw_total: 5 },
    { subject: "Filipino Language", topic: "Linguistics & Metalinguistics", weighted_score: 80, raw_correct: 4, raw_total: 5 },
    { subject: "Filipino Language", topic: "Filipino Language in Culture & Society", weighted_score: 100, raw_correct: 1, raw_total: 1 },
    { subject: "Reading", topic: "Reading Comprehension", weighted_score: 62, raw_correct: 16, raw_total: 26 },
    { subject: "Reading", topic: "Critical Reading", weighted_score: 50, raw_correct: 2, raw_total: 4 },
    { subject: "Social Studies", topic: "Asian History", weighted_score: 33, raw_correct: 2, raw_total: 6 },
    { subject: "Social Studies", topic: "Philippine History", weighted_score: 67, raw_correct: 2, raw_total: 3 },
    { subject: "Social Studies", topic: "World History", weighted_score: 50, raw_correct: 2, raw_total: 4 },
    { subject: "Social Studies", topic: "Economics", weighted_score: 50, raw_correct: 1, raw_total: 2 },
    { subject: "Logic/Abstract Reasoning", topic: "Logic", weighted_score: 40, raw_correct: 6, raw_total: 15 },
  ],
  subtopics: [
    { subject: "Mathematics", topic: "Algebra", subtopic: "Linear Equations and Inequalities in One Var.", weighted_score: 60, raw_correct: 3, raw_total: 5, mastery_band: "Developing" },
    { subject: "Mathematics", topic: "Algebra", subtopic: "Radicals", weighted_score: 67, raw_correct: 2, raw_total: 3, mastery_band: "Developing" },
    { subject: "Mathematics", topic: "Geometry", subtopic: "Triangles", weighted_score: 50, raw_correct: 1, raw_total: 2, mastery_band: "Developing" },
    { subject: "Mathematics", topic: "Geometry", subtopic: "Coordinate Geometry", weighted_score: 50, raw_correct: 1, raw_total: 2, mastery_band: "Developing" },
    { subject: "Science", topic: "Earth Systems", subtopic: "Anthrosphere / Humanosphere", weighted_score: 50, raw_correct: 1, raw_total: 2, mastery_band: "Developing" },
    { subject: "Science", topic: "Earth Systems", subtopic: "Atmosphere", weighted_score: 100, raw_correct: 1, raw_total: 1, mastery_band: "Advanced" },
    { subject: "Science", topic: "Cell Biology", subtopic: "Cell Cycle", weighted_score: 100, raw_correct: 1, raw_total: 1, mastery_band: "Advanced" },
    { subject: "Science", topic: "Cell Biology", subtopic: "Transport Mechanisms", weighted_score: 0, raw_correct: 0, raw_total: 1, mastery_band: "Needs Improvement" },
    { subject: "Reading", topic: "Reading Comprehension", subtopic: "Main Idea and Details", weighted_score: 65, raw_correct: 13, raw_total: 20, mastery_band: "Developing" },
    { subject: "Reading", topic: "Reading Comprehension", subtopic: "Inference and Sequence", weighted_score: 50, raw_correct: 1, raw_total: 2, mastery_band: "Developing" },
    { subject: "Reading", topic: "Reading Comprehension", subtopic: "Vocabulary and Reference", weighted_score: 50, raw_correct: 2, raw_total: 4, mastery_band: "Developing" },
    { subject: "Reading", topic: "Critical Reading", subtopic: "Passage Analysis", weighted_score: 33, raw_correct: 1, raw_total: 3, mastery_band: "Needs Improvement" },
    { subject: "English Language", topic: "Advanced Grammar & Syntax", subtopic: "Coordination and subordination", weighted_score: 75, raw_correct: 3, raw_total: 4, mastery_band: "Proficient" },
    { subject: "English Language", topic: "Vocabulary & Word Study", subtopic: "Context clues", weighted_score: 67, raw_correct: 2, raw_total: 3, mastery_band: "Developing" },
    { subject: "Filipino Language", topic: "Linguistics & Metalinguistics", subtopic: "The different levels of discourse in Filipino", weighted_score: 67, raw_correct: 2, raw_total: 3, mastery_band: "Developing" },
    { subject: "Social Studies", topic: "Philippine History", subtopic: "Geography: land and people, geographical features and boundaries, cultural communities and diversity, peopling of the Philippines", weighted_score: 67, raw_correct: 2, raw_total: 3, mastery_band: "Developing" },
    { subject: "Social Studies", topic: "World History", subtopic: "Between two wars: World War I and new alliances, Russian Revolution, independence movements and decolonization, World War II, Cold War", weighted_score: 50, raw_correct: 1, raw_total: 2, mastery_band: "Developing" },
    { subject: "Social Studies", topic: "Asian History", subtopic: "Asia at present: Asian governments, cultures and societies Current issues: migration, border conflicts, human rights, socio-economic inequity, integration and competition", weighted_score: 33, raw_correct: 1, raw_total: 3, mastery_band: "Needs Improvement" },
  ],
  classifications: [
    { code: "BMA", name: "Business, Management & Accountancy", fit_score: 22.4 },
    { code: "HSSC", name: "Humanities, Social Sciences & Communication", fit_score: 21.5 },
    { code: "ETT", name: "Education & Teacher Training", fit_score: 20.1 },
    { code: "HAMS", name: "Health & Allied Medical Sciences", fit_score: 18.3 },
    { code: "ITCS", name: "Information Technology & Computing Sciences", fit_score: 17.2 },
    { code: "SM", name: "Science & Mathematics", fit_score: 16.9 },
    { code: "EA", name: "Engineering & Architecture", fit_score: 15.8 },
    { code: "SNC", name: "Specialized & Niche Clusters", fit_score: 14.6 },
  ],
  predictions: [
    { university: "University of the Philippines", predictive_index: 28.4, profile: "Low Probability" },
    { university: "Ateneo de Manila University", predictive_index: 43.2, profile: "Low Probability" },
    { university: "De La Salle University", predictive_index: 55.8, profile: "Moderate Probability" },
    { university: "University of Santo Tomas", predictive_index: 68.9, profile: "Moderate Probability" },
  ],
  recommendations: {
    primary: { code: "BMA", name: "Business, Management & Accountancy", fit_score: 22.4 },
    alternatives: [
      { code: "HSSC", name: "Humanities, Social Sciences & Communication", fit_score: 21.5 },
      { code: "ETT", name: "Education & Teacher Training", fit_score: 20.1 },
    ],
    study_focus: "Prioritize Logic & Abstract Reasoning and Social Studies. These two subjects have the greatest impact on your composite score and are currently your weakest areas. Dedicate at least 45 minutes daily to pattern recognition exercises and Philippine history review.",
    strengths: ["Advanced Grammar & Syntax", "Universe & Solar System", "Linguistics & Metalinguistics", "Vocabulary & Word Study"],
    weaknesses: ["Logic", "World History", "Coordinate Geometry", "Critical Reading"],
  },
};

function buildResultModel(results) {
  const pctMap = {};
  (results.percentiles || []).forEach(p => { pctMap[`${p.target}:${p.code}`] = p.percentile_rank; });
  const topicsBySubject = {};
  (results.topics || []).forEach(t => {
    if (!topicsBySubject[t.subject]) topicsBySubject[t.subject] = [];
    topicsBySubject[t.subject].push(t);
  });
  const subtopicsByKey = {};
  (results.subtopics || []).forEach(st => {
    const key = `${st.subject}|||${st.topic}`;
    if (!subtopicsByKey[key]) subtopicsByKey[key] = [];
    subtopicsByKey[key].push(st);
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
}

const MOCK_RESULT_MODEL = buildResultModel(RAW);
const MOCK_TEMPLATE = { code: "Sample Diagnostic Exam", id: "demo" };

// ─── Auth ────────────────────────────────────────────────────────

function loadSession() {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (p?.access_token && p.exp > Date.now() / 1000) return p;
    localStorage.removeItem(STORAGE_KEY);
  } catch { localStorage.removeItem(STORAGE_KEY); }
  return null;
}

function saveSession(sess) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sess));
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

async function signIn(email, password) {
  const res = await fetch(`${AUTH_URL}/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error_description || data?.error || "Login failed.");
  return { access_token: data.access_token, exp: Math.floor(Date.now() / 1000) + (data.expires_in || 3600), user: data.user };
}

// ─── Login page ──────────────────────────────────────────────────

function LoginPage({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await onLogin(email, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#f0f4f8", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Sora', system-ui, sans-serif" }}>
      <div style={{ width: 400, maxWidth: "calc(100vw - 40px)", background: "#ffffff", borderRadius: 16, border: "1px solid #e8edf4", padding: "40px 36px", boxShadow: "0 8px 40px rgba(23,1,66,0.10)" }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#170142", fontFamily: "'Sora', system-ui, sans-serif", marginBottom: 4 }}>Results Portal</div>
        <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 32, fontWeight: 500 }}>Sign in to view your results</div>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#170142", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.8 }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus
              placeholder="you@email.com"
              style={{ width: "100%", boxSizing: "border-box", padding: "11px 14px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 14, color: "#170142", outline: "none", fontFamily: "inherit" }}
            />
          </div>
          <div style={{ marginBottom: 28 }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#170142", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.8 }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              placeholder="••••••••"
              style={{ width: "100%", boxSizing: "border-box", padding: "11px 14px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 14, color: "#170142", outline: "none", fontFamily: "inherit" }}
            />
          </div>
          {error && (
            <div style={{ marginBottom: 18, padding: "10px 14px", background: "#fff1f2", border: "1px solid #fecdd3", borderRadius: 8, fontSize: 13, color: "#9f1239", lineHeight: 1.5 }}>
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            style={{ width: "100%", padding: "13px", border: "none", background: "#170142", color: "#ffffff", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: loading ? 0.6 : 1 }}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Main ────────────────────────────────────────────────────────

export default function ResultsDemo() {
  const [session, setSession] = useState(loadSession);

  async function handleLogin(email, password) {
    const sess = await signIn(email, password);
    saveSession(sess);
    setSession(sess);
  }

  function handleLogout() {
    clearSession();
    setSession(null);
  }

  if (!session) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <ResultsView
      resultModel={MOCK_RESULT_MODEL}
      template={MOCK_TEMPLATE}
      onReset={() => window.location.reload()}
      onClose={handleLogout}
      adminToken={session.access_token}
    />
  );
}
