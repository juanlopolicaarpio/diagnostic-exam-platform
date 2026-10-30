import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateVerifiedQuestions, generateVerifiedReadingQuestions, reviseVerifiedQuestion, type ExampleQuestion, type VerifiedQuestion } from "../get-practice-questions/generate.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };

const VALID_SUBJECTS = new Set([
  "Mathematics",
  "English Language",
  "Reading",
  "Science",
  "Social Studies",
  "Filipino Language",
  "Logic/Abstract Reasoning",
]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// Maximum items this function will produce in ONE invocation.
//
// This is a wall-clock guard, not a product limit. Each invocation costs at
// least two Anthropic round trips (generate, then blind-solve verify) and
// retries up to MAX_ATTEMPTS times, so an oversized batch risks hitting the
// edge-function timeout and losing everything. The client asks for large
// batches by calling this endpoint repeatedly in waves — see
// src/useQuestionGeneration.js. Raise this only if you also measure runtime.
const MAX_BATCH = 15;
const MAX_ATTEMPTS = 4;

function clampDifficultyCount(value: unknown) {
  return Math.min(Math.max(0, Number(value) || 0), MAX_BATCH);
}

function buildDifficultyPlan(split: Record<string, unknown>) {
  const easy = clampDifficultyCount(split?.easy);
  const medium = clampDifficultyCount(split?.medium);
  const hard = clampDifficultyCount(split?.hard);
  const plan = [
    ...Array(easy).fill("easy"),
    ...Array(medium).fill("medium"),
    ...Array(hard).fill("hard"),
  ];
  return plan.slice(0, MAX_BATCH);
}

function remainingDifficultyPlan(original: string[], accepted: VerifiedQuestion[]) {
  const remaining = [...original];
  for (const q of accepted) {
    const idx = remaining.indexOf(String(q.difficulty_level || "").toLowerCase());
    if (idx !== -1) remaining.splice(idx, 1);
  }
  return remaining;
}

function mergeStimuliIntoExamples(
  examples: Record<string, unknown>[],
  stimuli: Record<string, { stimulus_title?: string; stimulus_type?: string; stimulus_text?: string }>,
): ExampleQuestion[] {
  return examples.map((row) => {
    const stimulusId = row.stimulus_id as string | null;
    const stim = stimulusId ? stimuli[stimulusId] : null;
    return {
      ...(row as unknown as ExampleQuestion),
      stimulus_title: stim?.stimulus_title ?? null,
      stimulus_type: stim?.stimulus_type ?? null,
      stimulus_text: stim?.stimulus_text ?? null,
    };
  });
}

async function fetchStimuli(
  // deno-lint-ignore no-explicit-any
  db: any,
  rows: Record<string, unknown>[],
): Promise<Record<string, { stimulus_title?: string; stimulus_type?: string; stimulus_text?: string }>> {
  const ids = [...new Set(rows.map((row) => row.stimulus_id).filter(Boolean))] as string[];
  if (!ids.length) return {};
  const { data } = await db
    .from("stimuli")
    .select("id,stimulus_title,stimulus_type,stimulus_text")
    .in("id", ids);
  return Object.fromEntries((data ?? []).map((row: Record<string, unknown>) => [row.id, row]));
}

async function loadExamples(
  // deno-lint-ignore no-explicit-any
  db: any,
  subject: string,
  topic: string,
  subtopic: string,
): Promise<ExampleQuestion[]> {
  const isReading = subject.toLowerCase() === "reading";
  const select = "topic,subtopic,question_text,choice_a,choice_b,choice_c,choice_d,choice_e,correct_answer,difficulty_level,stimulus_id,svg_content";

  let exactQuery = db
    .from("questions")
    .select(select)
    .eq("status", "active")
    .eq("subject", subject)
    .eq("topic", topic)
    .limit(12);
  if (subtopic) exactQuery = exactQuery.eq("subtopic", subtopic);
  if (!isReading) exactQuery = exactQuery.is("render_markup", null);

  const { data: exact, error } = await exactQuery;
  if (error) throw error;

  let examples = (exact ?? []) as Record<string, unknown>[];
  if (examples.length < 3) {
    const { data: topicRows } = await db
      .from("questions")
      .select(select)
      .eq("status", "active")
      .eq("subject", subject)
      .eq("topic", topic)
      .is("render_markup", null)
      .limit(12);
    examples = [...examples, ...((topicRows ?? []) as Record<string, unknown>[])];
  }

  const visualRelevant = /math|science|logic|abstract/i.test(subject) ||
    /geometry|trig|graph|diagram|data|integral|function|density|force|motion|wave|table/i.test(`${topic} ${subtopic}`);
  if (visualRelevant) {
    const { data: svgRows } = await db
      .from("questions")
      .select(select)
      .eq("status", "active")
      .eq("subject", subject)
      .not("svg_content", "is", null)
      .limit(4);
    examples = [...examples, ...((svgRows ?? []) as Record<string, unknown>[])];
  }

  const unique = new Map<string, Record<string, unknown>>();
  examples.forEach((row) => {
    const key = String(row.question_text || "");
    if (key && !unique.has(key)) unique.set(key, row);
  });
  const rows = [...unique.values()].slice(0, 14);
  const stimuli = await fetchStimuli(db, rows);
  return mergeStimuliIntoExamples(rows, stimuli);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing authorization token" }, 401);
  const userToken = authHeader.slice(7);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${userToken}` } } },
  );
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "Invalid or expired token" }, 401);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY is not configured" }, 500);

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const mode = String(body.mode || "generate");
  const subject = String(body.subject || "").trim();
  const topic = String(body.topic || "").trim();
  const subtopic = String(body.subtopic || "").trim();

  if (!VALID_SUBJECTS.has(subject)) return json({ error: "Invalid or missing subject" }, 400);
  if (!topic) return json({ error: "Missing topic" }, 400);

  if (mode === "improve") {
    const question = body.question as VerifiedQuestion | undefined;
    const teacherRequest = String(body.teacherRequest || "").trim();
    if (!question || !teacherRequest) return json({ error: "Missing question or teacher request" }, 400);
    const improved = await reviseVerifiedQuestion({
      apiKey,
      subject,
      topic,
      subtopic,
      question,
      teacherRequest,
    });
    if (!improved) return json({ error: "The revision did not pass verification. Try a narrower request." }, 422);
    return json({ question: improved });
  }

  const difficultyPlan = buildDifficultyPlan((body.difficultySplit || {}) as Record<string, unknown>);
  if (!difficultyPlan.length) {
    return json({ error: "Difficulty split must request at least one question." }, 400);
  }
  if (difficultyPlan.length > MAX_BATCH) {
    return json({ error: `A single request may ask for at most ${MAX_BATCH} questions. Split larger batches into waves.` }, 400);
  }
  const requested = difficultyPlan.length;

  let examples: ExampleQuestion[] = [];
  try {
    examples = await loadExamples(db, subject, topic, subtopic);
  } catch (exampleErr) {
    console.error("example query error:", exampleErr);
    return json({ error: "Could not load grounding examples" }, 500);
  }
  if (!examples.length) {
    return json({ error: "This scope has no active examples to ground AI generation." }, 422);
  }

  let existingQuery = db
    .from("questions")
    .select("question_text")
    .eq("status", "active")
    .eq("subject", subject)
    .eq("topic", topic)
    .limit(500);
  if (subtopic) existingQuery = existingQuery.eq("subtopic", subtopic);

  const { data: existing } = await existingQuery;
  const existingTexts = (existing ?? []).map((row: { question_text: string }) => row.question_text);

  // Questions the caller already holds from earlier waves of the same batch.
  // Passing them in keeps the duplicate check meaningful across waves — without
  // it, wave 3 happily regenerates something wave 1 already produced.
  const priorTexts = Array.isArray(body.priorTexts)
    ? (body.priorTexts as unknown[]).map((t) => String(t)).filter(Boolean)
    : [];

  const generated: VerifiedQuestion[] = [];
  let attempt = 0;
  while (generated.length < requested && attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const plan = remainingDifficultyPlan(difficultyPlan, generated);
    const seen = [...existingTexts, ...priorTexts, ...generated.map((q) => q.question_text)];
    const next = subject.toLowerCase() === "reading"
      ? await generateVerifiedReadingQuestions({
          apiKey,
          topic,
          subtopic: subtopic || topic,
          passage: examples.find((e) => e.stimulus_text) || examples[0],
          examples,
          existingTexts: seen,
          count: requested - generated.length,
          difficultyPlan: plan,
          extraInstructions: String(body.standards || ""),
        })
      : await generateVerifiedQuestions({
          apiKey,
          subject,
          topic,
          subtopic: subtopic || topic,
          examples,
          existingTexts: seen,
          count: requested - generated.length,
          difficultyPlan: plan,
          extraInstructions: String(body.standards || ""),
        });
    if (!next.length) break;
    generated.push(...next);
  }

  if (!generated.length) {
    return json({ error: "No generated items passed verification. Try an easier split, choose a subtopic with more examples, or add narrower standards." }, 422);
  }

  return json({
    requested,
    attempts: attempt,
    questions: generated.slice(0, requested).map((q) => ({
      ...q,
      subject,
      topic,
      subtopic: subtopic || null,
      source_school: "AI Generated",
      status: "draft",
    })),
  });
});
