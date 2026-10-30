// AI generation + verification for diagnostic questions.
//
// The public functions in this file are shared by student practice top-ups and
// the teacher-facing AI generator. A generated item is accepted only after
// deterministic linting plus a blind solver check.

import { PROMPT_RULES } from "../_shared/prompt-rules.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-6";

export interface ExampleQuestion {
  question_text: string;
  choice_a: string;
  choice_b: string;
  choice_c: string;
  choice_d: string;
  choice_e: string | null;
  correct_answer: string;
  difficulty_level: string;
  svg_content?: string | null;
  stimulus_id?: string | null;
  stimulus_title?: string | null;
  stimulus_type?: string | null;
  stimulus_text?: string | null;
}

export interface VerifiedQuestion {
  question_text: string;
  choice_a: string;
  choice_b: string;
  choice_c: string;
  choice_d: string;
  correct_answer: string;
  difficulty_level: string;
  svg_content?: string | null;
  stimulus_id?: string | null;
  stimulus_title?: string | null;
  stimulus_type?: string | null;
  stimulus_text?: string | null;
}

interface Candidate extends VerifiedQuestion {
  explanation?: string;
}

const LETTERS = ["a", "b", "c", "d"] as const;

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function protectChordRendering(text?: string | null): string | null {
  if (text === null || text === undefined) return null;
  return String(text).replace(/\bchord(s?)\b/gi, (_match, plural) => `cho\u2060rd${plural || ""}`);
}

function sanitiseCandidate(c: Candidate): Candidate {
  return {
    ...c,
    question_text: protectChordRendering(c.question_text) || "",
    choice_a: protectChordRendering(c.choice_a) || "",
    choice_b: protectChordRendering(c.choice_b) || "",
    choice_c: protectChordRendering(c.choice_c) || "",
    choice_d: protectChordRendering(c.choice_d) || "",
    svg_content: protectChordRendering(c.svg_content),
    stimulus_title: protectChordRendering(c.stimulus_title),
    stimulus_text: protectChordRendering(c.stimulus_text),
  };
}

function isReadingSubject(subject: string): boolean {
  return subject.trim().toLowerCase() === "reading";
}

function visualIsRelevant(subject: string, topic: string, subtopic: string): boolean {
  return /math|science|logic|abstract/i.test(subject) ||
    /geometry|trig|graph|diagram|data|integral|function|density|force|motion|wave|table/i.test(`${topic} ${subtopic}`);
}

