-- Per-student history of served practice questions.
-- Lets get-practice-questions skip questions a student has already seen for a
-- given drill scope (subject / topic / subtopic) until the bank is exhausted.
--
-- Only the service-role key (used by the edge function) touches this table, so
-- RLS is enabled with no policies to lock it down to server-side access.

create table if not exists public.practice_question_history (
  user_id     uuid        not null references auth.users(id)      on delete cascade,
  subject     text        not null,
  scope       text        not null,
  question_id uuid        not null references public.questions(id) on delete cascade,
  served_at   timestamptz not null default now(),
  primary key (user_id, subject, scope, question_id)
);

create index if not exists idx_pqh_user_scope
  on public.practice_question_history (user_id, subject, scope);

alter table public.practice_question_history enable row level security;
