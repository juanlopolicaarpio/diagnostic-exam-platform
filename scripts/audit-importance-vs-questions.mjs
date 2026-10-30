// ============================================================================
// audit-importance-vs-questions.mjs
// ============================================================================
// Guards the join the scoring engine depends on.
//
// finalize-exam matches every question to subtopic_classification_importance
// on the exact triple (subject, topic, subtopic). Any drift between the two
// tables silently corrupts results, in both directions:
//
//   ORPHAN IMPORTANCE  — a rated subtopic with no question behind it.
//     Nobody can ever be tested on it, so it can never be passed. Before the
//     fix in scoring-engine.ts it was reported as a permanent "critical gap"
//     for every student and counted as a failed critical topic, capping CTR
//     below what any student could reach.
//
//   ORPHAN QUESTION    — a question whose triple has no importance row.
//     computeWPS skips it, so it contributes nothing to any FitScore,
//     recommendation, or university prediction. The student answers it for
//     no effect.
//
// Neither shows up as an error anywhere: results still generate, they are
// just wrong. Run this after any change to the question bank or the
// importance matrix.
//
// Exits non-zero if either kind of orphan exists, so it can gate CI.
//
// Usage:
//   node scripts/audit-importance-vs-questions.mjs
//   node scripts/audit-importance-vs-questions.mjs --json
// ============================================================================

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const AS_JSON = process.argv.includes("--json");

// Subject names the scoring engine hardcodes in DISTINCTIVE_SUBJECTS for
// tie-breaking. A name here that no question uses makes that classification
// lose every rule-2 tie-break, silently.
const DISTINCTIVE_SUBJECTS = {
  BMA: "Mathematics",
  HAMS: "Science",
  EA: "Mathematics",
  ITCS: "Logic/Abstract Reasoning",
  SM: "Science",
  HSSC: "Humanities",
  ETT: "Reading",
  SNC: "Social Studies",
};

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!process.env[key]) process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

async function apiConfig() {
  loadEnv();
  const url = process.env.VITE_SUPABASE_URL?.replace(/\/$/, "");
  const anon = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.");

  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE;
  let key = anon;
  let bearer = anon;

  if (service) {
    key = service;
    bearer = service;
  } else if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: anon, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
      }),
    });
    if (!response.ok) throw new Error(`Login failed: ${response.status} ${await response.text()}`);
    bearer = (await response.json()).access_token;
  }

  return {
    rest: `${url}/rest/v1`,
    headers: { apikey: key, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  };
}

