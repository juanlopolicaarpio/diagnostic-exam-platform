import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const REPORT_DIR = path.join(ROOT, "reports");
const OUTPUT_CSV = path.join(REPORT_DIR, "reading-questions-with-paragraphs.csv");
const OUTPUT_JSON = path.join(REPORT_DIR, "reading-questions-with-paragraphs-report.json");

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
    body: JSON.stringify({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    }),
  });
  if (!login.ok) throw new Error(`Login failed: ${login.status} ${await login.text()}`);
  const token = (await login.json()).access_token;
  return {
    rest: `${url}/rest/v1`,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
}

async function fetchAll(rest, headers, table, params) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const pageParams = new URLSearchParams(params);
    pageParams.set("limit", "1000");
    pageParams.set("offset", String(offset));
    const response = await fetch(`${rest}/${table}?${pageParams}`, { headers });
    if (!response.ok) throw new Error(`${table} fetch failed: ${response.status} ${await response.text()}`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(file, rows) {
  const headers = [
    "id",
    "source_school",
    "subject",
    "topic",
    "subtopic",
    "difficulty_level",
    "status",
    "question_text",
    "correct_answer",
    "correct_choice_text",
    "stimulus_id",
    "stimulus_title",
    "stimulus_type",
    "paragraph_index",
    "paragraph_count",
    "match_method",
    "match_score",
    "paragraph_text",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "had", "has", "have",
  "he", "her", "here", "his", "i", "in", "is", "it", "its", "me", "my", "of", "on",
  "or", "our", "she", "that", "the", "their", "them", "there", "these", "they", "this",
  "those", "to", "was", "we", "were", "what", "when", "where", "which", "who", "why",
  "with", "you", "your",
  "ang", "mga", "sa", "si", "sina", "ni", "nina", "kay", "kina", "ng", "na", "at",
  "ay", "ito", "iyan", "iyon", "dahil", "kung", "para", "mga", "para", "ngunit",
  "alin", "ano", "sino", "bakit", "paano", "kanino", "nang", "the", "paragraph", "passage",
  "sentence", "question", "choice", "option", "main", "idea", "detail", "details",
]);

function tokenize(value) {
  return normalizeText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && token.length > 2 && !STOPWORDS.has(token));
}

