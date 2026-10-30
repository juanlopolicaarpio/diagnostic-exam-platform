// ═══════════════════════════════════════════════════════════════
// BULK QUESTION IMPORT — parse + validate (pure, no network, no React)
// ═══════════════════════════════════════════════════════════════
// The inverse of the CSV produced by App.exportQuestions: export a subject,
// edit the sheet, upload it back. One file format, used both directions.
//
// `prepareQuestionImport` is pure — no network, no React — so every rule can be
// tested in node (scripts/test-question-import.mjs). `commitQuestionImport` is
// the only part that writes, and it takes its REST base and headers as
// arguments so the same code path runs from the UI and from a test script.
//
// Row semantics:
//   blank id   → INSERT a new question
//   filled id  → UPDATE that question, touching only the columns present
//                in the header (an absent column is never nulled out)
// ═══════════════════════════════════════════════════════════════

// Extensions are explicit here (the rest of src/ relies on bundler resolution)
// so node can import this module directly for scripts/test-question-import.mjs.
import { validateMathItem } from "./mathValidation.js";
import { svgLooksSafe } from "./svgSafety.js";

export const QUESTION_IMPORT_FIELDS = [
  "id", "subject", "topic", "subtopic", "difficulty_level", "status", "source_school",
  "correct_answer", "question_text",
  "choice_a", "choice_b", "choice_c", "choice_d", "choice_e",
  "render_markup", "svg_content", "stimulus_id", "instruction_id",
];

export const STIMULUS_IMPORT_FIELDS = ["stimulus_title", "stimulus_type", "stimulus_text", "stimulus_group_key"];

// Columns an INSERT cannot do without. Updates only require `id`.
export const REQUIRED_INSERT_FIELDS = [
  "subject", "topic", "question_text", "choice_a", "choice_b", "choice_c", "choice_d", "correct_answer",
];

export const IMPORT_DIFFICULTIES = ["easy", "medium", "hard"];
// questions_status_check accepts exactly these three. Note that it does NOT
// accept `needs_human_review`, even though the bank UI filters for it and
// useQuestionGeneration.js tries to write it — any insert using that value comes
// back as a 23514. A failed check here leaves the row as a flagged draft.
export const IMPORT_STATUSES = ["active", "draft", "retired"];
// questions_source_school_check permits exactly these — see
// supabase/migrations/20260626010000_allow_ai_generated_source_school.sql.
// The column is also NOT NULL, so a new question has to name one of them.
export const IMPORT_SOURCE_SCHOOLS = ["UPCAT", "ACET", "DCAT", "USTET", "AI Generated"];

// `questions.subtopic` is NOT NULL, and existing rows with no subtopic store an
// empty string rather than NULL. A blank cell on a new question has to follow
// that, or the insert dies on a 23502.
const BLANK_INSERT_VALUE = { subtopic: "" };
const CHOICE_LETTERS = ["a", "b", "c", "d", "e"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tolerates the headings people actually type in a spreadsheet.
const HEADER_ALIASES = {
  question: "question_text", stem: "question_text", question_stem: "question_text", text: "question_text",
  answer: "correct_answer", correct: "correct_answer", key: "correct_answer",
  answer_key: "correct_answer", correct_choice: "correct_answer", correct_letter: "correct_answer",
  a: "choice_a", b: "choice_b", c: "choice_c", d: "choice_d", e: "choice_e",
  option_a: "choice_a", option_b: "choice_b", option_c: "choice_c", option_d: "choice_d", option_e: "choice_e",
  choice1: "choice_a", choice2: "choice_b", choice3: "choice_c", choice4: "choice_d", choice5: "choice_e",
  difficulty: "difficulty_level", level: "difficulty_level",
  passage: "stimulus_text", passage_text: "stimulus_text",
  passage_title: "stimulus_title", passage_type: "stimulus_type",
  group_key: "stimulus_group_key", passage_group_key: "stimulus_group_key",
  source: "source_school", school: "source_school", source_exam: "source_school",
  question_id: "id", uuid: "id",
  sub_topic: "subtopic", subject_name: "subject", topic_name: "topic", subtopic_name: "subtopic",
  svg: "svg_content", inline_svg: "svg_content",
  instruction: "instruction_id",
};

// ───────────────────────────────────────────────────────────────
// CSV / TSV parsing
// ───────────────────────────────────────────────────────────────

// Full RFC-4180 state machine. Needed, not optional: the export quotes every
// field, uses CRLF, and passages contain embedded newlines and quotes, so any
// split(",") approach shreds Reading exports.
export function parseDelimited(text, delimiter = ",") {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "") { quoted = true; i++; continue; }
    if (ch === delimiter) { endField(); i++; continue; }
    if (ch === "\r") { if (src[i + 1] === "\n") i++; endRow(); i++; continue; }
    if (ch === "\n") { endRow(); i++; continue; }
    field += ch; i++;
  }
  if (field !== "" || row.length) endRow();

  return rows;
}