async function callAnthropic(
  apiKey: string,
  toolName: string,
  inputSchema: Record<string, unknown>,
  systemPrompt: string,
  userPrompt: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      tools: [{ name: toolName, description: `Return results via ${toolName}.`, input_schema: inputSchema }],
      tool_choice: { type: "tool", name: toolName },
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    console.error("anthropic error:", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const block = (data.content ?? []).find((b: { type: string }) => b.type === "tool_use");
  return block?.input ?? null;
}

function exampleBlock(examples: ExampleQuestion[]): string {
  return examples
    .map((e, i) => {
      const stimulus = e.stimulus_text
        ? `Passage id: ${e.stimulus_id || ""}\nPassage title: ${e.stimulus_title || ""}\nPassage type: ${e.stimulus_type || "reading_passage"}\nPassage:\n${e.stimulus_text}\n`
        : "";
      const svg = e.svg_content
        ? `SVG example:\n${e.svg_content.slice(0, 1800)}${e.svg_content.length > 1800 ? "\n[SVG truncated]" : ""}\n`
        : "";
      return `Example ${i + 1} (${e.difficulty_level}):\n` +
        stimulus +
        svg +
        `Q: ${e.question_text}\n` +
        `a) ${e.choice_a}\nb) ${e.choice_b}\nc) ${e.choice_c}\nd) ${e.choice_d}\n` +
        `Correct: ${e.correct_answer}`;
    })
    .join("\n\n");
}

function baseSystemPrompt(subject: string, topic: string, subtopic: string): string {
  const reading = isReadingSubject(subject);
  const visual = visualIsRelevant(subject, topic, subtopic);
  return (
    `You are an expert assessment item writer for ${subject}. Write entrance-exam-quality four-option multiple-choice questions with exactly one defensible correct answer.\n\n` +
    `Exact alignment is mandatory: every item must directly test Subject: ${subject}; Topic: ${topic}; Subtopic: ${subtopic}. Do not drift into neighboring topics.\n\n` +
    `Difficulty calibration is strict. Easy = one direct move. Medium = two steps, interpretation, or method choice. Hard = three or more steps, deeper inference, a system, or a non-obvious technique. Do not label direct substitution, simple recall, or a one-formula plug-in as hard.\n\n` +
    `Distractors must be plausible and diagnostic. For hard questions, wrong choices must reflect realistic high-level mistakes: using the wrong intermediate result, reversing a relationship, overgeneralizing evidence, choosing a partly true but incomplete claim, misapplying a valid method, or overlooking a condition. Avoid filler, joke answers, and all/none of the above.\n\n` +
    `Use only four choices a-d. Vary the correct answer position. Keep math in \\( ... \\) where appropriate.\n\n` +
    `${PROMPT_RULES}\n\n` +
    (reading
      ? `For Reading, use exactly one of the provided DB passages as the source passage. Copy its stimulus_id, stimulus_title, stimulus_type, and stimulus_text into every generated item that uses it. Do not invent a new passage. Questions must be answerable from that passage only. Difficulty must come from inference/evidence work, not obscure wording.\n\n`
      : "") +
    (visual
      ? `If a graph, table, geometric figure, or science diagram is genuinely useful, include svg_content. Follow the style of provided SVG examples: inline <svg>, white background, clear black strokes/text, readable labels, simple geometry, no scripts, no external images, no event handlers, and a viewBox. If the visual is unnecessary or you cannot make it clearly answerable, leave svg_content null.\n\n`
      : `Avoid visual-dependent items unless provided examples clearly support the format.\n\n`)
  );
}

function questionSchema() {
  return {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question_text: { type: "string" },
            choice_a: { type: "string" },
            choice_b: { type: "string" },
            choice_c: { type: "string" },
            choice_d: { type: "string" },
            correct_answer: { type: "string", enum: ["a", "b", "c", "d"] },
            difficulty_level: { type: "string", enum: ["easy", "medium", "hard"] },
            svg_content: { type: ["string", "null"] },
            stimulus_id: { type: ["string", "null"] },
            stimulus_title: { type: ["string", "null"] },
            stimulus_type: { type: ["string", "null"] },
            stimulus_text: { type: ["string", "null"] },
            explanation: { type: "string" },
          },
          required: ["question_text", "choice_a", "choice_b", "choice_c", "choice_d", "correct_answer", "difficulty_level"],
        },
      },
    },
    required: ["questions"],
  };
}

async function generateCandidates(
  apiKey: string,
  subject: string,
  topic: string,
  subtopic: string,
  examples: ExampleQuestion[],
  difficulties: string[],
  count: number,
  extraInstructions = "",
): Promise<Candidate[]> {
  const system = baseSystemPrompt(subject, topic, subtopic);
  const user =
    `Write ${count} NEW multiple-choice questions.\n\n` +
    `Allowed difficulty_level values: ${difficulties.join(", ")}.\n` +
    `${extraInstructions ? `Additional standards and batch plan:\n${extraInstructions}\n\n` : ""}` +
    `Match the rigor and data structure of these existing questions, but do not copy them:\n\n` +
    `${exampleBlock(examples)}\n\n` +
    `Before returning, check every item for exact topic/subtopic alignment, correct difficulty, one correct answer, plausible distractors, and renderable SVG/passages if present.`;

  const out = await callAnthropic(apiKey, "submit_questions", questionSchema(), system, user);
  const list = (out?.questions ?? []) as Candidate[];
  return Array.isArray(list) ? list.map(sanitiseCandidate) : [];
}

