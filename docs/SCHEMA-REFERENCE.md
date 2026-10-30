# QuestionBank Schema Reference

This document explains the database shape used by the Exam Builder, Question
Bank, AI Generator, diagnostic runtime, scoring, and quizzes.

---

## Schema Groups

| Group | Tables |
|---|---|
| Content bank | `questions`, `stimuli`, `instructions`, `visual_assets`, `question_visual_assets` |
| Diagnostic templates | `diagnostic_templates`, `diagnostic_template_questions` |
| Diagnostic runtime | `diagnostic_sessions`, `session_sections`, `session_questions`, `session_responses` |
| Results | `session_subject_scores`, `session_topic_scores`, `session_subtopic_scores`, `session_classification_scores`, `session_readiness_tiers`, `session_recommendations`, `session_university_predictions`, `session_percentiles` |
| Scoring reference | `course_classifications`, `subtopic_classification_importance`, `university_subject_weights`, `scoring_models`, `active_scoring_model` |
| Practice | `practice_question_history` |
| Quizzes | `quizzes`, `quiz_questions`, `quiz_sessions`, `quiz_session_questions`, `quiz_responses` |
| Admin/auth support | `admin_users`, Supabase `auth.users` |

---

## Content Bank

### `questions`

Main question bank table. The Exam Builder, Quiz Builder, AI Generator, student
runtime, and exports all depend on this table.

Common columns:

| Column | Purpose |
|---|---|
| `id` | Question UUID. |
| `subject` | Subject label, for example `Mathematics` or `Reading`. |
| `topic` | Topic label under the subject. |
| `subtopic` | Detailed skill label. **NOT NULL** — rows with no subtopic store an empty string, not NULL. |
| `difficulty_level` | `easy`, `medium`, or `hard`. |
| `question_text` | Main stem. |
| `choice_a` | Answer choice A. |
| `choice_b` | Answer choice B. |
| `choice_c` | Answer choice C. |
| `choice_d` | Answer choice D. |
| `choice_e` | Optional answer choice E for legacy rows. Most generated content uses A-D only. |
| `correct_answer` | Correct letter, stored lowercase in current flows. |
| `source_school` | Provenance. **NOT NULL**, and `questions_source_school_check` permits only `UPCAT`, `ACET`, `DCAT`, `USTET`, `AI Generated`. |
| `status` | Serving state. `questions_status_check` permits **only** `active`, `draft`, `retired` — `needs_human_review` is rejected at insert time even though the bank UI filters for it and `useQuestionGeneration.js` tries to write it. |
| `stimulus_id` | Optional FK to `stimuli` for Reading passage groups. |
| `instruction_id` | Optional FK to `instructions` for shared instruction blocks. |
| `render_markup` | Optional special markup, mainly for error-identification items. |
| `svg_content` | Optional inline SVG diagram stored directly on the question row. |
| `created_at` | Creation timestamp. |
| `updated_at` | Update timestamp when present. |

Important behavior:

- The Exam Builder only auto-picks `active` questions.
- AI-generated rows are inserted through the Question Bank upload flow.
- Bulk CSV import/update goes through `src/questionImport.js`; it validates
  against the constraints above before writing, so a bad sheet produces row-level
  messages instead of an opaque Postgres error.
- A bulk insert through PostgREST requires every row object to carry identical
  keys, so the importer pads each row out to the union of columns being written.
- Math validation can mark a row `needs_human_review`.
- Inline diagrams usually live in `svg_content`.
- Uploaded files use the visual asset join tables, not `svg_content`.

### `stimuli`

Stores shared passages, especially for Reading.

Common columns:

| Column | Purpose |
|---|---|
| `id` | Stimulus UUID. |
| `stimulus_group_key` | Grouping key for passage families. **NOT NULL** (no unique index). CSV import derives one from the title, e.g. `IMPORT_THE_GARDEN`, when the sheet does not supply it. |
| `stimulus_title` | Passage title. |
| `stimulus_type` | Example: `reading_passage`. |
| `stimulus_text` | Full passage text. |
| `created_at` | Creation timestamp. |

