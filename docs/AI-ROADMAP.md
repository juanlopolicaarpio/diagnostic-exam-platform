# AI Roadmap — Generation, QA, and In-App Assistants

This is a design document, not an implementation. It explains *why* each piece
is shaped the way it is so you can build it yourself and defend the choices.

Read `ARCHITECTURE.md` §6 first for how the current pipeline works.

---

## Part 0 — Principles that apply to every agent here

Four rules, learned from the generator we already have:

1. **Never trust free-form model output.** Force a schema. Every Anthropic call
   in this codebase uses forced tool use, so parsing can't fail. Keep that.
2. **Separate the writer from the judge.** A model reviewing its own work shares
   its own blind spots. The generator's blind-solver pass is right in shape;
   its weakness is that generator and verifier are the same model.
3. **Deterministic checks before model checks.** Linting is free, instant, and
   catches the majority of garbage. Only spend tokens on what survives.
4. **The teacher is the last gate, always.** Agents propose; humans dispose.
   Nothing an agent produces should reach students without a human click.

### Model choice

Everything in this repo currently runs `claude-sonnet-4-6` — two generations
old. The current default should be **`claude-opus-5`** (1M context, adaptive
thinking, $5/$25 per MTok). It is materially better at multi-step math and at
judging its own work, which is exactly what item generation and QA need.

For this codebase specifically:

```ts
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-opus-5";
```

Notes that matter when you migrate:

- **Thinking is on by default** on Opus 5. `max_tokens` caps thinking *plus*
  response text together, so the current `max_tokens: 8192` needs raising —
  use 16000+ (and stream anything above ~16000).
- `temperature`, `top_p`, `budget_tokens` are **rejected with a 400** on Opus 5.
  None of them appear in `generate.ts` today, so nothing to remove.
- Control depth with `output_config: { effort: "..." }` instead. Suggested:
  `high` for generation, `xhigh` for verification and QA (correctness matters
  more than cost there), `low` for the chat assistants.
- The prompt-cache minimum drops to **512 tokens** on Opus 5. The 14-example
  grounding block is well over that — cache it (§1.3).

