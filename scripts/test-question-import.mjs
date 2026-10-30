// Tests for the bulk CSV question importer (src/questionImport.js).
// Run with: npm run test:import  (or npm test, which includes it)

import assert from "node:assert/strict";
import {
  parseDelimited,
  detectDelimiter,
  headerToField,
  prepareQuestionImport,
  importTemplateCsv,
  deriveStimulusGroupKey,
} from "../src/questionImport.js";

let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  process.stdout.write(`  ok  ${name}\n`);
}

const BOM = "﻿";
const HEAD = "id,subject,topic,subtopic,difficulty_level,status,correct_answer,question_text,choice_a,choice_b,choice_c,choice_d,source_school";
const q = v => `"${String(v).replace(/"/g, '""')}"`;
const row = cells => cells.map(q).join(",");
const csv = (...dataRows) => `${BOM}${HEAD}\r\n${dataRows.join("\r\n")}\r\n`;
const GOOD = ["", "Mathematics", "Algebra", "Linear Equations", "easy", "draft", "b", "If 3x + 6 = 21, what is x?", "3", "5", "7", "9", "UPCAT"];
// A syntactically valid question UUID — a filled id is what makes a row an update.
const ID = "3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607";

// ───────────────────────────────────────────────────────────────
// Parser
// ───────────────────────────────────────────────────────────────

check("parses quoted fields, embedded commas, quotes and newlines", () => {
  const text = `a,b,c\r\n"one, two","he said ""hi""","line1\nline2"\r\n`;
  const table = parseDelimited(text);
  assert.deepEqual(table[0], ["a", "b", "c"]);
  assert.deepEqual(table[1], ["one, two", 'he said "hi"', "line1\nline2"]);
  assert.equal(table.length, 2, "trailing CRLF must not create a phantom row");
});

check("strips the UTF-8 BOM the export writes", () => {
  assert.deepEqual(parseDelimited(`${BOM}id,subject\r\nx,y\r\n`)[0], ["id", "subject"]);
});

check("keeps empty trailing fields", () => {
  assert.deepEqual(parseDelimited("a,b,c\r\n1,,\r\n")[1], ["1", "", ""]);
});

check("detects tab- and semicolon-separated files", () => {
  assert.equal(detectDelimiter("id\tsubject\ttopic\nx\ty\tz"), "\t");
  assert.equal(detectDelimiter("id;subject;topic"), ";");
  assert.equal(detectDelimiter("id,subject,topic"), ",");
  assert.equal(detectDelimiter("onlyonecolumn"), ",");
});

check("header matching is case/space/alias tolerant", () => {
  assert.equal(headerToField("Question Text"), "question_text");
  assert.equal(headerToField("  DIFFICULTY  "), "difficulty_level");
  assert.equal(headerToField("Answer Key"), "correct_answer");
  assert.equal(headerToField("Option A"), "choice_a");
  assert.equal(headerToField("Passage"), "stimulus_text");
  assert.equal(headerToField("notacolumn"), null);
});

// ───────────────────────────────────────────────────────────────
// Insert path
// ───────────────────────────────────────────────────────────────

check("a clean row becomes a draft insert", () => {
  const result = prepareQuestionImport(csv(row(GOOD)));
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, { total: 1, inserts: 1, updates: 0, blocked: 0, ready: 1, withWarnings: 0 });
  const [r] = result.rows;
  assert.equal(r.action, "insert");
  assert.equal(r.id, null);
  assert.equal(r.payload.status, "draft");
  assert.equal(r.payload.difficulty_level, "easy");
  assert.equal(r.payload.correct_answer, "b");
  assert.equal(r.payload.subject, "Mathematics");
  assert.equal(r.stimulus, null);
});

check("missing required columns block the row", () => {
  const bad = [...GOOD];
  bad[1] = "";  // subject
  bad[8] = "";  // choice_a
  const [r] = prepareQuestionImport(csv(row(bad))).rows;
  assert.equal(r.errors.length, 2);
  assert.match(r.errors.join(" "), /subject is required/);
  assert.match(r.errors.join(" "), /choice_a is required/);
});

