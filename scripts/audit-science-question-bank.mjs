import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const CSV_PATH = path.join(ROOT, "question-bank", "science_questions.csv");
const REPORT_DIR = path.join(ROOT, "reports");
const REPORT_JSON = path.join(REPORT_DIR, "science-question-bank-audit.json");

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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === '"') {
        if (next === '"') { cell += '"'; i += 1; }
        else inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ",") { row.push(cell); cell = ""; continue; }
    if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    if (char === "\r") continue;
    cell += char;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function readCsvRows() {
  const parsed = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  const header = parsed.shift();
  return parsed
    .filter((cells) => cells.some((v) => String(v || "").trim()))
    .map((cells) => {
      const obj = {};
      header.forEach((h, i) => { obj[h.trim()] = (cells[i] || "").trim(); });
      return obj;
    });
}

function normalize(s) {
  return String(s || "").trim().replace(/\s+/g, " ");
}

function diffFields(csvRow, dbRow) {
  const fields = ["subject", "topic", "subtopic", "difficulty_level", "question_text",
    "choice_a", "choice_b", "choice_c", "choice_d", "correct_answer"];
  const diffs = [];
  for (const field of fields) {
    const csvVal = normalize(csvRow[field]);
    const dbVal = normalize(dbRow[field]);
    if (csvVal !== dbVal) {
      diffs.push({ field, csv: csvVal, db: dbVal });
    }
  }
  return diffs;
}

async function main() {
  console.log("Loading CSV...");
  const csvRows = readCsvRows();
  console.log(`CSV rows: ${csvRows.length}`);

  const csvById = new Map(csvRows.map((r) => [r.id, r]));

  console.log("Connecting to Supabase...");
  const { rest, headers } = await apiConfig();

  console.log("Fetching all science questions from DB...");
  const dbRows = await fetchAll(rest, headers, "questions", {
    "subject": "eq.Science",
    "select": "id,subject,topic,subtopic,difficulty_level,question_text,choice_a,choice_b,choice_c,choice_d,correct_answer,status",
  });
  console.log(`DB rows (Science): ${dbRows.length}`);

  const dbById = new Map(dbRows.map((r) => [r.id, r]));

  // Questions in DB but NOT in CSV — candidates for removal
  const inDbNotCsv = dbRows.filter((r) => !csvById.has(r.id));

  // Questions in CSV but NOT in DB — missing from DB
  const inCsvNotDb = csvRows.filter((r) => !dbById.has(r.id));

  // Questions in both — check for field mismatches
  const mismatched = [];
  for (const csvRow of csvRows) {
    const dbRow = dbById.get(csvRow.id);
    if (!dbRow) continue;
    const diffs = diffFields(csvRow, dbRow);
    if (diffs.length > 0) {
      mismatched.push({ id: csvRow.id, diffs });
    }
  }

  // Summary by topic for DB extras
  const extrasByTopic = {};
  for (const r of inDbNotCsv) {
    const key = `${r.topic} / ${r.subtopic}`;
    extrasByTopic[key] = (extrasByTopic[key] || 0) + 1;
  }

  const report = {
    generated_at: new Date().toISOString(),
    csv_count: csvRows.length,
    db_count: dbRows.length,
    summary: {
      in_db_not_csv: inDbNotCsv.length,
      in_csv_not_db: inCsvNotDb.length,
      field_mismatches: mismatched.length,
    },
    in_db_not_csv_by_topic: extrasByTopic,
    in_db_not_csv: inDbNotCsv.map((r) => ({
      id: r.id,
      status: r.status,
      topic: r.topic,
      subtopic: r.subtopic,
      difficulty_level: r.difficulty_level,
      question_text: r.question_text?.slice(0, 120),
    })),
    in_csv_not_db: inCsvNotDb.map((r) => ({
      id: r.id,
      topic: r.topic,
      subtopic: r.subtopic,
      difficulty_level: r.difficulty_level,
      question_text: r.question_text?.slice(0, 120),
    })),
    field_mismatches: mismatched,
  };

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to: ${REPORT_JSON}`);

  console.log(`\n=== SUMMARY ===`);
  console.log(`CSV questions:          ${csvRows.length}`);
  console.log(`DB questions (Science): ${dbRows.length}`);
  console.log(`In DB but NOT in CSV:   ${inDbNotCsv.length}  <-- candidates for removal`);
  console.log(`In CSV but NOT in DB:   ${inCsvNotDb.length}  <-- missing from DB`);
  console.log(`Field mismatches:       ${mismatched.length}`);

  if (inDbNotCsv.length > 0) {
    console.log(`\n--- DB extras by topic ---`);
    for (const [topic, count] of Object.entries(extrasByTopic).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count.toString().padStart(3)}  ${topic}`);
    }
  }

  if (inCsvNotDb.length > 0) {
    console.log(`\n--- Missing from DB (first 20) ---`);
    for (const r of inCsvNotDb.slice(0, 20)) {
      console.log(`  ${r.id}  ${r.topic} / ${r.subtopic}  "${r.question_text?.slice(0, 80)}"`);
    }
  }

  if (mismatched.length > 0) {
    console.log(`\n--- Field mismatches (first 20) ---`);
    for (const m of mismatched.slice(0, 20)) {
      console.log(`  ${m.id}:`);
      for (const d of m.diffs) {
        console.log(`    [${d.field}]`);
        console.log(`      CSV: ${String(d.csv).slice(0, 100)}`);
        console.log(`      DB:  ${String(d.db).slice(0, 100)}`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