async function fetchAll(rest, headers, table, params) {
  const pageSize = 1000;
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const pageParams = new URLSearchParams(params);
    pageParams.set("limit", String(pageSize));
    pageParams.set("offset", String(offset));
    const response = await fetch(`${rest}/${table}?${pageParams}`, { headers });
    if (!response.ok) throw new Error(`${table} fetch failed: ${response.status} ${await response.text()}`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

const keyOf = (subject, topic, subtopic) => `${subject}|||${topic}|||${subtopic}`;
const readable = (key) => {
  const [subject, topic, subtopic] = key.split("|||");
  return `[${subject}] ${topic} > ${subtopic}`;
};

const { rest, headers } = await apiConfig();

const importance = await fetchAll(rest, headers, "subtopic_classification_importance", {
  select: "subject,topic,subtopic,classification_code,importance_weight",
});
const questions = await fetchAll(rest, headers, "questions", { select: "subject,topic,subtopic" });

// ── Index both sides ──
const questionCounts = new Map();
const questionSubjects = new Set();
for (const q of questions) {
  const key = keyOf(q.subject, q.topic, q.subtopic);
  questionCounts.set(key, (questionCounts.get(key) || 0) + 1);
  questionSubjects.add(q.subject);
}

const importanceByKey = new Map();
for (const e of importance) {
  const key = keyOf(e.subject, e.topic, e.subtopic);
  if (!importanceByKey.has(key)) importanceByKey.set(key, []);
  importanceByKey.get(key).push(e);
}

// ── Orphan importance rows: rated but untestable ──
const orphanImportance = [];
for (const [key, rows] of importanceByKey) {
  if (questionCounts.has(key)) continue;
  orphanImportance.push({
    key,
    ratingRows: rows.length,
    highFor: rows.filter((r) => r.importance_weight === 3).map((r) => r.classification_code).sort(),
  });
}

// ── Orphan questions: answered but unscored ──
const orphanQuestions = [];
let orphanQuestionRows = 0;
for (const [key, count] of questionCounts) {
  if (importanceByKey.has(key)) continue;
  orphanQuestions.push({ key, questions: count });
  orphanQuestionRows += count;
}
orphanQuestions.sort((a, b) => b.questions - a.questions);

// ── CTR reachability per classification ──
// computeCTR now excludes untested subtopics from its denominator, so orphans
// no longer cap the score. They do still shrink the evidence base, so a
// classification whose critical subtopics are mostly unrepresented produces a
// CTR resting on very few questions.
const ctrCoverage = [];
const byClassification = new Map();
for (const e of importance) {
  if (e.importance_weight !== 3) continue;
  const code = e.classification_code;
  if (!byClassification.has(code)) byClassification.set(code, { total: 0, testable: 0 });
  const bucket = byClassification.get(code);
  bucket.total++;
  if (questionCounts.has(keyOf(e.subject, e.topic, e.subtopic))) bucket.testable++;
}
for (const [code, bucket] of byClassification) {
  ctrCoverage.push({
    code,
    highImportance: bucket.total,
    testable: bucket.testable,
    coverage: bucket.total > 0 ? bucket.testable / bucket.total : 0,
  });
}
ctrCoverage.sort((a, b) => a.coverage - b.coverage);

// ── Distinctive-subject sanity ──
const badDistinctive = Object.entries(DISTINCTIVE_SUBJECTS)
  .filter(([, subject]) => !questionSubjects.has(subject))
  .map(([code, subject]) => ({ code, subject }));

// ── Blank taxonomy on questions ──
const blankTaxonomy = [...questionCounts.entries()]
  .filter(([key]) => {
    const [, topic, subtopic] = key.split("|||");
    return !topic?.trim() || !subtopic?.trim();
  })
  .map(([key, count]) => ({ key, questions: count }));

const report = {
  importanceRows: importance.length,
  importanceKeys: importanceByKey.size,
  questionRows: questions.length,
  questionKeys: questionCounts.size,
  orphanImportance,
  orphanQuestions,
  orphanQuestionRows,
  ctrCoverage,
  badDistinctive,
  blankTaxonomy,
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("=".repeat(78));
  console.log("IMPORTANCE MATRIX vs QUESTION BANK");
  console.log("=".repeat(78));
  console.log(
    `\nimportance: ${importance.length} rows / ${importanceByKey.size} subtopics` +
    `    questions: ${questions.length} rows / ${questionCounts.size} subtopics`
  );

  console.log(`\n── ORPHAN IMPORTANCE: rated subtopics with no question (${orphanImportance.length}) ──`);
  if (orphanImportance.length === 0) console.log("  none");
  for (const o of orphanImportance) {
    const high = o.highFor.length > 0 ? `  HIGH for ${o.highFor.join(",")}` : "";
    console.log(`  ${readable(o.key)}${high}`);
  }

  console.log(
    `\n── ORPHAN QUESTIONS: unscored subtopics ` +
    `(${orphanQuestions.length} subtopics, ${orphanQuestionRows} questions) ──`
  );
  if (orphanQuestions.length === 0) console.log("  none");
  for (const o of orphanQuestions) {
    console.log(`  (${String(o.questions).padStart(3)}) ${readable(o.key)}`);
  }

  console.log("\n── CRITICAL-TOPIC COVERAGE per classification ──");
  console.log("  code   high-importance   testable   coverage");
  for (const c of ctrCoverage) {
    console.log(
      `  ${c.code.padEnd(6)} ${String(c.highImportance).padStart(11)} ` +
      `${String(c.testable).padStart(12)} ${(c.coverage * 100).toFixed(1).padStart(9)}%`
    );
  }

  if (badDistinctive.length > 0) {
    console.log("\n── DISTINCTIVE_SUBJECTS naming no real subject (loses every tie-break) ──");
    for (const b of badDistinctive) console.log(`  ${b.code} -> "${b.subject}"`);
  }

  if (blankTaxonomy.length > 0) {
    console.log("\n── QUESTIONS WITH BLANK topic/subtopic (unscorable) ──");
    for (const b of blankTaxonomy) console.log(`  (${b.questions}) ${readable(b.key)}`);
  }

  const failures = [];
  if (orphanImportance.length > 0) failures.push(`${orphanImportance.length} orphan importance subtopics`);
  if (orphanQuestions.length > 0) failures.push(`${orphanQuestions.length} orphan question subtopics`);
  if (badDistinctive.length > 0) failures.push(`${badDistinctive.length} bad distinctive subjects`);
  if (blankTaxonomy.length > 0) failures.push(`${blankTaxonomy.length} blank-taxonomy question groups`);

  console.log(`\n${"─".repeat(78)}`);
  console.log(failures.length === 0 ? "CLEAN — the join is complete in both directions." : `DRIFT: ${failures.join("; ")}`);
}

const clean =
  orphanImportance.length === 0 &&
  orphanQuestions.length === 0 &&
  badDistinctive.length === 0 &&
  blankTaxonomy.length === 0;

process.exit(clean ? 0 : 1);
