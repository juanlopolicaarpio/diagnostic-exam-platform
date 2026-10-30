import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const CSV_PATH = path.join(ROOT, "question-bank", "english_language_questions.csv");
const REPORT_DIR = path.join(ROOT, "reports");
const REPORT_JSON = path.join(REPORT_DIR, "english-question-bank-audit.json");
const REPORT_MD = path.join(REPORT_DIR, "english-question-bank-audit.md");

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
        if (next === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (char === "\r") continue;
    cell += char;
  }

  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
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
    .replace(/â€”|â€“|â€œ|â€|â€˜|â€™|Ã©|Ã±|Ã¼|Ã§|â€¦/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value) {
  return stripMarkup(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\b(?:the|a|an|of|in|on|for|to|from|by|with|at|and|or|as|that|this|these|those|is|are|was|were|be|been|being)\b/g, " ")
    .replace(/\b(?:select best replacement|choose the best answer|best replacement|which option|which sentence)\b/g, " INSTRUCTION ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStem(value) {
  return normalize(value)
    .replace(/\b(?:about|after|before|because|although|however|then|next|finally|whether|if)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function choiceSummary(row) {
  return ["choice_a", "choice_b", "choice_c", "choice_d", "choice_e"]
    .map((field) => row[field] ? `${field.slice(-1).toUpperCase()}. ${stripMarkup(row[field])}` : "")
    .filter(Boolean)
    .join(" | ");
}

function choiceKey(row) {
  return ["choice_a", "choice_b", "choice_c", "choice_d", "choice_e"]
    .map((field) => normalize(row[field]))
    .filter(Boolean)
    .sort()
    .join(" | ");
}

function fullKey(row) {
  return [
    normalize(row.question_text),
    normalize(row.choice_a),
    normalize(row.choice_b),
    normalize(row.choice_c),
    normalize(row.choice_d),
    normalize(row.choice_e),
    String(row.correct_answer || "").toLowerCase().trim(),
  ].join("\n");
}

function stemKey(row) {
  return normalizeStem(row.question_text);
}

function suspiciousFlags(row) {
  const text = stripMarkup([
    row.question_text,
    row.choice_a,
    row.choice_b,
    row.choice_c,
    row.choice_d,
    row.choice_e,
  ].filter(Boolean).join(" "));
  const flags = [];

  if (/â€”|â€“|â€œ|â€|â€˜|â€™|Ã.|�/.test(text)) flags.push("garbled_encoding");
  if (/select best replacement|choose the best answer|best replacement/i.test(text)) flags.push("instruction_leakage");
  if (/_{3,}/.test(String(row.question_text || ""))) flags.push("blank_or_gap_prompt");
  if (/\b(?:question|answer|choices?)\b/i.test(String(row.question_text || "")) && /Select best replacement/i.test(text)) flags.push("meta_prompt");
  if (/(?:^|[^\w])\b(?:_____|___)\b/.test(String(row.question_text || ""))) flags.push("placeholder_stem");
  if (String(row.question_text || "").trim().endsWith(",")) flags.push("dangling_comma_stem");
  const choices = ["choice_a", "choice_b", "choice_c", "choice_d", "choice_e"].map((field) => stripMarkup(row[field] || ""));
  if (new Set(choices.filter(Boolean)).size < choices.filter(Boolean).length) flags.push("duplicate_choices");
  if (choices.some((choice) => choice.length > 140)) flags.push("very_long_choice");
  if (choices.some((choice) => /select best replacement|choose the best answer|which option|which sentence/i.test(choice))) flags.push("instruction_text_in_choice");

  return flags;
}

function sortRows(rows) {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id));
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({
      key,
      rows: sortRows(group),
    }))
    .sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));
}

function rowBrief(row) {
  return {
    id: row.id,
    subject: row.subject,
    topic: row.topic,
    subtopic: row.subtopic,
    difficulty_level: row.difficulty_level,
    correct_answer: row.correct_answer,
    question_text: stripMarkup(row.question_text),
    choices: choiceSummary(row),
  };
}

