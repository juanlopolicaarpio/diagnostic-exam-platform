# Question Generation Guide — deepening the bank by hand

The working procedure for bringing a thin subtopic up to a usable depth of
items, safely and reversibly.

## Goal
Every subtopic that appears on the active diagnostic should have **at least 20
active questions** behind it in the `questions` table, so the exam builder has
room to vary difficulty and avoid repeating items across attempts. Work
thinnest-first: the subtopic with the fewest items is the one constraining the
blueprint.

## Database
- Supabase REST. Creds in `.env`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
- Auth: POST `${url}/auth/v1/token?grant_type=password` with the admin email/pass,
  use the returned `access_token` as `Authorization: Bearer`. (Anon key alone is
  RLS-limited; the admin login is what existing scripts use — copy `apiConfig()`
  from any `scripts/audit-*.mjs` or `scripts/insert-*.mjs`.)
- Table: **`questions`**. Columns used:
  `id` (uuid, generate with `crypto.randomUUID()`), `source_school` ("UPCAT" or
  "ACET"), `subject`, `topic`, `subtopic`, `difficulty_level` ("easy"|"medium"|"hard"),
  `question_text`, `render_markup` (null), `choice_a`..`choice_d`, `choice_e` (null),
  `correct_answer` ("a".."d", lowercase), `stimulus_id`/`instruction_id` (null unless
  attaching a passage), `status` ("active"), `svg_content` (null).
- Exam wiring lives in `diagnostic_templates` / `diagnostic_template_questions`.
  **Bank-only work does NOT touch those** — new questions just deepen the pool.

## Find thin subtopics
Join the active template's questions to get its subtopics, then count active rows
per `(subject, topic, subtopic)` in `questions`, resolving the active template by
`is_active = true and is_primary = true` rather than by a hardcoded id. See
`scripts/diagnostic-topic-bank-counts.mjs`.

## Formatting conventions (match existing rows)
- Inline math in `\( ... \)`. Use `\dfrac`, `\tfrac`, `\sqrt`, `\triangle`, `\cong`,
  `\angle`, `\displaystyle\lim_{x\to a}`. Degrees: `°` inline works (existing rows use it).
- **Do NOT** put a currency symbol inside math (`\₱` is invalid KaTeX and renders an
  error). Write amounts as plain text: `300 pesos`.
- Choices are plain strings or `\(...\)`. `choice_e` stays null (4 options).
- No `console.log` debugging in `src/` app code; scripts in `scripts/` are fine.

## Difficulty calibration (STRICT — this was the main review complaint)
Rule of thumb: **one move = easy**.
- **easy**: one operation — direct substitution, single formula plug-in, read-off
  (slope from `y=mx+b`, a circle's center/radius), one-step solve/inequality, a basic
  mean/median/mode/range, recalling/identifying one postulate, a non-indeterminate limit.
- **medium**: 2 steps or pick-a-method — line through two points (slope then intercept),
  parallel/perpendicular then write the equation, sign-flip inequality, 0/0 limit solved
  by factoring, weighted/combined mean, mean-after-removal, CPCTC angle via angle-sum,
  reasoning about which postulate a configuration satisfies.
- **hard**: 3+ steps / system / non-obvious technique — compound inequality, conjugate
  (rationalizing) limit, recover a linear function from two outputs, solve across two
  configurations with a twist, two-equation systems, a multi-step proof argument.
Do NOT label a single formula application "hard," and do NOT label direct substitution
or basic recall "medium."

## Distractor design
Every wrong option should be a **plausible mistake**, not filler:
- sign error / dropped negative, forgot to flip the inequality, used reciprocal instead
  of negative reciprocal, swapped numerator/denominator, used the non-included angle,
  off-by-one on the formula, picked the spread measure when asked for center, etc.
- Avoid a distractor that is itself arguably correct.

## Distinct purpose
No two items in a subtopic should test the same single move. Spread across the
sub-skills of the subtopic (e.g., Linear Functions: slope, intercepts, parallel,
perpendicular, inequality sign-flip, compound inequality, modeling/word problem,
function-from-outputs).

## English specifics (SAT/UPCAT style, NOT label drills)
- Test through **usage and sentence correction**, not "what is a gerund / functions as
  a ___" metalanguage. Use stems like "Choose the grammatically correct sentence,"
  "Which revision best corrects…," "Choose the most concise/precise option."
- Known caveat: "best corrects / most formal" stems that hinge on strict prescriptive
  rules can have an arguably-acceptable "wrong" answer — keep the qualifier so the
  intended key is defensible.
- Realism: a pile of isolated single-rule items reads like an AI grammar drill. Prefer
  variety and, where possible, short stimulus-based items closer to a real exam section.

## Answer-position balance
Spread `correct_answer` roughly evenly across a/b/c/d within a subtopic. After
generating, count keys; if one letter clusters (e.g., 11×"b"), permute choices.

## Workflow (safe + reversible)
1. Author items in a `scripts/<name>.mjs` generator: array of `{d,q,a,b,c,dd,k}`.
2. **Dry-run first** (default), `--apply` to commit. Make it idempotent: skip inserts
   whose `question_text` already exists in that subtopic.
3. Generate `id` per row; on apply, save inserted ids to
   `scripts/<name>.inserted.json` (rollback) and any edited rows' prior state to
   `scripts/<name>.before.json`.
4. **Verify numeric answers in code** where possible (compute and assert) before apply.
5. Re-run `node scripts/track-added-questions.mjs` (add your `.inserted.json` to its
   `ROLLBACK_FILES`) to refresh `added-questions-log.json/.md`.
6. Re-count the subtopic to confirm it hit 20 and check the E/M/H + answer spread.
