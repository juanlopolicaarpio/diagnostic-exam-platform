/**
 * audit-science-visual-requirements.mjs
 *
 * Fetches every science question from the DB, sends them in batches to the
 * Claude API, and emits a CSV that lists whether a visual aid is needed and—
 * if so—a precise description of what to draw (for SVG generation).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/audit-science-visual-requirements.mjs
 *   (or set ANTHROPIC_API_KEY in .env)
 *
 * Output: reports/science-visual-requirements.csv
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const REPORT_DIR = path.join(ROOT, "reports");
const OUT_CSV = path.join(REPORT_DIR, "science-visual-requirements.csv");
const BATCH_SIZE = 15; // questions per Claude API call
const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_RETRIES = 3;

// ── env ──────────────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, "");
  }
}

// ── Supabase ──────────────────────────────────────────────────────────────────

async function supabaseConfig() {
  loadEnv();
  const url = process.env.VITE_SUPABASE_URL?.replace(/\/$/, "");
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !(anonKey || serviceKey)) throw new Error("Missing Supabase URL/key in .env");

  let bearer = serviceKey ?? anonKey;

  if (!serviceKey && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
      }),
    });
    if (!r.ok) throw new Error(`Supabase login failed: ${r.status} ${await r.text()}`);
    bearer = (await r.json()).access_token;
  }

  return {
    rest: `${url}/rest/v1`,
    headers: {
      apikey: anonKey ?? serviceKey,
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
  };
}

async function fetchAll(rest, headers, table, params) {
  const PAGE = 1000;
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const p = new URLSearchParams(params);
    p.set("limit", String(PAGE));
    p.set("offset", String(offset));
    const r = await fetch(`${rest}/${table}?${p}`, { headers });
    if (!r.ok) throw new Error(`Fetch ${table} failed: ${r.status} ${await r.text()}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

// ── Claude API ────────────────────────────────────────────────────────────────

function claudeKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) {
    throw new Error(
      "ANTHROPIC_API_KEY not found.\n" +
      "Add it to .env as ANTHROPIC_API_KEY=sk-ant-... or export it before running."
    );
  }
  return k;
}

const SYSTEM_PROMPT = `You are an expert science educator reviewing Philippine college entrance exam (UPCAT) questions.

Your task: for each question, decide if a visual aid (figure, diagram, graph, chart, table, coordinate plane, circuit diagram, cell diagram, force diagram, data table, etc.) is REQUIRED to answer the question — meaning the question cannot be meaningfully answered without seeing that visual.

Rules:
1. Mark needs_visual: true ONLY when the visual is genuinely necessary — not just helpful.
   - Explicit cues: "shown below", "the figure", "refer to the diagram/graph/table", "the following", coordinates given as a set of points to plot, labeled angles/segments, etc.
   - Implicit cues: questions about reading a graph with specific data values, identifying a structure shown, placing shapes in exact positions, reading off measurements from a drawn figure.
2. For pure-text science questions (definitions, processes, cause-effect, classification) that could be answered without any diagram: needs_visual: false.
3. visual_description rules (when needs_visual is true):
   - Be concise but completely precise: include all labels, values, units, coordinates, and spatial relationships mentioned in the stem.
   - Do NOT solve the question or indicate the correct answer.
   - Describe only what must appear in the figure to make the question answerable.
   - The description will be used to generate a 500×500 black-line SVG — so be specific about layout, axes, shapes, labels, regions.
   - Example: "Coordinate plane with x-axis from -4 to 4 and y-axis from -4 to 4. A circle centered at (1, -2) with radius 3 is drawn. The region inside the circle is shaded. Label the center point and one radius endpoint."
4. When needs_visual is false, set visual_description to "no_visual_needed".
5. asset_key format: sci_<first8charsOfId>_fig01  (e.g. sci_0eeb43d7_fig01)

Return ONLY a valid JSON array — no markdown, no prose:
[
  {
    "id": "<full UUID>",
    "needs_visual": true,
    "visual_description": "...",
    "asset_key": "sci_<8chars>_fig01"
  },
  ...
]`;

function buildUserPrompt(batch) {
  const lines = batch.map((q, i) => {
    const choiceLines = ["a", "b", "c", "d", "e"]
      .map((l) => q[`choice_${l}`] ? `  Choice ${l.toUpperCase()}: ${q[`choice_${l}`]}` : null)
      .filter(Boolean)
      .join("\n");
    const markup = q.render_markup ? `  Render markup: ${q.render_markup.slice(0, 300)}` : "";
    return [
      `--- Question ${i + 1} ---`,
      `ID: ${q.id}`,
      `Topic: ${q.topic} / ${q.subtopic}`,
      `Difficulty: ${q.difficulty_level}`,
      `Stem: ${q.question_text}`,
      choiceLines,
      markup,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return lines.join("\n\n");
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callClaude(batch, apiKey) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(batch) }],
      }),
    });

    if (r.status === 529 || r.status === 503) {
      const wait = attempt * 10_000;
      console.log(`  Rate-limited (${r.status}). Waiting ${wait / 1000}s…`);
      await sleep(wait);
      continue;
    }

    if (!r.ok) {
      const body = await r.text();
      if (attempt < MAX_RETRIES) {
        console.warn(`  Claude error ${r.status}: ${body.slice(0, 200)} — retrying…`);
        await sleep(5000);
        continue;
      }
      throw new Error(`Claude API error ${r.status}: ${body.slice(0, 400)}`);
    }

    const json = await r.json();
    const text = json.content?.[0]?.text ?? "";

    // Strip markdown fences if present
    const clean = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    try {
      return JSON.parse(clean);
    } catch {
      if (attempt < MAX_RETRIES) {
        console.warn("  JSON parse failed, retrying…");
        await sleep(3000);
        continue;
      }
      throw new Error(`Failed to parse Claude response:\n${text.slice(0, 500)}`);
    }
  }
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

function csvEscape(val) {
  const s = String(val ?? "").replace(/\r?\n/g, " ");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const CSV_COLS = [
  "id", "short_id", "subject", "topic", "subtopic", "difficulty_level", "status",
  "question_text", "choice_a", "choice_b", "choice_c", "choice_d", "choice_e",
  "correct_answer", "render_markup", "needs_visual", "visual_description", "asset_key",
];

function toCsvRow(dbRow, analysis) {
  return CSV_COLS.map((col) => {
    if (col === "short_id") return csvEscape(dbRow.id?.slice(0, 8) ?? "");
    if (col === "needs_visual") return csvEscape(analysis?.needs_visual ?? "");
    if (col === "visual_description") return csvEscape(analysis?.visual_description ?? "error_no_analysis");
    if (col === "asset_key") return csvEscape(analysis?.asset_key ?? "");
    return csvEscape(dbRow[col] ?? "");
  }).join(",");
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = claudeKey();

  console.log("Connecting to Supabase…");
  const { rest, headers } = await supabaseConfig();

  console.log("Fetching all Science questions…");
  const questions = await fetchAll(rest, headers, "questions", {
    subject: "eq.Science",
    select: [
      "id", "subject", "topic", "subtopic", "difficulty_level", "status",
      "question_text", "choice_a", "choice_b", "choice_c", "choice_d", "choice_e",
      "correct_answer", "render_markup",
    ].join(","),
    order: "topic.asc,subtopic.asc,difficulty_level.asc",
  });

  console.log(`Found ${questions.length} Science questions.\n`);

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

  // Write CSV header
  fs.writeFileSync(OUT_CSV, CSV_COLS.join(",") + "\n", "utf8");

  // Track results
  const resultMap = new Map(); // id → analysis object
  let totalNeedVisual = 0;
  let errCount = 0;

  const batches = [];
  for (let i = 0; i < questions.length; i += BATCH_SIZE) {
    batches.push(questions.slice(i, i + BATCH_SIZE));
  }

  console.log(`Processing ${batches.length} batches of up to ${BATCH_SIZE} questions each…\n`);

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const from = bi * BATCH_SIZE + 1;
    const to = Math.min(from + BATCH_SIZE - 1, questions.length);
    process.stdout.write(`Batch ${bi + 1}/${batches.length} (q${from}–${to})… `);

    let analyses = [];
    try {
      analyses = await callClaude(batch, apiKey);
    } catch (err) {
      console.error(`\n  ERROR in batch ${bi + 1}: ${err.message}`);
      errCount += batch.length;
      // Write error rows so nothing is silently dropped
      for (const q of batch) {
        const errRow = toCsvRow(q, {
          needs_visual: "error",
          visual_description: `error: ${err.message.slice(0, 100)}`,
          asset_key: "",
        });
        fs.appendFileSync(OUT_CSV, errRow + "\n", "utf8");
      }
      continue;
    }

    // Index Claude results by id
    const analysisById = new Map(analyses.map((a) => [a.id, a]));

    let batchVisuals = 0;
    for (const q of batch) {
      const analysis = analysisById.get(q.id) ?? {
        needs_visual: "error_unmatched",
        visual_description: "error: Claude returned no entry for this id",
        asset_key: "",
      };
      resultMap.set(q.id, analysis);
      if (analysis.needs_visual === true) batchVisuals++;
      fs.appendFileSync(OUT_CSV, toCsvRow(q, analysis) + "\n", "utf8");
    }

    totalNeedVisual += batchVisuals;
    console.log(`done. ${batchVisuals}/${batch.length} need a visual.`);

    // Brief pause between batches to be polite to the API
    if (bi < batches.length - 1) await sleep(1500);
  }

  console.log(`\n=== DONE ===`);
  console.log(`Total questions analysed : ${questions.length}`);
  console.log(`Need a visual            : ${totalNeedVisual}`);
  console.log(`Errors                   : ${errCount}`);
  console.log(`Output CSV               : ${OUT_CSV}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
