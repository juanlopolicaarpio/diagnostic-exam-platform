# `get-practice-questions` — Edge Function API Reference

**Base URL:** `https://<your-project-ref>.supabase.co/functions/v1`

---

## Endpoint

```
POST /get-practice-questions
```

Returns a randomised batch of practice questions for the Adaptive Learning module.
Call this when a student clicks a topic or subtopic on their results page.

**Per-student de-duplication (automatic, server-side):** Each student is served
questions they haven't seen yet for the same drill scope. Calling the endpoint
again for the same `subtopic` (or `topic`, or whole `subject`) returns a *new*
batch, not a repeat — until they've worked through the bank for that scope, at
which point it transparently recycles and reshuffles from the start. This needs
no client changes: send the same request and the function tracks history by the
authenticated student's token. Note: if a scope has fewer questions than `limit`,
the same questions will necessarily repeat (reshuffled) — there's nothing else to
serve.

---

## Request

### Headers

| Header | Required | Value |
|---|---|---|
| `Authorization` | Yes | `Bearer <student_access_token>` |
| `Content-Type` | Yes | `application/json` |
| `apikey` | Yes | Supabase anon key (see below) |

**Anon key:**
```
<YOUR_SUPABASE_ANON_KEY>
```

The `Authorization` token must be the student's active Supabase session JWT — the same token you get back from sign-in. The function will reject expired or invalid tokens with `401`.

### Body (JSON)

| Field | Type | Required | Description |
|---|---|---|---|
| `subject` | string | **Yes** | Subject name — must match exactly (see valid values below) |
| `topic` | string | No | Topic within the subject. Omit to get questions from any topic. |
| `subtopic` | string | No | Subtopic within the topic. Takes priority over `topic` when both are sent. |
| `limit` | number | No | How many questions to return. Default: `10`. Max: `20`. |

**Valid `subject` values (exact strings, case-sensitive):**
- `Mathematics`
- `English Language`
- `Reading`
- `Science`
- `Social Studies`
- `Filipino Language`
- `Logic/Abstract Reasoning`

**Important — Logic/Abstract Reasoning:** Questions for this subject have no topic stored in the database. If you send a `topic` value alongside `subject: "Logic/Abstract Reasoning"`, the topic is silently ignored and you get questions for the whole subject. This is intentional.

---

## Response

### 200 OK

```json
{
  "questions": [
    {
      "id": "7c1d04e9-3a62-4b18-9f05-2e8b6c4d1a93",
      "subject": "Mathematics",
      "topic": "Algebra",
      "subtopic": "Algebraic Expressions",
      "difficulty_level": "medium",
      "question_text": "Simplify completely: 8(4x - 9) - 4(x - 9).",
      "render_markup": null,
      "choice_a": "24x - 36",
      "choice_b": "32x - 36",
      "choice_c": "28x + 36",
      "choice_d": "28x - 36",
      "choice_e": null,
      "correct_answer": "d",
      "svg_content": null,
      "stimulus_id": "uuid-or-null",
      "instruction_id": "uuid-or-null",
      "stimulus": null,
      "instruction": null
    }
  ]
}
```

**Field notes:**

| Field | Notes |
|---|---|
| `correct_answer` | Lowercase letter: `"a"`, `"b"`, `"c"`, `"d"`, or `"e"` |
| `choice_e` | May be `null` — not all questions have a fifth option |
| `render_markup` | If non-null, render this instead of `question_text` (it's a structured markup string for special question types like error-identification) |
| `svg_content` | Inline SVG string for abstract reasoning questions. Render as raw HTML/SVG when non-null. |
| `stimulus` | Pre-joined reading passage. `null` if the question has no passage. See shape below. |
| `instruction` | Pre-joined instruction text. `null` if not applicable. See shape below. |

**`stimulus` shape (when non-null):**
```json
{
  "id": "uuid",
  "stimulus_title": "Spot-the-error sentences",
  "stimulus_type": "spot_the_error_sentence",
  "stimulus_text": "Full passage text here..."
}
```

**`instruction` shape (when non-null):**
```json
{
  "id": "uuid",
  "instruction_text": "Select the underlined word or phrase that contains a grammatical error."
}
```

If `questions` is an empty array `[]`, it means no active questions are tagged for that subject/topic/subtopic combination yet — show a friendly "no questions available" message rather than an error.

---

## Error Responses

| Status | Meaning | `error` field |
|---|---|---|
| `400` | Missing or invalid `subject` | Lists the valid subject values |
| `400` | Bad JSON body | `"Invalid JSON body."` |
| `401` | Missing `Authorization` header | `"Missing authorization header"` |
| `401` | Token expired or invalid | `"Invalid or expired token"` |
| `405` | Wrong HTTP method (must be POST) | `"Method not allowed. Use POST."` |
| `500` | Database error | `"Failed to fetch questions."` |

All error responses have the shape:
```json
{ "error": "Human-readable message here" }
```

---

## Example — JavaScript / fetch

```js
async function getPracticeQuestions({ token, subject, topic, subtopic, limit = 10 }) {
  const res = await fetch(
    "https://<your-project-ref>.supabase.co/functions/v1/get-practice-questions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "apikey": "<YOUR_SUPABASE_ANON_KEY>",
      },
      body: JSON.stringify({ subject, topic, subtopic, limit }),
    }
  );

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.questions; // Question[]
}

// Usage — topic-level drill
const questions = await getPracticeQuestions({
  token: studentSession.access_token,
  subject: "Mathematics",
  topic: "Algebra",
});

// Usage — subtopic-level drill (more specific)
const questions = await getPracticeQuestions({
  token: studentSession.access_token,
  subject: "English Language",
  topic: "Advanced Grammar & Syntax",
  subtopic: "Coordination and subordination",
});

// Usage — Logic (no topic needed)
const questions = await getPracticeQuestions({
  token: studentSession.access_token,
  subject: "Logic/Abstract Reasoning",
});
```

---

## How to render questions

**Typical question (most common):**
- Show `question_text` as the question prompt
- Show `choice_a` through `choice_d` (and `choice_e` if non-null) as answer options
- Compare the student's chosen letter against `correct_answer` (both lowercase)

**Reading passage questions (`stimulus` is non-null):**
- Show `stimulus.stimulus_text` above the question as a reading passage
- Use `stimulus.stimulus_title` as a label (e.g. "Read the passage below:")
- Then show `question_text` and choices as normal

**Structured markup questions (`render_markup` is non-null):**
- Render `render_markup` instead of `question_text` — it contains special formatting for error-identification questions
- If `instruction` is non-null, show `instruction.instruction_text` above it as a directive
- Contact the the platform team for the markup renderer component if you don't already have it

**Abstract reasoning questions (`svg_content` is non-null):**
- Render `svg_content` as raw inline SVG — it contains the visual pattern the student must solve
- `question_text` typically just says something like "What comes next?" in these cases

---

## Scalability

The function is stateless and read-only. It:
- Fetches a pool of up to 50 matching questions and shuffles them in-memory (no `ORDER BY random()` full-table scan)
- Joins stimulus and instruction rows in a single parallel `Promise.all` — no sequential round trips
- Uses the service-role key server-side so RLS policies don't add per-row overhead
- Runs on Deno Deploy (globally distributed) — no cold start concerns at scale

It can handle thousands of concurrent students without issue.
