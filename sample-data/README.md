# Synthetic sample question bank

58 fabricated items across all seven subjects, written for this repository. The
real bank is not published — see [DISCLOSURE.md](../DISCLOSURE.md).

These are not padding. They are shaped to exercise every content feature the
system has, so that a local install can be driven from an empty database all
the way to a scored result.

| File | Items | What it exercises |
|---|---:|---|
| `questions/mathematics_questions.csv` | 13 | LaTeX in stems and choices (`\(\dfrac{}{}\)`, `\le`, superscripts) through the KaTeX path |
| `questions/science_questions.csv` | 11 | Chemistry notation, plus one item carrying an **inline SVG** velocity-time graph in `svg_content` |
| `questions/english_language_questions.csv` | 8 | Multi-line stems, plus two **error-identification** items using `<seg choice='X'>` render markup |
| `questions/filipino_language_questions.csv` | 6 | Non-English content and diacritics |
| `questions/reading_questions.csv` | 6 | A **shared passage**: one stimulus, six questions, imported once and linked by `stimulus_group_key` |
| `questions/social_studies_questions.csv` | 6 | Plain prose items at three difficulties |
| `questions/logic_abstract_reasoning_questions.csv` | 8 | **Inline SVG figure sequences** — dots, polygons, rotation, quadrant shading — generated rather than hand-drawn |

Answer keys are spread across all four letters rather than clustering on one —
the same property `scripts/fix-all-subjects-answer-distribution.mjs` enforces on
the real bank, because a bank with a dominant correct letter is guessable.

Every row was validated against the real importer: 58 rows, zero errors, zero
warnings, no unrecognised headers.

## Standing the system up from nothing

```bash
# 1. Schema, RLS, reference data, taxonomy and importance weights
supabase db reset

# 2. Grant yourself admin access (RLS requires a row in admin_users)
#    Sign up through the app first, then:
#    insert into admin_users (user_id, email)
#    select id, email from auth.users where email = 'you@example.com';

# 3. Run the admin app
npm run dev
```

Then, in the app:

1. **Question Bank → Import CSV.** Upload each file in `questions/`. The
   importer (`src/questionImport.js`) validates every row against the database
   constraints before writing, so a malformed sheet produces per-row messages
   rather than an opaque Postgres error. The reading file writes its passage
   into `stimuli` once and links all six items to it.

   All 58 rows import with no errors and no warnings. They land as **`draft`**,
   not `active` — the importer forces that regardless of what the sheet says,
   because a bulk upload is not a review. Nothing a student can be served
   enters the bank without someone clearing it first.
2. **Categories.** The taxonomy and importance weights are already seeded from
   `supabase/seed.sql`, so the subject/topic/subtopic pickers populate
   immediately.
3. **Review and activate.** Auto-pick only draws from `active` items, so the
   drafts have to be cleared before they can be used. Do it through the bank UI,
   or in SQL for a local install:

   ```sql
   update questions set status = 'active' where status = 'draft';
   ```

4. **Exam Builder.** Create a template and auto-pick. Note that 58 items cannot
   fill a 170-question blueprint — the builder will correctly report the
   shortfall per scope, which is itself the behaviour worth seeing. Either build
   a smaller template or use the Quiz Builder.
5. **Quiz Builder.** A 10-item quiz assembles cleanly from this bank and is the
   fastest way to a complete attempt.
6. **Preview as student.** Sit the quiz or exam, submit, and finalize to see the
   scoring engine produce subject scores, subtopic mastery, course-cluster fit
   and recommendations from real responses.

## Column format

The CSVs use the importer's own field names, so the header row is the contract:

```
subject, topic, subtopic, difficulty_level, status, source_school,
correct_answer, question_text, choice_a … choice_d,
render_markup, svg_content,
stimulus_group_key, stimulus_title, stimulus_type, stimulus_text
```

`src/questionImport.js` also accepts a range of human header aliases, since real
sheets arrive from spreadsheets and documents rather than from an export. The
canonical names are used here to keep the files unambiguous.

Constraints worth knowing when writing your own:

- `subtopic` is `NOT NULL` and stores `''` rather than `NULL` when absent.
- `difficulty_level` ∈ `easy | medium | hard`.
- `status` ∈ `active | draft | retired`, and an insert is forced to `draft`.
- `source_school` is CHECK-constrained, so an import cannot invent a provenance.
- `correct_answer` is a lowercase letter.
