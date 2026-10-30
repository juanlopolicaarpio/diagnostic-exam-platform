// Regenerates a consolidated log of every question added to the bank by these
// bump scripts. Reads the *.inserted.json rollback files, re-fetches the live
// rows by id so the log reflects current state (choice order, difficulty,
// any later edits), and writes added-questions-log.json + .md at repo root.
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SCRIPTS = path.join(ROOT, "scripts");
const ROLLBACK_FILES = [
  "bump-four-question-subtopics.inserted.json",
  "bump-gerunds.inserted.json",
  "benchmark-batch-thinnest.inserted.json",
  "rollout-batch-2-thinnest-math.inserted.json",
  "rollout-batch-3-circles-proportion-probability.inserted.json",
  "rollout-batch-4-math14.inserted.json",
  "rollout-batch-5-basic-finance.inserted.json",
];

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!process.env[key]) process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

async function apiConfig() {
  loadEnv();
  const url = process.env.VITE_SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  const token = (await login.json()).access_token;
  return { rest: `${url}/rest/v1`, headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" } };
}

async function main() {
  const { rest, headers } = await apiConfig();

  // Collect all tracked ids from the rollback files
  const tracked = [];
  for (const f of ROLLBACK_FILES) {
    const p = path.join(SCRIPTS, f);
    if (!fs.existsSync(p)) continue;
    for (const r of JSON.parse(fs.readFileSync(p, "utf8"))) tracked.push({ ...r, batch: f });
  }
  const ids = tracked.map((r) => r.id);
  if (!ids.length) { console.log("No tracked ids found."); return; }

  // Re-fetch live rows by id (current state)
  const live = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = await fetch(`${rest}/questions?id=in.(${chunk.join(",")})&select=*`, { headers });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${await res.text()}`);
    live.push(...await res.json());
  }
  const byId = Object.fromEntries(live.map((r) => [r.id, r]));

  const items = tracked.map((t) => {
    const r = byId[t.id] || {};
    return {
      id: t.id,
      batch: t.batch,
      subject: r.subject ?? null,
      topic: r.topic ?? null,
      subtopic: r.subtopic ?? r.subtopic ?? t.subtopic ?? null,
      difficulty_level: r.difficulty_level ?? null,
      question_text: r.question_text ?? t.question_text ?? null,
      choice_a: r.choice_a ?? null,
      choice_b: r.choice_b ?? null,
      choice_c: r.choice_c ?? null,
      choice_d: r.choice_d ?? null,
      correct_answer: r.correct_answer ?? null,
      source_school: r.source_school ?? null,
      status: r.status ?? "(deleted?)",
      created_at: r.created_at ?? null,
    };
  });

  items.sort((a, b) =>
    (a.subject || "").localeCompare(b.subject || "") ||
    (a.subtopic || "").localeCompare(b.subtopic || "") ||
    (a.question_text || "").localeCompare(b.question_text || ""));

  const log = {
    generatedAt: new Date().toISOString(),
    note: "Questions ADDED to the bank by the diagnostic thin-subtopic bump. Re-fetched live so difficulty/choices reflect current DB state. Regenerate with: node scripts/track-added-questions.mjs",
    totalAdded: items.length,
    items,
  };
  fs.writeFileSync(path.join(ROOT, "added-questions-log.json"), JSON.stringify(log, null, 2));

  // Markdown view
  let md = `# Added Questions Log\n\n`;
  md += `_Generated ${log.generatedAt}. Source of truth: \`added-questions-log.json\`. Regenerate: \`node scripts/track-added-questions.mjs\`._\n\n`;
  md += `**Total added: ${items.length}** across the diagnostic thin-subtopic bump (each listed subtopic raised from 4 → 14 active).\n\n`;
  const bySub = {};
  for (const it of items) {
    const key = `${it.subject} › ${it.topic} › ${it.subtopic}`;
    (bySub[key] ||= []).push(it);
  }
  for (const key of Object.keys(bySub).sort()) {
    const rows = bySub[key];
    md += `## ${key}  (${rows.length} added)\n\n`;
    md += `| # | Diff | Ans | Question | id |\n|---|---|---|---|---|\n`;
    rows.forEach((it, i) => {
      const q = (it.question_text || "").replace(/\|/g, "\\|");
      md += `| ${i + 1} | ${it.difficulty_level} | ${it.correct_answer} | ${q} | \`${it.id.slice(0, 8)}\` |\n`;
    });
    md += `\n`;
  }
  fs.writeFileSync(path.join(ROOT, "added-questions-log.md"), md);

  console.log(`Wrote added-questions-log.json and added-questions-log.md`);
  console.log(`Total tracked: ${items.length}. Live status counts:`);
  const sc = {};
  for (const it of items) sc[it.status] = (sc[it.status] || 0) + 1;
  console.log(" ", JSON.stringify(sc));
}

main().catch((e) => { console.error(e); process.exit(1); });
