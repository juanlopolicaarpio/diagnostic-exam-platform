-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
-- The browser is a first-class database client here: both the admin app and the
-- student app talk to PostgREST directly with the caller's JWT. RLS is
-- therefore not defence-in-depth, it is the primary access control.
--
-- Three principals:
--
--   anon           — unauthenticated. No access to anything in this schema.
--   authenticated  — a signed-in user. A student by default; an admin only if
--                    they have a row in admin_users.
--   service_role   — held exclusively by edge functions. Bypasses RLS.
--                    Everything answer-key-adjacent lives behind it: reading
--                    correct_answer, grading, writing scores, calling the model
--                    provider.
--
-- Note on authorisation: the original system granted the whole `authenticated`
-- role full read/write on the content tables and never consulted admin_users,
-- which meant any account that could sign up could read the entire question
-- bank. That was recorded as a known gap rather than fixed under deadline. This
-- reference implementation closes it: content writes require admin membership,
-- and students can read only the frozen snapshot of their own attempt.
-- ============================================================================

-- ── Who is an admin? ──
-- SECURITY DEFINER so the function can read admin_users while admin_users
-- itself stays locked down. STABLE so the planner calls it once per statement
-- instead of once per row.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users where user_id = auth.uid()
  );
$$;

-- Does the calling user own this diagnostic session?
create or replace function public.owns_session(target_session uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.diagnostic_sessions s
    where s.id = target_session
      and s.user_id = auth.uid()
  );
$$;

alter table public.questions                        enable row level security;
alter table public.stimuli                          enable row level security;
alter table public.instructions                     enable row level security;
alter table public.visual_assets                    enable row level security;
alter table public.question_visual_assets           enable row level security;
alter table public.diagnostic_templates             enable row level security;
alter table public.diagnostic_template_questions    enable row level security;
alter table public.diagnostic_sessions              enable row level security;
alter table public.session_sections                 enable row level security;
alter table public.session_questions                enable row level security;
alter table public.session_responses                enable row level security;
alter table public.session_subject_scores           enable row level security;
alter table public.session_topic_scores             enable row level security;
alter table public.session_subtopic_scores          enable row level security;
alter table public.session_classification_scores    enable row level security;
alter table public.session_readiness_tiers          enable row level security;
alter table public.session_recommendations          enable row level security;
alter table public.session_university_predictions   enable row level security;
alter table public.session_percentiles              enable row level security;
alter table public.course_classifications           enable row level security;
alter table public.subtopic_classification_importance enable row level security;
alter table public.university_subject_weights       enable row level security;
alter table public.scoring_models                   enable row level security;
alter table public.admin_users                      enable row level security;

-- ============================================================================
-- CONTENT BANK — admins author, nobody else reads it directly
-- ============================================================================
-- Students never query `questions`. They receive items through
-- get-question-bundle, which runs under the service role and projects away
-- correct_answer before responding. That is the only way an answer key stays
-- a secret while the browser still talks to PostgREST.

create policy questions_admin_all on public.questions
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy stimuli_admin_all on public.stimuli
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy instructions_admin_all on public.instructions
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy visual_assets_admin_all on public.visual_assets
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy qva_admin_all on public.question_visual_assets
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- DIAGNOSTIC AUTHORING — admin only
-- ============================================================================

create policy templates_admin_all on public.diagnostic_templates
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy dtq_admin_all on public.diagnostic_template_questions
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- DIAGNOSTIC RUNTIME — a student sees only their own attempt
-- ============================================================================
-- Reads only. Every state transition that matters (starting a section,
-- submitting an answer, advancing the clock, finalizing) goes through an edge
-- function, because each one has invariants a client cannot be trusted to keep:
-- a section's time budget, the lock after submission, the grade.

create policy sessions_own_select on public.diagnostic_sessions
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy session_sections_own_select on public.session_sections
  for select to authenticated
  using (public.owns_session(session_id) or public.is_admin());

create policy session_questions_own_select on public.session_questions
  for select to authenticated
  using (public.owns_session(session_id) or public.is_admin());

-- A student may read back what they answered, but is_correct is written by
-- submit-answer and this table carries no question text or key, so reading it
-- reveals nothing the student did not already submit.
create policy session_responses_own_select on public.session_responses
  for select to authenticated
  using (
    exists (
      select 1
      from public.session_questions sq
      where sq.id = session_question_id
        and (public.owns_session(sq.session_id) or public.is_admin())
    )
  );

-- ============================================================================
-- RESULTS — readable by the student they belong to, written by finalize-exam
-- ============================================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'session_subject_scores',
    'session_topic_scores',
    'session_subtopic_scores',
    'session_classification_scores',
    'session_readiness_tiers',
    'session_recommendations',
    'session_university_predictions',
    'session_percentiles'
  ]
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated '
      'using (public.owns_session(session_id) or public.is_admin())',
      t || '_own_select', t
    );
  end loop;
end
$$;

-- ============================================================================
-- SCORING REFERENCE — readable by admins, tunable by admins, used by functions
-- ============================================================================

create policy classifications_admin_all on public.course_classifications
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy importance_admin_all on public.subtopic_classification_importance
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy university_weights_admin_all on public.university_subject_weights
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy scoring_models_admin_all on public.scoring_models
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- ADMIN ROSTER
-- ============================================================================
-- (practice_question_history arrives in a later migration and is deliberately
-- server-only: RLS on, no policies at all, so nothing but the service role can
-- touch it.)

-- Deliberately no self-service insert: membership is granted out of band, so a
-- user cannot escalate by writing their own row.
create policy admin_users_self_select on public.admin_users
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
