import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

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
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing Supabase URL/key.");

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
    headers: {
      apikey: key,
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
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

const norm = (v) => (v == null || v === "" ? null : String(v).trim());

async function main() {
  const { rest, headers } = await apiConfig();

  // 1. Find the active diagnostic template
  const templates = await fetchAll(rest, headers, "diagnostic_templates", { select: "id,code,is_active,created_at" });
  const active = templates.filter((t) => t.is_active);
  console.log("=== diagnostic_templates ===");
  for (const t of templates) console.log(`  ${t.is_active ? "[ACTIVE]" : "        "} ${t.code}  (${t.id})`);

  const target = active.length ? active : templates;
  if (!target.length) throw new Error("No diagnostic templates found.");

  // 2. Pull the diagnostic template questions joined to the question rows
  const examRows = [];
  for (const t of target) {
    const rows = await fetchAll(rest, headers, "diagnostic_template_questions", {
      template_id: `eq.${t.id}`,
      select: "section_name,display_order,questions(id,subject,topic,subtopic,difficulty_level,status)",
      order: "display_order.asc",
    });
    for (const r of rows) {
      if (!r.questions) continue;
      examRows.push({ template: t.code, section: r.section_name, ...r.questions });
    }
  }

  // 3. Pull the entire question bank for counting
  const bank = await fetchAll(rest, headers, "questions", { select: "id,subject,topic,subtopic,status" });

  const bankAll = bank;
  const bankActive = bank.filter((q) => q.status === "active");

  const countBy = (rows, keyFn) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  };

  const subjTopicSub_all = countBy(bankAll, (q) => `${norm(q.subject)}||${norm(q.topic)}||${norm(q.subtopic)}`);
  const subjTopicSub_act = countBy(bankActive, (q) => `${norm(q.subject)}||${norm(q.topic)}||${norm(q.subtopic)}`);
  const subjTopic_all = countBy(bankAll, (q) => `${norm(q.subject)}||${norm(q.topic)}`);
  const subjTopic_act = countBy(bankActive, (q) => `${norm(q.subject)}||${norm(q.topic)}`);

  // 4. Build unique list of topic/subtopic pairs that appear in the diagnostic exam
  const seen = new Map();
  for (const r of examRows) {
    const subject = norm(r.subject);
    const topic = norm(r.topic);
    const subtopic = norm(r.subtopic);
    const key = `${subject}||${topic}||${subtopic}`;
    if (!seen.has(key)) {
      seen.set(key, { subject, topic, subtopic, examCount: 0 });
    }
    seen.get(key).examCount += 1;
  }

  const result = [...seen.values()].map((e) => {
    const stKey = `${e.subject}||${e.topic}||${e.subtopic}`;
    const tKey = `${e.subject}||${e.topic}`;
    return {
      ...e,
      bankSubtopic_active: subjTopicSub_act.get(stKey) || 0,
      bankSubtopic_total: subjTopicSub_all.get(stKey) || 0,
      bankTopic_active: subjTopic_act.get(tKey) || 0,
      bankTopic_total: subjTopic_all.get(tKey) || 0,
    };
  });

  result.sort((a, b) =>
    (a.subject || "").localeCompare(b.subject || "") ||
    (a.topic || "").localeCompare(b.topic || "") ||
    (a.subtopic || "").localeCompare(b.subtopic || ""));

  // Output
  console.log(`\nDiagnostic exam questions pulled: ${examRows.length}`);
  console.log(`Unique subject/topic/subtopic combos in exam: ${result.length}`);
  console.log(`Question bank size: ${bankAll.length} total, ${bankActive.length} active\n`);

  const out = { generatedAt: new Date().toISOString(), templates: target.map((t) => t.code), examRowCount: examRows.length, bankTotal: bankAll.length, bankActive: bankActive.length, rows: result };
  fs.writeFileSync(path.join(ROOT, "diagnostic-topic-bank-counts.json"), JSON.stringify(out, null, 2));

  // Pretty print grouped by subject -> topic
  let curSubj = null, curTopic = null;
  for (const r of result) {
    if (r.subject !== curSubj) {
      curSubj = r.subject; curTopic = null;
      const topicTotalActive = bankActive.filter((q) => norm(q.subject) === curSubj).length;
      console.log(`\n############ ${r.subject}  (bank active: ${topicTotalActive}) ############`);
    }
    if (r.topic !== curTopic) {
      curTopic = r.topic;
      console.log(`\n  TOPIC: ${r.topic ?? "(none)"}   [bank: ${r.bankTopic_active} active / ${r.bankTopic_total} total]`);
    }
    console.log(`     - ${r.subtopic ?? "(no subtopic)"}  | in exam: ${r.examCount}  | bank subtopic: ${r.bankSubtopic_active} active / ${r.bankSubtopic_total} total`);
  }

  console.log(`\nFull data written to diagnostic-topic-bank-counts.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
