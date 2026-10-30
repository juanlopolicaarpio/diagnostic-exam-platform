import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateVerifiedQuestions, generateVerifiedReadingQuestions, type ExampleQuestion } from "./generate.ts";

// Status given to AI-generated questions once they pass verification.
// "active" = served live immediately (on-the-fly mode). Switch to
// "needs_human_review" to instead queue them for admin approval in ExamBuilder.
const AI_QUESTION_STATUS = "active";

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

// Only expose what the frontend actually renders — no internal fields
const QUESTION_FIELDS = [
  "id",
  "subject",
  "topic",
  "subtopic",
  "difficulty_level",
  "question_text",
  "render_markup",
  "choice_a",
  "choice_b",
  "choice_c",
  "choice_d",
  "choice_e",
  "correct_answer",
  "stimulus_id",
  "instruction_id",
  "svg_content",
].join(",");

interface QuestionRow {
  id: string;
  stimulus_id: string | null;
  instruction_id: string | null;
  [key: string]: unknown;
}

interface GroundedExample extends ExampleQuestion {
  topic: string;
  stimulus_id?: string | null;
}

interface StimulusRow {
  id: string;
  stimulus_title: string | null;
  stimulus_type: string | null;
  stimulus_text: string | null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// Generate + verify fresh questions for an exhausted subtopic, persist the
// survivors (so the bank grows and we don't regenerate every call), and return
// them as ready-to-serve rows. Returns [] if the subtopic isn't eligible
// (not plain MCQ / too little grounding) or nothing passed verification.
async function aiTopUp(
  // deno-lint-ignore no-explicit-any -- supabase client is created untyped (no schema generic)
  db: any,
  apiKey: string,
  subject: string,
  subtopic: string,
  need: number,
  excludeIds: string[],
): Promise<QuestionRow[]> {
  // Plain (no passage / markup / visual) examples for grounding + the topic.
  const { data: plainExamples } = await db
    .from("questions")
    .select("topic,question_text,choice_a,choice_b,choice_c,choice_d,choice_e,correct_answer,difficulty_level")
    .eq("status", "active")
    .eq("subject", subject)
    .eq("subtopic", subtopic)
    .is("stimulus_id", null)
    .is("render_markup", null)
    .is("svg_content", null)
    .limit(8);

  // Too little grounding, or a passage/visual subtopic — don't auto-generate.
  let examples = (plainExamples ?? []) as GroundedExample[];
  let useStimulusMode = false;

  if (examples.length < 3) {
    const { data: stimulusRows } = await db
      .from("questions")
      .select("topic,stimulus_id,question_text,choice_a,choice_b,choice_c,choice_d,choice_e,correct_answer,difficulty_level")
      .eq("status", "active")
      .eq("subject", subject)
      .eq("subtopic", subtopic)
      .not("stimulus_id", "is", null)
      .is("render_markup", null)
      .is("svg_content", null)
      .limit(10);

    const stimulusExamples = (stimulusRows ?? []) as GroundedExample[];
    const stimulusIds = [...new Set(stimulusExamples.map((row) => row.stimulus_id).filter(Boolean))] as string[];

    if (stimulusIds.length) {
      const { data: stimuli } = await db
        .from("stimuli")
        .select("id,stimulus_title,stimulus_type,stimulus_text")
        .in("id", stimulusIds);

      const stimulusMap = new Map<string, StimulusRow>(
        ((stimuli ?? []) as StimulusRow[]).map((stimulus) => [stimulus.id, stimulus]),
      );

      examples = stimulusExamples
        .map((row) => {
          const stimulus = row.stimulus_id ? stimulusMap.get(row.stimulus_id) : null;
          return {
            ...row,
            stimulus_title: stimulus?.stimulus_title ?? null,
            stimulus_type: stimulus?.stimulus_type ?? "reading_passage",
            stimulus_text: stimulus?.stimulus_text ?? null,
          };
        })
        .filter((row) => row.stimulus_text);
      useStimulusMode = examples.length >= 3;
    }
  }

  if (examples.length < 3) return [];

  const topic = examples[0].topic as string;

  // Existing question texts for cheap near-duplicate rejection.
  const { data: existing } = await db
    .from("questions")
    .select("question_text")
    .eq("status", "active")
    .eq("subject", subject)
    .eq("subtopic", subtopic)
    .limit(300);
  const existingTexts = (existing ?? []).map((r: { question_text: string }) => r.question_text);

  const verified = useStimulusMode
    ? await generateVerifiedReadingQuestions({
      apiKey,
      subject,
      topic,
      subtopic,
      passage: examples.find((e) => e.stimulus_text) as ExampleQuestion,
      examples,
      existingTexts,
      count: need,
    })
    : await generateVerifiedQuestions({
      apiKey,
      subject,
      topic,
      subtopic,
      examples,
      existingTexts,
      count: need,
    });
  if (!verified.length) return [];

  const rows = verified.map((v) => ({
    source_school: "AI Generated",
    subject,
    topic,
    subtopic,
    difficulty_level: v.difficulty_level,
    question_text: v.question_text,
    choice_a: v.choice_a,
    choice_b: v.choice_b,
    choice_c: v.choice_c,
    choice_d: v.choice_d,
    choice_e: null,
    correct_answer: v.correct_answer,
    stimulus_id: v.stimulus_id || null,
    status: AI_QUESTION_STATUS,
  }));

  const { data: inserted, error } = await db
    .from("questions")
    .insert(rows)
    .select(QUESTION_FIELDS);
  if (error) {
    console.error("ai insert error:", error);
    return [];
  }

  const excl = new Set(excludeIds);
  return ((inserted ?? []) as unknown as QuestionRow[]).filter((q) => !excl.has(q.id));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // Require a valid Bearer token so the question bank isn't open to the public
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ error: "Missing authorization token" }, 401);
  }
  const userToken = authHeader.slice(7);

  // Parse + validate body
  let subject: string, topic: string | undefined, subtopic: string | undefined, limit: number;
  try {
    const body = await req.json();
    subject = body.subject ?? "";
    topic = body.topic ?? undefined;
    subtopic = body.subtopic ?? undefined;
    limit = Math.min(Math.max(1, Number(body.limit) || 10), 20);
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!VALID_SUBJECTS.has(subject)) {
    return json({ error: "Invalid or missing subject" }, 400);
  }

  // Verify the caller's token is a real Supabase session, and capture the
  // student's id so we can track which questions they've already been served.
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${userToken}` } } },
  );
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return json({ error: "Invalid or expired token" }, 401);
  }
  const userId = user.id;

  // Use service role for all DB queries — bypasses RLS, no per-row policy overhead
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Logic/Abstract Reasoning questions have no topic in the DB
  const isLogic = subject.toLowerCase().includes("logic");

  // A stable key for "what the student is drilling", at the same granularity the
  // query filters on. History is tracked per-scope so drilling a subtopic and
  // drilling its parent topic don't interfere with each other.
  const scope = isLogic
    ? `subject:${subject}`
    : subtopic
      ? `subtopic:${subtopic}`
      : topic
        ? `topic:${topic}`
        : `subject:${subject}`;

  // Build the scoped questions query (active + subject + topic/subtopic filter).
  const scopedQuestions = (excludeIds: string[]) => {
    let q = db
      .from("questions")
      .select(QUESTION_FIELDS)
      .eq("status", "active")
      .eq("subject", subject);
    if (!isLogic) {
      if (subtopic) q = q.eq("subtopic", subtopic);
      else if (topic) q = q.eq("topic", topic);
    }
    // Per-scope served sets stay small (a subtopic bank is modest), so an
    // in-query NOT IN is cheap and keeps the shuffle random across the bank.
    if (excludeIds.length) {
      q = q.not("id", "in", `(${excludeIds.join(",")})`);
    }
    return q.limit(50);
  };

  const shuffle = <T>(arr: T[]) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  // 1. Which questions has this student already seen for this scope?
  const { data: servedRows, error: histErr } = await db
    .from("practice_question_history")
    .select("question_id")
    .eq("user_id", userId)
    .eq("subject", subject)
    .eq("scope", scope);

  if (histErr) {
    console.error("history query error:", histErr);
    return json({ error: "Failed to fetch questions" }, 500);
  }

  const servedIds = (servedRows ?? []).map((r) => r.question_id as string);

  // 2. Fetch a pool of UNSEEN questions, shuffle, take the requested batch.
  const { data: unseenPool, error: qErr } = await scopedQuestions(servedIds);

  if (qErr) {
    console.error("questions query error:", qErr);
    return json({ error: "Failed to fetch questions" }, 500);
  }

  let selected = shuffle([...((unseenPool ?? []) as unknown as QuestionRow[])]).slice(0, limit);

  // 3. If the student has exhausted the vetted bank for this SUBTOPIC, try to
  //    generate fresh, verified questions on the fly before falling back to
  //    recycling. Only plain self-contained MCQ subtopics are eligible —
  //    passage/markup/visual questions are too risky to auto-generate.
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (selected.length < limit && apiKey && subtopic && !isLogic) {
    try {
      const generated = await aiTopUp(
        db,
        apiKey,
        subject,
        subtopic,
        limit - selected.length,
        selected.map((q) => q.id),
      );
      selected = selected.concat(generated).slice(0, limit);
    } catch (e) {
      console.error("ai top-up failed:", e);
    }
  }

  // 4. Still short (generation disabled/ineligible/insufficient)? Recycle: wipe
  //    this scope's history and top the batch back up from the start of the
  //    bank, so the student always gets a full set instead of a short/empty one.
  if (selected.length < limit) {
    await db
      .from("practice_question_history")
      .delete()
      .eq("user_id", userId)
      .eq("subject", subject)
      .eq("scope", scope);

    const need = limit - selected.length;
    if (need > 0) {
      const alreadyPicked = selected.map((q) => q.id);
      const { data: refillPool } = await scopedQuestions(alreadyPicked);
      const refill = shuffle([...((refillPool ?? []) as unknown as QuestionRow[])]).slice(0, need);
      selected = selected.concat(refill);
    }
  }

  if (!selected.length) {
    return json({ questions: [] });
  }

  // 5. Record what we just served so the next call skips these.
  await db.from("practice_question_history").upsert(
    selected.map((q) => ({
      user_id: userId,
      subject,
      scope,
      question_id: q.id,
    })),
    { onConflict: "user_id,subject,scope,question_id", ignoreDuplicates: true },
  );

  // Parallel fetch related stimulus + instruction rows
  const stimIds = [...new Set(selected.map((q) => q.stimulus_id).filter(Boolean))];
  const instrIds = [...new Set(selected.map((q) => q.instruction_id).filter(Boolean))];

  const [stimRes, instrRes] = await Promise.all([
    stimIds.length
      ? db
          .from("stimuli")
          .select("id,stimulus_title,stimulus_type,stimulus_text")
          .in("id", stimIds)
      : Promise.resolve({ data: [] as { id: string; stimulus_title: string; stimulus_type: string; stimulus_text: string }[], error: null }),
    instrIds.length
      ? db
          .from("instructions")
          .select("id,instruction_text")
          .in("id", instrIds)
      : Promise.resolve({ data: [] as { id: string; instruction_text: string }[], error: null }),
  ]);

  const stimMap = Object.fromEntries((stimRes.data ?? []).map((s) => [s.id, s]));
  const instrMap = Object.fromEntries((instrRes.data ?? []).map((i) => [i.id, i]));

  const questions = selected.map((q) => ({
    ...q,
    stimulus: q.stimulus_id ? (stimMap[q.stimulus_id] ?? null) : null,
    instruction: q.instruction_id ? (instrMap[q.instruction_id] ?? null) : null,
  }));

  return json({ questions });
});
