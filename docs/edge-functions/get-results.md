# `get-results` — exam review question list

**Verified against** a complete 170-question session end to end.

## What changed

The `get-results` edge function now returns a **`questions`** array alongside the existing
scores payload. This is the historical, question-by-question list that powers the
`/results/review` page. Nothing else in the response changed — the addition is purely
additive, so existing consumers are unaffected.

The list is built by joining `session_questions → questions` (+ `stimuli`, `instructions`)
and left-joining `session_responses`, ordered by `display_order` (the exact order the
student sat the questions). Grading was already done at answer time and is read from
`session_responses.is_correct` — nothing is re-computed here.

Exposing `correct_answer` is safe: the endpoint hard-requires `status === 'completed'`
and the questions are locked, so the exam is over. Ownership is still enforced
(a non-owner gets `403`).

## Endpoint

```
GET {SUPABASE_URL}/functions/v1/get-results?session_id={uuid}
Authorization: Bearer <student access_token>
apikey: <anon key>
```

- `403` — session belongs to another user
- `400` — missing `session_id`, or session not yet `completed`
- `404` — session not found

## Response shape (only the new field shown)

```jsonc
{
  "session_id": "uuid",
  "started_at": "timestamp",
  "completed_at": "timestamp",
  "readiness": { "overall_score": 74.6, "tier": "Conditionally Ready", "message": "..." },
  "subjects": [...], "topics": [...], "subtopics": [...],
  "classifications": [...], "recommendations": {...},
  "predictions": [...], "percentiles": [...],

  "questions": [
    {
      "session_question_id": "uuid",
      "question_id": "uuid",
      "section": "language",          // language | reading | math | science | social_studies | logic
      "subject": "English Language",
      "topic": "Discourse & Pragmatics",
      "question_text": "What is wrong with sentence 9?",
      "render_markup": null,          // use in place of question_text when present
      "svg_content": null,            // inline SVG for visual (Logic) questions; null otherwise
      "choices": { "a": "...", "b": "...", "c": "...", "d": "...", "e": null },
      "selected_answer": "d",         // the student's pick; null if unanswered
      "correct_answer": "d",
      "is_correct": true,             // pre-computed server-side
      "instruction": { "title": "Language", "text": "..." } | null,
      "stimulus":    { "title": "Optional Title", "text": "Passage text..." } | null
    }
  ]
}
```

## What the frontend dev needs to do

1. **Nothing new to fetch** — the questions come back in the existing `get-results`
   call you already make for the scores dashboard. Read `response.questions`.

2. **Filter buckets** (the All / Correct / Incorrect / Unanswered toggle):
   - **Correct**   → `q.is_correct === true`
   - **Incorrect** → `q.selected_answer && !q.is_correct`
   - **Unanswered**→ `!q.selected_answer`  *(covers both "no answer row" and a blank submission)*

   These three buckets are mutually exclusive and always sum to `questions.length`
   (verified: 40 + 32 + 98 = 170 on the test session).

3. **Rendering each card:**
   - Question body: prefer `render_markup` when non-null, else `question_text`.
   - **Visual/Logic questions**: render `svg_content` (inline SVG) when present — those
     questions have little/no `question_text`. This field is beyond your original spec
     but you'll need it or the Logic section renders blank.
   - `choices.e` is `null` for 4-option questions — skip nulls when listing choices.
   - `instruction` and `stimulus` are `null` when not applicable.

4. **Answer comparison colors:** compare `selected_answer` vs `correct_answer`
   (or just use `is_correct`). Teal = correct, red = incorrect, amber = unanswered.

5. **Field name deltas vs. your original spec** (both extras are harmless additions):
   - Added `is_correct` (boolean) — saves you a string compare.
   - Added `svg_content` and `section` — needed for visual questions / section grouping.
   - `instruction.text` maps from `instructions.instruction_text`; `stimulus.text` from
     `stimuli.stimulus_text` — already normalized to `text` for you.

## Notes / performance

- First call after a deploy is a cold start (~2s observed); warm calls are fast.
  The scores are precomputed; the questions query is a single indexed read on
  `session_questions (session_id)`.
- The endpoint only works for `completed` sessions. In-progress sessions still
  return `400` (by design — no answer keys during the exam).
