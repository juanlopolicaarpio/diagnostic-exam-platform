// ============================================================================
// Read-only full backup of every exam-attempt table, before a wipe.
// Writes exports/attempt-backup-<timestamp>.json. No writes to the database.
// Usage: node scripts/backup-exam-attempt-data.mjs
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

// Every table holding per-student attempt data, parent first (read order).
const ATTEMPT_TABLES = [
  "diagnostic_sessions",
  "session_sections",
  "session_questions",
  "session_responses",
  "session_subject_scores",
  "session_topic_scores",
  "session_subtopic_scores",
  "session_classification_scores",
  "session_readiness_tiers",
  "session_recommendations",
  "session_university_predictions",
  "session_percentiles",
  "practice_question_history",
];

async function fetchAll(table) {
  const out = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(
      `${URL}/rest/v1/${table}?select=*&offset=${offset}&limit=${pageSize}`,
      { headers: authHeaders }
    );
    if (!res.ok) throw new Error(`${table} HTTP ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

// Auth users are NOT wiped, but snapshot them so the backup is self-contained.
const users = [];
for (let page = 1; ; page++) {
  const res = await fetch(`${URL}/auth/v1/admin/users?page=${page}&per_page=200`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error(`users HTTP ${res.status}: ${await res.text()}`);
  const batch = (await res.json()).users || [];
  users.push(...batch);
  if (batch.length < 200) break;
}

const data = {};
for (const t of ATTEMPT_TABLES) {
  data[t] = await fetchAll(t);
  console.log(`${String(data[t].length).padStart(7)}  ${t}`);
}

mkdirSync("exports", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const path = `exports/attempt-backup-${stamp}.json`;
writeFileSync(
  path,
  JSON.stringify({ backed_up_at: new Date().toISOString(), users, tables: data }, null, 2)
);

const total = ATTEMPT_TABLES.reduce((n, t) => n + data[t].length, 0);
console.log(`\n${total} attempt rows + ${users.length} users`);
console.log(`Wrote ${path}`);