Usage:

- `questions.stimulus_id` points here.
- `get-question-bundle` embeds passage data for students.
- AI Reading generation uses existing stimuli instead of inventing passages.

### `instructions`

Stores reusable instruction/rubric blocks.

Common columns:

| Column | Purpose |
|---|---|
| `id` | Instruction UUID or key. |
| `instruction_text` | Text shown with linked questions. |
| `instruction_type` | Optional category/type. |

Usage:

- `questions.instruction_id` points here.
- `get-question-bundle` can embed instructions with questions.

### `visual_assets`

Stores metadata for uploaded files. The file bytes live in Supabase Storage.

Common columns:

| Column | Purpose |
|---|---|
| `id` | Asset UUID. |
| `storage_path` | Path inside the `question-visuals` bucket. |
| `asset_type` | `image`, `figure`, `diagram`, or `chart`. |
| `alt_text` | Accessibility text. |
| `caption` | Optional caption. |
| `created_at` | Creation timestamp. |

Usage:

- Question Bank uploads create rows here.
- `visualContent.jsx` chooses the viewer from file extension and asset metadata.

### `question_visual_assets`

Join table between questions and uploaded visual assets.

Common columns:

| Column | Purpose |
|---|---|
| `id` | Join row UUID. |
| `question_id` | FK to `questions.id`. |
| `visual_asset_id` | FK to `visual_assets.id`. |
| `display_order` | Display order for multiple assets. |
| `marked_segment` | Optional segment label. |
| `passage_question_range` | Optional range label for passage-related visuals. |

Usage:

- Question Bank reads/writes this table when attaching or removing figures.
- `get-question-bundle` joins it to return student visual assets.

---

## Diagnostic Template Tables

### `diagnostic_templates`

One saved exam definition.

Common columns:

| Column | Purpose |
|---|---|
| `id` | Template UUID. |
| `code` | Stable template code, for example `MOCK-EXAM-2`. |
| `version` | Template version number. |
| `total_questions` | Expected total, normally 170. |
| `is_active` | Whether students may receive this template. |
| `is_primary` | Whether this is the first-choice active template. |
| `created_at` | Creation timestamp. |
| `updated_at` | Update timestamp when present. |

Status interpretation:

| `is_active` | `is_primary` | Meaning |
|---|---|---|
| true | true | Primary active diagnostic. |
| true | false | Available retake diagnostic. |
| false | false | Inactive diagnostic. |

Special code:

```txt
__DELETED_EXAM_SESSIONS__
```

This archive template is used to hold sessions when an exam template is deleted.

### `diagnostic_template_questions`

Ordered list of questions inside one diagnostic template.

Common columns:

| Column | Purpose |
|---|---|
| `id` | Row UUID. |
| `template_id` | FK to `diagnostic_templates.id`. |
| `question_id` | FK to `questions.id`. |
| `section_name` | One of the six diagnostic section keys. |
| `display_order` | Order inside the full exam/template. |
| `created_at` | Creation timestamp. |

Valid `section_name` values:

- `language`
- `reading`
- `math`
- `science`
- `social_studies`
- `logic`

The Exam Builder replaces this table's rows for a template every time the exam
is saved.

---

## Diagnostic Runtime Tables

### `diagnostic_sessions`

One student's attempt at one diagnostic template.

Common columns:

| Column | Purpose |
|---|---|
| `id` | Session UUID. |
| `user_id` | Supabase Auth user ID. |
| `template_id` | FK to the diagnostic template used. |
| `status` | Runtime status. |
| `current_section` | Current section key. |
| `started_at` | Session start timestamp. |
| `completed_at` | Final completion timestamp. |
| `total_questions` | Normally 170. |

Common statuses:

