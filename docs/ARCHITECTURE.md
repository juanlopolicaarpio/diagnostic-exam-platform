# System Architecture

**Audience:** anyone picking this codebase up.

This walks the whole system: the data model, how an exam is authored and
assembled, how a timed attempt survives a refresh, how scoring works, and how AI
generation is kept on a leash. Section 7 is a candid account of the design debt
that remains.

---

## 1. What this system is

This is a **college-entrance-exam diagnostic platform**. A student sits a fixed
170-question exam across 6 timed sections. The system grades it, then computes
how well the student fits each of 8 university course clusters, predicts
university outcomes, and produces a study plan.

This repository holds the **admin/teacher app** and the **entire backend** — the
question bank tooling, the exam builder, the AI generation pipeline, the edge
functions, the scoring engine, and the schema. The student-facing exam UI is a
separate frontend against the same backend; `src/StudentExamPreview.jsx` is a
full working implementation of that experience, used by teachers to preview an
exam exactly as a student will sit it.

```
┌────────────────────┐         ┌────────────────────┐
│  admin / teacher   │         │  student app       │
│  (this repo)       │         │  (separate client) │
│  React + Vite SPA  │         │                    │
└─────────┬──────────┘         └─────────┬──────────┘
          │                              │
          │  PostgREST (anon key + user JWT)
          │  Edge Functions (Deno)        │
          ▼                              ▼
     ┌──────────────────────────────────────────┐
     │            Supabase project              │
     │  Postgres + RLS · Auth · Storage · Edge  │
     └──────────────────────────────────────────┘
                       │
                       ▼
              Anthropic Messages API
              (question generation)
```

There is **no backend server of our own**. The admin app talks directly to
PostgREST for CRUD and calls edge functions for anything that needs the
service-role key or an AI call. This is the single most important architectural
fact to internalise: *the browser is a first-class database client, and RLS is
the only thing standing between a teacher and the whole question bank.*

---

## 2. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | React 19 + Vite 8, plain JS (`.jsx`) | No TypeScript, no router, no state library, no CSS framework — inline style objects |
| Styling | Inline `style={{}}` objects, one `css`/`G` const per file | Dark theme in the bank/builder, light theme in the generator |
| Math | KaTeX + `react-latex-next`, plus a hand-rolled parser (`mathParser2.jsx`) | See §8 |
| Backend | Supabase (Postgres 15 + PostgREST + GoTrue + Storage) | No server of our own |
| Serverless | Supabase Edge Functions (Deno) | 14 functions in `supabase/functions/` |
| AI | Anthropic Messages API, model set per-environment | Called only from edge functions, never the browser |
| Hosting | Vercel (`vercel.json` present) | Static SPA build |

**Front-end entry point:** `src/main.jsx` → `src/App.jsx`. `App.jsx` owns auth
and a `view` state string (`bank` / `builder` / `quizzes` / `categories` /
`generator`). There is no router — navigation is a `useState`. Refreshing the
page always lands on the question bank.

---

## 3. Data model

30 tables in `public`. They fall into five clusters.

### 3.1 Content (the question bank)

```
        stimuli                     instructions
     (reading passages)          (shared rubric text)
            │ 1                        │ 1
            │                          │
            │ N                        │ N
            └────────► questions ◄──────┘
                          │ 1
                          │
                          │ N
              question_visual_assets ──N──1── visual_assets
                                                 (storage_path)
```

| Table | Purpose |
|---|---|
| `questions` | The item bank. Subject / topic / subtopic / difficulty / 4–5 choices / correct answer / optional inline `svg_content` |
| `stimuli` | Reading passages, shared by many questions via `questions.stimulus_id` |
| `instructions` | Shared instruction blocks, so a group of items states its rubric once |
| `visual_assets` | Uploaded figure metadata → `storage_path` in the `question-visuals` bucket |
| `question_visual_assets` | Join table, carries `display_order`, `marked_segment`, `passage_question_range` |

`questions` columns worth knowing:

- `render_markup` — optional alternate rendering. Used for "error identification"
  items, which embed `<seg choice='A'>…</seg>` markers. `SegMarkup` in
  `App.jsx:118` renders these. **The AI generator explicitly excludes these rows
  from its grounding examples** (`generate-question-batch/index.ts:99`).
- `svg_content` — an inline `<svg>` string stored on the question row. This is
  the *primary* visual mechanism in practice, not `visual_assets`: it needs no
  upload, no bucket round-trip, and no second request to render. Math and logic
  items are the heaviest users.
- `source_school` — provenance. CHECK-constrained, so an import cannot invent a
  source.
- `status` — `active | draft | retired`, CHECK-constrained. Only `active` is
  eligible for auto-pick into an exam, and both ingest paths force new rows to
  `draft`. The bank UI also filters for a fourth state, `needs_human_review`,
  which the constraint does not permit — see §7.3.

### 3.2 Exam definition

```
diagnostic_templates ──1──N── diagnostic_template_questions ──N──1── questions
```

A template is an ordered list of 170 questions bucketed into 6 sections.
`is_active` and `is_primary` form a two-bit state the assembler reads: active +
primary is the exam new students receive, active alone is an available retake,
and neither means retired — existing attempts still resolve, but no new ones
start.

One reserved code matters: `__DELETED_EXAM_SESSIONS__` is a tombstone template
used to park orphaned sessions when an exam is deleted, so a deletion can never
strand a student's completed attempt behind a dangling foreign key.

Section order and timing are **hardcoded in three places** that must agree:

| Section | Questions | Time | Source of truth |
|---|---:|---:|---|
| language | 30 | 18:00 | `_shared/utils.ts:144` `SECTION_CONFIG` |
| reading | 30 | 23:30 | mirrored in `section_time_limits` (a DB table) |
| math | 40 | 50:00 | mirrored in `ExamBuilder.jsx:20` `SUBJECTS` |
| science | 40 | 33:20 | |
| social_studies | 15 | 9:00 | |
| logic | 15 | 18:45 | |

Nothing enforces that they keep agreeing — see §7.1.

### 3.3 Student attempt (runtime)

```
diagnostic_sessions ──1──N── session_sections   (per-section clock + status)
        │
        ├──1──N── session_questions             (frozen snapshot of the template)
        │              │ 1
        │              └──N── session_responses (the answers, graded at submit)
```

- `session_questions` is a **snapshot**. Editing a template later does not
  change an in-flight exam. This is correct and deliberate.
- `session_sections.elapsed_seconds` + `last_activity_at` implement a
  disconnect-tolerant clock (`_shared/section-clock.ts`, migration
  `20260803000000`). Time while the student is away is not charged.

### 3.4 Results (written once, read many)

Eight tables, all keyed on `session_id`, all populated in a single pass by
`finalize-exam`:

`session_subject_scores` · `session_topic_scores` · `session_subtopic_scores` ·
`session_classification_scores` · `session_readiness_tiers` ·
`session_recommendations` · `session_university_predictions` ·
`session_percentiles`

`get-results` does zero computation — it reads these eight tables and assembles
JSON. That's the right call: compute once at finalize, read cheaply forever.

### 3.5 Scoring reference data

| Table | Purpose |
|---|---|
| `course_classifications` | The 8 clusters: BMA, HAMS, EA, ITCS, SM, HSSC, ETT, SNC |
| `subtopic_classification_importance` | The heart of the scoring model: how important is subtopic *S* for cluster *C* (weight 1/2/3). One row per (subtopic, cluster) pair, so it grows as the product of taxonomy size and cluster count |
| `university_subject_weights` | Per-university subject multipliers |
| `scoring_models` | Difficulty weights + α/β + critical threshold, versioned by name |
| `active_scoring_model` | View selecting the current model row |
| `admin_users` | Allow-list of accounts permitted to use the admin app |

### 3.6 Quizzes — a second, deliberately separate assessment type

