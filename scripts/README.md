# Maintenance and audit toolchain

A question bank of a few thousand items, edited by several people over months,
drifts. Subtopic labels diverge. Instruction blocks get restated per item
instead of shared. Correct answers cluster on one letter. LaTeX gets written as
plain text in some rows and as delimited math in others. A figure gets uploaded
in a format the renderer has never seen.

None of that is visible from the admin UI, which shows one question at a time.
So the bank is maintained by scripts: Node programs that authenticate as an
admin, read the bank through PostgREST under row-level security, and report or
repair a specific class of inconsistency.

## The working pattern

Every script here follows the same shape, and it is the shape that matters more
than any individual script:

1. **Read-only by default.** Nothing writes without `--apply`. The default run
   prints what *would* change.
2. **Idempotent.** Re-running must be a no-op. Inserts skip rows whose
   `question_text` already exists in that subtopic.
3. **Reversible.** On apply, inserted ids are written to
   `<name>.inserted.json` and the prior state of every edited row to
   `<name>.before.json`, so any change can be undone by a companion rollback.
4. **Authenticated as a user, not as the service role.** Scripts sign in with
   `ADMIN_EMAIL` / `ADMIN_PASSWORD` and operate under RLS. Only the few that
   genuinely must bypass it (backups, hard deletes) use
   `SUPABASE_SERVICE_ROLE_KEY`.

A content migration against live assessment data is a one-way door unless you
build the door to swing both ways first. These four rules are what made it safe
to do hundreds of them.

## What is here

### Build and test guards

| Script | Purpose |
|---|---|
| `assert-svg-rendering-nondestructive.mjs` | Runs **before every build**. Fails if `visualContent.jsx` reintroduces destructive SVG normalisation — a regression class that silently corrupts existing diagrams rather than throwing |
| `test-math-patterns.mjs` | Unit tests for the math preprocessor: plain-text → LaTeX conversion, delimiter normalisation, auto-detection |
| `test-question-import.mjs` | Unit tests for the bulk CSV importer: delimiter detection, header aliasing, per-row validation, stimulus key derivation |

### Audits (read-only)

| Script | Finds |
|---|---|
| `audit-rendered-math.mjs` | Server-renders every math item through the real React renderer and reports anything that fails to typeset — the only way to catch a rendering bug without opening 1,000 questions by hand |
| `audit-english-question-bank.mjs` | Structural problems in English items: duplicate stems, malformed error-identification markup, answer-location bias |
| `audit-science-question-bank.mjs` | Science item structure and unit/notation consistency |
| `audit-science-visual-requirements.mjs` | Uses a model to flag science items whose text implies a diagram they do not have |
| `audit-importance-vs-questions.mjs` | Subtopics with high importance weights but too few questions — i.e. the parts of the scoring model the bank cannot actually measure |
| `audit-language-instruction-duplicates.mjs` | Instruction text repeated per item instead of shared through `instructions` |
| `audit-overscaffolded-connector-instructions.mjs` | Items whose instructions give the answer away |
| `check-duplicate-question-patterns.mjs` | Near-duplicate stems within a subtopic |
| `diagnostic-topic-bank-counts.mjs` | Per-subtopic active counts for the live exam's scopes, thinnest-first — the input to any bank-deepening work |
| `inspect-rest-openapi.mjs` | Dumps the PostgREST OpenAPI schema, the fastest way to confirm what columns and constraints actually exist |

### Repairs (`--apply` required)

| Script | Fixes |
|---|---|
| `fix-all-subjects-answer-distribution.mjs` | Rebalances correct-answer letters across a subtopic. A bank where 40% of answers are "C" is guessable |
| `reorder-exam-sections.mjs` | Rewrites a template's section order and display ordering consistently |
| `seed-humanities-literature-taxonomy.mjs` | Inserts a taxonomy branch with one importance row per course cluster |
| `track-added-questions.mjs` | Regenerates a consolidated log of every question added by these scripts, from their `.inserted.json` rollback files |

### Data operations

| Script | Purpose |
|---|---|
| `backup-exam-attempt-data.mjs` | Full backup of attempts, responses and results before any destructive operation |
| `wipe-exam-attempt-data.mjs` | Clears attempt data (for a staging reset). Refuses to run without a backup present |
| `export-filtered.mjs` | Analysis export of users, attempts and results with staff and test accounts excluded |
| `export-reading-questions.mjs` | Exports reading items with their passages reassembled for review |

## Running them

```bash
node scripts/<name>.mjs            # dry run — reports, writes nothing
node scripts/<name>.mjs --apply    # commits the change, writes rollback files
```

Credentials come from `.env` (see `.env.example`). Every script loads it the
same way and fails loudly if a required variable is missing.

## A note on what is not here

The real bank was maintained by well over a hundred of these. Most were
single-use: a specific rewrite pack for a specific subtopic, carrying the
replacement item text inline. Those are not published, because the content
inside them *is* the question bank.

What is published is the subset that is genuinely tooling — the guards, the
audits, and the repairs whose logic is reusable rather than tied to one batch of
content.