Consider **`claude-haiku-4-5`** for the cheap, high-volume paths (the chat
assistant's routing turn), and keep the expensive model for judgment.

---

## Part 0.5 — Straight answer: are the agents we run today actually solid?

**One agent exists today: the question generator. It is solid in structure and
mediocre in configuration.** No hedging — here is the split.

### What is genuinely good (not marketing)

| | Why it actually matters |
|---|---|
| **Forced tool-use schema** | Output cannot be malformed. No regex parsing of prose, no "the model returned markdown" class of bug. This is correct and most in-house pipelines get it wrong. |
| **Blind-solve verification** | The verifier never sees the claimed answer. It has to independently arrive at the same letter, assert exactly one option is defensible, and not be low-confidence. This is the difference between a generator and a slop machine, and you already have it. |
| **Retrieval grounding** | Up to 14 real bank items from the same subtopic, including 4 real SVGs when the scope is visual. The model imitates your house style instead of inventing one. |
| **Deterministic lint before the model** | Duplicates, identical choices, unsafe SVG, and short stimuli are killed for free, before spending a token on verification. |
| **Over-generation + retry** | Asks for more than it needs and re-runs only the unfilled difficulty slots. Attrition is expected rather than fatal. |

That set of five is a genuinely above-average pipeline. If someone asks whether
you are "just calling ChatGPT and hoping", the blind-solve gate is the answer.

### What is not solid — the honest list

**1. Generator and verifier are the same model.** This is the real weakness.
`callAnthropic` uses one `MODEL` const for both passes. A model that makes an
arithmetic slip while writing an item is meaningfully likely to make the same
slip while checking it, then confidently confirm its own wrong key. The blind-
solve design is right; the independence is fake. *Fix: §1.1.*

**2. The model is two generations old.** `claude-sonnet-4-6`. The current
default should be `claude-opus-5`. This matters most on exactly the items where
verification fails silently — multi-step maths and science. *One env var.*

**3. Verification is a single pass.** One judgment per item. Two independent
passes disagreeing is the cheapest possible signal that an item is ambiguous,
and you are not collecting it. *Fix: 3 passes, majority vote — §2.2 already
assumes this for QA.*

**4. Nothing checks the arithmetic.** The verifier returns a letter, not a
worked solution. There is no point at which a number is actually recomputed.
*Fix: §1.2.*

**5. `validateMathItem` runs only in the browser.** The engine itself never
calls it, so the practice-question top-up path — which writes to the bank with
no human in the loop at all — has no math validation whatsoever.

**6. You have no idea how well it works.** No logging of accept rate, reject
reasons, or cost per accepted item. Every claim about quality in this document,
including mine, is reasoning about the code rather than measurement. *Fix: §1.5
— and do it before the model upgrade, so you can tell whether the upgrade
helped.*

**7. SVG is verified as source, not as a picture.** The blind solver reads the
`<svg>` markup. A diagram that is syntactically valid and semantically
answerable but visually broken — overlapping labels, a line off-canvas — passes.
There is no rendering step in the loop.

### The verdict

The **architecture** is right and I would defend it in a review: schema-forced
generation, deterministic lint, independent blind-solve, retry on attrition,
human approval before activation. Most teams building this ship a single
`generate()` call and a `JSON.parse`.

The **execution** has one structural flaw (shared model between writer and
judge) and one embarrassing gap (no measurement). Neither is expensive to fix —
§1.1 is roughly ten lines and §1.5 is one table.

What you should not say is "our AI questions are verified". What you can say
truthfully today is: *"every generated item is grounded in real bank questions
from the same subtopic, deterministically linted, and then independently
re-solved by a model that never sees the proposed answer. Items that fail are
discarded, and everything that survives lands as a draft for teacher review."*
That is accurate and it is a strong claim.

---

## Part 1 — Fixing the generator (do this before adding anything new)

Five changes, in priority order. Each is small.

### 1.1 Split the verifier from the generator

The single highest-leverage change. Right now `generateCandidates` and
`verifyCandidates` both call `callAnthropic` with the same `MODEL`. Give the
verifier its own:

```ts
const GEN_MODEL    = Deno.env.get("ANTHROPIC_MODEL")   || "claude-opus-5";
const VERIFY_MODEL = Deno.env.get("ANTHROPIC_VERIFIER") || "claude-opus-5";

async function callAnthropic(apiKey, model, toolName, schema, system, user) { … }
```

Then run verification at higher effort than generation. Even with the same model
ID, a fresh context that never saw the generation prompt is a meaningfully
independent judge; with a different model it is genuinely independent.

### 1.2 Add a solve-and-check pass for math

The blind solver picks a letter. It does not show its work, so an arithmetic
slip in generation can be matched by the same slip in verification. Extend the
verifier schema for math/science:

```ts
solutions: [{
  index, chosen, single_correct, confidence,
  worked_solution: string,        // NEW — the steps
  computed_value:  string | null, // NEW — the final numeric answer
}]
```

Then assert `computed_value` actually matches the text of the chosen choice.
That is a deterministic check on a model-produced value — cheap, and it catches
the failure mode that currently leaks.

### 1.3 Cache the grounding block

`exampleBlock(examples)` can run to several thousand tokens and is identical
across the 4 retry attempts and across every batch for the same scope. Put the
system prompt and examples before a `cache_control` breakpoint and the varying
instruction after it. Cache reads cost ~0.1× — this is close to free money on a
retry loop.

### 1.4 Stop auto-activating AI output — **DONE**

Uploads now land as `status: "draft"`
(`src/useQuestionGeneration.js`). Nothing AI-written reaches a student without a
human moving it to `active`. This is what makes a QA workflow possible at all.

Also done, same pass: batch size is no longer pinned to 10. The edge function
enforces `MAX_BATCH = 15` per invocation as a timeout guard, and the client
requests larger batches as successive waves (`planWaves`), so 40 questions is
four calls, not one call that dies at the edge timeout. Generation state lives
in `App`, so switching tabs no longer kills a running batch.

### 1.5 Log the funnel

You currently cannot answer "how good is the generator?" Record, per batch:
scope, model, requested count, candidates returned, lint rejections **by
reason**, verify rejections **by reason**, accepted count, tokens in/out. A
small `ai_generation_runs` table. Without this, every future tuning decision is
a guess.

---

## Part 2 — The QA agent

### 2.1 Scope: the teacher chooses, always

The QA agent **never** runs over the whole bank on its own. The teacher picks
what to review:

- a **subtopic** — "QA all 14 questions in Algebra › Factoring"
- a **topic** — "QA everything in Algebra"
- a **selection** — tick specific rows in the bank and QA those
- **the current filter** — whatever the bank is showing right now

This matters for three reasons. Cost is bounded and predictable. The teacher
reviews a coherent set, so they build a feel for one area instead of context-
switching across nine subjects. And a scoped run finishes in a minute, so it
fits into how someone actually works.

The bank already has subject/topic/subtopic filters and row selection, so the
scope picker is the existing filter state plus `selectedIds` — no new UI
concepts.

### 2.2 The three questions it answers

Per the spec, every reviewed question gets judged on exactly three things. Keep
it to three: a rubric with twelve axes produces mush.

**1. Does the difficulty label match reality?**

`difficulty_level` is load-bearing — `ExamBuilder`'s `DIFFICULTY_TARGETS` builds
every exam from it, and the scoring engine weights by it (easy 1.0 / medium 1.5
/ hard 2.0). A mislabelled item corrupts both. The bank is currently 54% medium,
which is roughly what you'd expect if a lot of items were labelled by default.

The agent solves the item and reports the number of genuine reasoning steps
required, then maps that to the same definition the generator prompt already
uses:

> Easy = one direct move. Medium = two steps, interpretation, or method choice.
> Hard = three or more steps, deeper inference, a system, or a non-obvious
> technique.

Output: `{ assessed: "easy"|"medium"|"hard", steps: n, matches_label: bool }`.
Reusing the generator's own wording is deliberate — QA and generation must not
drift apart on what "hard" means.

**2. Is it a good question?**

Blind-solve first (the model never sees the claimed key), then judge:

- **key_correct** — does the blind answer match `correct_answer`? This is the
  one that finds genuinely broken items.
- **single_defensible_answer** — or are two options arguable?
- **distractor_quality** — do the wrong options represent real mistakes, or are
  they filler?
- **stem_clarity** — is it answerable as written, without giving itself away?
- **answerable_from_source** — for reading items, from the passage alone; for
  SVG items, from the figure.

**3. Is it AI slop?**

Specific and worth its own axis, because 309 items are AI-written and the
failure modes are recognisable:

- **Label leakage** — the stem names the skill being tested ("identify the
  misused sequence marker"). `_shared/prompt-rules.ts` bans this in generation;
  QA should catch what slipped through.
- **Formulaic stems** — ten questions in a subtopic all opening "Which of the
  following best describes…".
- **Tell-tale distractors** — one obviously-correct option and three
  throwaways; "all of the above"; the longest option being correct every time.
- **Generic filler context** — invented scenarios with no bearing on the maths.
- **House-style drift** — reads nothing like the UPCAT/ACET items around it.

Output: `{ slop_score: 0-5, signals: [...] }`. Slop is not "wrong", so it never
blocks — it sorts.

### 2.3 Cheap checks first

Before spending a single token, run deterministic checks in plain JavaScript.
They are free, instant, and will find real problems in your existing bank today:

- duplicate / near-duplicate stems within the scope (reuse `normalise` from
  `generate.ts`)
- choices identical after normalisation
- answer-position skew (if 60% of a subtopic answers "c", something is wrong)
- malformed or unsafe SVG (`svgLooksSafe` already exists)
- stimulus present but under 250 chars
- subject/topic/subtopic not in the taxonomy — this alone flags the 137
  orphaned Humanities/Literature rows
- math that `mathParser2` cannot parse — reuse `validateMathItem`
- "all of the above" / "none of the above"
- longest-choice-is-correct pattern across the scope

**Build this first.** It costs nothing and it is the honest baseline against
which you measure whether the model pass adds value.

### 2.4 Where it runs

Not in the browser — reuse the pattern that already works for generation.

```
New table:  question_qa_reviews
  question_id      uuid  → questions(id)
  reviewed_at      timestamptz
  model            text
  difficulty       jsonb   -- {assessed, steps, matches_label}
  quality          jsonb   -- {key_correct, blind_answer, single_defensible,
                             --  distractor_quality, stem_clarity, notes}
  slop             jsonb   -- {score, signals[]}
  verdict          text    -- clean | suspected_wrong_key | ambiguous
                           -- | difficulty_mismatch | weak_distractors | slop
  severity         int     -- 1..5, drives queue order
  suggested_fix    jsonb   -- proposed patch, NEVER auto-applied
  resolved_by      uuid
  resolution       text    -- accepted | rejected | edited | deferred
  primary key (question_id, reviewed_at)

New edge function:  qa-review-batch
  POST { question_ids: [...] }        -- explicit selection, ≤ 10 per call
  → deterministic checks, then one blind-solve call, then one judge call
  → writes question_qa_reviews, returns the rows
```

Note the shape mirrors `generate-question-batch` exactly: **bounded work per
invocation, client loops in waves.** Ten questions per call, two model round
trips, well inside the timeout. Reuse `planWaves`-style chunking and the same
progress UI — including surviving a tab switch. Do not write a "QA the whole
topic in one call" endpoint; it will time out and lose everything.

Re-running a scope inserts new rows rather than mutating old ones, so you keep
history and can see whether a prompt change improved things.

### 2.5 The dashboard tab

A sixth `view` in `App.jsx`.

```
┌─ QA ──────────────────────────────────────────────────────────┐
│  Scope  [Subject ▾][Topic ▾][Subtopic ▾]   or  12 selected     │
│         14 questions in scope          [ Run QA ]              │
│         ▓▓▓▓▓▓▓▓░░░░  wave 2/2 · 10/14 reviewed                │
├───────────────────────────────────────────────────────────────┤
│  ● 2  suspected wrong key          ← always first              │
│  ● 3  difficulty mismatch                                      │
│  ● 4  weak distractors                                         │
│  ● 1  AI slop                                                  │
│  ● 4  clean                                                    │
├───────────────────────────────────────────────────────────────┤
│  Q #a3f2…   Algebra › Factoring        labelled: hard          │
│  [question renders exactly as a student sees it]               │
│                                                                │
│  Key            says (c) · blind solve chose (a)      ✗         │
│  Difficulty     assessed easy (1 step) vs labelled hard  ✗      │
│  Distractors    3/5 — (b) and (d) are not plausible             │
│  Slop           1/5 — no signals                                │
│                                                                │
│  "Factoring x²−5x+6 gives (x−2)(x−3), so the roots are 2 and    │
│   3 — choice (a). Choice (c) matches x²+5x+6."                  │
│                                                                │
│  [Apply fix] [Edit manually] [Mark OK — AI wrong] [Skip]        │
└───────────────────────────────────────────────────────────────┘
```

Decisions worth defending:

- **"Mark OK — AI wrong" is a first-class button.** It records that the agent
  was wrong, and those records are your eval set for tuning the QA prompt.
  Without it you have no feedback loop and no way to know if QA is any good.
- **Sort by severity.** A wrong answer key and a bland distractor are not the
  same problem.
- **Reuse the bank's render components** so the reviewer sees exactly what a
  student sees — `MathContent`, `ChoiceContent`, `QuestionWithUnderline`,
  `VisualAssetPreview`.
- **Never bulk-apply.** One question, one human decision. The agent proposes.

### 2.6 Build order

1. Deterministic checks in plain JS, run over a chosen scope. Free.
2. `question_qa_reviews` migration.
3. `qa-review-batch` edge function — deterministic + blind-solve + judge.
4. The QA tab, reusing the generator's wave/progress pattern.
5. Feed the generator's own verify pass into `question_qa_reviews`, so every AI
   question arrives with a QA record already attached.

### 2.3 Where it runs

Not in the browser. A QA sweep over a bank of several thousand questions cannot live in a tab.

```
New table:  question_qa_reviews
  question_id      uuid  → questions(id)
  reviewed_at      timestamptz
  model            text
  tier             int          -- 0 | 1 | 2
  verdict          text         -- clean | low_confidence | ambiguous
                                -- | suspected_wrong_key | quality_issue
  confidence       numeric
  scores           jsonb        -- the rubric, tier 2 only
  issues           jsonb        -- [{type, severity, detail}]
  suggested_fix    jsonb        -- proposed patch, NEVER auto-applied
  resolved_by      uuid         -- admin who dispositioned it
  resolution       text         -- accepted | rejected | edited | deferred
  primary key (question_id, reviewed_at)

New edge function:  qa-review-batch
  POST { question_ids[] } or { scope: {subject, topic, subtopic}, limit }
  → runs tiers, writes question_qa_reviews, returns a summary
```

Call it in chunks of 25–50 from the dashboard so each invocation stays inside
the function timeout, and drive a progress bar off the chunk count. Idempotent
by design: re-running a scope writes new rows rather than mutating old ones, so
you keep a history.

### 2.4 The dashboard tab

A sixth `view` in `App.jsx`, alongside bank / builder / quizzes / categories /
generator.

```
┌─ QA ──────────────────────────────────────────────────────────┐
│  Coverage      412 / 1,850 reviewed        [ Run QA on scope ] │
│  Scope       [Subject ▾] [Topic ▾] [Subtopic ▾]  Tier [0│1│2]  │
├───────────────────────────────────────────────────────────────┤
│  ● 23   suspected wrong key      ← start here                  │
│  ● 61   ambiguous / 2 defensible answers                       │
│  ● 140  weak distractors                                       │
│  ● 89   difficulty mislabelled                                 │
│  ●  7   unrenderable math / broken SVG                         │
├───────────────────────────────────────────────────────────────┤
│  Queue (sorted by severity)                                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Q #a3f2…  Math › Algebra › Factoring          hard       │  │
│  │ Key says (c). Blind solve: 3/3 chose (a).                │  │
│  │                                                           │  │
│  │ [full question renders here, same components as the bank] │  │
│  │                                                           │  │
│  │ AI reasoning:  "Factoring x²−5x+6 gives (x−2)(x−3),       │  │
│  │  so the roots are 2 and 3 — choice (a). Choice (c)        │  │
│  │  corresponds to x²+5x+6."                                 │  │
│  │                                                           │  │
│  │ Suggested fix: set correct_answer = "a"                   │  │
│  │ [Apply fix] [Edit manually] [Mark OK — AI wrong] [Skip]   │  │
│  └──────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

Design decisions worth defending:

- **"Mark OK — AI wrong" is a first-class button.** It records that the agent
  was wrong. Those records are your eval set for tuning the QA prompt. Without
  it you have no feedback loop.
- **Sort by severity, not by ID.** A wrong answer key is a different category of
  problem from a mediocre distractor.
- **Reuse the existing render components** (`MathContent`, `ChoiceContent`,
  `QuestionWithUnderline`, `VisualAssetPreview`) so the reviewer sees exactly
  what a student sees.
- **Never bulk-apply.** One question, one human decision.

### 2.5 Build order

1. Tier 0 in plain JS, run over the whole bank, render the results. **Do this
   first** — it costs nothing and will probably surface a few hundred real
   issues before a single token is spent.
2. `question_qa_reviews` table + migration.
3. `qa-review-batch` edge function, Tier 1 only.
4. QA dashboard tab reading `question_qa_reviews`.
5. Tier 2 rubric, applied to flagged items.
6. Wire the generator's own verify step to write a Tier-1 row, so every AI
   question arrives with its QA record already attached.

---

## Part 3 — In-app AI assistants

You want an assistant "in most parts of the app". The trap is building one
chatbot that floats over everything and knows nothing. The alternative is a
small set of **scoped assistants**, each with a narrow tool surface and real
context about what the teacher is looking at.

### 3.1 The shared skeleton

Build this once and reuse it four times.

```
Browser                          Edge function            Anthropic
───────                          ─────────────            ─────────
<AssistantPanel                  ai-assistant
  context={…}                      · authenticate user
  tools={…} />                     · look up the assistant profile by `surface`
     │                             · assemble system prompt + context
     │  POST {surface, context,    · loop: call Claude, run any tool,
     │        messages}              feed results back
     └───────────────────────────►  · return the final message + any
                                      proposed actions
```

Key decisions:

- **One edge function, many profiles.** `surface: "exam_builder" | "generator"
  | "qa" | "bank"` selects the system prompt and the allowed tool list. Don't
  build four functions.
- **Read tools run server-side and freely. Write tools are proposals.** The
  function returns `{proposed_actions: [...]}`; the browser renders them as
  buttons the teacher clicks. The agent never writes to `questions` or
  `diagnostic_template_questions` directly.
- **Context is passed explicitly, not inferred.** The panel sends what the
  teacher is looking at — the current blueprint, the selected question, the
  current filters. That is the difference between a useful assistant and a
  generic chatbot.
- **Use the SDK's tool runner**, not a hand-written `while (stop_reason ===
  "tool_use")` loop. It handles the loop, and its per-turn hooks are where you
  put the approval gate.

### 3.2 The four surfaces

#### Exam Builder assistant — the highest-value one

The blueprint UI is powerful and genuinely hard to drive. This assistant makes
it conversational.

*Context:* current blueprint, current selections, per-slot fill status, bank
counts for each slot.

*Read tools:* `get_bank_coverage(subject, topic, subtopic, difficulty)`,
`compare_to_recommended_blueprint()`, `find_candidates(slot)`.

*Proposals:* `set_topic_count`, `set_difficulty_split`, `swap_question`,
`autofill_section`.

Conversations it should handle:

> "Why can't I fill the hard Geometry slots?"
> → *The bank has 4 hard Geometry items and 3 are already used in
> DIAGNOSTIC-EXAM-1. Options: reduce hard Geometry from 5 to 2, pull 3 from
> Trigonometry, or generate 5 new ones.* **[Open generator for Geometry/hard]**

> "Make this exam harder overall."
> → *Shifts 8 medium slots to hard across Math and Science, staying inside
> section totals.* **[Apply]** **[Show me the diff]**

#### Question Generator assistant

Today the teacher types free text into `standards` and hopes. The assistant
turns intent into a proper batch plan.

*Context:* selected scope, difficulty split, current drafts, existing stems in
scope.

Conversations:

> "I want 10 questions on quadratic word problems, nothing that's just plug the
> formula."
> → sets the split, writes precise `extraInstructions`, then reviews the returned
> drafts and flags any that *are* plug-in items before the teacher sees them.

> "Question 4 feels too easy for 'hard'."
> → routes into the existing `mode: "improve"` path with a specific request.

#### QA assistant

Sits inside the QA tab, on the currently-open flagged question.

> "Explain why this is flagged."
> "Are (b) and (d) really both correct?"
> "Rewrite (c) so it's a plausible distractor without being correct."

Every rewrite comes back as a proposal, and passes through the *same* lint +
blind-solve gate as generated questions before the teacher can apply it. Reuse
`passesLint` and `verifyCandidates` — don't write a second quality bar.

#### Question Bank assistant

*Context:* current filters, result count.

> "Show me every Reading question attached to a passage with fewer than 3
> questions." → translates to filters and applies them.
> "How is Science distributed by difficulty?" → runs counts, answers in prose.

Read-only. Lowest risk, cheapest to build — a good first one to ship.

### 3.3 Build order

1. **QA assistant first.** It has the tightest scope, the clearest value, and it
   forces you to build the skeleton on a low-risk surface.
2. **Bank assistant** — read-only, proves the context-passing pattern.
3. **Generator assistant** — reuses the existing generate/improve endpoints.
4. **Exam Builder assistant** — highest value, most surface area, build it once
   you trust the skeleton.

### 3.4 Things that will bite you

- **Context assembly is most of the work.** The prompt is easy; deciding what
  the assistant should know about the teacher's current screen is the design
  problem. Budget your time accordingly.
- **Cache the stable prefix.** System prompt + tool definitions + taxonomy are
  identical every turn. Put the breakpoint after them, before the conversation.
- **Cost.** Four always-available assistants across a teacher's session adds up.
  Route trivial turns to a cheap model; reserve the expensive one for judgment.
- **Failure is normal.** Show what the assistant tried and what it got back. An
  assistant that silently does nothing is worse than no assistant.
- **Never let an assistant edit a live question directly.** Proposal → human
  click → the same validation path as everything else. This is the rule that
  keeps the system defensible.

---

## Part 4 — Suggested sequence

| Phase | Work | Why now |
|---|---|---|
| 0 | Generator fixes §1.1–1.5 | Small, high-leverage, and §1.4 unblocks all QA work |
| 1 | QA Tier 0 | Free; will surface real problems immediately |
| 2 | QA table + edge function + tab | The review workflow the bank has never had |
| 3 | Assistant skeleton + QA assistant | Proves the pattern on the safest surface |
| 4 | Remaining three assistants | Value order: exam builder > generator > bank |