`supabase/migrations/20260722000000_quizzes.sql` defines 5 tables
(`quizzes`, `quiz_questions`, `quiz_sessions`, `quiz_session_questions`,
`quiz_responses`) with their own RLS, served by their own three edge functions
(`assemble-quiz`, `finalize-quiz`, `submit-quiz-answer`).

The duplication is intentional. A diagnostic is a fixed 170-question instrument
whose sections, timings and scoring model are load-bearing; a quiz is whatever a
teacher wants — 10 math items, or 10 math and 5 reading. Overloading
`diagnostic_templates` to carry both would have meant either relaxing the
diagnostic's invariants (its `is_primary` pool, its section constraint, its
170-question expectation) or threading a `kind` discriminator through every
query and every scoring path. Two small table families with two small function
sets keeps the diagnostic's guarantees intact, at the cost of some structural
repetition. That trade is the right way round: the repetition is visible and
cheap, whereas a diagnostic that could be silently misassembled is neither.

---

## 4. How a diagnostic exam is made

Two separate acts: *authoring* the template, and *assembling* a student session.

### 4.1 Authoring — `src/ExamBuilder.jsx` (2,626 lines)

This is the largest and most intricate file in the repo. It builds a 170-question
template from a **blueprint**.

A blueprint is a nested spec: per section → per topic → per subtopic → a count
and a difficulty split.

```js
math: { topics: [ { name: "Algebra", count: 21,
        subtopics: [ { name: "Factoring", count: 2,
                       difficulty: { easy: 0, medium: 1, hard: 1 } }, … ] } ] }
```

`RECOMMENDED_BLUEPRINT` (line 44 onward) is the shipped default and encodes the
real UPCAT-style distribution. `DIFFICULTY_TARGETS` sets per-section
easy/medium/hard totals (logic is all-medium by design).

The flow:

1. `buildSlots(blueprint)` flattens the tree into N *slots*, each a
   `{subject, topic, subtopic, difficulty}` requirement.
2. Auto-pick queries the bank per slot and fills it, honouring
   `EXCLUDED_AUTO_PICK_QUESTION_IDS` and a special path for Reading that keeps
   passages intact and caps a passage at 6 questions (`trimReadingToTarget`).
3. The teacher can hand-swap any question.
4. Save writes `diagnostic_templates` + 170 `diagnostic_template_questions`.
5. Drafts are kept in `localStorage` under `exam_builder_drafts`.
6. `is_primary` is a 3-state pill: primary / active / inactive.

**Preview** logs in as a hardcoded test student (`student@example.com`, password in
source at `ExamBuilder.jsx:14-15`) and drives the real student runtime through
`StudentExamPreview.jsx`. That credential is a liability — see §7.5.

### 4.2 Assembly — `assemble-exam` edge function

```
POST /assemble-exam  (student JWT)
  1. Existing session in in_progress|ready_to_finalize?  → resume it
     (unless older than SESSION_MAX_AGE_HOURS=24 → mark expired)
  2. Collect template_ids the student has already used
  3. Pick the first active template not yet used
       ordered by is_primary DESC, code ASC
     → none left = HTTP 409 "no retakes available"
  4. INSERT diagnostic_session
     INSERT 6 session_sections (first one in_progress, started_at=now)
     COPY 170 template questions → session_questions, in batches of 50
  5. Return session metadata
```

Note step 4 is **not transactional**. The function compensates with manual
cleanup deletes on each failure branch. A crash between the inserts leaves a
partial session. `assemble-exam/index.ts:154` says so in a comment. This is a
known V1 tradeoff; the fix is a Postgres function.

### 4.3 Student runtime

