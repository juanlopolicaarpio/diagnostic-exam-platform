# QuestionBank - User Manual

How to use the QuestionBank platform. This is written for a teacher or
administrator, not for a developer. Exam Builder is one tab inside QuestionBank.

---

## Contents

1. Signing in and navigation
2. Question Bank
3. Exam Builder
4. Student Preview
5. Managing exams
6. Categories
7. AI Generator
8. Quizzes
9. Troubleshooting

---

## 1. Signing In And Navigation

Open QuestionBank and sign in with an admin email and password.

The app has five main tabs:

| Tab | Purpose |
|---|---|
| Question Bank | Search, filter, edit, upload figures, bulk update, and import/export questions. |
| Exam Builder | Build and manage the full 170-question diagnostic exam. |
| Quizzes | Build shorter flexible quizzes from the same question bank. |
| Categories | Manage the subject, topic, and subtopic taxonomy. |
| AI Generator | Generate verified questions using AI and upload them to the Question Bank. |

The app does not use separate browser URLs for each tab. If you refresh the
page, it returns to the Question Bank. Use the app tabs for navigation.

---

## 2. Question Bank

The Question Bank is the main content management area. It shows question cards,
24 per page.

### Search And Filter

Use the search box to find a question by text, choice text, answer text, or
question ID.

Use the filters to narrow by:

| Filter | Use |
|---|---|
| Subject | Example: Mathematics, Science, Reading. |
| Topic | The main topic under the subject. |
| Subtopic | The detailed skill or concept. |
| Source school | UPCAT, ACET, DCAT, USTET, or AI Generated. |
| Difficulty | Easy, medium, hard. |
| Status | Active, retired, needs_human_review, and other internal review states. |

When a filter is active, use Clear to return to the full bank.

### Question Statuses

| Status | Meaning |
|---|---|
| active | Live and available for exams, quizzes, and practice. |
| needs_human_review | Saved but flagged by validation, usually because a math item needs checking. |
| retired | Kept in the database but not served to students. |

### Opening A Question

Click a question card to open it. The modal shows the question as a student
would see it, including math, underlined text, passages, inline SVG diagrams,
and attached visual assets.

Click Edit Question to change:

- question text
- answer choices
- correct answer
- subject, topic, and subtopic
- difficulty
- source school
- status
- reading passage or instruction linkage
- inline SVG content, when present

Click Save Changes to write the edit to the database.

### Adding Figures Or Files

Figures are attached while editing a question.

1. Open the question.
2. Click Edit Question.
3. Scroll to the Figures area.
4. Optionally enter alt text or a caption.
5. Choose a file.

The file uploads to the `question-visuals` storage bucket and is connected to
that question. The renderer supports images, SVG, PDF, video, audio, and generic
file links.

Some questions use inline SVG stored directly on the question row. Those show as
visuals too, but they are edited through the SVG content field instead of the
file upload control.

### Bulk Actions

Use Select page to select all visible questions. With selected questions, you
can:

- bulk change difficulty
- export only the selected questions
- clear the current selection

### Exporting Questions

Choose an export format:

| Format | Use |
|---|---|
| CSV | Spreadsheet editing or database review. |
| Word `.docx` | Human review, printing, or sharing with editors. |
| PDF | Fixed-layout review and printing. |

If questions are selected, the export includes only those selected questions. If
nothing is selected, the export follows the current filter/search result.

---

### Importing Questions In Bulk

**Import CSV** is the inverse of the CSV export: export a subject, edit the
sheet, upload it back. There is one file format for both directions, so you
never have to build a file from scratch — though **Download blank template** in
the import window gives you one if you prefer.

Pick the file with **Import CSV**. Nothing is written yet: the file is read and
checked in your browser first, and a preview window shows what would happen.
Only when you press **Import N rows** does anything reach the database.

The preview reports five numbers:

