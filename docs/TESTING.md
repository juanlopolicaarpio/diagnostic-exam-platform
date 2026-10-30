# Testing — from zero

Written for someone who has never written a test. Every example is real code
from this repo that you can run right now.

```bash
npm test              # everything (45 tests)
npm run test:scoring  # just the scoring engine (17)
npm run test:edge     # all Deno tests in _shared/
npm run test:watch    # re-run on save — use this while writing tests
```

---

## 1. What a test actually is

A test is a function that calls your code with known inputs and asserts the
output is what you expected. That is the whole idea. There is no magic.

Here is the smallest real one in this repo:

```ts
Deno.test("FitScore blends WPS and CTR by alpha/beta, on a 0-100 scale", () => {
  assertEquals(computeFitScore(0.8, 0.5, 0.7, 0.3), 71);
});
```

Three parts, and every test you ever write has the same three:

1. **A name** that says what should be true. Not `"test1"` — a sentence.
2. **A call** to your real function with inputs you chose.
3. **An assertion**: `assertEquals(actual, expected)`. If they differ, the test
   fails and prints both.

That's it. `deno test` finds every `Deno.test(...)` in the files you point it
at, runs them, and reports pass/fail.

## 2. Why bother

The honest answer, specific to this codebase: **you shipped two scoring bugs
that silently gave students wrong results for months.** Nobody noticed, because
wrong numbers look exactly like right numbers. A test would have caught both in
under a second.

Tests pay for themselves when:

- The code is hard to check by eye (scoring math — yes).
- The failure is silent (wrong FitScore — yes).
- You'll change it again later (you will).

Tests are *not* worth it for everything. Don't test that a button is blue.

## 3. Why we start with the scoring engine

Look at the top of `scoring-engine.ts`:

> This is a PURE FUNCTION library. It takes data in, returns results out.
> No database calls. No side effects. No Supabase client.

That is the single property that makes code easy to test. A pure function needs
no setup — no database, no login, no server. You hand it an array and check what
comes back.

Compare with `assemble-exam`: to test it you'd need a database, a user, a
template, and a way to undo everything afterwards. Same logical complexity,
100× the effort to test.

**The lesson that generalises:** when you want something to be testable, push
the decision-making into a pure function and leave only the plumbing in the part
that touches the world. The scoring engine already does this; `finalize-exam` is
just glue that fetches, calls the engine, and writes.

## 4. Anatomy of the real test file

Open `supabase/functions/_shared/scoring-engine.test.ts`.

### The imports

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { computeCTR, computeFitScore, /* … */ } from "./scoring-engine.ts";
```

Deno imports by URL — no `npm install`, no `node_modules`. The version is pinned
in the URL (`@0.208.0`) so the test can't break because someone upstream shipped
a change.

### Builders — the part that makes tests readable

A `GradedResponse` has 8 fields. If every test spelled all 8 out, the one field
that matters would be buried:

```ts
// Without a builder — what is this test actually about?
const r = { questionId: "q1", subject: "Mathematics", topic: "Algebra",
            subtopic: "Factoring", difficultyLevel: "medium",
            selectedAnswer: "a", correctAnswer: "a", isCorrect: true };
```

So the file defines a builder with sane defaults and lets each test override
only what it cares about:

```ts
function response(over: Partial<GradedResponse> = {}): GradedResponse {
  return { questionId: `q${++idCounter}`, subject: "Mathematics",
           topic: "Algebra", subtopic: "Factoring", difficultyLevel: "medium",
           selectedAnswer: "a", correctAnswer: "a", isCorrect: true, ...over };
}