| Function | Role |
|---|---|
| `get-question-bundle` | Returns one section's questions + stimuli + instructions + visuals + any existing answers. **Strips `correct_answer` before responding.** |
| `submit-answer` | Upserts one response; grades server-side using the service-role key |
| `heartbeat` | Keeps `last_activity_at` fresh so the section clock doesn't charge idle/disconnected time |
| `pause-section` / `pause-demo-exam` | Freezes the clock |
| `submit-section` | Fills unanswered questions as incorrect, locks the section, starts the next one, or flips the session to `ready_to_finalize` |
| `finalize-exam` | Runs the scoring engine and writes the 8 result tables |
| `get-results` | Pure read of those 8 tables |
| `get-practice-questions` | Adaptive-learning drills; tops up from the bank and, if exhausted, generates fresh items with AI |

`submit-section` fills blanks with a `NOT EXISTS` guard so a last-second
`submit-answer` isn't clobbered. Correctness is **never** computed in the
browser.

---

## 5. The scoring engine

`supabase/functions/_shared/scoring-engine.ts` (957 lines) is a **pure function
library** — no DB, no side effects, fully testable. `finalize-exam` is the glue.

The pipeline, in order:

```
graded responses
   │
   ├─► perf(S) = correct/total per subtopic        → mastery band
   │
   ├─► WPS(C)  = Σ perf(S)·imp(S,C) / Σ imp(S,C)   weighted performance
   │
   ├─► CTR(C)  = passed / TESTED high-importance subtopics
   │
   ├─► FitScore(C) = (α·WPS + β·CTR) · 100         α=0.70, β=0.30
   │
   ├─► rank 8 clusters, tie-break within 3 points:
   │       1) higher CTR  2) higher distinctive-subject WPS  3) co-equal
   │
   ├─► subject/topic scores, difficulty-weighted (easy 1.0 / med 1.5 / hard 2.0)
   ├─► readiness tier   (≥90 Highly Ready, ≥75 Ready, ≥60 Conditionally, else Not Yet)
   ├─► university predictive index (subject weights × university multipliers)
   └─► recommendations (strengths / weaknesses / study focus)
```

Two fixes in this code are worth understanding, because both were real scoring
bugs and both were invisible from the outside — the engine returned plausible
numbers in each case:

1. **CTR denominator.** It was *all* high-importance subtopics for a cluster.
   Subtopics the exam never tested therefore counted as failures, so a cluster
   whose critical subtopics were under-represented in the bank capped every
   student's CTR below 1.0 — a student answering perfectly still could not score
   a full coverage ratio. The fix counts only subtopics the student was actually
   tested on: an untested subtopic is evidence of nothing and counts neither for
   nor against. The same reasoning applies in the recommendations pass, where
   treating untested subtopics as `perf = 0` surfaced permanent phantom gaps.
2. **Distinctive-subject names.** The tie-break maps each cluster to a
   "distinctive subject" and filters subtopic performance by that string. Two
   entries matched no `questions.subject` value at all, so those clusters
   silently scored WPS 0 and lost every rule-2 tie — a string-matching bug
   presenting as a ranking preference. The lesson is in the schema, not the
   lookup table: a mapping keyed on free-text subject labels should have been a
   foreign key.

Both are the reason `scoring-engine.test.ts` exists. The engine is pure
precisely so bugs of this shape can be caught by a unit test rather than by
reading a student's results and finding them odd.

---

## 6. The AI question-generation pipeline

Two entry points, one engine.

```
Admin UI                                Student practice
QuestionGenerator.jsx                   get-practice-questions
      │                                          │
      ▼                                          ▼
generate-question-batch  ────────►  get-practice-questions/generate.ts
   (auth, scope, examples)              (the actual engine)
                                                 │
                                                 ▼
                                    Anthropic Messages API
                                    claude-sonnet-4-6, tool_choice forced
```

### 6.1 The engine — `get-practice-questions/generate.ts`