| Number | Meaning |
|---|---|
| rows | Data rows found in the file, excluding the header. |
| new questions | Rows with a blank `id` — these will be created. |
| updates | Rows with an `id` — these will change an existing question. |
| blocked | Rows with an error. They are skipped; everything else still imports. |
| warnings | Rows that will import but deserve a look. |

New questions are saved as **drafts**. Students never see a draft. Filter
Status = draft in the bank to review and activate them. Unticking "New
questions land as drafts" lets a row import as `active` directly — only do that
for content that has already been reviewed somewhere else.

#### Blank `id` creates, filled `id` updates

That single rule is the whole mental model.

An update only touches the columns that are **in your file**. A sheet with just
`id` and `difficulty_level` changes the difficulty of those questions and
nothing else. A column you leave out is never overwritten, and an **empty cell
in an update is ignored**, not treated as "erase this" — so you cannot wipe a
stem or a subtopic by accident. (To clear a subtopic, use the bank's bulk Move
controls instead.)

#### Columns

Headers are matched case-insensitively and ignore spaces and underscores, so
`Question Text`, `question_text`, and `QUESTION TEXT` are the same column. A few
common alternatives are also understood: `question`/`stem`, `answer`/`answer
key`, `option a`, `difficulty`, `passage`, `source`. Column order does not
matter, unrecognized columns are listed in the preview and ignored, and
tab-separated files (pasted straight out of Excel or Google Sheets) work too.

Required for a **new** question:

| Column | Rules |
|---|---|
| `subject` | Any text. A subject not yet in the bank imports with a warning. |
| `topic` | Any text. New topics warn, same as subjects. |
| `question_text` | The stem. Math may be written plainly (`x^2`, `1/2`) or as LaTeX. |
| `choice_a` – `choice_d` | All four are required. `choice_e` is optional and legacy. |
| `correct_answer` | A letter A–E. `A`, `a`, `(A)`, and `A.` all work. If you paste the answer *text* instead and it matches exactly one choice, that choice is used and the row is flagged with a warning. |
| `source_school` | One of `UPCAT`, `ACET`, `DCAT`, `USTET`, `AI Generated`. Required — the database does not allow a question without provenance. Case is forgiven. |

Optional on a new question:

| Column | Rules |
|---|---|
| `id` | Leave blank. Filling it turns the row into an update. |
| `subtopic` | Blank is fine. |
| `difficulty_level` | `easy`, `medium`, or `hard`. Blank defaults to `medium` with a warning. |
| `status` | `active`, `draft`, or `retired`. Defaults to `draft`, and stays `draft` unless you untick the drafts option. |
| `stimulus_id` | UUID of an existing passage, to attach this question to it. |
| `stimulus_title`, `stimulus_text`, `stimulus_type`, `stimulus_group_key` | A new passage, written inline. See below. |
| `svg_content` | An inline `<svg>...</svg>` diagram. Rejected if it contains script, `href`, or event handlers. |
| `render_markup`, `instruction_id` | Passed through as-is for the flows that use them. |

#### Passages

Two ways to attach a reading passage:

1. **Reuse an existing one** — put its UUID in `stimulus_id`. Export a Reading
   subject to find the UUIDs.
2. **Write a new one inline** — fill `stimulus_text` (and ideally
   `stimulus_title`). Every row whose passage text is identical shares a single
   passage, so a ten-question passage set produces one passage, not ten. Give
   those rows byte-identical text — a stray edit in one row creates a second
   copy. `stimulus_group_key` is derived from the title when you leave it blank.

If both `stimulus_id` and `stimulus_text` are filled, the existing passage wins
and the row is flagged with a warning.

#### What the preview blocks

A blocked row is never sent to the database. The common causes:

- a missing required column
- `correct_answer` that is not a letter and does not match a choice
- `correct_answer` pointing at an empty choice
- `difficulty_level`, `status`, or `source_school` outside its allowed values
- an `id` that is not a valid UUID, or the same `id` twice in one file
- inline SVG that fails the safety check