check("a new row cannot be published straight to active", () => {
  const sneaky = [...GOOD];
  sneaky[5] = "active";
  const [r] = prepareQuestionImport(csv(row(sneaky))).rows;
  assert.equal(r.payload.status, "draft");
  assert.match(r.warnings.join(" "), /land as draft/);
  // ...unless the operator explicitly turns the guard off.
  const [loose] = prepareQuestionImport(csv(row(sneaky)), { forceDraft: false }).rows;
  assert.equal(loose.payload.status, "active");
});

check("blank difficulty defaults to medium with a warning", () => {
  const noDiff = [...GOOD];
  noDiff[4] = "";
  const [r] = prepareQuestionImport(csv(row(noDiff))).rows;
  assert.equal(r.payload.difficulty_level, "medium");
  assert.match(r.warnings.join(" "), /defaulted to medium/);
});

check("bad difficulty and bad status are errors, not silent coercions", () => {
  const bad = [...GOOD];
  bad[4] = "very hard";
  bad[5] = "published";
  const [r] = prepareQuestionImport(csv(row(bad))).rows;
  assert.equal(r.errors.length, 2);
  assert.match(r.errors.join(" "), /difficulty_level "very hard"/);
  assert.match(r.errors.join(" "), /status "published"/);
});

check("correct_answer accepts A/a/(A) and rejects junk", () => {
  for (const given of ["A", "a", "(A)", "A."]) {
    const v = [...GOOD]; v[6] = given;
    const [r] = prepareQuestionImport(csv(row(v))).rows;
    assert.deepEqual(r.errors, [], `${given} should be accepted`);
    assert.equal(r.payload.correct_answer, "a");
  }
  const junk = [...GOOD]; junk[6] = "none of these";
  const [bad] = prepareQuestionImport(csv(row(junk))).rows;
  assert.match(bad.errors.join(" "), /must be a single letter A-E/);
});

check("correct_answer given as the answer text is recovered", () => {
  const v = [...GOOD]; v[6] = "7";  // choice_c
  const [r] = prepareQuestionImport(csv(row(v))).rows;
  assert.deepEqual(r.errors, []);
  assert.equal(r.payload.correct_answer, "c");
  assert.match(r.warnings.join(" "), /matched choice C by text/);
});

check("an answer letter pointing at an empty choice is blocked", () => {
  const head = "subject,topic,source_school,question_text,choice_a,choice_b,choice_c,choice_d,correct_answer";
  const text = `${head}\r\n${row(["Science", "Biology", "UPCAT", "Stem?", "x", "y", "z", "", "d"])}\r\n`;
  const [r] = prepareQuestionImport(text).rows;
  assert.match(r.errors.join(" "), /correct_answer is D but choice_d is empty/);
});

check("duplicate choice text warns", () => {
  const dup = [...GOOD]; dup[10] = "5";  // choice_c same as choice_b
  const [r] = prepareQuestionImport(csv(row(dup))).rows;
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings.join(" "), /choice_b and choice_c have the same text/);
});

check("non-breaking spaces from spreadsheets count as blank", () => {
  const nbsp = [...GOOD]; nbsp[3] = " ";
  const [r] = prepareQuestionImport(csv(row(nbsp))).rows;
  assert.deepEqual(r.errors, []);
  // questions.subtopic is NOT NULL, so "no subtopic" is the empty string.
  assert.equal(r.payload.subtopic, "");
});

check("a new question always carries a subtopic, even when the column is absent", () => {
  const head = "subject,topic,question_text,choice_a,choice_b,choice_c,choice_d,correct_answer";
  const text = `${head}
${row(["Science", "Biology", "Stem?", "w", "x", "y", "z", "a"])}
`;
  assert.equal(prepareQuestionImport(text).rows[0].payload.subtopic, "");
  // An update must not invent one — that would overwrite a stored subtopic.
  const upd = `id,difficulty_level
${row([ID, "hard"])}
`;
  assert.equal(prepareQuestionImport(upd).rows[0].payload.subtopic, undefined);
});

