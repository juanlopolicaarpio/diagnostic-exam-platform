// ============================================================================
// Read-only FILTERED export: users + exam sessions + full results, with staff
// and test accounts excluded so an analysis set contains only real attempts.
// Exclusion is by email pattern plus an explicit session id list, because a
// deleted user leaves attempts behind that no longer join to anything.
// Writes to ./exports/filtered/. No DB writes.
// Usage: node scripts/export-filtered.mjs
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const env = {};
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const URL = env.VITE_SUPABASE_URL;
const KEY = env.SERVICE_ROLE;
const authHeaders = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// ── Exclusion rule ──
const EXCLUDED_EMAIL_PATTERNS = ["student@example.com"];
const EXCLUDE_EMAIL = (email) => {
  const e = String(email || "").toLowerCase();
  return EXCLUDED_EMAIL_PATTERNS.some((pattern) => e.includes(pattern));
};
// Sessions to leave out of the export — staff test runs and orphaned attempts.
const EXCLUDE_SESSION_IDS = new Set([]);

// ── Fetch all auth users ──
const users = [];
for (let page = 1; ; page++) {
  const res = await fetch(`${URL}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: authHeaders });
  if (!res.ok) throw new Error(`users HTTP ${res.status}: ${await res.text()}`);
  const batch = (await res.json()).users || [];
  users.push(...batch);
  if (batch.length < 200) break;
}
const emailById = new Map(users.map((u) => [u.id, u.email]));

async function fetchAll(table, select = "*") {
  const out = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(`${URL}/rest/v1/${table}?select=${encodeURIComponent(select)}&offset=${offset}&limit=${pageSize}`, { headers: authHeaders });
    if (!res.ok) throw new Error(`${table} HTTP ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

const resultTables = [
  "diagnostic_sessions", "session_readiness_tiers", "session_subject_scores",
  "session_topic_scores", "session_subtopic_scores", "session_classification_scores",
  "session_recommendations", "session_university_predictions", "session_percentiles",
  "session_responses",
];
const data = {};
for (const t of resultTables) data[t] = await fetchAll(t);

// session_questions maps each answered question to its exam SECTION.
const sessionQuestions = await fetchAll("session_questions", "id,session_id,section_name");
const sectionBySqId = new Map(sessionQuestions.map((q) => [q.id, q.section_name]));

const bySession = (rows) => {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.session_id)) m.set(r.session_id, []);
    m.get(r.session_id).push(r);
  }
  return m;
};
const idx = Object.fromEntries(resultTables.filter((t) => t !== "diagnostic_sessions").map((t) => [t, bySession(data[t])]));

// ── Assemble + FILTER ──
const usersKept = users.filter((u) => !EXCLUDE_EMAIL(u.email));

const sessions = data.diagnostic_sessions
  .filter((s) => {
    if (EXCLUDE_SESSION_IDS.has(s.id)) return false;
    return !EXCLUDE_EMAIL(emailById.get(s.user_id));
  })
  .map((s) => {
    const g = (t) => idx[t].get(s.id) || [];
    return {
      ...s,
      student_email: emailById.get(s.user_id) || "(unknown / deleted user)",
      readiness_tier: g("session_readiness_tiers")[0] || null,
      subject_scores: g("session_subject_scores"),
      topic_scores: g("session_topic_scores"),
      subtopic_scores: g("session_subtopic_scores"),
      classification_scores: g("session_classification_scores"),
      recommendation: g("session_recommendations")[0] || null,
      university_predictions: g("session_university_predictions"),
      percentiles: g("session_percentiles"),
      responses: g("session_responses"),
    };
  });

// ── Section-level rollup (raw correctness per exam section) ──
const SECTION_ORDER = ["language", "reading", "math", "science", "social_studies", "logic"];
for (const s of sessions) {
  const tally = new Map(); // section -> { raw_correct, raw_total }
  for (const r of s.responses) {
    const section = sectionBySqId.get(r.session_question_id) || "(unmapped)";
    if (!tally.has(section)) tally.set(section, { raw_correct: 0, raw_total: 0 });
    const t = tally.get(section);
    t.raw_total += 1;
    if (r.is_correct) t.raw_correct += 1;
  }
  const order = (name) => {
    const i = SECTION_ORDER.indexOf(name);
    return i === -1 ? 999 : i;
  };
  s.section_scores = [...tally.entries()]
    .map(([section, t]) => ({
      section,
      raw_correct: t.raw_correct,
      raw_total: t.raw_total,
      pct: t.raw_total ? Math.round((t.raw_correct / t.raw_total) * 10000) / 100 : null,
    }))
    .sort((a, b) => order(a.section) - order(b.section));
}