```
1. GROUND      loadExamples(): pull up to 14 active questions from the same
               subject/topic/subtopic. Falls back to topic-level if <3 exact.
               If the scope looks visual, also pull 4 questions WITH svg_content
               so the model can imitate the SVG house style.
               Reading: merges the actual passage text from `stimuli`.

2. GENERATE    One Anthropic call. Forced tool use (`submit_questions`) with a
               strict JSON schema, so output is always well-formed.
               Over-generates: asks for count+5 (clamped 8..16) to survive
               attrition. Difficulty plan is passed as an explicit list.
               System prompt = role + alignment + difficulty calibration +
               distractor rules + PROMPT_RULES + reading/visual clauses.

3. LINT        Deterministic, no model call:
                 · 4 non-empty, mutually distinct choices
                 · correct_answer ∈ {a,b,c,d}
                 · stem ≥10 normalised chars
                 · not a duplicate of any of the ~500 existing stems in scope,
                   nor of anything earlier in this batch
                 · SVG must start <svg>, end </svg>, and contain no
                   script/foreignObject/<image/href=/on*= handlers
                 · a stimulus, if present, must be ≥250 chars

4. VERIFY      Second Anthropic call — a BLIND SOLVER. It sees the stem,
               choices, passage, and SVG but NOT the claimed answer. It returns
               {chosen, single_correct, confidence} per item.
               An item is accepted only if:
                   single_correct == true
                   AND confidence != "low"
                   AND chosen == the claimed correct_answer

5. RETRY       generate-question-batch loops up to 4 times, each time asking
               only for the difficulty slots still unfilled.
```

`reviseVerifiedQuestion` ("Improve with AI") runs the same lint+verify gate,
retrying up to 3 times with escalating "make a smaller, clearer revision"
guidance. It preserves the passage and SVG unless the teacher asked to change
them.

### 6.2 The prompt rules

`_shared/prompt-rules.ts` is a shared block appended to every system prompt. It
is almost entirely about **not leaking the skill being tested** — no
"identify the misused sequence marker", no "which sentence uses coordination
correctly". It also carries a genuinely strange but necessary hack: the math
renderer breaks the word *chord* (it detects `or` inside it), so the prompt
mandates a word-joiner character `cho⁠rd` everywhere. That is a renderer
bug being papered over in a prompt — see §7.6.

### 6.3 Can it generate images?

**Yes, for SVG — and it is already working.** The generator produces inline
`<svg>` in `svg_content` when the scope is visual (math/science/logic, or a
topic matching `geometry|graph|diagram|data|function|force|motion|wave|table`).
It is grounded on up to 4 real SVGs from the bank, so the output matches house
style. The safety filter is applied twice (edge function `validSvg`, browser
`svgLooksSafe`) before anything is stored, and the browser preview renders it
live so a teacher approves visually.

Caveats worth knowing:

- The blind solver *does* see the SVG text, so an unanswerable diagram is
  usually caught. But it reads SVG **as source, not as a rendered picture** — a
  visually broken but syntactically valid diagram can pass.
- There is no raster image generation, and no way for the AI to attach an
  uploaded file. AI visuals are SVG-only, by design.
- The mechanism works well; the practical limit is that a model writing SVG by
  hand is good at diagrams with regular structure and poor at anything needing
  real spatial judgement.

### 6.4 Honest assessment: is this pipeline good?

It is **better than most in-house generators** and the two things it gets right
are the two things that matter: forced-schema output (so parsing never fails)
and a blind-solver verification gate (so the answer key is independently
confirmed). Retrieval-grounding on real bank items is also the correct approach
for style consistency.

Where it is genuinely weak:

| Gap | Impact | Fix |
|---|---|---|
| Verifier is the **same model** as the generator | Correlated blind spots — it can confidently confirm its own error | Use a different/stronger model for the verify pass |
| Single verification pass | An item is judged once | 2-of-3 self-consistency, or verify at higher effort |
| No numeric checking | A math item with an arithmetic slip passes if the solver makes the same slip | Have the model emit a worked solution and check it with code |
| `validateMathItem` is client-side only | `src/mathValidation.js` (53 lines) runs in the browser on upload; the edge function does not run it | Move it into the engine |
| No review queue behind the draft gate | Generated items land as `draft`, but nothing records who cleared one or when, so the gate cannot be audited | `reviewed_by` / `reviewed_at` and a queue view (§7.4) |
| No telemetry | We do not know the accept rate, the reject reasons, or the cost per accepted item | Log lint/verify outcomes |
| No prompt caching | The system prompt and the grounding examples are resent every call at full price | `cache_control` on the examples block |