async function verifyCandidates(apiKey: string, candidates: Candidate[]): Promise<boolean[]> {
  const system =
    `You are a meticulous subject-matter expert grading multiple-choice questions. ` +
    `Solve each item independently using all provided passage or SVG context. Report the single best answer, whether exactly one option is correct, and confidence. ` +
    `Be strict: if an item is ambiguous, has multiple defensible answers, is not answerable from the passage/SVG, or has no correct answer, set single_correct = false.`;

  const qBlock = candidates
    .map((c, i) => {
      const stimulus = c.stimulus_text
        ? `Passage title: ${c.stimulus_title || ""}\nPassage:\n${c.stimulus_text}\n`
        : "";
      const svg = c.svg_content ? `SVG/visual:\n${c.svg_content}\n` : "";
      return `[${i}]\n${stimulus}${svg}Q: ${c.question_text}\n` +
        `a) ${c.choice_a}\nb) ${c.choice_b}\nc) ${c.choice_c}\nd) ${c.choice_d}`;
    })
    .join("\n\n");

  const schema = {
    type: "object",
    properties: {
      solutions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            chosen: { type: "string", enum: ["a", "b", "c", "d"] },
            single_correct: { type: "boolean" },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["index", "chosen", "single_correct", "confidence"],
        },
      },
    },
    required: ["solutions"],
  };

  const out = await callAnthropic(apiKey, "submit_solutions", schema, system, `Solve each question independently:\n\n${qBlock}`);
  const solutions = (out?.solutions ?? []) as {
    index: number;
    chosen: string;
    single_correct: boolean;
    confidence: string;
  }[];

  const verdict = new Array(candidates.length).fill(false);
  for (const s of solutions) {
    const cand = candidates[s.index];
    if (!cand) continue;
    verdict[s.index] =
      s.single_correct === true &&
      s.confidence !== "low" &&
      s.chosen === cand.correct_answer;
  }
  return verdict;
}

function validSvg(value?: string | null): boolean {
  if (!value) return true;
  const svg = value.trim();
  if (!svg.startsWith("<svg") || !svg.includes("</svg>")) return false;
  if (/script|foreignObject|<image|href=|onload=|onclick=|onerror=/i.test(svg)) return false;
  return true;
}

function passesLint(c: Candidate, existingNormalised: Set<string>, batchSeen: Set<string>): boolean {
  const choices = [c.choice_a, c.choice_b, c.choice_c, c.choice_d];
  if (choices.some((x) => !x || !x.trim())) return false;
  const distinct = new Set(choices.map((x) => normalise(x)));
  if (distinct.size !== 4) return false;
  if (!LETTERS.includes(c.correct_answer as typeof LETTERS[number])) return false;
  if (!c.question_text || !c.question_text.trim()) return false;
  const norm = normalise(c.question_text);
  if (norm.length < 10) return false;
  if (existingNormalised.has(norm) || batchSeen.has(norm)) return false;
  if (!validSvg(c.svg_content)) return false;
  if (c.stimulus_text && c.stimulus_text.trim().length < 250) return false;
  return true;
}

function toVerified(c: Candidate, difficulty: string): VerifiedQuestion {
  return {
    question_text: c.question_text.trim(),
    choice_a: c.choice_a.trim(),
    choice_b: c.choice_b.trim(),
    choice_c: c.choice_c.trim(),
    choice_d: c.choice_d.trim(),
    correct_answer: c.correct_answer,
    difficulty_level: difficulty,
    svg_content: c.svg_content?.trim() || null,
    stimulus_id: c.stimulus_id?.trim() || null,
    stimulus_title: c.stimulus_title?.trim() || null,
    stimulus_type: c.stimulus_type?.trim() || (c.stimulus_text ? "reading_passage" : null),
    stimulus_text: c.stimulus_text?.trim() || null,
  };
}

