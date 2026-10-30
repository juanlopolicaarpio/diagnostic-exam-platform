/**
 * Balances correct-answer distribution across ALL subjects.
 * Checks every letter (a/b/c/d). If any is overrepresented (>30%),
 * redistributes the excess by swapping the two relevant choices and
 * updating correct_answer. Only those two choice texts + correct_answer
 * change — nothing else is touched.
 *
 * Usage:
 *   node scripts/fix-all-subjects-answer-distribution.mjs            # audit (dry-run)
 *   node scripts/fix-all-subjects-answer-distribution.mjs --apply    # write to DB
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;
const THRESHOLD_PCT = 30;

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
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
  if (!url || !key) throw new Error("Missing Supabase URL/key.");
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  if (!login.ok) throw new Error(`Login failed: ${login.status} ${await login.text()}`);
  const token = (await login.json()).access_token;
  return { rest: `${url}/rest/v1`, headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" } };
}

async function fetchAllQuestions(rest, headers) {
  const rows = [];
  let offset = 0;
  const fields = "id,subject,topic,subtopic,choice_a,choice_b,choice_c,choice_d,correct_answer";
  while (true) {
    const params = new URLSearchParams({ select: fields, limit: "1000", offset: String(offset) });
    const resp = await fetch(`${rest}/questions?${params}`, { headers });
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${await resp.text()}`);
    const page = await resp.json();
    rows.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

async function patchQuestion(rest, headers, id, patch) {
  const resp = await fetch(`${rest}/questions?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw new Error(`Patch failed for ${id}: ${resp.status} ${await resp.text()}`);
}

function countDist(rows) {
  const dist = { a: 0, b: 0, c: 0, d: 0, other: 0 };
  for (const r of rows) {
    const ans = r.correct_answer?.toLowerCase();
    if (["a", "b", "c", "d"].includes(ans)) dist[ans]++;
    else dist.other++;
  }
  return dist;
}

/**
 * Builds the minimal set of swap operations to bring all letters to ~target.
 * Sources (overrepresented) are matched to destinations (underrepresented).
 */
function buildUpdates(rows, dist) {
  const validRows = rows.filter((r) => ["a", "b", "c", "d"].includes(r.correct_answer?.toLowerCase()));
  const total = validRows.length;
  if (total === 0) return [];
  const target = Math.round(total / 4);

  // Collect source questions (excess per letter) and destination slots (deficit per letter)
  const sources = []; // { row, from }
  const destinations = []; // target letter strings

  for (const letter of ["a", "b", "c", "d"]) {
    const excess = dist[letter] - target;
    if (excess > 0) {
      const letterRows = validRows.filter((r) => r.correct_answer?.toLowerCase() === letter);
      for (let i = 0; i < excess && i < letterRows.length; i++) {
        sources.push({ row: letterRows[i], from: letter });
      }
    } else if (excess < 0) {
      for (let i = 0; i < -excess; i++) {
        destinations.push(letter);
      }
    }
  }

  // Match sources → destinations (counts should be equal; take the min to be safe)
  const len = Math.min(sources.length, destinations.length);
  const updates = [];
  for (let i = 0; i < len; i++) {
    const { row, from } = sources[i];
    const to = destinations[i];
    const fromKey = `choice_${from}`;
    const toKey = `choice_${to}`;
    updates.push({
      id: row.id,
      from,
      to,
      patch: {
        [fromKey]: row[toKey],
        [toKey]: row[fromKey],
        correct_answer: to,
      },
    });
  }
  return updates;
}

function needsFix(dist, total) {
  if (total === 0) return false;
  for (const letter of ["a", "b", "c", "d"]) {
    if ((dist[letter] / total) * 100 > THRESHOLD_PCT) return true;
  }
  return false;
}

function printDist(dist, total, indent = "  ") {
  for (const [letter, count] of Object.entries(dist)) {
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
    console.log(`${indent}${letter.toUpperCase()}: ${count} (${pct}%)`);
  }
}

async function main() {
  const { rest, headers } = await apiConfig();
  console.log("Logged in. Fetching ALL questions...");
  const all = await fetchAllQuestions(rest, headers);
  console.log(`Total questions fetched: ${all.length}\n`);

  // Group by subject
  const bySubject = {};
  for (const row of all) {
    const sub = row.subject || "(no subject)";
    if (!bySubject[sub]) bySubject[sub] = [];
    bySubject[sub].push(row);
  }

  const subjects = Object.keys(bySubject).sort();

  console.log("=".repeat(60));
  console.log("ANSWER DISTRIBUTION BY SUBJECT");
  console.log("=".repeat(60));

  const toFix = [];

  for (const subject of subjects) {
    const rows = bySubject[subject];
    const total = rows.length;
    const dist = countDist(rows);
    const fix = needsFix(dist, total);
    const flag = fix ? "  *** NEEDS FIX ***" : "";

    console.log(`\n${subject} (${total} questions)${flag}`);
    printDist(dist, total);

    if (fix) {
      const updates = buildUpdates(rows, dist);
      // Summarise moves
      const moveSummary = {};
      for (const u of updates) {
        const key = `${u.from.toUpperCase()}→${u.to.toUpperCase()}`;
        moveSummary[key] = (moveSummary[key] || 0) + 1;
      }
      const moveStr = Object.entries(moveSummary).map(([k, v]) => `${k}×${v}`).join("  ");
      console.log(`  -> Moves: ${moveStr} (${updates.length} total)`);
      toFix.push({ subject, updates, dist, total });
    }
  }

  console.log("\n" + "=".repeat(60));
  const totalUpdates = toFix.reduce((n, s) => n + s.updates.length, 0);

  if (toFix.length === 0) {
    console.log("All subjects are balanced. Nothing to fix.");
    return;
  }

  console.log(`\nSubjects needing fixes (${toFix.length}): ${toFix.map((s) => s.subject).join(", ")}`);
  console.log(`Total questions to update: ${totalUpdates}`);

  if (DRY_RUN) {
    console.log("\n[DRY RUN] No changes written. Run with --apply to commit.");
    return;
  }

  // Apply fixes
  let grandDone = 0;
  let grandErrors = 0;
  for (const { subject, updates, dist, total } of toFix) {
    console.log(`\nFixing: ${subject} (${updates.length} updates)...`);
    let done = 0;
    let errors = 0;
    for (const upd of updates) {
      try {
        await patchQuestion(rest, headers, upd.id, upd.patch);
        done++;
      } catch (err) {
        console.error(`  ERROR ${upd.id}: ${err.message}`);
        errors++;
      }
      if ((done + errors) % 20 === 0) process.stdout.write(`\r  ${done + errors}/${updates.length}...`);
    }
    process.stdout.write(`\r  Done: ${done} updated, ${errors} errors\n`);

    // Show expected new distribution for this subject
    const newDist = { ...dist };
    for (const u of updates.slice(0, done)) {
      newDist[u.from]--;
      newDist[u.to]++;
    }
    console.log(`  Expected new distribution:`);
    printDist(newDist, total, "    ");

    grandDone += done;
    grandErrors += errors;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`COMPLETE: ${grandDone} questions updated, ${grandErrors} errors across ${toFix.length} subjects.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