The single highest-leverage change is **splitting generator and verifier
models**: a model reviewing its own work shares its own blind spots, and that is
the one weakness the rest of the pipeline cannot compensate for. The second is
**measuring the pipeline at all** — without accept rates and reject reasons,
every other improvement here is unfalsifiable.

---

## 7. Design debt (what I would fix next, and why)

Nothing below is hypothetical. Each one is a real weakness in the system as
written, and each one is here because a system described only by its strengths
is not described honestly.

### 7.1 Three sources of truth for section configuration

Section order, question count, and time limit are declared in
`_shared/utils.ts` (`SECTION_CONFIG`), mirrored in `ExamBuilder.jsx`
(`SUBJECTS`), and mirrored again in a database table. They agree, and nothing
makes them agree. Changing a section's time limit in one place and not the
others produces a disagreement between what the builder promises and what the
clock enforces — which the student discovers mid-exam, in the worst possible
place to discover it.

The fix is to make the database the single source and have both the edge
functions and the client read it, accepting one extra round-trip at section
start in exchange for the invariant. The reason it was not done that way first
is uninteresting but worth saying: the constant existed before the table did.

### 7.2 Taxonomy drift between bank and blueprint

`questions.subject` is free text. `ExamBuilder.SUBJECTS` maps a fixed set of
subject strings into the six exam sections, and the AI generator keeps its own
`VALID_SUBJECTS` list. A subject that exists in the bank but in neither list is
content that can never be auto-picked into an exam and can never be generated
for — it is invisible rather than broken, which is worse.

The structural fix is a `subjects` table with a foreign key from `questions`,
and section membership as a column on it. Free-text taxonomy keyed across three
independent lists is the single largest source of silent inconsistency in this
schema, and §5's distinctive-subject bug was the same root cause wearing a
different hat.

### 7.3 A status the schema does not accept — and it fails the whole batch

`questions_status_check` permits `active`, `draft`, and `retired`. The AI upload
path correctly lands generated items as `draft`, but when `validateMathItem`
finds an arithmetic problem it escalates that row to `needs_human_review`
(`useQuestionGeneration.js`) — a value the constraint rejects.

The upload is a single bulk `POST` of the whole wave, so one escalated row takes
the entire batch down with a `23514`. The failure mode is exactly inverted: the
items the system was *least* sure about are the ones that prevent any of them
being saved, and the error surfaced to the teacher is a raw Postgres constraint
string.

Two things are wrong and both are worth stating. The state is real and belongs
in the constraint — a generated item that failed numeric validation genuinely
has a different status from a hand-authored draft, and the schema should say so.
And a bulk insert of independently-valid rows should not be all-or-nothing;
per-row results are what the CSV importer already does well
(`src/questionImport.js`), and the AI path should borrow it.

### 7.4 Nothing measures whether review actually happens

Both ingest paths now gate correctly — the importer forces `draft` regardless of
what the sheet claims, and the generator writes `draft` by design. What does not
exist is any evidence that the gate is used. There is no review queue, no
reviewer attribution, no record of who activated an item or when, and no way to
distinguish an item a human read and approved from one that was bulk-activated
to unblock an exam build.

A gate nobody can audit is a convention, not a control. The missing piece is
small — a `reviewed_by` / `reviewed_at` pair and a filtered queue view — and
until it exists, "a human approves every item" is a claim this system cannot
actually support.

### 7.5 A parser bug papered over by a prompt rule

`mathParser2.jsx` treats `or` as an operator token, so it mangles any word
containing that substring — "chord" being the one that actually came up. Rather
than fix the tokenizer, a prompt rule was added instructing the model to emit
the word with an invisible word joiner inside it.

That workaround now sits in generated content, which means the fix is no longer
free: correcting the parser also means finding and normalising everything
written while the workaround was in force. It is a small, clean illustration of
why you fix the layer that is wrong rather than the layer that is convenient.