const csv = (rows, cols) => {
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
};

mkdirSync("exports/filtered", { recursive: true });

writeFileSync("exports/filtered/users.csv", csv(
  usersKept.map((u) => ({ email: u.email, id: u.id, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at }))
    .sort((a, b) => (a.email > b.email ? 1 : -1)),
  ["email", "id", "created_at", "last_sign_in_at"]
));

const summary = sessions.map((s) => ({
  student_email: s.student_email, session_id: s.id, status: s.status,
  started_at: s.started_at, completed_at: s.completed_at,
  overall_score: s.readiness_tier?.overall_score ?? "",
  readiness_tier: s.readiness_tier?.readiness_tier ?? "",
  primary_recommendation: s.recommendation?.primary_classification_code ?? "",
  num_responses: s.responses.length,
})).sort((a, b) => (a.student_email > b.student_email ? 1 : -1));
writeFileSync("exports/filtered/sessions_summary.csv", csv(summary,
  ["student_email", "session_id", "status", "started_at", "completed_at", "overall_score", "readiness_tier", "primary_recommendation", "num_responses"]));

const subjectRows = sessions.flatMap((s) => s.subject_scores.map((r) => ({ student_email: s.student_email, session_id: s.id, ...r })));
if (subjectRows.length) {
  const cols = ["student_email", "session_id", ...Object.keys(subjectRows[0]).filter((k) => !["student_email", "session_id"].includes(k))];
  writeFileSync("exports/filtered/subject_scores.csv", csv(subjectRows, cols));
}

// Section scores flattened (email + session + section grain)
const sectionRows = sessions.flatMap((s) => s.section_scores.map((r) => ({ student_email: s.student_email, session_id: s.id, status: s.status, ...r })));
if (sectionRows.length) {
  writeFileSync("exports/filtered/section_scores.csv", csv(sectionRows, ["student_email", "session_id", "status", "section", "raw_correct", "raw_total", "pct"]));
}

writeFileSync("exports/filtered/full_results.json", JSON.stringify({ exported_at: new Date().toISOString(), excluded: EXCLUDED_EMAIL_PATTERNS.join(", "), users: usersKept, sessions }, null, 2));

console.log(`Users kept:   ${usersKept.length} (excluded ${users.length - usersKept.length})`);
console.log(`Sessions kept:${sessions.length}`);
console.log("Wrote -> exports/filtered/{users.csv, sessions_summary.csv, subject_scores.csv, full_results.json}\n");

// Print full results for kept sessions to console
for (const s of sessions.sort((a, b) => (a.student_email > b.student_email ? 1 : -1))) {
  console.log("============================================================");
  console.log(`${s.student_email}  |  ${s.status}  |  session ${s.id}`);
  console.log(`  started:   ${s.started_at}`);
  console.log(`  completed: ${s.completed_at || "-"}`);
  if (s.readiness_tier) console.log(`  READINESS: ${s.readiness_tier.overall_score} (${s.readiness_tier.readiness_tier})`);
  console.log(`  responses: ${s.responses.length}`);
  if (s.section_scores.length) {
    console.log("  SECTION SCORES:");
    for (const x of s.section_scores) console.log(`    - ${String(x.section).padEnd(16)} ${x.raw_correct}/${x.raw_total}  (${x.pct}%)`);
  }
  if (s.subject_scores.length) {
    console.log("  SUBJECT SCORES:");
    for (const x of s.subject_scores) console.log(`    - ${String(x.subject).padEnd(18)} ${x.raw_correct}/${x.raw_total}  weighted=${x.weighted_score}`);
  }
  if (s.recommendation) {
    console.log(`  RECOMMENDATION: primary=${s.recommendation.primary_classification_code} alt=${JSON.stringify(s.recommendation.alternative_classification_codes)}`);
    if (s.recommendation.strengths) console.log(`    strengths:  ${JSON.stringify(s.recommendation.strengths)}`);
    if (s.recommendation.weaknesses) console.log(`    weaknesses: ${JSON.stringify(s.recommendation.weaknesses)}`);
  }
  if (s.university_predictions.length) {
    console.log("  UNIVERSITY PREDICTIONS:");
    for (const x of s.university_predictions) console.log(`    - ${String(x.university_code).padEnd(10)} idx=${x.predictive_index} ${x.profile_label || ""}`);
  }
}