export async function generateVerifiedQuestions(opts: {
  apiKey: string;
  subject: string;
  topic: string;
  subtopic: string;
  examples: ExampleQuestion[];
  existingTexts: string[];
  count: number;
  difficultyPlan?: string[];
  extraInstructions?: string;
}): Promise<VerifiedQuestion[]> {
  const { apiKey, subject, topic, subtopic, examples, existingTexts, count } = opts;
  const planned = (opts.difficultyPlan ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
  const difficulties = [...new Set(planned.length ? planned : examples.map((e) => e.difficulty_level).filter(Boolean))];
  if (!difficulties.length) difficulties.push("medium");

  const target = Math.min(Math.max(count + 5, 8), 16);
  const planText = planned.length ? `Return this exact difficulty distribution if possible: ${planned.join(", ")}.` : "";
  const extraInstructions = [planText, opts.extraInstructions || ""].filter(Boolean).join("\n");
  const candidates = await generateCandidates(apiKey, subject, topic, subtopic, examples, difficulties, target, extraInstructions);
  if (!candidates.length) return [];

  const existingNormalised = new Set(existingTexts.map(normalise));
  const batchSeen = new Set<string>();
  const linted: Candidate[] = [];
  for (const c of candidates) {
    if (passesLint(c, existingNormalised, batchSeen)) {
      batchSeen.add(normalise(c.question_text));
      linted.push(c);
    }
  }
  if (!linted.length) return [];

  const verdicts = await verifyCandidates(apiKey, linted);
  const verified: VerifiedQuestion[] = [];
  for (let i = 0; i < linted.length; i++) {
    if (!verdicts[i]) continue;
    const c = linted[i];
    const difficulty = difficulties.includes(c.difficulty_level) ? c.difficulty_level : difficulties[0];
    verified.push(toVerified(c, difficulty));
  }
  return verified;
}

export async function generateVerifiedReadingQuestions(opts: {
  apiKey: string;
  subject?: string;
  topic: string;
  subtopic: string;
  passage: ExampleQuestion;
  examples: ExampleQuestion[];
  existingTexts: string[];
  count: number;
  difficultyPlan?: string[];
  extraInstructions?: string;
}): Promise<VerifiedQuestion[]> {
  const { apiKey, topic, subtopic, passage, examples, existingTexts, count } = opts;
  const subject = opts.subject || "Reading";
  if (!passage.stimulus_text) return [];

  const planned = (opts.difficultyPlan ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
  const difficulties = [...new Set(planned.length ? planned : examples.map((e) => e.difficulty_level).filter(Boolean))];
  if (!difficulties.length) difficulties.push("medium");

  const system =
    baseSystemPrompt(subject, topic, subtopic) +
    `Generate questions only for the provided passage. Do not rewrite the passage. ` +
    `Return question_text, choices, correct_answer, and difficulty_level only.`;

  const localExamples = examples
    .filter((e) => e.stimulus_text === passage.stimulus_text)
    .slice(0, 8);
  const user =
    `Source passage id: ${passage.stimulus_id || ""}\n` +
    `Source passage title: ${passage.stimulus_title || ""}\n` +
    `Source passage:\n${passage.stimulus_text}\n\n` +
    `Write ${Math.min(Math.max(count + 6, 10), 18)} NEW ${subject} questions for Topic: ${topic}; Subtopic: ${subtopic}.\n` +
    `Difficulty plan: ${planned.join(", ")}.\n` +
    `${opts.extraInstructions ? `Additional standards:\n${opts.extraInstructions}\n\n` : ""}` +
    `Use these existing questions as style examples, but do not copy them:\n\n` +
    `${exampleBlock(localExamples.length ? localExamples : examples.slice(0, 8))}\n\n` +
    `Every question must be answerable from the source passage. Hard questions should require synthesis, evaluating an argument, or identifying what is and is not supported by evidence.`;

  const out = await callAnthropic(apiKey, "submit_questions", questionSchema(), system, user);
  const candidates = ((out?.questions ?? []) as Candidate[]).map((candidate) => ({
    ...candidate,
    stimulus_id: passage.stimulus_id || null,
    stimulus_title: passage.stimulus_title || null,
    stimulus_type: passage.stimulus_type || "reading_passage",
    stimulus_text: passage.stimulus_text || null,
  }));
  if (!candidates.length) return [];

  const existingNormalised = new Set(existingTexts.map(normalise));
  const batchSeen = new Set<string>();
  const linted: Candidate[] = [];
  for (const c of candidates) {
    if (passesLint(c, existingNormalised, batchSeen)) {
      batchSeen.add(normalise(c.question_text));
      linted.push(c);
    }
  }
  if (!linted.length) return [];

  const verdicts = await verifyCandidates(apiKey, linted);
  const verified: VerifiedQuestion[] = [];
  for (let i = 0; i < linted.length; i++) {
    if (!verdicts[i]) continue;
    const c = linted[i];
    const difficulty = difficulties.includes(c.difficulty_level) ? c.difficulty_level : difficulties[0];
    verified.push(toVerified(c, difficulty));
  }
  return verified;
}

export async function reviseVerifiedQuestion(opts: {
  apiKey: string;
  subject: string;
  topic: string;
  subtopic: string;
  question: VerifiedQuestion;
  teacherRequest: string;
}): Promise<VerifiedQuestion | null> {
  const { apiKey, subject, topic, subtopic, question, teacherRequest } = opts;
  const system = baseSystemPrompt(subject, topic, subtopic) +
    `You are revising one existing item. Preserve any passage or SVG unless the teacher specifically asks to change it. Keep the revision conservative enough to pass independent verification.`;

  const baseUser =
    `Revise this question according to the teacher request.\n\n` +
    `Teacher request: ${teacherRequest}\n\n` +
    (question.stimulus_text ? `Current passage title: ${question.stimulus_title || ""}\nCurrent passage:\n${question.stimulus_text}\n` : "") +
    (question.svg_content ? `Current SVG:\n${question.svg_content}\n` : "") +
    `Current difficulty: ${question.difficulty_level}\n` +
    `Current question: ${question.question_text}\n` +
    `a) ${question.choice_a}\n` +
    `b) ${question.choice_b}\n` +
    `c) ${question.choice_c}\n` +
    `d) ${question.choice_d}\n` +
    `Correct: ${question.correct_answer}\n\n` +
    `Return the full revised item.`;

  const schema = {
    type: "object",
    properties: {
      question_text: { type: "string" },
      choice_a: { type: "string" },
      choice_b: { type: "string" },
      choice_c: { type: "string" },
      choice_d: { type: "string" },
      correct_answer: { type: "string", enum: ["a", "b", "c", "d"] },
      difficulty_level: { type: "string", enum: ["easy", "medium", "hard"] },
      svg_content: { type: ["string", "null"] },
      stimulus_id: { type: ["string", "null"] },
      stimulus_title: { type: ["string", "null"] },
      stimulus_type: { type: ["string", "null"] },
      stimulus_text: { type: ["string", "null"] },
      explanation: { type: "string" },
    },
    required: ["question_text", "choice_a", "choice_b", "choice_c", "choice_d", "correct_answer", "difficulty_level"],
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const user = attempt === 0
      ? baseUser
      : `${baseUser}\n\nThe previous revision failed independent verification. Make a smaller, clearer revision with one unambiguous answer and more diagnostic distractors.`;
    const out = await callAnthropic(apiKey, "submit_question_revision", schema, system, user);
    if (!out) continue;
    const candidate = sanitiseCandidate(out as unknown as Candidate);
    if (!candidate.stimulus_text && question.stimulus_text) {
      candidate.stimulus_title = question.stimulus_title;
      candidate.stimulus_type = question.stimulus_type;
      candidate.stimulus_text = question.stimulus_text;
      candidate.stimulus_id = question.stimulus_id;
    }
    if (!candidate.svg_content && question.svg_content) candidate.svg_content = question.svg_content;
    if (!passesLint(candidate, new Set(), new Set())) continue;
    const [verified] = await verifyCandidates(apiKey, [candidate]);
    if (verified) return toVerified(candidate, candidate.difficulty_level);
  }
  return null;
}