Warnings never block: a new subject/topic/subtopic, a defaulted difficulty, two
choices with identical text, a repeated stem, or a maths item whose answer key
does not match the arithmetic the app can verify.

#### What CSV cannot carry

Uploaded figures — images, PDFs, and other attached files — are not part of the
CSV. They live in storage and are attached per question in the edit screen.
Inline `svg_content` is the exception and does import. CSV export does not
include `svg_content`, so a round trip leaves existing diagrams untouched rather
than erasing them.

---

## 3. Exam Builder

The diagnostic exam is fixed at 170 questions across 6 timed sections.

| Section | Questions | Time |
|---|---:|---:|
| Language | 30 | 18:00 |
| Reading | 30 | 23:30 |
| Mathematics | 40 | 50:00 |
| Science | 40 | 33:20 |
| Social Studies | 15 | 9:00 |
| Logic / Abstract Reasoning | 15 | 18:45 |

The counts and timers are fixed. The teacher controls which questions fill each
section.

### Starting A New Exam

1. Go to Exam Builder.
2. Click New Exam.
3. Enter a name, such as `Mock Exam 2`.
4. The builder opens a local draft immediately.

The builder has four stages:

| Stage | Purpose |
|---|---|
| Welcome | Overview and starting point. |
| 1. Plan | Choose topic/subtopic distribution and difficulty split. |
| 2. Pick Questions | Auto-pick or manually select matching questions. |
| 3. Check | Review all selected questions in exam order and save. |

### Stage 1 - Plan

The plan is the blueprint for the exam. For each section, choose:

- topic names
- how many questions each topic gets
- subtopic names
- how many questions each subtopic gets
- easy, medium, and hard counts per subtopic

Use Fill Recommended Plan to load the standard QuestionBank diagnostic
distribution.
This is the normal starting point.

The builder enforces the section totals. You cannot move to question picking
until every section adds up to its required question count.

### Moving Quota Between Topics

If one topic has too many questions and another has too few, use the quota move
controls in the Plan stage. This moves question count between topics without
changing the section total.

### Stage 2 - Pick Questions

The completed plan becomes a list of slots. A slot means one exact requirement,
for example:

`Mathematics / Algebra / Factoring / hard / 1 question`

Click Auto-pick Questions to fill the slots from the bank.

Auto-pick uses only active questions. It matches:

- subject
- topic
- subtopic, when the slot has one
- difficulty

For Reading, auto-pick keeps passage groups together and limits how much one
passage can dominate the Reading section.

After auto-pick, review the slots manually. You can search and swap questions
inside a slot.

### When A Slot Will Not Fill

A slot will not fill when the bank does not have enough active questions matching
the exact subject/topic/subtopic/difficulty requirement.

Use one of these fixes:

- reduce the slot count
- move count to another topic or subtopic
- loosen the difficulty distribution
- generate or write more questions for that scope

### Stage 3 - Check

The Check stage shows the full exam in section order. Review:

- total count
- section order
- passages
- diagrams
- repeated questions
- question wording
- answer choices

Save Exam becomes available only when all slots are complete.

Click Save Exam, then confirm. The app writes to:

- `diagnostic_templates`
- `diagnostic_template_questions`

### Drafts

Exam drafts are saved in the browser's local storage. If you close the tab, the
draft appears again on the Exam Builder home screen.

Drafts are local to that browser on that computer. They do not sync to other
users until the exam is saved.

Use Discard Changes to delete the local draft and reload the saved database
version.

---

## 4. Student Preview

Preview Exam launches the real student exam flow against the backend.

Use it to check:

- section order
- timers
- passage display
- SVG diagrams
- uploaded figures
- answer saving
- section submission
- final results

If you find a bad question in preview, open it from the preview modal and edit
it. The edit writes back to the same `questions` table used by the Question
Bank.

---

## 5. Managing Exams

Every saved diagnostic template has a serving status.

