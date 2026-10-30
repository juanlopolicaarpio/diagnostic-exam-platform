# Exam Builder — Code Walkthrough

This document identifies the code required to operate and maintain the Exam
Builder tab inside QuestionBank. It intentionally excludes unrelated QA scripts,
audit exports, and one-off data cleanup files.

---

## Required Code Surface

### Frontend

| File | Why it is required |
|---|---|
| `src/App.jsx` | App shell, auth, Question Bank, exports, category modals, tab routing, and shared AI generation state. |
| `src/ExamBuilder.jsx` | Main diagnostic exam builder and exam manager. |
| `src/StudentExamPreview.jsx` | Student-style preview of a saved exam template. |
| `src/CategoryManager.jsx` | Category tree and add-question workflows used by the builder ecosystem. |
| `src/QuestionGenerator.jsx` | AI Generator UI. |
| `src/useQuestionGeneration.js` | AI Generator state machine, wave planning, and Question Bank upload flow. |
| `src/classificationOptions.js` | Loads taxonomy options from scoring/taxonomy tables. |
| `src/mathContent.jsx` | Renders math and mixed text safely in questions and choices. |
| `src/mathParser2.jsx` | Parses plain-text math patterns used by the renderer. |
| `src/mathValidation.js` | Flags generated/edited math items that need review. |
| `src/questionText.jsx` | Renders underlined referenced text. |
| `src/visualContent.jsx` | Renders inline SVGs and uploaded visual assets. |
| `src/questionExport.js` | CSV, Word, PDF/HTML export support. |
| `src/main.jsx`, `src/index.css`, `src/App.css` | App entry and global styling. |

### Backend Edge Functions

| Folder | Why it is required |
|---|---|
| `supabase/functions/assemble-exam` | Creates or resumes a student diagnostic session from an active template. |
| `supabase/functions/get-question-bundle` | Loads one section for the student runtime without exposing correct answers. |
| `supabase/functions/submit-answer` | Grades and stores one answer server-side. |
| `supabase/functions/submit-section` | Locks a section, fills blanks as wrong, advances the session. |
| `supabase/functions/heartbeat` | Updates student activity for the disconnect-tolerant timer. |
| `supabase/functions/pause-section` | Pauses a diagnostic section clock. |
| `supabase/functions/pause-demo-exam` | Preview/demo clock pause support. |
| `supabase/functions/finalize-exam` | Runs scoring and writes final result tables. |
| `supabase/functions/get-results` | Reads final results for display. |
| `supabase/functions/generate-question-batch` | Teacher-facing AI question generation and revision endpoint. |
| `supabase/functions/get-practice-questions` | Adaptive practice and shared generation engine. |
| `supabase/functions/_shared` | Shared auth, section config, timer, scoring, and prompt utilities. |

### Database And Storage

| Path | Why it is required |
|---|---|
| `supabase/migrations/20260626000000_practice_question_history.sql` | Practice history table used by adaptive learning. |
| `supabase/migrations/20260626010000_allow_ai_generated_source_school.sql` | Allows `AI Generated` provenance in `questions.source_school`. |
| `supabase/migrations/20260722000000_quizzes.sql` | Quiz tables, used by the Quiz Builder. |
| `supabase/migrations/20260723000000_relax_visual_assets_asset_type.sql` | Visual asset type compatibility for uploads. |
| `supabase/migrations/20260803000000_section_clock_activity.sql` | Activity-based section timer columns. |
| `supabase-setup-question-visuals.sql` | One-time storage bucket and visual asset setup. |

### Build And Runtime Config

| File | Purpose |
|---|---|
| `package.json` | Scripts and dependency list. |
| `package-lock.json` | Locked npm dependency graph. |
| `vite.config.js` | Vite build config. |
| `eslint.config.js` | Lint config. |
| `vercel.json` | Static hosting config. |

---

## Exam Builder Core Constants

File: `src/ExamBuilder.jsx`

| Constant | Purpose |
|---|---|
| `SUBJECTS` | Defines the six diagnostic sections, their labels, database `section_name`, accepted question subjects, total question counts, and colors. |
| `DIFFICULTY_TARGETS` | Default easy/medium/hard totals per diagnostic section. |
| `DIFFICULTIES` | Canonical difficulty order: `easy`, `medium`, `hard`. |
| `EXCLUDED_AUTO_PICK_QUESTION_IDS` | Question IDs excluded from automatic selection. |
| `RECOMMENDED_BLUEPRINT` | Default QuestionBank diagnostic plan: subject -> topic -> subtopic -> count -> difficulty split. |
| `DRAFT_INDEX_KEY` | Local storage key for the list of local exam drafts. |
| `ARCHIVE_TEMPLATE_CODE` | Template code used to park sessions when a template is deleted. |

The section order in `SUBJECTS` currently matches `SECTION_CONFIG` in
`supabase/functions/_shared/utils.ts`.

---

## Exam Builder Main Flow

The diagnostic builder has two major components:

| Component | Role |
|---|---|
| `ExamManager` | Lists saved templates and local drafts; opens new/edit/preview flows; activates and deletes templates. |
| `ExamBuilderEditor` | Builds one exam template through Welcome, Plan, Pick Questions, and Check stages. |

### 1. Start Or Resume

Important functions:

| Function | Purpose |
|---|---|
| `openNewExam()` | Creates a local draft shell using the entered exam name. |
| `openDraft(draft)` | Opens a browser-local draft from `localStorage`. |
| `loadTemplate(t)` | Loads saved template questions from `diagnostic_template_questions`. |
| `loadTemplates()` | Reads saved templates and local draft metadata for the builder home screen. |

Local drafts are stored with:

- index key: `exam_builder_drafts`
- payload key: `exam_draft_<TEMPLATE_CODE>`

The saved database version is not changed until `saveTemplate()` runs.

### 2. Plan

Important functions:

| Function | Purpose |
|---|---|
| `createBlueprint()` | Returns an empty plan for every diagnostic subject. |
| `cloneBlueprint(blueprint)` | Deep-copies a blueprint before editing. |
| `loadRecommendedTemplate()` | Loads `RECOMMENDED_BLUEPRINT` into the editor. |
| `topicTotal(topic)` | Totals subtopic counts inside one topic. |
| `subjectBlueprintTotal(subjectBlueprint)` | Totals all topic counts in a section. |
| `isBlueprintComplete(blueprint)` | Confirms every section total equals the required count. |
| `clampTopicCount(...)` | Prevents a topic from exceeding the section budget. |
| `fitSubtopicsToCount(...)` | Adjusts subtopic counts when topic count changes. |
| `clampSubtopicCount(...)` | Prevents a subtopic from exceeding its topic budget. |
| `applyQuotaMove()` | Moves question quota from one topic to another. |

The plan is complete only when all six sections hit their totals:

- Math: 40
- Science: 40
- Language: 30
- Reading: 30
- Social Studies: 15
- Logic / Abstract Reasoning: 15

### 3. Build Slots

Important functions:

| Function | Purpose |
|---|---|
| `buildSlots(blueprint)` | Flattens the nested blueprint into exact question requirements. |
| `questionFitsSlot(q, slot)` | Checks whether a bank question matches a slot. |
| `slotSelectedCount(selections, slot)` | Counts selected questions matching a slot. |
| `reconcileSelectionsWithBlueprint(...)` | Removes selected questions that no longer fit after plan edits. |
| `blueprintFromSelections(selections)` | Rebuilds a plan from an existing saved template. |

A slot contains:

- subject key
- section name
- accepted question subjects
- topic
- subtopic
- difficulty
- target count
- stable slot ID

### 4. Pick Questions

Important functions:

| Function | Purpose |
|---|---|
| `autoPickQuestions()` | Fills the plan automatically from active bank questions. |
| `trimReadingToTarget(...)` | Keeps Reading passage groups while trimming to 30 questions. |
| `addQuestion(q)` | Adds one question to the active matching slot. |
| `removeQuestion(subjectKey, qid)` | Removes one selected question. |
| `getAllSelectedIds(selections)` | Prevents duplicate use across slots. |
| `groupingKeyForQuestion(q)` | Groups Reading questions by passage/stimulus. |
| `normalizeDifficulty(value)` | Normalizes difficulty labels before matching. |
| `fetchClassOpts(token)` | Loads available subject/topic/subtopic options for editing. |

Auto-pick:

1. Uses the current blueprint, or the recommended blueprint if the current one
   is incomplete.
2. Queries active questions.
3. Fills exact difficulty matches first.
4. Falls back to other difficulties when necessary.
5. Avoids excluded question IDs.
6. Keeps Reading passage groups together.
7. Produces warning notes for any shortfalls or fallback picks.

### 5. Review And Save

Important functions:

| Function | Purpose |
|---|---|
| `saveTemplate()` | Creates/updates `diagnostic_templates` and replaces rows in `diagnostic_template_questions`. |
| `selectedTotal(selections)` | Confirms the final selected count. |
| `allSlotsComplete` | Derived boolean that gates Save Exam. |
| `discardChanges()` | Removes local draft and reloads the saved state. |

`saveTemplate()` writes:

1. A `diagnostic_templates` row if needed.
2. The final `total_questions`.
3. Deletes old `diagnostic_template_questions` for that template.
4. Inserts new rows with `template_id`, `question_id`, `section_name`, and
   `display_order`.
5. Removes the local draft.

---

## Question Editing Inside The Builder

The builder can edit questions directly through the modal.

Important functions:

| Function | Purpose |
|---|---|
| `makeEditForm(q)` | Converts a question row into editable form state. |
| `saveQuestionEdits()` | Patches the `questions` row from inside the builder. |
| `applyQuestionUpdate(updated)` | Updates any selected copies after a question edit. |
| `QuestionModal` | View/edit UI for a question. |
| `QuestionList` | Slot/bank list UI. |

