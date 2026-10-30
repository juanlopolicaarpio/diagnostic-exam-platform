-- ============================================================================
-- SEED — taxonomy, subtopic importance weights, university weights
-- ============================================================================
-- Run automatically by `supabase db reset`. This is a representative slice of
-- the taxonomy, not the full one: enough for the Categories tab to populate,
-- the exam blueprint to resolve, and the scoring engine to produce a real
-- ranking from the sample question bank in sample-data/.
--
-- Importance weights (1 = Low, 2 = Medium, 3 = High) say how much a subtopic
-- matters to each course cluster. They are the bridge between a question's
-- taxonomy and a student's course-fit ranking, and they are the reason the
-- engine can say "weak on the things engineering actually needs" rather than
-- just "scored 58% in math".
-- ============================================================================

with taxonomy(subject, topic, subtopic, weights) as (
  values
    -- Mathematics ---------------------------------------------------------
    ('Mathematics', 'Algebra', 'Linear Functions and Inequalities',
      '{"BMA":3,"HAMS":2,"EA":3,"ITCS":3,"SM":3,"HSSC":1,"ETT":2,"SNC":2}'::jsonb),
    ('Mathematics', 'Algebra', 'Quadratic Equations',
      '{"BMA":2,"HAMS":2,"EA":3,"ITCS":3,"SM":3,"HSSC":1,"ETT":2,"SNC":1}'::jsonb),
    ('Mathematics', 'Algebra', 'Exponential Functions',
      '{"BMA":3,"HAMS":2,"EA":3,"ITCS":3,"SM":3,"HSSC":1,"ETT":2,"SNC":1}'::jsonb),
    ('Mathematics', 'Geometry', 'Circles',
      '{"BMA":1,"HAMS":1,"EA":3,"ITCS":2,"SM":3,"HSSC":1,"ETT":2,"SNC":1}'::jsonb),
    ('Mathematics', 'Geometry', 'Triangles and Trigonometry',
      '{"BMA":1,"HAMS":2,"EA":3,"ITCS":2,"SM":3,"HSSC":1,"ETT":2,"SNC":1}'::jsonb),
    ('Mathematics', 'Statistics and Probability', 'Probability',
      '{"BMA":3,"HAMS":3,"EA":2,"ITCS":3,"SM":3,"HSSC":2,"ETT":2,"SNC":2}'::jsonb),
    ('Mathematics', 'Basic Finance', 'Interest and Growth',
      '{"BMA":3,"HAMS":1,"EA":2,"ITCS":2,"SM":2,"HSSC":1,"ETT":1,"SNC":2}'::jsonb),

    -- Science -------------------------------------------------------------
    ('Science', 'Biology', 'Cell Structure and Function',
      '{"BMA":1,"HAMS":3,"EA":1,"ITCS":1,"SM":3,"HSSC":1,"ETT":2,"SNC":1}'::jsonb),
    ('Science', 'Biology', 'Genetics and Heredity',
      '{"BMA":1,"HAMS":3,"EA":1,"ITCS":2,"SM":3,"HSSC":1,"ETT":2,"SNC":1}'::jsonb),
    ('Science', 'Chemistry', 'Stoichiometry',
      '{"BMA":1,"HAMS":3,"EA":3,"ITCS":1,"SM":3,"HSSC":1,"ETT":2,"SNC":1}'::jsonb),
    ('Science', 'Chemistry', 'Atomic Structure',
      '{"BMA":1,"HAMS":2,"EA":2,"ITCS":1,"SM":3,"HSSC":1,"ETT":2,"SNC":1}'::jsonb),
    ('Science', 'Physics', 'Kinematics',
      '{"BMA":1,"HAMS":2,"EA":3,"ITCS":2,"SM":3,"HSSC":1,"ETT":2,"SNC":1}'::jsonb),
    ('Science', 'Physics', 'Energy and Work',
      '{"BMA":1,"HAMS":2,"EA":3,"ITCS":2,"SM":3,"HSSC":1,"ETT":2,"SNC":1}'::jsonb),
    ('Science', 'Earth Science', 'Weather and Climate',
      '{"BMA":1,"HAMS":1,"EA":2,"ITCS":1,"SM":2,"HSSC":2,"ETT":2,"SNC":2}'::jsonb),

    -- English Language ----------------------------------------------------
    ('English Language', 'Grammar', 'Subject-Verb Agreement',
      '{"BMA":3,"HAMS":2,"EA":2,"ITCS":2,"SM":2,"HSSC":3,"ETT":3,"SNC":2}'::jsonb),
    ('English Language', 'Grammar', 'Pronoun Reference',
      '{"BMA":2,"HAMS":2,"EA":2,"ITCS":2,"SM":2,"HSSC":3,"ETT":3,"SNC":2}'::jsonb),
    ('English Language', 'Grammar', 'Modifiers and Parallelism',
      '{"BMA":2,"HAMS":2,"EA":2,"ITCS":2,"SM":2,"HSSC":3,"ETT":3,"SNC":2}'::jsonb),
    ('English Language', 'Vocabulary', 'Word Choice in Context',
      '{"BMA":3,"HAMS":2,"EA":2,"ITCS":2,"SM":2,"HSSC":3,"ETT":3,"SNC":2}'::jsonb),

    -- Filipino Language ---------------------------------------------------
    ('Filipino Language', 'Gramatika', 'Pandiwa at Aspekto',
      '{"BMA":2,"HAMS":1,"EA":1,"ITCS":1,"SM":1,"HSSC":3,"ETT":3,"SNC":2}'::jsonb),
    ('Filipino Language', 'Gramatika', 'Pang-ugnay',
      '{"BMA":2,"HAMS":1,"EA":1,"ITCS":1,"SM":1,"HSSC":3,"ETT":3,"SNC":2}'::jsonb),
    ('Filipino Language', 'Talasalitaan', 'Kahulugan sa Pangungusap',
      '{"BMA":2,"HAMS":1,"EA":1,"ITCS":1,"SM":1,"HSSC":3,"ETT":3,"SNC":2}'::jsonb),

    -- Reading -------------------------------------------------------------
    ('Reading', 'Comprehension', 'Main Idea and Purpose',
      '{"BMA":3,"HAMS":3,"EA":2,"ITCS":2,"SM":2,"HSSC":3,"ETT":3,"SNC":3}'::jsonb),
    ('Reading', 'Comprehension', 'Inference',
      '{"BMA":3,"HAMS":3,"EA":2,"ITCS":3,"SM":3,"HSSC":3,"ETT":3,"SNC":3}'::jsonb),
    ('Reading', 'Comprehension', 'Author Tone and Attitude',
      '{"BMA":2,"HAMS":2,"EA":1,"ITCS":1,"SM":1,"HSSC":3,"ETT":3,"SNC":2}'::jsonb),
    ('Reading', 'Analysis', 'Argument and Evidence',
      '{"BMA":3,"HAMS":2,"EA":2,"ITCS":3,"SM":3,"HSSC":3,"ETT":2,"SNC":2}'::jsonb),

    -- Social Studies ------------------------------------------------------
    ('Social Studies', 'History', 'Colonial Period',
      '{"BMA":1,"HAMS":1,"EA":1,"ITCS":1,"SM":1,"HSSC":3,"ETT":3,"SNC":2}'::jsonb),
    ('Social Studies', 'Economics', 'Supply and Demand',
      '{"BMA":3,"HAMS":1,"EA":2,"ITCS":2,"SM":2,"HSSC":3,"ETT":2,"SNC":2}'::jsonb),
    ('Social Studies', 'Civics', 'Branches of Government',
      '{"BMA":2,"HAMS":1,"EA":1,"ITCS":1,"SM":1,"HSSC":3,"ETT":3,"SNC":2}'::jsonb),

    -- Logic / Abstract Reasoning ------------------------------------------
    ('Logic/Abstract Reasoning', 'Logic', 'Figure Sequences',
      '{"BMA":2,"HAMS":2,"EA":3,"ITCS":3,"SM":3,"HSSC":2,"ETT":2,"SNC":2}'::jsonb),
    ('Logic/Abstract Reasoning', 'Logic', 'Pattern Classification',
      '{"BMA":2,"HAMS":2,"EA":3,"ITCS":3,"SM":3,"HSSC":2,"ETT":2,"SNC":2}'::jsonb)
)
insert into public.subtopic_classification_importance
  (subject, topic, subtopic, classification_code, importance_label, importance_weight)