function paragraphize(stimulusText) {
  const normalized = String(stimulusText || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const byBlankLines = normalized
    .split(/\n\s*\n+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (byBlankLines.length > 1) return byBlankLines;

  const byLines = normalized
    .split(/\n+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (byLines.length > 1) return byLines;

  return [normalized.replace(/\s+/g, " ").trim()];
}

function looksLikeMetadataParagraph(paragraph, title) {
  const normalized = normalizeText(paragraph);
  if (!normalized) return true;
  if (normalized.length <= 8) return true;

  const titleNorm = normalizeText(title);
  if (titleNorm && (normalized === titleNorm || normalized.includes(titleNorm))) return true;

  const metadataHints = [
    /\bpublic domain\b/,
    /\badapted from\b/,
    /\bexcerpt from\b/,
    /\bby [a-z]/,
    /\bfrom (?:the|a|an)\b/,
  ];
  return metadataHints.some((rx) => rx.test(normalized));
}

function prepParagraphs(stimulus) {
  const paragraphs = paragraphize(stimulus?.stimulus_text || "");
  if (paragraphs.length <= 1) return paragraphs;

  const cleaned = [...paragraphs];
  while (cleaned.length > 1 && looksLikeMetadataParagraph(cleaned[0], stimulus?.stimulus_title || "")) {
    cleaned.shift();
  }
  return cleaned.length ? cleaned : paragraphs;
}

function ordinalFromText(text) {
  const value = normalizeText(text);
  if (!/\b(?:paragraph|talata|saknong|stanza)\b/.test(value)) return null;

  const english = [
    [/(\bfirst\b|\b1(?:st)?\b)/, 1],
    [/(\bsecond\b|\b2(?:nd)?\b)/, 2],
    [/(\bthird\b|\b3(?:rd)?\b)/, 3],
    [/(\bfourth\b|\b4(?:th)?\b)/, 4],
    [/(\bfifth\b|\b5(?:th)?\b)/, 5],
    [/(\bsixth\b|\b6(?:th)?\b)/, 6],
    [/(\bseventh\b|\b7(?:th)?\b)/, 7],
    [/(\beighth\b|\b8(?:th)?\b)/, 8],
    [/(\bninth\b|\b9(?:th)?\b)/, 9],
    [/(\btenth\b|\b10(?:th)?\b)/, 10],
  ];
  for (const [rx, index] of english) {
    if (rx.test(value)) return index;
  }

  const filipino = [
    [/ika-?\s*1|unang/, 1],
    [/ika-?\s*2|ikalawang/, 2],
    [/ika-?\s*3|ikatlong/, 3],
    [/ika-?\s*4|ikaapat/, 4],
    [/ika-?\s*5|ikalimang/, 5],
    [/ika-?\s*6|ikaanim/, 6],
    [/ika-?\s*7|ikapitong/, 7],
    [/ika-?\s*8|ikawalong/, 8],
    [/ika-?\s*9|ikasiyam/, 9],
    [/ika-?\s*10|ikasampung/, 10],
  ];
  for (const [rx, index] of filipino) {
    if (rx.test(value)) return index;
  }

  return null;
}

function answerText(row) {
  const key = String(row.correct_answer || "").trim().toLowerCase();
  if (!["a", "b", "c", "d", "e"].includes(key)) return "";
  return row[`choice_${key}`] || "";
}

function overlapScore(questionTokens, paragraphTokens) {
  if (!questionTokens.length || !paragraphTokens.length) return 0;
  const q = new Set(questionTokens);
  const p = new Set(paragraphTokens);
  let shared = 0;
  for (const token of q) if (p.has(token)) shared += 1;
  return shared / Math.sqrt(q.size * p.size);
}

function scoreParagraph(question, paragraph, choiceText) {
  const qTokens = tokenize(question);
  const pTokens = tokenize(paragraph);
  const cTokens = tokenize(choiceText);

  const questionScore = overlapScore(qTokens, pTokens);
  const choiceScore = overlapScore(cTokens, pTokens);
  const phraseBonus = normalizeText(question).includes(normalizeText(paragraph).slice(0, 24)) ? 0.15 : 0;
  const lengthPenalty = pTokens.length ? Math.max(0, Math.min(0.08, Math.abs(pTokens.length - qTokens.length) / 250)) : 0;

  return (questionScore * 1.25) + (choiceScore * 1.75) + phraseBonus - lengthPenalty;
}

function bestParagraphForQuestion(row, stimulus) {
  const paragraphs = prepParagraphs(stimulus);
  if (!paragraphs.length) {
    return {
      paragraph_index: "",
      paragraph_text: "",
      paragraph_count: 0,
      match_method: "missing_stimulus",
      match_score: 0,
    };
  }

  if (paragraphs.length === 1) {
    return {
      paragraph_index: 1,
      paragraph_text: paragraphs[0],
      paragraph_count: 1,
      match_method: "single_paragraph",
      match_score: 1,
    };
  }

  const explicitIndex = ordinalFromText(row.question_text || "");
  if (explicitIndex && explicitIndex >= 1 && explicitIndex <= paragraphs.length) {
    return {
      paragraph_index: explicitIndex,
      paragraph_text: paragraphs[explicitIndex - 1],
      paragraph_count: paragraphs.length,
      match_method: "explicit_ordinal",
      match_score: 1,
    };
  }

  const choiceText = answerText(row);
  const scored = paragraphs.map((paragraph, index) => ({
    index: index + 1,
    paragraph,
    score: scoreParagraph(row.question_text || "", paragraph, choiceText),
  })).sort((a, b) => b.score - a.score);

  const best = scored[0];
  return {
    paragraph_index: best.index,
    paragraph_text: best.paragraph,
    paragraph_count: paragraphs.length,
    match_method: "keyword_overlap",
    match_score: Number(best.score.toFixed(4)),
    runner_up_score: scored[1] ? Number(scored[1].score.toFixed(4)) : "",
  };
}

async function main() {
  const { rest, headers } = await apiConfig();
  const questions = await fetchAll(rest, headers, "questions", {
    select: "id,source_school,subject,topic,subtopic,difficulty_level,status,question_text,choice_a,choice_b,choice_c,choice_d,choice_e,correct_answer,stimulus_id,created_at,updated_at",
    subject: "eq.Reading",
    order: "stimulus_id.asc,created_at.asc,id.asc",
  });

  const stimulusIds = [...new Set(questions.map((row) => row.stimulus_id).filter(Boolean))];
  const stimuli = new Map();
  for (let index = 0; index < stimulusIds.length; index += 100) {
    const ids = stimulusIds.slice(index, index + 100).map(encodeURIComponent).join(",");
    const rows = await fetchAll(rest, headers, "stimuli", {
      select: "id,stimulus_title,stimulus_type,stimulus_text",
      id: `in.(${ids})`,
    });
    for (const row of rows) stimuli.set(row.id, row);
  }

  const output = questions.map((row) => {
    const stimulus = stimuli.get(row.stimulus_id) || null;
    const match = bestParagraphForQuestion(row, stimulus);
    return {
      id: row.id,
      source_school: row.source_school || "",
      subject: row.subject || "",
      topic: row.topic || "",
      subtopic: row.subtopic || "",
      difficulty_level: row.difficulty_level || "",
      status: row.status || "",
      question_text: row.question_text || "",
      correct_answer: row.correct_answer || "",
      correct_choice_text: answerText(row),
      stimulus_id: row.stimulus_id || "",
      stimulus_title: stimulus?.stimulus_title || "",
      stimulus_type: stimulus?.stimulus_type || "",
      paragraph_index: match.paragraph_index,
      paragraph_count: match.paragraph_count,
      match_method: match.match_method,
      match_score: match.match_score,
      paragraph_text: match.paragraph_text || "",
    };
  });

  writeCsv(OUTPUT_CSV, output);

  const report = {
    generatedAt: new Date().toISOString(),
    counts: {
      questions: questions.length,
      stimuli: stimuli.size,
      matched: output.filter((row) => row.paragraph_text).length,
      missingStimulus: output.filter((row) => !row.stimulus_id).length,
    },
    outputCsv: path.relative(ROOT, OUTPUT_CSV),
    note: "Paragraph matching is heuristic when a passage has multiple paragraphs and no explicit ordinal is mentioned in the question.",
  };
  fs.writeFileSync(OUTPUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