check("source_school is checked against the database constraint", () => {
  const head = "subject,topic,question_text,choice_a,choice_b,choice_c,choice_d,correct_answer,source_school";
  const base = ["Science", "Biology", "Stem?", "w", "x", "y", "z", "a"];
  const make = school => `${head}\r\n${row([...base, school])}\r\n`;

  const [ok] = prepareQuestionImport(make("ACET")).rows;
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.payload.source_school, "ACET");

  // Case is forgiven — the canonical spelling is what gets stored.
  const [loose] = prepareQuestionImport(make("ai generated")).rows;
  assert.deepEqual(loose.errors, []);
  assert.equal(loose.payload.source_school, "AI Generated");
  assert.match(loose.warnings.join(" "), /read as "AI Generated"/);

  // Anything else would come back from Postgres as an opaque 23514.
  const [bad] = prepareQuestionImport(make("Manual Upload")).rows;
  assert.match(bad.errors.join(" "), /source_school "Manual Upload" must be one of/);

  // Blank is NOT allowed on a new question: questions.source_school is NOT NULL,
  // even though its CHECK constraint would accept a null.
  const [blank] = prepareQuestionImport(make("")).rows;
  assert.match(blank.errors.join(" "), /source_school is required/);
});

check("math answer-key check warns on a provably wrong key", () => {
  const head = "subject,topic,source_school,question_text,choice_a,choice_b,choice_c,choice_d,correct_answer";
  const text = `${head}\r\n${row(["Mathematics", "Logarithms", "UPCAT", "If log_2 x = 3, what is x?", "6", "8", "9", "16", "a"])}\r\n`;
  const [r] = prepareQuestionImport(text).rows;
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings.join(" "), /Math check/);
  // It stays a draft: questions_status_check rejects needs_human_review.
  assert.equal(r.payload.status, "draft");
});

check("a new question must declare provenance, because source_school is NOT NULL", () => {
  const head = "subject,topic,question_text,choice_a,choice_b,choice_c,choice_d,correct_answer";
  const text = `${head}\r\n${row(["Science", "Biology", "Stem?", "w", "x", "y", "z", "a"])}\r\n`;
  assert.match(prepareQuestionImport(text).rows[0].errors.join(" "), /source_school is required/);
  // An update never needs it.
  const upd = `id,difficulty_level\r\n${row([ID, "hard"])}\r\n`;
  assert.deepEqual(prepareQuestionImport(upd).rows[0].errors, []);
});

// ───────────────────────────────────────────────────────────────
// Update path
// ───────────────────────────────────────────────────────────────

check("a filled id becomes an update", () => {
  const upd = [...GOOD]; upd[0] = ID;
  const [r] = prepareQuestionImport(csv(row(upd))).rows;
  assert.equal(r.action, "update");
  assert.equal(r.id, ID);
  assert.equal(r.payload.id, undefined, "id travels in the URL, not the patch body");
  const result = prepareQuestionImport(csv(row(upd))).summary;
  assert.equal(result.updates, 1);
  assert.equal(result.inserts, 0);
});

check("an update only patches the columns present in the header", () => {
  const text = `id,difficulty_level\r\n${row([ID, "hard"])}\r\n`;
  const [r] = prepareQuestionImport(text).rows;
  assert.deepEqual(Object.keys(r.payload), ["difficulty_level"]);
  assert.equal(r.payload.difficulty_level, "hard");
});

check("an empty cell on an update never wipes a stored value", () => {
  const text = `id,subject,subtopic,question_text\r\n${row([ID, "", "", "New stem"])}\r\n`;
  const [r] = prepareQuestionImport(text).rows;
  assert.deepEqual(r.payload, { question_text: "New stem" });
});

check("an update with nothing to change is blocked", () => {
  const text = `id,subtopic\r\n${row([ID, ""])}\r\n`;
  const [r] = prepareQuestionImport(text).rows;
  assert.match(r.errors.join(" "), /no other values to update/);
});