select
  t.subject,
  t.topic,
  t.subtopic,
  c.code,
  case (t.weights ->> c.code)::int
    when 3 then 'High'
    when 2 then 'Medium'
    else 'Low'
  end,
  coalesce((t.weights ->> c.code)::numeric, 1)
from taxonomy t
cross join public.course_classifications c
on conflict (subject, topic, subtopic, classification_code) do update
  set importance_label  = excluded.importance_label,
      importance_weight = excluded.importance_weight;

-- ── University subject weights ──
-- Different institutions weight the same subjects differently, so the same
-- answer sheet produces a different predicted standing per university. Codes
-- here are placeholders.
insert into public.university_subject_weights (university_code, subject, weight_multiplier) values
  ('UNIV_A', 'Mathematics',              0.30),
  ('UNIV_A', 'Science',                  0.25),
  ('UNIV_A', 'Reading',                  0.20),
  ('UNIV_A', 'English Language',         0.15),
  ('UNIV_A', 'Social Studies',           0.05),
  ('UNIV_A', 'Logic/Abstract Reasoning', 0.05),
  ('UNIV_B', 'Mathematics',              0.25),
  ('UNIV_B', 'Science',                  0.20),
  ('UNIV_B', 'Reading',                  0.25),
  ('UNIV_B', 'English Language',         0.20),
  ('UNIV_B', 'Social Studies',           0.05),
  ('UNIV_B', 'Logic/Abstract Reasoning', 0.05)
on conflict (university_code, subject) do update
  set weight_multiplier = excluded.weight_multiplier;
