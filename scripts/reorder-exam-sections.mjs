/**
 * Reorder diagnostic exam sections to: language, reading, math, science,
 * social_studies, logic — by rewriting display_order on
 * diagnostic_template_questions rows. Each question keeps its position WITHIN
 * its section; only the section blocks move.
 *
 * Dry-run by default. Pass --apply to write. Writes in two phases (offset then
 * final) so it is safe even if (template_id, display_order) is unique.
 *
 * Auth: SUPABASE_SERVICE_ROLE_KEY, or ADMIN_EMAIL + ADMIN_PASSWORD.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const APPLY = process.argv.includes("--apply");
const OFFSET = 100000;

const SECTION_ORDER = ["language", "reading", "math", "science", "social_studies", "logic"];

function loadEnv() {
  for (const envFile of [".env.local", ".env"]) {
    const envPath = path.join(ROOT, envFile);
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (!process.env[key]) process.env[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  }
}

async function apiConfig() {
  loadEnv();
  const url = process.env.VITE_SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing VITE_SUPABASE_URL and Supabase key.");
  let bearer = key;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
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
    const p = new URLSearchParams(params);
    p.set("limit", String(pageSize));
    p.set("offset", String(offset));
    const r = await fetch(`${rest}/${table}?${p}`, { headers });
    if (!r.ok) throw new Error(`${table} fetch failed: ${r.status} ${await r.text()}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function upsert(rest, headers, rows) {
  const r = await fetch(`${rest}/diagnostic_template_questions?on_conflict=id`, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Upsert failed: ${r.status} ${await r.text()}`);
}

function planForTemplate(rows) {
  // rows already sorted by current display_order
  const known = rows.filter(r => SECTION_ORDER.includes(r.section_name));
  const unknown = rows.filter(r => !SECTION_ORDER.includes(r.section_name));
  const ordered = [];
  for (const section of SECTION_ORDER) {
    for (const r of known) if (r.section_name === section) ordered.push(r);
  }
  ordered.push(...unknown); // anything unexpected goes last, original order
  return ordered.map((r, i) => ({ ...r, newOrder: i + 1 }));
}

function sectionSeq(rows) {
  const seq = [];
  for (const r of rows) {
    const o = r.newOrder ?? r.display_order;
    void o;
    if (!seq.length || seq[seq.length - 1].s !== r.section_name) seq.push({ s: r.section_name, c: 1 });
    else seq[seq.length - 1].c += 1;
  }
  return seq.map(x => `${x.s}(${x.c})`).join(" → ");
}

const { rest, headers } = await apiConfig();
console.log(`Mode: ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}`);
console.log(`Target order: ${SECTION_ORDER.join(" → ")}\n`);

const templates = await fetchAll(rest, headers, "diagnostic_templates", { select: "id,code" });

for (const t of templates) {
  const rows = await fetchAll(rest, headers, "diagnostic_template_questions", {
    template_id: `eq.${t.id}`,
    select: "id,template_id,question_id,section_name,display_order",
    order: "display_order.asc",
  });
  if (rows.length === 0) {
    console.log(`SKIP ${t.code} — 0 rows`);
    continue;
  }
  const planned = planForTemplate(rows);
  const changed = planned.filter(r => r.newOrder !== r.display_order);
  console.log(`Template ${t.code} (${rows.length} q)`);
  console.log(`  before: ${sectionSeq(rows)}`);
  console.log(`  after:  ${sectionSeq(planned)}`);
  console.log(`  rows changing display_order: ${changed.length}`);

  if (!APPLY || changed.length === 0) continue;

  // Phase 1: move everything out of the target range to avoid unique collisions.
  const phase1 = planned.map(r => ({
    id: r.id, template_id: r.template_id, question_id: r.question_id,
    section_name: r.section_name, display_order: r.newOrder + OFFSET,
  }));
  await upsert(rest, headers, phase1);

  // Phase 2: set final values.
  const phase2 = planned.map(r => ({
    id: r.id, template_id: r.template_id, question_id: r.question_id,
    section_name: r.section_name, display_order: r.newOrder,
  }));
  await upsert(rest, headers, phase2);

  // Verify.
  const after = await fetchAll(rest, headers, "diagnostic_template_questions", {
    template_id: `eq.${t.id}`,
    select: "section_name,display_order",
    order: "display_order.asc",
  });
  console.log(`  VERIFIED: ${sectionSeq(after)}`);
}

console.log(APPLY ? "\nDone." : "\nDry-run complete. Re-run with --apply to write.");