| Status | Meaning |
|---|---|
| ACTIVE | The primary exam served first. |
| AVAILABLE | Usable after a student has already taken the primary exam. |
| INACTIVE | Not served to students. |

Set as Active promotes an available exam to the primary exam.

Delete removes the exam definition from the template list. Student sessions
attached to that exam are moved to the archive template first so session history
is not left pointing at a missing template.

Students are not given the same exam template twice. If a student has completed
all active/available templates, the backend reports that no retake is available.

---

## 6. Categories

Categories manage the taxonomy:

`Subject -> Topic -> Subtopic`

Categories matter because they drive:

- Question Bank filters
- Exam Builder planning
- AI Generator scope
- subtopic-level results
- course-cluster scoring

### Creating A Category

1. Go to Categories.
2. Click New Subject, Topic, or Subtopic.
3. Enter the subject/topic/subtopic names.
4. Save.

The system writes rows to `subtopic_classification_importance` for every course
classification code, with default Low importance. This makes the taxonomy appear
immediately even before questions exist.

### Deleting A Category

A category can be deleted only when it has zero questions. Move or retire the
questions first, then delete the empty category.

### Adding Questions From Categories

Open a subtopic and click Add questions. You can:

- generate questions with AI
- create a question manually
- move existing questions into that scope

---

## 7. AI Generator

The AI Generator creates multiple-choice questions for a selected topic or
subtopic.

### Generate Questions

1. Go to AI Generator.
2. Pick a topic or subtopic from the left taxonomy panel.
3. Enter how many easy, medium, and hard questions you want.
4. Optionally add standards or instructions.
5. Click Generate.

Questions appear in waves. Large requests are split into smaller backend calls
so the teacher can see results as they pass verification.

### Stop A Run

Click Stop after this wave to stop generation. Questions already generated stay
on screen.

Closing or refreshing the browser tab stops the run.

### Edit Generated Questions

Before uploading, edit any generated question in the panel:

- question text
- choices
- correct answer
- difficulty
- SVG diagram, if present
- reading passage metadata, if present

### Improve With AI

Use Improve with AI on one generated question at a time. Enter a specific
instruction, such as:

- make the distractors more plausible
- make this harder
- simplify the wording
- fix the diagram label

The revised version must pass the same verification gate before it replaces the
generated question.

### Upload

Click Upload to write the accepted generated questions to the Question Bank.

### Why The Generator Returns Fewer Than Requested

The generator rejects items that fail linting or blind-solver verification. If
you ask for 20 and receive 16, the other 4 did not pass the quality gate. Run
the generator again to top up the scope.

---

## 8. Quizzes

Quizzes are flexible assessments built from the same question bank. Unlike the
diagnostic, quizzes are not fixed at 170 questions.

Use quizzes when you want:

- one subject only
- a short review quiz
- a custom mix of sections
- a printable quiz and answer key

### Building A Quiz

1. Go to Quizzes.
2. Click New Quiz.
3. Add one or more sections.
4. Set the target count for each section.
5. Auto-pick or manually add questions.
6. Preview or export the quiz.
7. Save or publish when ready.

Quizzes use separate tables from diagnostic exams, so creating a quiz does not
change the active diagnostic.

---

## 9. Troubleshooting

| Issue | What to do |
|---|---|
| A question slot will not fill | Add more active matching questions, adjust the plan, or generate new questions for that scope. |
| AI returns fewer questions than requested | Some items failed verification. Generate again to top up. |
| An uploaded figure does not show | Reopen the question, confirm it is attached in Edit mode, and check the file preview. |
| Math rendering looks wrong | Note the question ID and send it to the developer. |
| Draft exam disappeared on another computer | Drafts are local to the browser. Save the exam to sync it through the database. |
| A student preview has no next exam | The preview student has already used the available active templates. Add or activate another template. |
| A category cannot be deleted | It still has questions. Move or retire those questions first. |
