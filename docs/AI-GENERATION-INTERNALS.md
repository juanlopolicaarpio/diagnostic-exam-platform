# AI Question Generation — Internals

This document explains how QuestionBank generates AI questions, why the design is
defensible for an exam-prep platform, and where each part lives in the code.

---

## User Flow

1. Teacher opens the AI Generator tab.
2. Teacher chooses a subject/topic/subtopic.
3. Teacher enters an easy/medium/hard count.
4. Teacher optionally adds standards or instructions.
5. The UI splits the request into waves.
6. Each wave calls `generate-question-batch`.
7. The edge function loads examples from the existing bank.
8. The shared generator asks Anthropic to create candidates.
9. Candidates go through linting and blind-solver verification.
10. Verified candidates appear in the UI.
11. Teacher can edit or improve each item.
12. Teacher uploads accepted items to the Question Bank.

---

## Code Map

| File | Role |
|---|---|
| `src/QuestionGenerator.jsx` | Teacher-facing UI: scope picker, difficulty split, standards field, generated question cards. |
| `src/useQuestionGeneration.js` | Generation state machine: wave planning, fetch calls, cancellation, revision, upload. |
| `supabase/functions/generate-question-batch/index.ts` | Authenticated edge function for generation and improvement. |
| `supabase/functions/get-practice-questions/generate.ts` | Shared generation engine: prompts, tool schemas, linting, verification. |
| `supabase/functions/_shared/prompt-rules.ts` | Shared item-writing rules added to every generation prompt. |
| `src/mathValidation.js` | Client-side validation that can flag math items as `needs_human_review`. |

---

## Frontend Control Flow

File: `src/useQuestionGeneration.js`

### Wave Planning

The UI does not send one large request. It calls the edge function in waves of
10 questions:

```js
const WAVE_SIZE = 10;
export const MAX_TOTAL = 60;
```

`planWaves(split)` round-robins easy, medium, and hard counts so one wave is not
all easy or all hard.

Example:

```js
planWaves({ easy: 6, medium: 6, hard: 6 })
```

returns two mixed waves instead of one long request.

This protects against edge-function timeout and lets teachers see questions as
they pass verification.

### Generation Request

For each wave, the frontend calls:

```txt
POST /functions/v1/generate-question-batch
```

with:

```json
{
  "mode": "generate",
  "subject": "Mathematics",
  "topic": "Algebra",
  "subtopic": "Factoring",
  "difficultySplit": { "easy": 1, "medium": 2, "hard": 1 },
  "standards": "Focus on entrance-exam style factoring problems.",
  "priorTexts": []
}
```

`priorTexts` prevents duplicate stems across waves in the same run.

### Cancellation

`cancel()` aborts the current fetch and keeps already generated questions on
screen. It does not erase accepted generated questions.

### Improvement

`improve(index, teacherRequest)` sends one generated question back to the same
edge function with:

```json
{
  "mode": "improve",
  "question": { "...": "..." },
  "teacherRequest": "Make the distractors more plausible."
}
```

The revised item must pass verification before replacing the generated question
in the UI.

### Upload

`upload()` inserts rows into:

- `stimuli`, if a generated Reading item includes a new passage payload
- `questions`, for the generated question rows

Uploaded AI questions are inserted into the Question Bank with:

```js
source_school: "AI Generated"
```

Math validation also runs during upload so math items that need attention can be
flagged by the app.

---

## Edge Function Control Flow

File: `supabase/functions/generate-question-batch/index.ts`

### Request Guardrails

The function:

1. Handles CORS preflight.
2. Requires `POST`.
3. Requires a bearer token.
4. Authenticates the user through Supabase Auth.
5. Requires `ANTHROPIC_API_KEY`.
6. Validates subject and topic.
7. Limits one invocation to `MAX_BATCH = 15`.
8. Retries generation up to `MAX_ATTEMPTS = 4`.