// Now a test reads as its own intent:
response({ difficultyLevel: "hard", isCorrect: false })
```

`attempts(3, 4)` builds "4 questions, 3 right". Write these helpers as soon as
you find yourself copy-pasting setup. They are the difference between a test
suite people maintain and one they delete.

### A test that documents a decision

```ts
Deno.test("same subtopic name under a different subject is not merged", () => {
  const perfs = computeSubtopicPerformance([
    ...attempts(2, 2, { subject: "Mathematics", subtopic: "Data Analysis" }),
    ...attempts(0, 2, { subject: "Science", topic: "Biology", subtopic: "Data Analysis" }),
  ]);
  assertEquals(perfs.length, 2);
});
```

"Data Analysis" genuinely exists under both Mathematics and Science in your
bank. This test pins down that the grouping key is subject+topic+subtopic, not
subtopic alone. If someone "simplifies" that key later, this fails immediately
instead of quietly corrupting every importance-matrix lookup.

That's a big part of what tests are for: **they are executable documentation of
decisions you'd otherwise forget you made.**

### Boundary tests

```ts
assertEquals(tierFor(0.90), "Highly Ready");   // boundary, inclusive
assertEquals(tierFor(0.8999), "Ready");        // just under
```

Bugs cluster at boundaries. `>=` vs `>` is the single most common off-by-one in
scoring code. Whenever you see a threshold in code, test **exactly on it** and
**just below it**. Don't bother with 0.5 and 0.95 — those were never going to
break.

### Regression tests

```ts
Deno.test("REGRESSION: untested critical subtopics are excluded from the CTR denominator", () => {
```

This one exists because of a real bug. The comment above it explains the
symptom (BMA capped at CTR 0.62), so whoever hits this failure in two years
knows what it protects.

**Rule: every time you fix a bug, write the test that would have caught it, and
say so in the name.** This is the highest-value test you will ever write,
because you have proof the scenario happens.

## 5. Prove your test actually works

A test that has never failed is worthless — it might be asserting nothing.

Before you trust a new test, **break the code on purpose and watch it fail.**
We did exactly this for the CTR regression test. Reintroducing the old buggy
denominator:

```
REGRESSION: untested critical subtopics are excluded ... FAILED
FAILED | 16 passed | 1 failed
```

Then restoring the fix:

```
ok | 17 passed | 0 failed
```

That two-step is the only way to know a test is real. Do it every time.

## 6. Writing your first new test — a walkthrough

Say you want to cover `computeTopicScores`, which has no tests yet.

**Step 1 — read the function and decide what should be true.**
It aggregates responses by subject+topic with difficulty weighting. So: two
topics in, two rows out; a hard question should count more than an easy one.

**Step 2 — write the name first.**

```ts
Deno.test("topic scores split by topic and weight by difficulty", () => {
});
```

**Step 3 — write the assertion you wish were true, before the setup.**

```ts
assertEquals(scores.length, 2);
```

**Step 4 — build the minimum input that makes it meaningful.**

```ts
const scores = computeTopicScores([
  ...attempts(2, 2, { topic: "Algebra" }),
  ...attempts(0, 2, { topic: "Geometry" }),
], MODEL);
```

**Step 5 — run it.**

```bash
npm run test:watch
```

**Step 6 — break the code, confirm red. Restore, confirm green.**

Six steps, and notice the order: name, then assertion, then setup. Writing the
assertion first stops you writing a test that just describes whatever the code
already does.

## 7. What to test next, in order

1. **`computeTopicScores`, `rankClassifications`, `generateRecommendations`** —
   same file, same pattern, no new infrastructure. `rankClassifications`
   especially: it has a three-rule tie-break that just had a bug in it.
2. **`computeAllResults`** — a *golden test*: one realistic set of ~30 responses
   in, assert the whole result object. This is the single most valuable test in
   the system, because it locks the end-to-end contract that `finalize-exam`
   writes to eight tables.
3. **`passesLint` in `get-practice-questions/generate.ts`** — pure, and it is
   the AI pipeline's only deterministic quality gate. Test that it rejects
   duplicate choices, a bad `correct_answer`, an unsafe SVG, a short stimulus.
4. **`planWaves` in `src/useQuestionGeneration.js`** — pure; assert 25 questions
   becomes 3 waves and that no wave exceeds 10.
5. **`_shared/section-clock.ts`** — already has 12 tests. Read them; they are a
   good model for time-based logic.

Skip for now: React components (needs a DOM test runner — real setup cost, low
return here) and edge-function HTTP handlers (needs a live database).

## 8. Rules of thumb

- **One reason to fail per test.** If a test can break for three reasons, its
  failure message tells you nothing.
- **The name is the spec.** `"CTR threshold is inclusive at the boundary"` beats
  `"test CTR 3"`.
- **No logic in tests.** No `if`, no loops computing the expected value. If the
  test recomputes what the code does, it will happily agree with a bug. Hardcode
  `71`, don't write `0.7*0.8+0.3*0.5`.
- **Test behaviour, not implementation.** Assert on the returned FitScore, not
  on some private helper.
- **Fast and offline.** These 45 tests run in ~200ms with no network. That's why
  people actually run them.

## 9. Where this goes next

Right now tests run when you remember to run them. The next step is making them
run automatically on every push, so a regression can't reach `master`. A minimal
GitHub Actions workflow:

```yaml
name: tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - uses: denoland/setup-deno@v1
        with: { deno-version: v2.x }
      - run: npm ci
      - run: npm test
      - run: npm run lint
```

Add that once the suite covers `computeAllResults`, so the gate is protecting
something worth protecting.