### 7.6 No generation telemetry

Nothing records how many generated items are accepted, which lint rule or
verification failure rejected the rest, or the cost per accepted item. The
pipeline's quality is therefore an impression rather than a measurement, and
every improvement to it — a different verifier model, a second verification
pass, higher reasoning effort — is unfalsifiable. Logging lint and verify
outcomes is cheap and should have come before any of the tuning.

---

## 8. Rendering subsystem (why there are four files)

Rendering a question is harder than it looks and the code reflects that.

| File | Job |
|---|---|
| `mathContent.jsx` (1,034) | Decides whether a string is math, and how to render it |
| `mathParser2.jsx` (444) | Plain-text math (`x^2`, `sqrt(x)`, `1/2`) → structured output |
| `questionText.jsx` (125) | `QuestionWithUnderline` — underlines the phrase referenced by the stem |
| `visualContent.jsx` (334) | `VisualAssetPreview` — picks a viewer from the storage-path extension (image / svg / pdf / video / audio / file) |
| `questionExport.js` (520) | CSV, HTML, and DOCX export with passages and images inlined |

`npm run build` runs `scripts/assert-svg-rendering-nondestructive.mjs` first —
a guard that fails the build if an SVG-rendering change would destroy existing
content. Keep that guard.

---

## 9. Security model in one paragraph

The browser holds the **anon key** plus a user JWT. Every PostgREST call goes
out under that JWT and is filtered by RLS. Anything that must not be
client-trusted — reading `correct_answer`, grading, writing scores, calling
Anthropic — happens inside an edge function that holds the **service-role key**
and bypasses RLS. Edge functions authenticate the caller with a *user* client
first (`authenticateUser`), then act with the *admin* client. That two-client
pattern (`_shared/utils.ts:50`) is applied consistently across all 14
functions.

The part worth stating plainly is the division of labour. RLS decides *which
rows* a caller may see; the edge functions decide *which columns and which
transitions* are legitimate. An answer key is not protected by a row policy,
because the row is one a student is entitled to read — it is protected by
`get-question-bundle` projecting the column away before responding. Likewise a
section's time limit is not protected by a policy, because the client is allowed
to know it; it is protected by the clock living server-side, where a client
cannot edit it. Row-level security alone would not have been enough for either.

---

## 10. Where to change what

| I want to… | Touch |
|---|---|
| Change section order, count, or time | `_shared/utils.ts` `SECTION_CONFIG`, `ExamBuilder.jsx` `SUBJECTS`, and `section_time_limits` — all three |
| Change the exam blueprint | `ExamBuilder.jsx` `RECOMMENDED_BLUEPRINT` |
| Change scoring weights | `scoring_models` table (no deploy needed) |
| Change scoring *logic* | `_shared/scoring-engine.ts`, then redeploy `finalize-exam` |
| Change how AI writes questions | `_shared/prompt-rules.ts` (style) or `get-practice-questions/generate.ts` (structure) |
| Change the AI model | `ANTHROPIC_MODEL` secret on the Supabase project |
| Add a question field | migration → `App.jsx` form + detail → `questionExport.js` → `get-question-bundle` select |
| Add a dashboard tab | `App.jsx` `view` state + nav button + render branch |

---

## 11. Deploying

```bash
# Frontend
npm run build          # runs the SVG guard, then vite build
                       # Vercel builds from git on push

# Edge functions (per function)
supabase functions deploy <name> --project-ref <your-project-ref>

# Migrations
supabase db push       # or paste into the Supabase SQL editor
```

Function secrets live in the Supabase dashboard, not `.env`:
`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_ANON_KEY`, `SUPABASE_URL`, optionally `CORS_ALLOWED_ORIGIN`.

`supabase-setup-question-visuals.sql` is a **one-time** script that must be run
as `postgres` in the SQL editor. It has already been run — the
`question-visuals` bucket exists and is public.