function mismatchFields(sourceRow, dbRow, fields) {
  const mismatches = [];
  for (const field of fields) {
    const sourceValue = sourceRow[field] ?? "";
    const dbValue = dbRow?.[field] ?? "";
    if (String(sourceValue) !== String(dbValue)) {
      mismatches.push({
        field,
        source: sourceValue,
        db: dbValue,
      });
    }
  }
  return mismatches;
}

function markdown(report) {
  const lines = [
    "# English Question Bank Audit",
    "",
    `Generated: ${report.generatedAt}`,
    `CSV rows: ${report.counts.csvRows}`,
    `DB rows: ${report.counts.dbRows}`,
    `Matched IDs: ${report.counts.matchedRows}`,
    `Missing in DB: ${report.counts.missingInDb}`,
    `Extra in DB: ${report.counts.extraInDb}`,
    `Content mismatches: ${report.counts.contentMismatches}`,
    `CSV duplicate stem groups: ${report.counts.csvDuplicateStemGroups}`,
    `DB duplicate stem groups: ${report.counts.dbDuplicateStemGroups}`,
    `CSV exact duplicate groups: ${report.counts.csvExactDuplicateGroups}`,
    `DB exact duplicate groups: ${report.counts.dbExactDuplicateGroups}`,
    `CSV suspicious rows: ${report.counts.csvSuspiciousRows}`,
    `DB suspicious rows: ${report.counts.dbSuspiciousRows}`,
    "",
  ];

  const sections = [
    ["Missing in DB", report.missingInDb],
    ["Extra in DB", report.extraInDb],
    ["Content Mismatches", report.contentMismatchesDetailed],
    ["CSV Duplicate Stems", report.csvDuplicateStems],
    ["DB Duplicate Stems", report.dbDuplicateStems],
    ["CSV Exact Duplicates", report.csvExactDuplicates],
    ["DB Exact Duplicates", report.dbExactDuplicates],
    ["CSV Suspicious Rows", report.csvSuspiciousRowsDetailed],
    ["DB Suspicious Rows", report.dbSuspiciousRowsDetailed],
  ];

  for (const [title, items] of sections) {
    lines.push(`## ${title}`);
    lines.push("");
    if (!items.length) {
      lines.push("None.");
      lines.push("");
      continue;
    }
    for (const item of items.slice(0, 50)) {
      if (item.rows) {
        lines.push(`### ${item.key} (${item.rows.length})`);
        for (const row of item.rows) {
          lines.push(`- ${row.id} | ${row.topic || ""} | ${row.subtopic || ""}`);
          lines.push(`  - Q: ${row.question_text}`);
          lines.push(`  - Choices: ${row.choices}`);
          if (row.flags?.length) lines.push(`  - Flags: ${row.flags.join(", ")}`);
        }
      } else if (item.mismatches) {
        lines.push(`- ${item.id} | ${item.topic || ""} | ${item.subtopic || ""}`);
        lines.push(`  - Q: ${item.question_text}`);
        for (const mismatch of item.mismatches) {
          lines.push(`  - ${mismatch.field}: source="${stripMarkup(mismatch.source)}" | db="${stripMarkup(mismatch.db)}"`);
        }
      } else {
        lines.push(`- ${item.id} | ${item.topic || ""} | ${item.subtopic || ""}`);
        if (item.question_text) lines.push(`  - Q: ${item.question_text}`);
        if (item.choices) lines.push(`  - Choices: ${item.choices}`);
        if (item.flags?.length) lines.push(`  - Flags: ${item.flags.join(", ")}`);
      }
    }
    if (items.length > 50) lines.push(`- ... and ${items.length - 50} more`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) throw new Error(`Missing CSV: ${CSV_PATH}`);

  const csvText = fs.readFileSync(CSV_PATH, "utf8");
  const parsed = parseCsv(csvText);
  const header = parsed.shift();
  const rows = parsed
    .filter((cells) => cells.some((value) => String(value || "").trim() !== ""))
    .map((cells) => {
      const row = {};
      for (let index = 0; index < header.length; index += 1) {
        row[header[index]] = cells[index] ?? "";
      }
      return row;
    });

  const { rest, headers } = await apiConfig();
  const dbRows = await fetchAll(rest, headers, "questions", {
    select: "id,subject,topic,subtopic,difficulty_level,question_text,choice_a,choice_b,choice_c,choice_d,choice_e,correct_answer,instruction_id,status",
    subject: "eq.English Language",
    order: "id.asc",
  });

  const dbById = new Map(dbRows.map((row) => [row.id, row]));
  const csvById = new Map(rows.map((row) => [row.id, row]));

  const matched = [];
  const missingInDb = [];
  const extraInDb = [];
  const contentMismatchesDetailed = [];

  for (const row of rows) {
    const dbRow = dbById.get(row.id);
    if (!dbRow) {
      missingInDb.push(rowBrief(row));
      continue;
    }
    matched.push({ source: row, db: dbRow });
    const fields = ["subject", "topic", "subtopic", "difficulty_level", "question_text", "choice_a", "choice_b", "choice_c", "choice_d", "correct_answer"];
    const mismatches = mismatchFields(row, dbRow, fields);
    if (mismatches.length) {
      contentMismatchesDetailed.push({
        id: row.id,
        topic: row.topic,
        subtopic: row.subtopic,
        question_text: stripMarkup(row.question_text),
        mismatches,
      });
    }
  }

  for (const row of dbRows) {
    if (!csvById.has(row.id)) extraInDb.push(rowBrief(row));
  }

  const csvDuplicateStems = groupBy(rows, stemKey).map((group) => ({
    key: group.key,
    rows: sortRows(group.rows).map((row) => ({
      ...rowBrief(row),
      flags: suspiciousFlags(row),
    })),
  }));
  const dbDuplicateStems = groupBy(dbRows, stemKey).map((group) => ({
    key: group.key,
    rows: sortRows(group.rows).map((row) => ({
      ...rowBrief(row),
      flags: suspiciousFlags(row),
    })),
  }));
  const csvExactDuplicates = groupBy(rows, fullKey).map((group) => ({
    key: group.key,
    rows: sortRows(group.rows).map((row) => ({
      ...rowBrief(row),
      flags: suspiciousFlags(row),
    })),
  }));
  const dbExactDuplicates = groupBy(dbRows, fullKey).map((group) => ({
    key: group.key,
    rows: sortRows(group.rows).map((row) => ({
      ...rowBrief(row),
      flags: suspiciousFlags(row),
    })),
  }));

  const csvSuspiciousRowsDetailed = rows
    .map((row) => ({ ...rowBrief(row), flags: suspiciousFlags(row) }))
    .filter((row) => row.flags.length)
    .sort((a, b) => a.id.localeCompare(b.id));
  const dbSuspiciousRowsDetailed = dbRows
    .map((row) => ({ ...rowBrief(row), flags: suspiciousFlags(row) }))
    .filter((row) => row.flags.length)
    .sort((a, b) => a.id.localeCompare(b.id));

  const report = {
    generatedAt: new Date().toISOString(),
    counts: {
      csvRows: rows.length,
      dbRows: dbRows.length,
      matchedRows: matched.length,
      missingInDb: missingInDb.length,
      extraInDb: extraInDb.length,
      contentMismatches: contentMismatchesDetailed.length,
      csvDuplicateStemGroups: csvDuplicateStems.length,
      dbDuplicateStemGroups: dbDuplicateStems.length,
      csvExactDuplicateGroups: csvExactDuplicates.length,
      dbExactDuplicateGroups: dbExactDuplicates.length,
      csvSuspiciousRows: csvSuspiciousRowsDetailed.length,
      dbSuspiciousRows: dbSuspiciousRowsDetailed.length,
    },
    missingInDb,
    extraInDb,
    contentMismatchesDetailed,
    csvDuplicateStems,
    dbDuplicateStems,
    csvExactDuplicates,
    dbExactDuplicates,
    csvSuspiciousRowsDetailed,
    dbSuspiciousRowsDetailed,
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
