# Edge Functions — how they work and how to deploy them

Everything here is verified against this project. Commands are copy-pasteable.

---

## 1. What an edge function is

A Supabase Edge Function is a **single TypeScript file that runs on a server
when someone HTTP-POSTs to a URL.** That is the whole model.

- It runs on **Deno**, not Node. That's why imports are URLs
  (`https://esm.sh/@supabase/supabase-js@2`) — there is no `node_modules`.
- Each function is a folder under `supabase/functions/<name>/` containing
  `index.ts`.
- `supabase/functions/_shared/` is importable by all of them and is **not**
  itself a function.
- It is stateless. Nothing survives between requests. Anything you need to
  remember goes in Postgres.
- Its URL is `https://<project>.supabase.co/functions/v1/<name>`.

The smallest possible one:

```ts
Deno.serve(async (req) => {
  const body = await req.json();
  return new Response(JSON.stringify({ hello: body.name }), {
    headers: { "Content-Type": "application/json" },
  });
});
```

`Deno.serve` takes a function that receives a `Request` and returns a
`Response`. Every function in this repo is that, plus guard rails.

## 2. Why this project uses them at all

The admin app talks to Postgres **directly** through PostgREST. So why have
functions at all? Three reasons, and every function here exists for one of them:

| Reason | Example | Why the browser can't do it |
|---|---|---|
| **Secrets** | `generate-question-batch` | The Anthropic API key must never reach a browser bundle |
| **Trust** | `submit-answer`, `submit-section` | Grading requires reading `correct_answer`, which students must never see |
| **Privilege** | `finalize-exam`, `assemble-exam` | Writing scores and creating sessions needs to bypass RLS |

If a piece of logic needs none of those three, it does **not** need a function —
put it in the client and let RLS do the work. That's the rule for deciding
where new code goes.

## 3. The two-client pattern — the most important idea here

Every function in this repo does this, via `_shared/utils.ts`:

```ts
const { userClient, adminClient } = createClients(req);
const user = await authenticateUser(userClient);   // WHO are you?
// …then use adminClient for the privileged work
```

- **`userClient`** is built with the **anon key** plus the caller's JWT. Every
  query through it is filtered by RLS. Its only job is to answer *"who is
  making this request?"* — `authenticateUser` throws a 401 if the token is
  invalid or expired.
- **`adminClient`** is built with the **service-role key**. It bypasses RLS
  entirely. It can read `correct_answer` and write to any table.

The order matters and is non-negotiable: **authenticate with the user client
first, then act with the admin client.** Skipping the first step means anyone
with the public anon key can invoke a function that writes with god-mode
privileges.

Whenever you write a new function, copy this shape. It is the security model.

## 4. Reading a real one

`submit-answer/index.ts`, in outline:

```
1. withErrorHandling(...)         handles the CORS preflight and turns any
                                  thrown ApiError into the right HTTP status
2. reject non-POST                → 405
3. createClients + authenticateUser
4. validate input                 requireUuid(session_id), requireSectionName(...)
5. verify ownership               does this session belong to this user?
6. adminClient reads correct_answer, compares, upserts the graded response
7. jsonResponse({...})
```

Steps 1–5 are boilerplate you will repeat. Steps 6–7 are the actual feature.
`_shared/utils.ts` exists so 1–5 are three lines instead of forty.

Two helpers worth knowing:

- `ApiError(status, message)` — throw it anywhere and `withErrorHandling`
  converts it to that HTTP status. No manual response plumbing.
- `SECTION_CONFIG` — the single source of truth for section names, counts, and
  times. Never hardcode a section list in a function; import this.

## 5. Deploying

### One function

```bash
npx supabase functions deploy <name> --project-ref <your-project-ref>
```

That's the whole thing. It bundles the folder plus anything it imports from
`_shared/`, uploads it, and swaps it live in a few seconds. There is no build
step and no restart.

`WARNING: Docker is not running` is harmless — Docker is only needed to run
functions locally.

### Several

```bash
for f in assemble-quiz submit-quiz-answer finalize-quiz; do
  npx supabase functions deploy $f --project-ref <your-project-ref>
done
```

### Important gotcha: editing `_shared/` does not deploy anything

`_shared/` is not a function — it is bundled *into* functions at deploy time.
So when you change `scoring-engine.ts`, **nothing happens in production until
you redeploy every function that imports it.**

