-- ============================================================================
-- REFERENCE DATA — course clusters and the default scoring model
-- ============================================================================
-- Structural, not sample: the scoring engine cannot run without these rows, and
-- their codes are referenced directly by application code
-- (src/CategoryManager.jsx) and by the scoring engine's test suite.
--
-- Subtopic importance weights are tuned content rather than structure, so they
-- live in supabase/seed.sql instead of here.
-- ============================================================================

insert into public.course_classifications (code, name, description) values
  ('BMA',  'Business, Management & Accountancy',          'Accountancy, business administration, economics, entrepreneurship, management.'),
  ('HAMS', 'Health & Allied Medical Sciences',            'Medicine, nursing, pharmacy, medical technology, allied health programs.'),
  ('EA',   'Engineering & Architecture',                  'All engineering disciplines, architecture, industrial design.'),
  ('ITCS', 'Information Technology & Computing Sciences', 'Computer science, information technology, information systems, data science.'),
  ('SM',   'Science & Mathematics',                       'Pure and applied sciences, mathematics, statistics, research-track programs.'),
  ('HSSC', 'Humanities, Social Sciences & Communication', 'Communication, political science, psychology, sociology, languages, arts.'),
  ('ETT',  'Education & Teacher Training',                'Elementary and secondary education, specialised teaching tracks.'),
  ('SNC',  'Specialized & Niche Clusters',                'Programs that do not map cleanly onto the other seven clusters.')
on conflict (code) do update
  set name        = excluded.name,
      description = excluded.description;

-- ── Default scoring model ──
-- Every parameter the fit calculation needs, in one dated row:
--
--   difficulty_*_weight  a correct hard item is worth more than a correct easy
--                        one, so two students with the same raw count but
--                        different difficulty profiles do not score the same.
--
--   alpha / beta         fit_score = alpha * WPS + beta * CTR, and the schema
--                        constrains the pair to sum to 1. Performance
--                        dominates, but coverage is not free: a cluster
--                        measured by two items cannot outrank one measured by
--                        thirty on performance alone.
--
--   critical_threshold   the share of a cluster's high-importance subtopics a
--                        student must pass for the subtopic to count towards
--                        CTR.
--
-- Dated rather than flagged, so the parameters that scored any given attempt
-- can still be identified after a re-tune.
insert into public.scoring_models (
  name,
  active_from,
  difficulty_easy_weight,
  difficulty_medium_weight,
  difficulty_hard_weight,
  alpha_weight,
  beta_weight,
  critical_threshold
) values (
  'baseline-v1',
  '2026-01-01T00:00:00Z',
  1.0,
  1.5,
  2.0,
  0.70,
  0.30,
  0.60
)
on conflict (name) do nothing;