check("a malformed id is an error, not a silent insert", () => {
  const bad = [...GOOD]; bad[0] = "12345";
  const [r] = prepareQuestionImport(csv(row(bad))).rows;
  assert.match(r.errors.join(" "), /is not a question UUID/);
});

check("the same id twice in one file is blocked on the second row", () => {
  const a = [...GOOD]; a[0] = ID;
  const b = [...GOOD]; b[0] = ID;
  const { rows } = prepareQuestionImport(csv(row(a), row(b)));
  assert.deepEqual(rows[0].errors, []);
  assert.match(rows[1].errors.join(" "), /also appears on row 1/);
});

check("a repeated stem across rows warns", () => {
  const { rows } = prepareQuestionImport(csv(row(GOOD), row(GOOD)));
  assert.deepEqual(rows[1].errors, []);
  assert.match(rows[1].warnings.join(" "), /Same question text as row 1/);
});

check("a math update only warns — it never pulls a live question from exams", () => {
  const head = "id,subject,question_text,choice_a,choice_b,choice_c,choice_d,correct_answer";
  const text = `${head}\r\n${row([ID, "Mathematics", "If log_2 x = 3, what is x?", "6", "8", "9", "16", "a"])}\r\n`;
  const [r] = prepareQuestionImport(text).rows;
  assert.match(r.warnings.join(" "), /Math check/);
  assert.equal(r.payload.status, undefined);
});

// ───────────────────────────────────────────────────────────────
// Passages, SVG, taxonomy
// ───────────────────────────────────────────────────────────────

check("passage text produces a stimulus to create", () => {
  const head = "subject,topic,source_school,question_text,choice_a,choice_b,choice_c,choice_d,correct_answer,stimulus_title,stimulus_text";
  const text = `${head}\r\n${row(["Reading", "Comprehension", "UPCAT", "What is the tone?", "w", "x", "y", "z", "a", "The Garden", "Line one\nLine two"])}\r\n`;
  const [r] = prepareQuestionImport(text).rows;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.stimulus, {
    // stimuli.stimulus_group_key is NOT NULL, so one is always derived.
    stimulus_group_key: "IMPORT_THE_GARDEN",
    stimulus_title: "The Garden",
    stimulus_type: "reading_passage",
    stimulus_text: "Line one\nLine two",
  });
});

check("a passage group key is derived, or taken from the sheet when given", () => {
  assert.equal(deriveStimulusGroupKey("Why Go by Sea?", ""), "IMPORT_WHY_GO_BY_SEA");
  assert.equal(deriveStimulusGroupKey("", "Ang mga ugat ng kabataan ay nasa pamilya at paaralan."),
    "IMPORT_ANG_MGA_UGAT_NG_KABATAAN_AY_NASA_PAMILYA");
  assert.equal(deriveStimulusGroupKey("", ""), "IMPORT_PASSAGE");
  assert.equal(deriveStimulusGroupKey("!!!", ""), "IMPORT_PASSAGE");

  const head = "subject,topic,source_school,question_text,choice_a,choice_b,choice_c,choice_d,correct_answer,stimulus_group_key,stimulus_text";
  const text = `${head}\r\n${row(["Reading", "Comprehension", "UPCAT", "Tone?", "w", "x", "y", "z", "a", "UPCAT_READ_P9_V1", "A passage."])}\r\n`;
  assert.equal(prepareQuestionImport(text).rows[0].stimulus.stimulus_group_key, "UPCAT_READ_P9_V1");
});

check("an existing stimulus_id wins over inline passage text", () => {
  const head = "subject,topic,source_school,question_text,choice_a,choice_b,choice_c,choice_d,correct_answer,stimulus_id,stimulus_text";
  const text = `${head}\r\n${row(["Reading", "Comprehension", "UPCAT", "Tone?", "w", "x", "y", "z", "a", ID, "ignored"])}\r\n`;
  const [r] = prepareQuestionImport(text).rows;
  assert.equal(r.stimulus, null);
  assert.equal(r.payload.stimulus_id, ID);
  assert.match(r.warnings.join(" "), /existing passage \(stimulus_id\) is used/);
});

