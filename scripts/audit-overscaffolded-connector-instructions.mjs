import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const APPLY = process.argv.includes("--apply");
const REPORT_DIR = path.join(ROOT, "reports");
const REPORT_JSON = path.join(REPORT_DIR, "overscaffolded-connector-audit.json");
const REPORT_MD = path.join(REPORT_DIR, "overscaffolded-connector-audit.md");

// The neutral replacement instruction (matches well-formatted questions in DB like
// "Which transition best fits? The technician backed up the files. _____, he installed...")
const NEUTRAL_INSTRUCTION = "Which connector best completes the sentence?";

function loadEnv() {
  for (const name of [".env.local", ".env"]) {
    const envPath = path.join(ROOT, name);
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

function strip(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Keywords in the instruction portion that reveal the relationship type.
// If the instruction part (before the colon/sentence) contains any of these,
// the student can identify the answer without actually understanding the relationship.
const SEQUENCE_HINTS = /timeline|time[\s-]order|order of events|sequence|next step|next action|later action|what happened next|final step|last step|concluding action|what followed|indicates? what followed|preserves? (?:the )?order|signals? (?:the )?(?:next|sequence)|shows? (?:the )?(?:next|order|sequence|later|last|what happened|a (?:concluding|later))|fits? (?:the )?sequence|keeps? the sequence|completes? the (?:sequence|process|step)|indicates? (?:a )?final|indicates? (?:the )?(?:next|order)/i;

const CONTRAST_HINTS = /contrast|opposing idea|opposite idea|disagrees?|conflict/i;
const ADDITION_HINTS = /\baddition\b|\bfurthermore\b/i;
const CAUSE_EFFECT_HINTS = /cause.and.effect|cause.effect|\bresult\b.*transition|\beffect\b.*transition/i;

function detectOverscaffolding(questionText) {
  const text = strip(questionText);

  // Extract the instruction (everything before a colon or question mark that is followed
  // by an uppercase letter — that signals the start of the actual sentence)
  const colonMatch = text.match(/^(.+?):\s*([A-Z])/);
  const qmarkMatch = text.match(/^(.+?\?)\s*([A-Z])/);

  let instruction = "";
  let sentencePart = "";

  if (colonMatch) {
    instruction = colonMatch[1].trim();
    sentencePart = text.slice(colonMatch.index + colonMatch[1].length + 1).trimStart();
  } else if (qmarkMatch) {
    instruction = qmarkMatch[1].trim();
    sentencePart = text.slice(qmarkMatch.index + qmarkMatch[1].length).trimStart();
  } else {
    return null;
  }

  // Only check if the question has a fill-in blank (_____)
  if (!/_____/.test(text)) return null;

  const instrLower = instruction.toLowerCase();

  let label = null;
  if (SEQUENCE_HINTS.test(instrLower)) label = "sequence_hint";
  else if (CONTRAST_HINTS.test(instrLower)) label = "contrast_hint";
  else if (ADDITION_HINTS.test(instrLower)) label = "addition_hint";
  else if (CAUSE_EFFECT_HINTS.test(instrLower)) label = "cause_effect_hint";

  if (!label) return null;

  // Build the fixed question text: neutral instruction first, then the sentence
  // This matches the convention of well-formatted questions in DB like:
  // "Which transition best fits? The technician backed up the files. _____, ..."
  const fixedQuestionText = `${NEUTRAL_INSTRUCTION} ${sentencePart}`;

  return {
    label,
    instruction,
    sentencePart,
    fixedQuestionText,
  };
}

// Checks if a choice (any subject) is just "No" — possibly truncated from "No Error"
// or from "No [noun]" in fill-in-the-blank questions.
function isBareNo(value) {
  return /^No\.?$/.test(strip(value));
}

function choiceSummary(row) {
  return ["choice_a", "choice_b", "choice_c", "choice_d", "choice_e"]
    .map((field) => row[field] ? `${field.slice(-1).toUpperCase()}. ${strip(row[field])}` : "")
    .filter(Boolean)
    .join(" | ");
}

async function patchQuestion(rest, headers, id, patch) {
  const response = await fetch(`${rest}/questions?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`Patch failed for ${id}: ${response.status} ${await response.text()}`);
  return (await response.json())[0];
}

function markdown(report) {
  const lines = [
    "# Audit: Over-scaffolded Connector Instructions & Bare 'No' Choices",
    "",
    `Generated: ${report.generatedAt}`,
    `Applied: ${report.applied}`,
    `English rows scanned: ${report.counts.englishRows}`,
    `All-subjects rows scanned: ${report.counts.totalRows}`,
    `Over-scaffolded instructions found: ${report.counts.overscaffolded}`,
    `Bare "No" choices found (all subjects): ${report.counts.bareNo}`,
    "",
  ];

  lines.push("## Over-scaffolded Instructions");
  lines.push("");
  lines.push("These questions give away the relationship type in the instruction,");
  lines.push('so students can answer by label-matching rather than reading the sentence.');
  lines.push("");

  if (!report.overscaffolded.length) {
    lines.push("None found.");
    lines.push("");
  } else {
    for (const item of report.overscaffolded) {
      lines.push(`### ${item.id} | ${item.topic} / ${item.subtopic} | status: ${item.status}`);
      lines.push(`- **Label:** \`${item.label}\``);
      lines.push(`- **Instruction (over-specific):** "${item.instruction}"`);
      lines.push(`- **Sentence part:** ${item.sentencePart}`);
      lines.push(`- **Choices:** ${item.choices}`);
      lines.push(`- **Correct:** ${item.correct_answer}`);
      lines.push(`- **BEFORE:** ${item.question_text}`);
      lines.push(`- **AFTER:** ${item.fixedQuestionText}`);
      if (item.applied) lines.push(`- **Applied:** YES`);
      lines.push("");
    }
  }

  lines.push('## Bare "No" Choices (possibly truncated)');
  lines.push("");
  lines.push('NOTE: These are fill-in-blank questions (not error-id) where a choice is just "No".');
  lines.push('They may be intentional ("no boiling points") or truncated. Manual review needed.');
  lines.push("");

  if (!report.bareNo.length) {
    lines.push("None found.");
    lines.push("");
  } else {
    for (const item of report.bareNo) {
      lines.push(`### ${item.id} | ${item.subject} | ${item.topic}`);
      lines.push(`- **Q:** ${item.question_text}`);
      lines.push(`- **Choices:** ${item.choices}`);
      lines.push(`- **Correct:** ${item.correct_answer}`);
      for (const t of item.bareNoFields) {
        lines.push(`- **Bare field:** \`${t}\` = "${strip(item[t])}"`);
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const { rest, headers } = await apiConfig();

  // Fetch English Language questions
  const englishRows = await fetchAll(rest, headers, "questions", {
    select: "id,subject,topic,subtopic,status,question_text,choice_a,choice_b,choice_c,choice_d,choice_e,correct_answer",
    subject: "eq.English Language",
    order: "topic.asc,subtopic.asc,id.asc",
  });

  // Fetch all questions for the bare-No check
  const allRows = await fetchAll(rest, headers, "questions", {
    select: "id,subject,topic,subtopic,status,question_text,choice_a,choice_b,choice_c,choice_d,choice_e,correct_answer",
    order: "subject.asc,id.asc",
  });

  // --- Over-scaffolded detection ---
  const overscaffolded = [];
  for (const row of englishRows) {
    const result = detectOverscaffolding(row.question_text);
    if (!result) continue;
    overscaffolded.push({
      id: row.id,
      topic: row.topic,
      subtopic: row.subtopic,
      status: row.status,
      question_text: strip(row.question_text),
      choices: choiceSummary(row),
      correct_answer: row.correct_answer,
      label: result.label,
      instruction: result.instruction,
      sentencePart: result.sentencePart,
      fixedQuestionText: result.fixedQuestionText,
      applied: false,
    });
  }

  // --- Bare "No" detection (all subjects) ---
  const bareNo = [];
  const choiceFields = ["choice_a", "choice_b", "choice_c", "choice_d", "choice_e"];
  for (const row of allRows) {
    const bareNoFields = choiceFields.filter((f) => isBareNo(row[f]));
    if (!bareNoFields.length) continue;
    bareNo.push({
      id: row.id,
      subject: row.subject,
      topic: row.topic,
      subtopic: row.subtopic,
      status: row.status,
      question_text: strip(row.question_text),
      choices: choiceSummary(row),
      correct_answer: row.correct_answer,
      bareNoFields,
      ...Object.fromEntries(choiceFields.map((f) => [f, row[f]])),
    });
  }

  // --- Apply fixes if --apply ---
  const patched = [];
  if (APPLY) {
    for (const item of overscaffolded) {
      const patched_row = await patchQuestion(rest, headers, item.id, {
        question_text: item.fixedQuestionText,
      });
      item.applied = true;
      patched.push(patched_row);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    applied: APPLY,
    neutralInstruction: NEUTRAL_INSTRUCTION,
    counts: {
      englishRows: englishRows.length,
      totalRows: allRows.length,
      overscaffolded: overscaffolded.length,
      bareNo: bareNo.length,
      patched: patched.length,
    },
    overscaffolded,
    bareNo,
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(REPORT_MD, markdown(report));

  console.log(JSON.stringify(report.counts, null, 2));
  if (APPLY) console.log("Changes applied to DB.");
  else console.log("Dry run only. Run with --apply to write changes.");
  console.log(`Wrote ${path.relative(ROOT, REPORT_JSON)}`);
  console.log(`Wrote ${path.relative(ROOT, REPORT_MD)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
