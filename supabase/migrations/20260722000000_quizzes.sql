-- ============================================================================
-- QUIZZES — flexible, teacher-built assessments
-- ============================================================================
-- Unlike diagnostic_templates (a fixed 170-question exam across 6 sections),
-- a quiz can be any size and any subject mix (e.g. 10 math, or 10 math /
-- 5 reading / 5 English). Kept in separate tables so quizzes never affect the
-- diagnostic active/primary pool or the assemble-exam template picker.
--
-- Access model (mirrors the existing diagnostic tables, which the admin app
-- writes using the logged-in admin's access token):
--   * quizzes / quiz_questions      → manageable by the `authenticated` role.
--   * quiz_sessions / *_questions /
--     quiz_responses                → a student sees only their own rows.
--     Grading writes go through the edge functions using the service-role key
--     (which bypasses RLS), same as the diagnostic submit-answer flow.
-- ============================================================================

-- ── Quiz (the assessment itself) ──
create table if not exists public.quizzes (
  id              uuid        primary key default gen_random_uuid(),
  code            text        not null unique,
  title           text        not null,
  description     text,
  created_by      uuid        references auth.users(id) on delete set null,
  total_questions integer     not null default 0,
  is_published    boolean     not null default false,
  settings        jsonb       not null default '{}'::jsonb,  -- per-section time limits, shuffle, etc.
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ── Quiz question list (which questions, in what order, in which section) ──
create table if not exists public.quiz_questions (
  id            uuid        primary key default gen_random_uuid(),
  quiz_id       uuid        not null references public.quizzes(id)   on delete cascade,
  question_id   uuid        not null references public.questions(id) on delete cascade,
  section_name  text        not null,   -- free label: language | reading | math | ... | custom
  display_order integer     not null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_quiz_questions_quiz
  on public.quiz_questions (quiz_id, display_order);

-- ── Student session (one attempt at a quiz) ──
create table if not exists public.quiz_sessions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users(id)  on delete cascade,
  quiz_id      uuid        not null references public.quizzes(id) on delete cascade,
  status       text        not null default 'in_progress',  -- in_progress | completed | expired
  score        integer,
  total        integer,
  started_at   timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_quiz_sessions_user
  on public.quiz_sessions (user_id, status);

-- ── Frozen snapshot of the quiz's questions for a session ──
create table if not exists public.quiz_session_questions (
  id            uuid    primary key default gen_random_uuid(),
  session_id    uuid    not null references public.quiz_sessions(id) on delete cascade,
  question_id   uuid    not null references public.questions(id)     on delete cascade,
  section_name  text    not null,
  display_order integer not null,
  locked        boolean not null default false
);

create index if not exists idx_qsq_session
  on public.quiz_session_questions (session_id, display_order);

-- ── Graded answers ──
create table if not exists public.quiz_responses (
  id              uuid        primary key default gen_random_uuid(),
  session_id      uuid        not null references public.quiz_sessions(id) on delete cascade,
  question_id     uuid        not null references public.questions(id)     on delete cascade,
  selected_answer text,
  is_correct      boolean,
  answered_at     timestamptz not null default now(),
  unique (session_id, question_id)
);

create index if not exists idx_quiz_responses_session
  on public.quiz_responses (session_id);

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table public.quizzes                enable row level security;
alter table public.quiz_questions         enable row level security;
alter table public.quiz_sessions          enable row level security;
alter table public.quiz_session_questions enable row level security;
alter table public.quiz_responses         enable row level security;

-- Quiz authoring: the admin app acts as an authenticated user, same posture as
-- the diagnostic_templates tables. (No role table exists in this project; add a
-- role/claim check here if teacher vs. student separation is introduced later.)
drop policy if exists quizzes_authoring on public.quizzes;
create policy quizzes_authoring on public.quizzes
  for all to authenticated using (true) with check (true);

drop policy if exists quiz_questions_authoring on public.quiz_questions;
create policy quiz_questions_authoring on public.quiz_questions
  for all to authenticated using (true) with check (true);

-- Sessions: a student may read and create/advance only their own attempts.
drop policy if exists quiz_sessions_own_select on public.quiz_sessions;
create policy quiz_sessions_own_select on public.quiz_sessions
  for select to authenticated using (user_id = auth.uid());

drop policy if exists quiz_sessions_own_insert on public.quiz_sessions;
create policy quiz_sessions_own_insert on public.quiz_sessions
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists quiz_sessions_own_update on public.quiz_sessions;
create policy quiz_sessions_own_update on public.quiz_sessions
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Session questions / responses: readable only when the parent session is the
-- caller's own. Writes are performed server-side with the service-role key.
drop policy if exists qsq_own_select on public.quiz_session_questions;
create policy qsq_own_select on public.quiz_session_questions
  for select to authenticated using (
    exists (
      select 1 from public.quiz_sessions s
      where s.id = quiz_session_questions.session_id and s.user_id = auth.uid()
    )
  );

drop policy if exists quiz_responses_own_select on public.quiz_responses;
create policy quiz_responses_own_select on public.quiz_responses
  for select to authenticated using (
    exists (
      select 1 from public.quiz_sessions s
      where s.id = quiz_responses.session_id and s.user_id = auth.uid()
    )
  );
