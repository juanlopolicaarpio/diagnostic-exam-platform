import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const REPORT_DIR = path.join(ROOT, "reports");
const REPORT_JSON = path.join(REPORT_DIR, "language-instruction-duplicates.json");
const REPORT_MD = path.join(REPORT_DIR, "language-instruction-duplicates.md");

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

function stripMarkup(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStem(value) {
  return stripMarkup(value)
    .toLowerCase()
    .replace(/\b(?:the|a|an)\b/g, " ")
    .replace(/\b(?:about|for|in|on|from|within|during|regarding|related to)\b/g, " ")
    .replace(/\b(?:debate brief|library notice|student council memo|research summary|fundraising event)\b/g, " CONTEXT ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function choiceSummary(row) {
  return ["choice_a", "choice_b", "choice_c", "choice_d", "choice_e"]
    .map((field) => row[field] ? `${field.slice(-1).toUpperCase()}. ${stripMarkup(row[field])}` : "")
    .filter(Boolean)
    .join(" | ");
}

function markdown(report) {
  const lines = [
    "# Language Instruction Duplicate Audit",
    "",
    `Generated: ${report.generatedAt}`,
    `Rows scanned: ${report.counts.scanned}`,
    `Instruction-tied language rows: ${report.counts.inScope}`,
    `Duplicate template groups: ${report.counts.duplicateGroups}`,
    `Rows in duplicate groups: ${report.counts.rowsInDuplicateGroups}`,
    "",
    "## Duplicate Groups",
    "",
  ];

  for (const group of report.duplicateGroups) {
    lines.push(`### ${group.key}`);
    lines.push(`Count: ${group.rows.length}`);
    lines.push("");
    for (const row of group.rows) {
      lines.push(`- ${row.id} | ${row.subject || ""} | ${row.topic || ""} | ${row.subtopic || ""}`);
      lines.push(`  - Q: ${row.question_text}`);
      lines.push(`  - Instruction: ${row.instruction_code || ""} | ${row.instruction_text || ""}`);
      lines.push(`  - Choices: ${row.choices}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const { rest, headers } = await apiConfig();
  const questions = await fetchAll(rest, headers, "questions", {
    select: "id,subject,topic,subtopic,question_text,choice_a,choice_b,choice_c,choice_d,choice_e,correct_answer,instruction_id,status",
    instruction_id: "not.is.null",
    order: "subject.asc,topic.asc,subtopic.asc,question_text.asc",
  });

  const instructionIds = [...new Set(questions.map((q) => q.instruction_id).filter(Boolean))];
  const instructions = new Map();
  for (let index = 0; index < instructionIds.length; index += 100) {
    const ids = instructionIds.slice(index, index + 100).map(encodeURIComponent).join(",");
    const rows = await fetchAll(rest, headers, "instructions", {
      select: "id,code,instruction_text",
      id: `in.(${ids})`,
    });
    for (const row of rows) instructions.set(row.id, row);
  }

  const inScope = questions
    .filter((row) => /english|language/i.test(`${row.subject || ""} ${row.topic || ""} ${row.subtopic || ""}`))
    .map((row) => {
      const instruction = instructions.get(row.instruction_id) || {};
      return {
        ...row,
        instruction_code: instruction.code || "",
        instruction_text: stripMarkup(instruction.instruction_text || ""),
        choices: choiceSummary(row),
      };
    });

  const groups = new Map();
  for (const row of inScope) {
    const key = normalizeStem(row.question_text);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const duplicateGroups = [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({ key, rows }))
    .sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));

  const report = {
    generatedAt: new Date().toISOString(),
    counts: {
      scanned: questions.length,
      inScope: inScope.length,
      duplicateGroups: duplicateGroups.length,
      rowsInDuplicateGroups: duplicateGroups.reduce((sum, group) => sum + group.rows.length, 0),
    },
    duplicateGroups,
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(REPORT_MD, markdown(report));
  console.log(JSON.stringify(report.counts, null, 2));
  console.log(`Wrote ${path.relative(ROOT, REPORT_JSON)}`);
  console.log(`Wrote ${path.relative(ROOT, REPORT_MD)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