- `in_progress`
- `ready_to_finalize`
- `completed`
- `expired`

### `session_sections`

One row per diagnostic section per session.

Common columns:

| Column | Purpose |
|---|---|
| `id` | Row UUID. |
| `session_id` | FK to `diagnostic_sessions.id`. |
| `section_name` | Section key. |
| `status` | Section status. |
| `started_at` | When the student started the section. |
| `submitted_at` | When the student submitted the section. |
| `time_limit_seconds` | Immutable section budget. |
| `elapsed_seconds` | Accumulated active time spent in the section. |
| `last_activity_at` | Last observed student activity. |

Section clock behavior:

- `time_limit_seconds` is the budget.
- `elapsed_seconds` is time actually spent.
- `last_activity_at` prevents disconnected time from being charged as active
  exam time.

### `session_questions`

Frozen snapshot of the questions assigned to a session.

Common columns:

| Column | Purpose |
|---|---|
| `id` | Session-question UUID. |
| `session_id` | FK to `diagnostic_sessions.id`. |
| `question_id` | FK to `questions.id`. |
| `section_name` | Section key. |
| `display_order` | Order inside the section/exam. |
| `locked` | Whether the question is locked after section submission. |

Why it exists:

- A student's exam should not change if the template is edited later.
- Responses attach to `session_questions`, not directly to template rows.

### `session_responses`

Stores graded answers.

Common columns:

| Column | Purpose |
|---|---|
| `id` | Response UUID. |
| `session_question_id` | FK to `session_questions.id`. |
| `selected_answer` | Student-selected letter. |
| `is_correct` | Server-computed correctness. |
| `submitted_at` | Answer timestamp. |

Important behavior:

- The browser does not compute correctness.
- `submit-answer` reads `questions.correct_answer` server-side and upserts this
  table.

---

## Result Tables

These are written by `finalize-exam` and read by `get-results`.

### `session_subject_scores`

Subject-level performance.

Common columns:

| Column | Purpose |
|---|---|
| `session_id` | Diagnostic session. |
| `subject` | Subject name. |
| `correct_count` | Correct responses. |
| `total_count` | Total questions. |
| `score_percent` | Percent score. |
| `weighted_score` | Difficulty-weighted score when present. |

### `session_topic_scores`

Topic-level performance.

Common columns:

| Column | Purpose |
|---|---|
| `session_id` | Diagnostic session. |
| `subject` | Subject name. |
| `topic` | Topic name. |
| `correct_count` | Correct responses. |
| `total_count` | Total questions. |
| `score_percent` | Percent score. |

### `session_subtopic_scores`

Subtopic-level performance.

Common columns:

| Column | Purpose |
|---|---|
| `session_id` | Diagnostic session. |
| `subject` | Subject name. |
| `topic` | Topic name. |
| `subtopic` | Subtopic name. |
| `correct_count` | Correct responses. |
| `total_count` | Total questions. |
| `score_percent` | Percent score. |
| `mastery_band` | Mastery label when generated by scoring. |

### `session_classification_scores`

Course-cluster fit scores.

Common columns:

| Column | Purpose |
|---|---|
| `session_id` | Diagnostic session. |
| `classification_code` | Course classification code. |
| `fit_score` | Final fit score. |
| `weighted_performance_score` | Subtopic-importance weighted performance. |
| `critical_threshold_ratio` | Ratio for tested high-importance subtopics. |
| `rank` | Cluster rank. |

Joined to:

- `course_classifications`

### `session_readiness_tiers`

Readiness label per course classification.

Common columns:

| Column | Purpose |
|---|---|
| `session_id` | Diagnostic session. |
| `classification_code` | Course classification code. |
| `readiness_tier` | Readiness label. |
| `score` | Related score value when present. |

### `session_recommendations`

Study and course-fit recommendations.

Common columns:

| Column | Purpose |
|---|---|
| `session_id` | Diagnostic session. |
| `classification_code` | Course classification code. |
| `recommendation_type` | Type/category of recommendation. |
| `content` | Recommendation text or JSON content. |

### `session_university_predictions`

University outcome estimates.

Common columns:

| Column | Purpose |
|---|---|
| `session_id` | Diagnostic session. |
| `university` | University name/code. |
| `classification_code` | Course classification code. |
| `prediction_score` | Computed prediction score. |
| `prediction_label` | Human-readable prediction tier. |

### `session_percentiles`

Percentile-style result values.

Common columns:

| Column | Purpose |
|---|---|
| `session_id` | Diagnostic session. |
| `scope` | Subject/classification/overall scope. |
| `percentile` | Percentile value. |
| `created_at` | Creation timestamp. |

---

## Scoring Reference Tables

### `course_classifications`

Course clusters used by the recommendation engine.

Common columns:

| Column | Purpose |
|---|---|
| `code` | Classification code. |
| `name` | Human-readable name. |
| `description` | Optional description. |

Codes used by the app:

- `BMA`
- `HAMS`
- `EA`
- `ITCS`
- `SM`
- `HSSC`
- `ETT`
- `SNC`

### `subtopic_classification_importance`

Taxonomy and scoring-importance table. This is the key bridge between question
subtopics and course classifications.

Common columns:

| Column | Purpose |
|---|---|
| `subject` | Subject label. |
| `topic` | Topic label. |
| `subtopic` | Subtopic label. |
| `classification_code` | Course classification code. |
| `importance_label` | Usually Low, Medium, High. |
| `importance_weight` | Numeric weight, usually 1, 2, or 3. |

Usage:

- Categories tab reads it as taxonomy.
- New categories insert one row per classification code.
- Scoring engine uses it to compute course-cluster fit.

### `university_subject_weights`

University-specific subject weighting.

Common columns:

| Column | Purpose |
|---|---|
| `university` | University name/code. |
| `subject` | Subject name. |
| `weight` | Multiplier used in prediction. |

### `scoring_models`

Scoring model parameters.

Common columns:

| Column | Purpose |
|---|---|
| `id` | Model UUID. |
| `name` | Model name. |
| `is_active` | Whether this model is selected. |
| `difficulty_weights` | JSON/object with easy/medium/hard weights. |
| `alpha` | Fit-score weight for weighted performance. |
| `beta` | Fit-score weight for critical threshold ratio. |
| `critical_threshold` | Threshold used in readiness/critical calculations. |

### `active_scoring_model`

View that returns the active scoring model row.

Usage:

- `finalize-exam`/scoring code reads the active model instead of hardcoding all
  scoring constants in the app.

---

## Practice Table

### `practice_question_history`

Tracks which practice questions a student has already seen.

Common columns:

| Column | Purpose |
|---|---|
| `user_id` | Supabase Auth user ID. |
| `question_id` | FK to `questions.id`. |
| `subject` | Practice subject. |
| `topic` | Practice topic. |
| `subtopic` | Practice subtopic. |
| `served_at` | When the question was served. |

Usage:

- `get-practice-questions` avoids repeatedly serving the same items.
- Practice generation can top up exhausted scopes.

---

## Quiz Tables

Quizzes are intentionally separate from diagnostic templates.

### `quizzes`

One teacher-authored quiz.

Columns from migration:

| Column | Purpose |
|---|---|
| `id` | Quiz UUID. |
| `code` | Unique quiz code. |
| `title` | Quiz title. |
| `description` | Optional description. |
| `created_by` | Auth user who created it. |
| `total_questions` | Number of questions in quiz. |
| `is_published` | Whether students may take it. |
| `settings` | JSON settings such as time limits and shuffle. |
| `created_at` | Creation timestamp. |
| `updated_at` | Update timestamp. |

### `quiz_questions`

Ordered list of questions in a quiz.

Columns from migration:

| Column | Purpose |
|---|---|
| `id` | Row UUID. |
| `quiz_id` | FK to `quizzes.id`. |
| `question_id` | FK to `questions.id`. |
| `section_name` | Flexible section label. |
| `display_order` | Order inside quiz. |
| `created_at` | Creation timestamp. |

### `quiz_sessions`

One student's quiz attempt.

Columns from migration:

| Column | Purpose |
|---|---|
| `id` | Session UUID. |
| `user_id` | Auth user ID. |
| `quiz_id` | FK to `quizzes.id`. |
| `status` | `in_progress`, `completed`, or `expired`. |
| `score` | Correct count. |
| `total` | Total questions. |
| `started_at` | Start timestamp. |
| `completed_at` | Completion timestamp. |

### `quiz_session_questions`

Frozen snapshot of quiz questions for one attempt.

Columns from migration:

| Column | Purpose |
|---|---|
| `id` | Row UUID. |
| `session_id` | FK to `quiz_sessions.id`. |
| `question_id` | FK to `questions.id`. |
| `section_name` | Quiz section label. |
| `display_order` | Question order. |
| `locked` | Whether the row is locked. |

### `quiz_responses`

Graded quiz answers.

Columns from migration:

| Column | Purpose |
|---|---|
| `id` | Response UUID. |
| `session_id` | FK to `quiz_sessions.id`. |
| `question_id` | FK to `questions.id`. |
| `selected_answer` | Student selected letter. |
| `is_correct` | Server-computed correctness. |
| `answered_at` | Timestamp. |

Unique key:

```txt
(session_id, question_id)
```

---

## Storage

### Bucket: `question-visuals`

Stores uploaded visual files for questions.

Database linkage:

```txt
questions
  -> question_visual_assets
  -> visual_assets.storage_path
  -> storage bucket question-visuals
```

Inline SVGs do not use the bucket. They live in `questions.svg_content`.

---

## Main Relationships

### Question Content

```txt
stimuli 1 -> many questions
instructions 1 -> many questions
questions 1 -> many question_visual_assets
visual_assets 1 -> many question_visual_assets
```

### Diagnostic Authoring

```txt
diagnostic_templates 1 -> many diagnostic_template_questions
questions 1 -> many diagnostic_template_questions
```

### Diagnostic Runtime

```txt
diagnostic_templates 1 -> many diagnostic_sessions
diagnostic_sessions 1 -> many session_sections
diagnostic_sessions 1 -> many session_questions
session_questions 1 -> many session_responses
questions 1 -> many session_questions
```

### Results

```txt
diagnostic_sessions 1 -> many session_subject_scores
diagnostic_sessions 1 -> many session_topic_scores
diagnostic_sessions 1 -> many session_subtopic_scores
diagnostic_sessions 1 -> many session_classification_scores
diagnostic_sessions 1 -> many session_readiness_tiers
diagnostic_sessions 1 -> many session_recommendations
diagnostic_sessions 1 -> many session_university_predictions
diagnostic_sessions 1 -> many session_percentiles
```

### Scoring

```txt
course_classifications 1 -> many subtopic_classification_importance
subtopic_classification_importance joins question subtopics to course clusters
university_subject_weights adjusts university prediction scoring
active_scoring_model selects current scoring parameters
```

### Quizzes

```txt
quizzes 1 -> many quiz_questions
quizzes 1 -> many quiz_sessions
quiz_sessions 1 -> many quiz_session_questions
quiz_sessions 1 -> many quiz_responses
questions 1 -> many quiz_questions
questions 1 -> many quiz_session_questions
```

---

## RLS / Access Pattern

The browser uses:

- Supabase anon key
- logged-in user's JWT
- PostgREST for normal admin CRUD

Edge functions use:

- user-scoped client to authenticate the caller
- service-role client for privileged operations such as grading, session
  assembly, and result writes

Student-facing answer keys are never sent from the browser. Functions that need
`correct_answer` read it server-side.