The same validation as the bank is applied:

- four choices are required
- status can be changed
- math validation can mark the question `needs_human_review`
- topic/subtopic changes can make a selected question no longer fit the slot

---

## Exam Template Management

File: `src/ExamBuilder.jsx`

Important functions:

| Function | Purpose |
|---|---|
| `setPrimaryTemplate(t)` | Clears `is_primary` on active templates and marks one template primary. |
| `deleteTemplate(t)` | Moves attached sessions to the archive template, deletes template questions, then deletes the template. |
| `openQuestionForPreview(questionId)` | Loads a full question row and visual assets from preview. |
| `savePreviewEdits()` | Saves question edits made while previewing. |

Template status is represented by:

- `is_active = true` and `is_primary = true`: primary active exam
- `is_active = true` and `is_primary = false`: available exam
- `is_active = false`: inactive exam

---

## Student Preview Runtime

File: `src/StudentExamPreview.jsx`

The preview uses the real edge functions and the real student flow.

Important runtime calls:

| Edge function | Preview use |
|---|---|
| `assemble-exam` | Creates/resumes a test session. |
| `get-question-bundle` | Loads the current section. |
| `submit-answer` | Saves and grades answers. |
| `submit-section` | Advances to the next section. |
| `finalize-exam` | Computes final scores. |
| `get-results` | Loads final results. |

Important local helpers:

| Function | Purpose |
|---|---|
| `normalizeQuestionRow(...)` | Converts edge function rows into preview UI shape. |
| `attachVisuals(...)` | Resolves inline SVGs, stimuli, and uploaded visual assets for preview. |
| `callFunction(...)` | Calls Supabase edge functions with auth headers. |

---

## Backend Session Assembly

File: `supabase/functions/assemble-exam/index.ts`

Core behavior:

1. Authenticate the user JWT.
2. Resume a live session if one exists.
3. Find templates already used by the student.
4. Select the first active unused template, ordered by primary first.
5. Insert `diagnostic_sessions`.
6. Insert the six `session_sections`.
7. Copy rows from `diagnostic_template_questions` into `session_questions`.
8. Return session metadata to the frontend.

The student never receives the template directly. They receive frozen
`session_questions`, which protects in-progress sessions from later template
edits.

---

## Backend Question Bundle

File: `supabase/functions/get-question-bundle/index.ts`

Core behavior:

1. Authenticate the user JWT.
2. Confirm the session belongs to the user.
3. Load the requested section from `session_sections`.
4. Load matching `session_questions` joined to `questions`, `stimuli`, and
   `instructions`.
5. Load `question_visual_assets` joined to `visual_assets`.
6. Load existing responses for the section.
7. Return question payloads without `correct_answer`.

This is the function that protects answer keys during the student exam.

---

## Backend Answer And Section Submission

| Function | Main tables |
|---|---|
| `submit-answer` | `diagnostic_sessions`, `session_questions`, `questions`, `session_responses` |
| `submit-section` | `session_sections`, `session_questions`, `session_responses`, `diagnostic_sessions` |
| `heartbeat` | `session_sections` |
| `pause-section` | `session_sections` |

Correctness is computed in `submit-answer`, server-side, using the service-role
client. The browser sends only the selected answer.

`submit-section` locks the section, fills unanswered questions as incorrect, and
starts the next section or marks the session `ready_to_finalize`.

---

## Scoring And Results

| File | Purpose |
|---|---|
| `supabase/functions/finalize-exam/index.ts` | Loads graded responses, calls the scoring engine, writes result tables. |
| `supabase/functions/_shared/scoring-engine.ts` | Pure scoring logic. |
| `supabase/functions/get-results/index.ts` | Reads the final result tables for display. |

`finalize-exam` writes:

- `session_subject_scores`
- `session_topic_scores`
- `session_subtopic_scores`
- `session_classification_scores`
- `session_readiness_tiers`
- `session_recommendations`
- `session_university_predictions`
- `session_percentiles`

---

## Environment Variables

Frontend build variables:

| Variable | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL. |
| `VITE_SUPABASE_ANON_KEY` | Public anon key used by browser requests. |

Edge function secrets:

| Secret | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase URL injected by Supabase. |
| `SUPABASE_ANON_KEY` | Anon key injected by Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged server-side database access. |
| `ANTHROPIC_API_KEY` | AI question generation API key. |
| `ANTHROPIC_MODEL` | Optional model override. Defaults to `claude-sonnet-4-6`. |
| `CORS_ALLOWED_ORIGIN` | Optional CORS restriction. Defaults to `*`. |

---

## Commands

Install:

```bash
npm install
```

Run locally:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Run tests:

```bash
npm test
```

Deploy one edge function:

```bash
npx supabase functions deploy assemble-exam --project-ref <your-project-ref>
```

Deploy after shared scoring changes:

```bash
npx supabase functions deploy finalize-exam --project-ref <your-project-ref>
```

Apply migrations:

```bash
npx supabase db push
```