// Sniffs comma vs tab vs semicolon from the header line so a sheet pasted out
// of Excel or Google Sheets works without the operator converting it first.
export function detectDelimiter(text) {
  const firstLine = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/)[0] || "";
  const counts = [",", "\t", ";"].map(d => [d, firstLine.split(d).length - 1]);
  counts.sort((x, y) => y[1] - x[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

export function normalizeHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function headerToField(value) {
  const key = normalizeHeader(value);
  if (!key) return null;
  if (QUESTION_IMPORT_FIELDS.includes(key) || STIMULUS_IMPORT_FIELDS.includes(key)) return key;
  return HEADER_ALIASES[key] || null;
}

// ───────────────────────────────────────────────────────────────
// Row validation
// ───────────────────────────────────────────────────────────────

// `stimuli.stimulus_group_key` is NOT NULL in the database, and existing rows
// follow a SCREAMING_SNAKE convention (UPCAT_READ_P2_V2, ACET_PT1_READ_PASSAGE7_V3).
// A sheet that supplies passage text but no key still has to produce one, so we
// derive it from the title — or from the opening words when there is no title.
// There is no unique index on the column, so a repeated key is not an error.
export function deriveStimulusGroupKey(title, text) {
  const source = String(title || "").trim()
    || String(text || "").trim().split(/\s+/).slice(0, 8).join(" ");
  const slug = source
    .normalize("NFKD")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
    .replace(/_+$/, "");
  return `IMPORT_${slug || "PASSAGE"}`;
}

function cleanCell(value) {
  // Excel and Word love turning a blank into a non-breaking space; treat that
  // as blank rather than as content.
  return String(value ?? "").replace(/\u00A0/g, " ").trim();
}

function resolveAnswerLetter(raw, choiceTexts) {
  const value = cleanCell(raw);
  if (!value) return { letter: null };

  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact.length === 1 && CHOICE_LETTERS.includes(compact)) return { letter: compact };

  // Someone pasted the answer text instead of the letter. Recoverable when
  // exactly one choice matches it.
  const norm = s => cleanCell(s).toLowerCase().replace(/\s+/g, " ");
  const hits = CHOICE_LETTERS.filter(l => choiceTexts[l] && norm(choiceTexts[l]) === norm(value));
  if (hits.length === 1) {
    return { letter: hits[0], note: `correct_answer "${value}" matched choice ${hits[0].toUpperCase()} by text.` };
  }
  return { letter: null };
}

function validateRow(record, rowNumber, present, opts) {
  const { forceDraft = true, knownSubjects = [], knownTopics = [], knownSubtopics = [] } = opts;
  const errors = [];
  const warnings = [];
  const get = field => cleanCell(record[field]);
  const has = field => present.has(field);
  const filled = field => has(field) && get(field) !== "";

  const id = get("id");
  const action = id ? "update" : "insert";
  if (id && !UUID_RE.test(id)) {
    errors.push(`id "${id}" is not a question UUID. Leave it blank to create a new question.`);
  }

  if (action === "insert") {
    REQUIRED_INSERT_FIELDS.forEach(field => {
      if (!filled(field)) errors.push(`${field} is required for a new question.`);
    });
  }

  const payload = {};

  // Plain text columns, copied through as-is.
  ["subject", "topic", "question_text", "choice_a", "choice_b", "choice_c", "choice_d", "choice_e",
    "subtopic", "render_markup", "instruction_id"].forEach(field => {
    if (!has(field)) return;
    const value = get(field);
    if (value === "") {
      // On an update an empty cell means "leave alone" — never silently wipe a
      // stored value. Required-field emptiness was already caught above.
      if (action === "insert" && !REQUIRED_INSERT_FIELDS.includes(field)) {
        payload[field] = field in BLANK_INSERT_VALUE ? BLANK_INSERT_VALUE[field] : null;
      }
      return;
    }
    payload[field] = value;
  });

  // A sheet can leave the subtopic column out entirely; the NOT NULL constraint
  // still has to be satisfied for a new row.
  if (action === "insert" && payload.subtopic === undefined) payload.subtopic = "";

  // difficulty_level
  if (filled("difficulty_level")) {
    const diff = get("difficulty_level").toLowerCase();
    if (!IMPORT_DIFFICULTIES.includes(diff)) {
      errors.push(`difficulty_level "${get("difficulty_level")}" must be one of ${IMPORT_DIFFICULTIES.join(", ")}.`);
    } else {
      payload.difficulty_level = diff;
    }
  } else if (action === "insert") {
    payload.difficulty_level = "medium";
    warnings.push("difficulty_level was blank — defaulted to medium.");
  }

  // correct_answer
  const choiceTexts = Object.fromEntries(CHOICE_LETTERS.map(l => [l, has(`choice_${l}`) ? get(`choice_${l}`) : ""]));
  if (filled("correct_answer")) {
    const { letter, note } = resolveAnswerLetter(get("correct_answer"), choiceTexts);
    if (!letter) {
      errors.push(`correct_answer "${get("correct_answer")}" must be a single letter A-E (or match one choice exactly).`);
    } else {
      if (note) warnings.push(note);
      payload.correct_answer = letter;
      // Only checkable when that choice column is in the file; on a partial
      // update the choice lives in the database, not the sheet.
      if (has(`choice_${letter}`) && choiceTexts[letter] === "") {
        errors.push(`correct_answer is ${letter.toUpperCase()} but choice_${letter} is empty.`);
      }
    }
  }

  // Duplicate choice text is nearly always a copy-paste slip.
  const seenChoice = new Map();
  CHOICE_LETTERS.forEach(l => {
    const value = choiceTexts[l].toLowerCase().replace(/\s+/g, " ");
    if (!value) return;
    if (seenChoice.has(value)) {
      warnings.push(`choice_${seenChoice.get(value)} and choice_${l} have the same text.`);
    } else {
      seenChoice.set(value, l);
    }
  });

  // source_school is CHECK-constrained in the database, so a typo here would
  // otherwise come back as an opaque 23514 that fails the whole insert chunk.
  if (filled("source_school")) {
    const given = get("source_school");
    const match = IMPORT_SOURCE_SCHOOLS.find(s => s.toLowerCase() === given.toLowerCase());
    if (!match) {
      errors.push(`source_school "${given}" must be one of ${IMPORT_SOURCE_SCHOOLS.join(", ")}.`);
    } else {
      payload.source_school = match;
      if (match !== given) warnings.push(`source_school "${given}" read as "${match}".`);
    }
  } else if (action === "insert") {
    errors.push(`source_school is required for a new question — one of ${IMPORT_SOURCE_SCHOOLS.join(", ")}.`);
  }

  // status
  if (filled("status")) {
    const status = get("status").toLowerCase();
    if (!IMPORT_STATUSES.includes(status)) {
      errors.push(`status "${get("status")}" must be one of ${IMPORT_STATUSES.join(", ")}.`);
    } else if (action === "insert" && forceDraft && status !== "draft") {
      payload.status = "draft";
      warnings.push(`status "${status}" ignored — new questions land as draft for review.`);
    } else {
      payload.status = status;
    }
  } else if (action === "insert") {
    payload.status = "draft";
  }

  // svg_content — rendered into the page, so it goes through the same gate as
  // AI-generated SVG.
  if (has("svg_content")) {
    const svg = get("svg_content");
    if (svg === "") {
      if (action === "insert") payload.svg_content = null;
    } else if (!svgLooksSafe(svg)) {
      errors.push("svg_content failed the SVG safety check (must be a bare <svg>...</svg> with no script, href, or event handlers).");
    } else {
      payload.svg_content = svg;
    }
  }

  // Passage linkage: an explicit id wins; otherwise passage text creates or
  // reuses a stimulus at commit time.
  let stimulus = null;
  if (filled("stimulus_id")) {
    const stimulusId = get("stimulus_id");
    if (!UUID_RE.test(stimulusId)) {
      errors.push(`stimulus_id "${stimulusId}" is not a UUID.`);
    } else {
      payload.stimulus_id = stimulusId;
      if (filled("stimulus_text")) {
        warnings.push("Both stimulus_id and stimulus_text are set — the existing passage (stimulus_id) is used.");
      }
    }
  } else if (filled("stimulus_text")) {
    const stimulusTitle = filled("stimulus_title") ? get("stimulus_title") : null;
    stimulus = {
      stimulus_group_key: filled("stimulus_group_key")
        ? get("stimulus_group_key")
        : deriveStimulusGroupKey(stimulusTitle, get("stimulus_text")),
      stimulus_title: stimulusTitle,
      stimulus_type: filled("stimulus_type") ? get("stimulus_type") : "reading_passage",
      stimulus_text: get("stimulus_text"),
    };
  }

  // Taxonomy: a warning, not an error — the bank genuinely allows new
  // subjects/topics, and CategoryManager is where they get blessed.
  if (payload.subject && knownSubjects.length && !knownSubjects.includes(payload.subject)) {
    warnings.push(`subject "${payload.subject}" is new to the bank.`);
  }
  if (payload.topic && knownTopics.length && !knownTopics.includes(payload.topic)) {
    warnings.push(`topic "${payload.topic}" is new to the bank.`);
  }
  if (payload.subtopic && knownSubtopics.length && !knownSubtopics.includes(payload.subtopic)) {
    warnings.push(`subtopic "${payload.subtopic}" is new to the bank.`);
  }

  // Same arithmetic check the AI upload path runs. It can only warn: the status
  // the generator uses for this (`needs_human_review`) is rejected by
  // questions_status_check, and a new row is a draft already — which a human has
  // to clear before students see it. On an update we would not touch status
  // anyway, since silently flipping a live question would pull it out of exams
  // as a side effect of an unrelated edit.
  const math = validateMathItem({
    subject: payload.subject,
    question_text: payload.question_text,
    correct_answer: payload.correct_answer,
    ...Object.fromEntries(CHOICE_LETTERS.map(l => [`choice_${l}`, payload[`choice_${l}`]])),
  });
  if (math.checked && !math.valid) {
    warnings.push(`Math check: ${math.reason}`);
  }

  if (action === "update" && Object.keys(payload).length === 0 && !stimulus) {
    errors.push("Row has an id but no other values to update.");
  }

  return { row: rowNumber, action, id: id || null, payload, stimulus, errors, warnings };
}

// ───────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────

export function prepareQuestionImport(text, opts = {}) {
  const delimiter = opts.delimiter || detectDelimiter(text);
  const table = parseDelimited(text, delimiter).filter(cells => cells.some(c => cleanCell(c) !== ""));

  if (!table.length) {
    return { ok: false, fatal: "The file is empty.", delimiter, rows: [], unknownHeaders: [], summary: emptySummary() };
  }

  const headerCells = table[0];
  const fields = headerCells.map(headerToField);
  const unknownHeaders = headerCells.filter((cell, i) => !fields[i] && cleanCell(cell) !== "");

  const present = new Set(fields.filter(Boolean));
  if (!present.size) {
    return {
      ok: false,
      fatal: `No recognized columns in the header row. Expected at least some of: ${QUESTION_IMPORT_FIELDS.join(", ")}.`,
      delimiter, rows: [], unknownHeaders, summary: emptySummary(),
    };
  }

  const duplicated = [...new Set(fields.filter((f, i) => f && fields.indexOf(f) !== i))];
  if (duplicated.length) {
    return {
      ok: false,
      fatal: duplicated.length > 1
        ? `Columns ${duplicated.join(", ")} appear more than once in the header row.`
        : `Column ${duplicated[0]} appears more than once in the header row.`,
      delimiter, rows: [], unknownHeaders, summary: emptySummary(),
    };
  }

  const dataRows = table.slice(1);
  if (!dataRows.length) {
    return {
      ok: false, fatal: "The file has a header row but no question rows.",
      delimiter, rows: [], unknownHeaders, summary: emptySummary(),
    };
  }

  const rows = dataRows.map((cells, index) => {
    const record = {};
    fields.forEach((field, i) => { if (field) record[field] = cells[i]; });
    return validateRow(record, index + 1, present, opts);
  });

  // Cross-row checks.
  const seenIds = new Map();
  const seenStems = new Map();
  rows.forEach(r => {
    if (r.id) {
      if (seenIds.has(r.id)) r.errors.push(`id ${r.id} also appears on row ${seenIds.get(r.id)}.`);
      else seenIds.set(r.id, r.row);
    }
    const stem = (r.payload.question_text || "").toLowerCase().replace(/\s+/g, " ");
    if (!stem) return;
    if (seenStems.has(stem)) r.warnings.push(`Same question text as row ${seenStems.get(stem)}.`);
    else seenStems.set(stem, r.row);
  });

  return {
    ok: true, fatal: null, delimiter,
    headerFields: [...present], unknownHeaders, rows,
    summary: summarizeImport(rows),
  };
}

function emptySummary() {
  return { total: 0, inserts: 0, updates: 0, blocked: 0, ready: 0, withWarnings: 0 };
}

export function summarizeImport(rows) {
  const valid = rows.filter(r => !r.errors.length);
  return {
    total: rows.length,
    inserts: valid.filter(r => r.action === "insert").length,
    updates: valid.filter(r => r.action === "update").length,
    blocked: rows.length - valid.length,
    ready: valid.length,
    withWarnings: valid.filter(r => r.warnings.length).length,
  };
}

// A blank sheet with the exact headers the importer reads, for operators who
// would rather start from a template than from an export.
export function importTemplateCsv() {
  const columns = [
    "id", "subject", "topic", "subtopic", "difficulty_level", "status", "source_school",
    "question_text", "choice_a", "choice_b", "choice_c", "choice_d", "correct_answer",
    "stimulus_id", "stimulus_title", "stimulus_type", "stimulus_text",
  ];
  const example = [
    "", "Mathematics", "Algebra", "Linear Equations", "medium", "draft", "UPCAT",
    "If 3x + 6 = 21, what is the value of x?", "3", "5", "7", "9", "b",
    "", "", "", "",
  ];
  const quote = v => `"${String(v).replace(/"/g, '""')}"`;
  return `\uFEFF${columns.map(quote).join(",")}\r\n${example.map(quote).join(",")}\r\n`;
}

// ═══════════════════════════════════════════════════════════════
// COMMIT — the only part of the importer that writes
// ═══════════════════════════════════════════════════════════════
// Takes the rows `prepareQuestionImport` approved and sends them to PostgREST.
// `rest` is the REST base URL, `headers` the already-built auth headers. Errors
// are collected per chunk/row instead of thrown, so one bad row cannot silently
// discard the rest of a 2,000-row file.

export async function commitQuestionImport(rows, { rest, headers, chunkSize = 200 } = {}) {
  const ready = rows.filter(r => !r.errors.length);
  const log = [];
  let inserted = 0;
  let updated = 0;
  let failed = 0;
  const createdStimulusIds = [];
  const insertedIds = [];

  try {
    // Passages first. Rows whose passage text matches share one stimulus — the
    // same de-dupe the AI upload path uses — so a 10-question passage set does
    // not create 10 copies of the passage.
    const stimulusCache = new Map();
    for (const r of ready) {
      if (!r.stimulus) continue;
      const key = [r.stimulus.stimulus_group_key, r.stimulus.stimulus_title || "", r.stimulus.stimulus_type, r.stimulus.stimulus_text].join("|||");
      if (!stimulusCache.has(key)) {
        const res = await fetch(`${rest}/stimuli`, {
          method: "POST",
          headers: { ...headers, Prefer: "return=representation" },
          body: JSON.stringify(r.stimulus),
        });
        if (!res.ok) throw new Error(`Passage insert failed: ${await res.text()}`);
        const created = await res.json();
        const stimulusId = Array.isArray(created) ? created[0]?.id : created?.id;
        if (!stimulusId) throw new Error("Passage insert did not return an id.");
        stimulusCache.set(key, stimulusId);
        createdStimulusIds.push(stimulusId);
      }
      r.payload.stimulus_id = stimulusCache.get(key);
    }
    if (stimulusCache.size) {
      log.push(`Created ${stimulusCache.size} passage${stimulusCache.size === 1 ? "" : "s"}.`);
    }

    // Inserts go up in chunks rather than as one giant array, so a failure names
    // the rows it took down instead of failing the whole file opaquely.
    const inserts = ready.filter(r => r.action === "insert");

    // PostgREST rejects a bulk insert whose objects do not all carry the same
    // keys ("All object keys must match"), and rows legitimately differ — only
    // passage rows gain a stimulus_id, for instance. Pad every row out to the
    // union of keys, with null for the ones it does not set.
    const insertKeys = [...new Set(inserts.flatMap(r => Object.keys(r.payload)))];
    const squared = payload => Object.fromEntries(insertKeys.map(k => [k, payload[k] ?? null]));

    for (let i = 0; i < inserts.length; i += chunkSize) {
      const chunk = inserts.slice(i, i + chunkSize);
      const res = await fetch(`${rest}/questions`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify(chunk.map(r => squared(r.payload))),
      });
      if (res.ok) {
        inserted += chunk.length;
        const created = await res.json();
        if (Array.isArray(created)) created.forEach(q => { if (q?.id) insertedIds.push(q.id); });
      } else {
        failed += chunk.length;
        log.push(`Rows ${chunk[0].row}-${chunk[chunk.length - 1].row} were not created: ${await res.text()}`);
      }
    }

    // One PATCH per update — PostgREST cannot carry different values for
    // different ids in a single request. return=representation so a valid-but-
    // unknown id is reported instead of silently matching nothing.
    for (const r of ready.filter(row => row.action === "update")) {
      const res = await fetch(`${rest}/questions?id=eq.${encodeURIComponent(r.id)}`, {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify(r.payload),
      });
      if (!res.ok) {
        failed++;
        log.push(`Row ${r.row} (${r.id}) was not updated: ${await res.text()}`);
        continue;
      }
      const touched = await res.json();
      if (Array.isArray(touched) && touched.length === 0) {
        failed++;
        log.push(`Row ${r.row}: no question in the bank has id ${r.id}.`);
      } else {
        updated++;
      }
    }
  } catch (e) {
    // A throw here means the run aborted early (a passage insert failed, the
    // network dropped). Everything not yet written is a failure, not a silent
    // zero — otherwise the UI would report "0 created, 0 failed".
    log.push(`Import stopped: ${e.message}`);
    failed += Math.max(0, ready.length - inserted - updated - failed);
  }

  return { inserted, updated, failed, log, insertedIds, createdStimulusIds };
}