```bash
# after touching _shared/scoring-engine.ts:
npx supabase functions deploy finalize-exam --project-ref <your-project-ref>

# after touching _shared/utils.ts — that's imported nearly everywhere:
grep -rl "_shared/utils.ts" supabase/functions --include=index.ts
```

This is the single easiest way to think you shipped a fix and not have shipped
it.

### Checking what is actually live

```bash
npx supabase functions list --project-ref <your-project-ref>
```

Or just call it — a `404` means not deployed, anything else means it is:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "$VITE_SUPABASE_URL/functions/v1/generate-question-batch" \
  -H "apikey: $VITE_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer <a user JWT>" \
  -H "Content-Type: application/json" -d '{}'
```

| Code | Meaning |
|---|---|
| 404 | Not deployed |
| 401 | Deployed; your token is missing or invalid |
| 400 | Deployed and authenticated; your body failed validation |
| 405 | Deployed; wrong HTTP method (several here are GET-only) |

`400` is the healthy answer to an empty body — it means the function ran.

## 6. Secrets

Functions do **not** read your local `.env`. They read secrets stored on the
project:

```bash
npx supabase secrets list --project-ref <your-project-ref>
npx supabase secrets set ANTHROPIC_MODEL=claude-opus-5 --project-ref <your-project-ref>
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically — never set those by hand. This project additionally
needs `ANTHROPIC_API_KEY` and optionally `ANTHROPIC_MODEL` and
`CORS_ALLOWED_ORIGIN`.

Changing a secret takes effect on the next invocation; no redeploy needed.

## 7. Logs and debugging

Supabase Dashboard → Edge Functions → pick the function → **Logs**. Every
`console.log` / `console.error` lands there, along with status codes and
durations. When something 500s in production this is the first place to look —
the client only ever sees `"Internal server error"`, deliberately.

## 8. Timeouts — why generation runs in waves

A function has a wall-clock limit. `generate-question-batch` makes **at least
two Anthropic round trips** per attempt (generate, then blind-solve verify) and
retries up to 4 times. A large batch can blow the limit, and when it does you
lose everything — there is no partial result.

That is why `MAX_BATCH = 15` exists in that function, and why the client asks
for 40 questions as four waves of ten rather than one call
(`src/useQuestionGeneration.js`). Waves also mean the teacher sees questions
appear progressively instead of staring at a spinner.

**Rule for any new function that calls a model: bound the work per invocation,
and let the client loop.** If the work genuinely can't be bounded, it needs a
job row in Postgres and a poll — not a longer timeout.

## 9. Local development

```bash
npx supabase functions serve <name>    # requires Docker
```

Honestly: for this project it is usually faster to deploy and read the logs.
The functions are small, deploys take seconds, and there is no local database
with several thousand questions in it.

## 10. Writing a new one — checklist

1. `supabase/functions/<name>/index.ts`
2. Import the guard rails:
   ```ts
   import { createClients, authenticateUser, ApiError, jsonResponse,
            withErrorHandling } from "../_shared/utils.ts";
   ```
3. `serve(withErrorHandling(async (req) => { … }))`
4. Reject the wrong method → `throw new ApiError(405, "…")`
5. `createClients(req)` → `authenticateUser(userClient)`
6. Validate every input (`requireUuid`, `requireSectionName`). Never trust the
   body.
7. Check ownership before touching anything user-scoped.
8. Do the privileged work with `adminClient`.
9. Bound any model calls. Return `jsonResponse(...)`.
10. Deploy, then verify with `curl` that an empty body gives 400, not 404.
11. **Commit it.** Several functions in this repo exist only on one laptop.

## 11. The functions in this project

| Function | Method | Purpose |
|---|---|---|
| `assemble-exam` | POST | Create or resume a student's 170-question session |
| `get-question-bundle` | GET | One section's questions, `correct_answer` stripped |
| `submit-answer` | POST | Grade and store one response |
| `submit-section` | POST | Lock a section, fill blanks as wrong, advance |
| `heartbeat` | POST | Keep the section clock honest across disconnects |
| `pause-section`, `pause-demo-exam` | POST | Freeze the clock |
| `finalize-exam` | POST | Run the scoring engine, write 8 result tables |
| `get-results` | GET | Read those 8 tables back |
| `get-practice-questions` | POST | Adaptive drills; AI top-up when the bank runs dry |
| `generate-question-batch` | POST | Teacher-facing AI generation and revision |
| `assemble-quiz`, `submit-quiz-answer`, `finalize-quiz` | POST | Quiz runtime |
