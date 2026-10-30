// ============================================================================
// Wipe all per-student exam-attempt data so every user can retake the exam.
//
// KEEPS: auth.users, admin_users, questions, stimuli, instructions, visual
//        assets, diagnostic_templates, diagnostic_template_questions, and all
//        scoring config (scoring_models, subtopic_classification_importance,
//        university_subject_weights, course_classifications, section_time_limits).
//
// Dry run (default, no writes):  node scripts/wipe-exam-attempt-data.mjs
// Execute:                       node scripts/wipe-exam-attempt-data.mjs --confirm
// Also wipe practice drill history: add --include-practice-history
// ============================================================================
import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const URL = env.VITE_SUPABASE_URL;
const KEY = env.SERVICE_ROLE;
const authHeaders = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const CONFIRM = process.argv.includes("--confirm");
const INCLUDE_PRACTICE = process.argv.includes("--include-practice-history");

// Child-first order, so this works whether or not the FKs cascade.
// `filter` is the PostgREST predicate that matches every row in the table.
const WIPE_ORDER = [
  { table: "session_responses", filter: "id=not.is.null" },
  { table: "session_questions", filter: "id=not.is.null" },
  { table: "session_sections", filter: "id=not.is.null" },
  { table: "session_subject_scores", filter: "id=not.is.null" },
  { table: "session_topic_scores", filter: "id=not.is.null" },
  { table: "session_subtopic_scores", filter: "id=not.is.null" },
  { table: "session_classification_scores", filter: "id=not.is.null" },
  { table: "session_readiness_tiers", filter: "id=not.is.null" },
  { table: "session_recommendations", filter: "id=not.is.null" },
  { table: "session_university_predictions", filter: "id=not.is.null" },
  { table: "session_percentiles", filter: "id=not.is.null" },
  { table: "diagnostic_sessions", filter: "id=not.is.null" },
];
if (INCLUDE_PRACTICE) {
  WIPE_ORDER.push({ table: "practice_question_history", filter: "user_id=not.is.null" });
}

async function count(table) {
  const res = await fetch(`${URL}/rest/v1/${table}?select=*&limit=1`, {
    headers: { ...authHeaders, Prefer: "count=exact", Range: "0-0" },
  });
  return Number((res.headers.get("content-range") || "?/0").split("/")[1]) || 0;
}

if (!CONFIRM) {
  console.log("DRY RUN — nothing will be deleted. Re-run with --confirm to execute.\n");
  let total = 0;
  for (const { table } of WIPE_ORDER) {
    const n = await count(table);
    total += n;
    console.log(`  would delete ${String(n).padStart(7)}  ${table}`);
  }
  console.log(`\n  ${total} rows total.`);
  if (!INCLUDE_PRACTICE) {
    console.log("  practice_question_history left alone (add --include-practice-history to wipe it too).");
  }
  process.exit(0);
}

console.log("EXECUTING WIPE\n");
let total = 0;
for (const { table, filter } of WIPE_ORDER) {
  const before = await count(table);
  const res = await fetch(`${URL}/rest/v1/${table}?${filter}`, {
    method: "DELETE",
    headers: { ...authHeaders, Prefer: "count=exact" },
  });
  if (!res.ok) throw new Error(`${table} HTTP ${res.status}: ${await res.text()}`);
  const after = await count(table);
  total += before - after;
  console.log(`  deleted ${String(before - after).padStart(7)}  ${table}  (remaining: ${after})`);
}

console.log(`\n${total} rows deleted.`);

// ── Verify the keep-list survived untouched ──
console.log("\nPreserved:");
for (const t of [
  "questions",
  "stimuli",
  "instructions",
  "diagnostic_templates",
  "diagnostic_template_questions",
  "admin_users",
  "subtopic_classification_importance",
  "university_subject_weights",
  "course_classifications",
  "section_time_limits",
  "scoring_models",
]) {
  console.log(`  ${String(await count(t)).padStart(7)}  ${t}`);
}

const usersRes = await fetch(`${URL}/auth/v1/admin/users?page=1&per_page=1`, {
  headers: { ...authHeaders },
});
const totalUsers = (await usersRes.json()).total ?? "?";
console.log(`  ${String(totalUsers).padStart(7)}  auth.users`);