check("unsafe inline SVG is blocked", () => {
  const head = "subject,topic,source_school,question_text,choice_a,choice_b,choice_c,choice_d,correct_answer,svg_content";
  const safe = `${head}\r\n${row(["Science", "Physics", "UPCAT", "Read the graph.", "w", "x", "y", "z", "a", "<svg viewBox=\"0 0 10 10\"><rect width=\"4\" height=\"4\"/></svg>"])}\r\n`;
  assert.deepEqual(prepareQuestionImport(safe).rows[0].errors, []);
  const evil = `${head}\r\n${row(["Science", "Physics", "UPCAT", "Read the graph.", "w", "x", "y", "z", "a", "<svg onload=\"alert(1)\"></svg>"])}\r\n`;
  assert.match(prepareQuestionImport(evil).rows[0].errors.join(" "), /SVG safety check/);
});

check("unknown taxonomy warns but does not block", () => {
  const [r] = prepareQuestionImport(csv(row(GOOD)), {
    knownSubjects: ["Science"], knownTopics: ["Biology"], knownSubtopics: ["Cells"],
  }).rows;
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.filter(w => /is new to the bank/.test(w)).length, 3);
});

// ───────────────────────────────────────────────────────────────
// File-level failures
// ───────────────────────────────────────────────────────────────

check("empty file, header-only file, and junk headers fail loudly", () => {
  assert.match(prepareQuestionImport("").fatal, /empty/);
  assert.match(prepareQuestionImport(csv()).fatal, /no question rows/);
  assert.match(prepareQuestionImport("foo,bar\r\n1,2\r\n").fatal, /No recognized columns/);
});

check("a duplicated column in the header fails the whole file", () => {
  assert.match(prepareQuestionImport("subject,subject\r\nx,y\r\n").fatal, /appears more than once/);
});

check("unknown extra columns are reported and ignored", () => {
  const text = `subject,topic,source_school,question_text,choice_a,choice_b,choice_c,choice_d,correct_answer,reviewer_notes\r\n${row(["Science", "Biology", "UPCAT", "Stem?", "w", "x", "y", "z", "a", "looks fine"])}\r\n`;
  const result = prepareQuestionImport(text);
  assert.deepEqual(result.unknownHeaders, ["reviewer_notes"]);
  assert.deepEqual(result.rows[0].errors, []);
  assert.equal(result.rows[0].payload.reviewer_notes, undefined);
});

check("blank spacer rows between questions are skipped", () => {
  const text = `${BOM}${HEAD}\r\n${row(GOOD)}\r\n,,,,,,,,,,,,\r\n${row(GOOD)}\r\n`;
  assert.equal(prepareQuestionImport(text).summary.total, 2);
});

check("a tab-separated sheet pasted from Excel works", () => {
  const tabbed = `${HEAD.replace(/,/g, "\t")}\n${GOOD.join("\t")}\n`;
  const result = prepareQuestionImport(tabbed);
  assert.equal(result.delimiter, "\t");
  assert.equal(result.summary.inserts, 1);
});

check("the generated template is itself a valid import", () => {
  const result = prepareQuestionImport(importTemplateCsv());
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows[0].errors, []);
  assert.equal(result.summary.inserts, 1);
});

check("a mixed file reports inserts, updates and blocked rows separately", () => {
  const insert = [...GOOD];
  const update = [...GOOD]; update[0] = ID; update[7] = "A different stem, so no duplicate warning.";
  const blocked = [...GOOD]; blocked[6] = "zzz";
  const { summary } = prepareQuestionImport(csv(row(insert), row(update), row(blocked)));
  assert.deepEqual(summary, { total: 3, inserts: 1, updates: 1, blocked: 1, ready: 2, withWarnings: 0 });
});

console.log(`\nPassed ${checks} question import tests.`);