Valid subjects:

- Mathematics
- English Language
- Reading
- Science
- Social Studies
- Filipino Language
- Logic/Abstract Reasoning

### Loading Examples

`loadExamples(db, subject, topic, subtopic)` retrieves up to 14 examples from
the live question bank.

The query prefers:

1. active rows matching subject + topic + subtopic
2. topic-level fallback rows if too few exact rows exist
3. SVG examples for visual-heavy subjects/scopes
4. reading passage text from `stimuli` for Reading items

Non-reading examples with `render_markup` are excluded because those items have
special error-identification markup that the generator should not imitate unless
explicitly supported.

### Existing Stem Check

The function loads up to 500 active question stems in the same scope. These are
used by the generator engine to reject duplicate stems.

### Retrying

If a wave asks for 10 questions and only 7 pass, the function calculates which
difficulty slots are still missing and retries. It stops when:

- the requested count is filled
- no more candidates pass
- `MAX_ATTEMPTS` is reached

The response includes only verified questions, sliced to the requested count.

---

## Generation Engine

File: `supabase/functions/get-practice-questions/generate.ts`

The generation engine is shared by:

- teacher-facing generation
- adaptive practice top-up generation

### Model

The model is controlled by:

```ts
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-6";
```

No model key is exposed to the browser. All Anthropic calls happen inside edge
functions.

### Forced Tool Output

The engine calls Anthropic with:

```ts
tools: [{ name: toolName, input_schema: inputSchema }],
tool_choice: { type: "tool", name: toolName }
```

This means the model must return structured JSON through the requested tool
schema. The app does not parse free-form prose.

Required generated fields:

- `question_text`
- `choice_a`
- `choice_b`
- `choice_c`
- `choice_d`
- `correct_answer`
- `difficulty_level`

Optional fields:

- `svg_content`
- `stimulus_id`
- `stimulus_title`
- `stimulus_type`
- `stimulus_text`
- `explanation`

### Prompt Structure

`baseSystemPrompt(subject, topic, subtopic)` gives the model:

- assessment-writer role
- exact subject/topic/subtopic alignment
- difficulty calibration
- distractor quality rules
- four-choice requirement
- shared QuestionBank prompt rules
- Reading-specific instructions, when subject is Reading
- SVG-specific instructions, when visuals are relevant

The examples block includes real bank questions. For Reading, it also includes
the passage text. For visual scopes, it includes SVG examples, truncated when
large.

This is retrieval-grounded generation: the model sees the local style and
structure before writing new items.

---

## Lint Gate

Function: `passesLint(...)`

Before the blind solver sees anything, each candidate must pass deterministic
checks:

| Check | Reason |
|---|---|
| Four non-empty choices | Prevents incomplete multiple-choice items. |
| Choices are distinct after normalization | Prevents repeated answer options. |
| `correct_answer` is `a`, `b`, `c`, or `d` | Keeps answer format compatible with scoring. |
| Stem is present and at least 10 normalized characters | Prevents empty or trivial stems. |
| Stem is not duplicated in existing questions | Protects the bank from repeated items. |
| Stem is not duplicated inside the same batch | Prevents wave-level repetition. |
| SVG starts with `<svg` and contains `</svg>` | Ensures inline SVG shape. |
| SVG does not contain script/image/href/event-handler patterns | Blocks unsafe SVG content. |
| Passage text, when present, is at least 250 characters | Prevents fake or underspecified Reading passages. |

The frontend runs an additional SVG safety check before upload:

```js
svgLooksSafe(value)
```

---

## Blind-Solver Verification

Function: `verifyCandidates(apiKey, candidates)`

This is the strongest quality gate in the system.

The verifier receives:

- question text
- choices
- passage, when present
- SVG source, when present

The verifier does not receive:

- the candidate's claimed correct answer
- the original generation rationale

It must return:

```json
{
  "index": 0,
  "chosen": "c",
  "single_correct": true,
  "confidence": "high"
}
```

The candidate passes only when:

```txt
single_correct == true
confidence != "low"
chosen == candidate.correct_answer
```

If the blind solver chooses a different answer, reports low confidence, or says
the item is ambiguous, the item is discarded.

---

## Reading Generation

Reading questions are handled separately by:

```ts
generateVerifiedReadingQuestions(...)
```

Rules:

- use an existing DB passage
- do not invent or rewrite the passage
- copy `stimulus_id`, title, type, and text
- every question must be answerable from that passage
- hard questions should require inference, synthesis, evidence evaluation, or
  support/unsupported reasoning

This keeps Reading generation anchored to real QuestionBank passages instead of
creating unsupported passage content.

---

## SVG / Diagram Generation

The model may produce `svg_content` when the scope is visual:

- math
- science
- logic/abstract reasoning
- geometry
- graphing
- data/table interpretation
- force/motion/waves
- other visual-heavy topics

SVG rules in the prompt:

- inline `<svg>`
- white background
- clear black strokes/text
- readable labels
- simple geometry
- viewBox
- no scripts
- no external images
- no event handlers

SVGs are checked server-side by `validSvg(...)` and client-side by
`svgLooksSafe(...)`.

AI visual generation is SVG-only. Raster images are not generated by this
pipeline.

---

## Why The Design Is Defensible

### 1. The AI Does Not Bypass Quality Control

Generated questions pass deterministic linting, blind-solver verification, and
the teacher's on-screen review before upload to the Question Bank.

### 2. Output Is Structured

The generator uses Anthropic tool calls with a JSON schema. This avoids fragile
parsing of free-form model text.

### 3. It Is Grounded On The Existing Bank

The model sees examples from the same subject/topic/subtopic. That makes the
output match QuestionBank's content style, difficulty expectations, and data
shape.

### 4. It Has Deterministic Rejection Rules

Linting rejects incomplete, duplicate, malformed, or unsafe candidates before
any subjective model judgment happens.

### 5. It Uses Independent Answer Verification

The blind solver has to solve the item without seeing the answer key. This is a
practical defense against incorrect answer keys and ambiguous questions.

### 6. It Fails Closed

If the function cannot load examples, cannot reach Anthropic, receives invalid
JSON, or gets no verified items, it returns an error instead of inserting
unverified content.

### 7. Cost And Runtime Are Bounded

The frontend limits one user run to `MAX_TOTAL = 60`. The backend limits one
function invocation to `MAX_BATCH = 15`. Large requests are split into waves.

---

## How To Explain Fewer-Than-Requested Results

This is expected behavior.

The user-requested count is the target. The accepted count is the number of
questions that passed:

1. model generation
2. schema/tool output
3. deterministic lint
4. blind-solver verification
5. local upload validation

Rejected questions are not shown because they failed the quality gate. Generate
again to top up the scope.

---

## Changing The Generator

| Change | File |
|---|---|
| Change model | Supabase secret `ANTHROPIC_MODEL`. |
| Change generation rules | `supabase/functions/get-practice-questions/generate.ts`. |
| Change shared style rules | `supabase/functions/_shared/prompt-rules.ts`. |
| Change maximum per function call | `MAX_BATCH` in `generate-question-batch/index.ts`. |
| Change maximum per UI run | `MAX_TOTAL` in `src/useQuestionGeneration.js`. |
| Change wave size | `WAVE_SIZE` in `src/useQuestionGeneration.js`. |
| Change upload behavior | `upload()` in `src/useQuestionGeneration.js`. |
| Change SVG safety rules | `validSvg(...)` and `svgLooksSafe(...)`. |

After editing shared generator code, redeploy:

```bash
npx supabase functions deploy generate-question-batch --project-ref <your-project-ref>
npx supabase functions deploy get-practice-questions --project-ref <your-project-ref>
```
