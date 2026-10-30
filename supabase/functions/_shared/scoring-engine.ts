// ============================================================================
// BACKEND — PHASE 4: SCORING ENGINE
// ============================================================================
// File: supabase/functions/_shared/scoring-engine.ts
//
// This is a PURE FUNCTION library. It takes data in, returns results out.
// No database calls. No side effects. No Supabase client.
//
// WHY PURE FUNCTIONS:
//   1. Testable — feed fake data, verify outputs
//   2. Portable — works in Edge Functions, test runners, background workers
//   3. Debuggable — same inputs always produce same outputs
//
// The finalize-exam Edge Function will:
//   1. Fetch all raw data from the database
//   2. Call these functions to compute scores
//   3. Write the results back to the database
//
// This file is imported by Edge Functions using:
//   import { computeAllResults } from "../_shared/scoring-engine.ts";
// ============================================================================


// ============================================================================
// TYPES — The shapes of data flowing through the engine
// ============================================================================
// These types define what goes IN and what comes OUT of each function.
// Think of them as contracts: "I promise to give you data shaped like this."
// ============================================================================

/** A single graded response — one question answered by the student */
export interface GradedResponse {
  questionId: string;
  subject: string;
  topic: string;
  subtopic: string;
  difficultyLevel: "easy" | "medium" | "hard";
  selectedAnswer: string | null;  // null = unanswered (timer expired)
  correctAnswer: string;
  isCorrect: boolean;
}

/** Performance for one subtopic: how many right out of how many total */
export interface SubtopicPerformance {
  subject: string;
  topic: string;
  subtopic: string;
  correct: number;
  total: number;
  perf: number;         // correct / total (0.00 to 1.00)
  masteryBand: string;  // "Needs Improvement" | "Developing" | "Proficient" | "Advanced"
}

/** One row of the importance matrix: subtopic X has importance Y for classification Z */
export interface ImportanceEntry {
  subject: string;
  topic: string;
  subtopic: string;
  classificationCode: string;
  importanceWeight: number;  // 1, 2, or 3
}

/** Difficulty weight settings from the scoring_models table */
export interface ScoringModel {
  difficultyEasyWeight: number;    // default 1.0
  difficultyMediumWeight: number;  // default 1.5
  difficultyHardWeight: number;    // default 2.0
  alphaWeight: number;             // default 0.70
  betaWeight: number;              // default 0.30
  criticalThreshold: number;       // default 0.60
}

/** Scores for one classification (e.g., EA) */
export interface ClassificationScore {
  code: string;
  name: string;
  wps: number;       // Weighted Performance Score (0.00 to 1.00)
  ctr: number;       // Critical Topic Rate (0.00 to 1.00)
  fitScore: number;  // Final composite (0.00 to 100.00)
  fitRank: number;   // 1 = best fit
}

/** Subject-level score with difficulty weighting */
export interface SubjectScore {
  subject: string;
  rawCorrect: number;
  rawTotal: number;
  weightedScore: number;  // Difficulty-weighted percentage (0.00 to 100.00)
}

/** Topic-level score */
export interface TopicScore {
  subject: string;
  topic: string;
  rawCorrect: number;
  rawTotal: number;
  weightedScore: number;
}

/** Overall readiness assessment */
export interface ReadinessTier {
  overallScore: number;  // 0.00 to 100.00
  tier: "Highly Ready" | "Ready" | "Conditionally Ready" | "Not Yet Ready";
}

/** University prediction output */
export interface UniversityPrediction {
  universityCode: string;
  predictiveIndex: number;  // 0.00 to 100.00
  profileLabel: "High Probability" | "Good Probability" | "Borderline" | "Low Probability";
}

/** University subject weight from the database */
export interface UniversityWeight {
  universityCode: string;
  subject: string;
  weightMultiplier: number;
}

/** The final recommendation report */
export interface Recommendation {
  primaryClassificationCode: string;
  alternativeClassificationCodes: string[];
  strengths: string[];     // Up to 5 subtopics scored at Proficient or above (may be empty)
  weaknesses: string[];    // Weakest subtopics (especially high-importance ones)
  studyFocus: string;      // Plain-text recommendation
}

/** Everything the scoring engine produces — the complete output */
export interface ScoringResults {
  subtopicScores: SubtopicPerformance[];
  topicScores: TopicScore[];
  subjectScores: SubjectScore[];
  classificationScores: ClassificationScore[];
  readinessTier: ReadinessTier;
  recommendations: Recommendation;
  universityPredictions: UniversityPrediction[];
}


// ============================================================================
// CONSTANTS
// ============================================================================

const CLASSIFICATION_NAMES: Record<string, string> = {
  BMA:  "Business, Management & Accountancy",
  HAMS: "Health & Allied Medical Sciences",
  EA:   "Engineering & Architecture",
  ITCS: "Information Technology & Computing Sciences",
  SM:   "Science & Mathematics",
  HSSC: "Humanities, Social Sciences & Communication",
  ETT:  "Education & Teacher Training",
  SNC:  "Specialized & Niche Clusters",
};

// Which subject is "most distinctive" for each classification.
// Used in tie-breaking rule #2: compare WPS on the distinctive subject.
//
// These strings MUST match questions.subject exactly — the tie-break filters
// subtopic perfs by them, so a name that matches nothing silently yields
// WPS 0 and makes that classification lose every rule-2 tie. ITCS was set to
// "Logic" and HSSC to "Language"; neither is a real subject value.
const DISTINCTIVE_SUBJECTS: Record<string, string> = {
  BMA:  "Mathematics",              // Statistics/Economics focus
  HAMS: "Science",                  // Biology/Chemistry focus
  EA:   "Mathematics",              // Physics/Engineering math focus
  ITCS: "Logic/Abstract Reasoning", // Logic/Abstract Reasoning focus
  SM:   "Science",                  // Pure science focus
  HSSC: "Humanities",               // Humanities/Communication focus
  ETT:  "Reading",                  // Pedagogy/Comprehension focus
  SNC:  "Social Studies",           // Broad/general focus
};

const ALL_CLASSIFICATION_CODES = ["BMA", "HAMS", "EA", "ITCS", "SM", "HSSC", "ETT", "SNC"];


// ============================================================================
// STEP 1: COMPUTE SUBTOPIC PERFORMANCE — perf(S)
// ============================================================================
// For each subtopic, count correct vs total and compute the ratio.
//
// Example:
//   "Linear Equations": 8 questions, 6 correct → perf = 0.75
//   "Cell Biology":     5 questions, 3 correct → perf = 0.60
//
// This is the foundation — everything else builds on perf(S).
// ============================================================================

export function computeSubtopicPerformance(
  responses: GradedResponse[]
): SubtopicPerformance[] {
  // Group responses by subtopic using a composite key
  const groups = new Map<string, GradedResponse[]>();

  for (const r of responses) {
    const key = `${r.subject}|||${r.topic}|||${r.subtopic}`;
    const existing = groups.get(key) || [];
    existing.push(r);
    groups.set(key, existing);
  }

  const results: SubtopicPerformance[] = [];

  for (const [key, group] of groups) {
    const [subject, topic, subtopic] = key.split("|||");
    const correct = group.filter((r) => r.isCorrect).length;
    const total = group.length;
    const perf = total > 0 ? correct / total : 0;

    results.push({
      subject,
      topic,
      subtopic,
      correct,
      total,
      perf: roundTo(perf, 4),
      masteryBand: getMasteryBand(perf),
    });
  }

  return results;
}

/** Map a perf score to a human-readable mastery band */
function getMasteryBand(perf: number): string {
  if (perf >= 0.80) return "Advanced";
  if (perf >= 0.60) return "Proficient";
  if (perf >= 0.40) return "Developing";
  return "Needs Improvement";
}


// ============================================================================
// STEP 2: COMPUTE WEIGHTED PERFORMANCE SCORE — WPS(C)
// ============================================================================
// For each classification C, compute a weighted average of perf(S)
// across all subtopics, where the weights come from the importance matrix.
//
// WPS(C) = Σ [ perf(S) × imp(S,C) ] / Σ [ imp(S,C) ]
//
// Subtopics rated High (3) for C contribute 3x as much as Low (1).
// This captures: "Did the student do well on what MATTERS for this field?"
//
// Example for BMA with 3 subtopics:
//   Subtopic A: perf=0.80, importance for BMA=1 (Low)
//   Subtopic B: perf=0.60, importance for BMA=2 (Medium)
//   Subtopic C: perf=0.90, importance for BMA=3 (High)
//   WPS = (0.80×1 + 0.60×2 + 0.90×3) / (1+2+3) = 4.70/6 = 0.783
// ============================================================================

export function computeWPS(
  subtopicPerfs: SubtopicPerformance[],
  importanceEntries: ImportanceEntry[],
  classificationCode: string
): number {
  // Filter importance entries for this classification
  const classImportance = importanceEntries.filter(
    (e) => e.classificationCode === classificationCode
  );

  // Build a lookup: "subject|||topic|||subtopic" → importance weight
  const importanceMap = new Map<string, number>();
  for (const entry of classImportance) {
    const key = `${entry.subject}|||${entry.topic}|||${entry.subtopic}`;
    importanceMap.set(key, entry.importanceWeight);
  }

  let numerator = 0;   // Σ [ perf(S) × imp(S,C) ]
  let denominator = 0;  // Σ [ imp(S,C) ]

  for (const sp of subtopicPerfs) {
    const key = `${sp.subject}|||${sp.topic}|||${sp.subtopic}`;
    const weight = importanceMap.get(key);

    if (weight === undefined) {
      // This subtopic has no importance rating for this classification.
      // This shouldn't happen if the importance matrix is complete.
      // Skip it — it won't contribute to the score.
      continue;
    }

    numerator += sp.perf * weight;
    denominator += weight;
  }

  if (denominator === 0) return 0;
  return roundTo(numerator / denominator, 4);
}


// ============================================================================
// STEP 3: COMPUTE CRITICAL TOPIC RATE — CTR(C)
// ============================================================================
// For each classification C, find all subtopics rated "High" (weight = 3).
// Count how many the student "passed" (perf >= threshold, default 0.60).
//
// CTR(C) = passed_high_importance / tested_high_importance
//
// This is the "gatekeeper" — even if your overall WPS is great, failing
// critical topics for a classification will tank your CTR and pull down
// the FitScore. See Case 4 in the scoring doc: the student who wants
// Pre-Med but failed Science gets CTR = 0.00, cratering to FitScore 47.7.
//
// IMPORTANT — the denominator counts only subtopics the student was
// actually TESTED on. A High-importance subtopic that the exam never
// asked about (no question in the bank carries that subject/topic/subtopic)
// is excluded entirely rather than counted as a failure. Counting it as
// failed put a hard ceiling on CTR that no student could clear: e.g. BMA
// has 22 of its 58 High-importance subtopics unrepresented in the bank,
// so a perfect student was capped at CTR 0.62 through no fault of their own.
// ============================================================================

export function computeCTR(
  subtopicPerfs: SubtopicPerformance[],
  importanceEntries: ImportanceEntry[],
  classificationCode: string,
  threshold: number
): number {
  // Find all subtopics rated HIGH (weight = 3) for this classification
  const highImportance = importanceEntries.filter(
    (e) => e.classificationCode === classificationCode && e.importanceWeight === 3
  );

  if (highImportance.length === 0) return 1.0; // No critical topics = auto-pass

  // Build a lookup for student performance
  const perfMap = new Map<string, number>();
  for (const sp of subtopicPerfs) {
    const key = `${sp.subject}|||${sp.topic}|||${sp.subtopic}`;
    perfMap.set(key, sp.perf);
  }

  let passed = 0;
  let tested = 0;

  for (const entry of highImportance) {
    const key = `${entry.subject}|||${entry.topic}|||${entry.subtopic}`;
    const perf = perfMap.get(key);

    // Never tested on this subtopic — it cannot count for or against them
    if (perf === undefined) continue;

    tested++;
    if (perf >= threshold) passed++;
  }

  // The exam covered none of this classification's critical subtopics.
  // There is no evidence either way, so don't penalise the student.
  if (tested === 0) return 1.0;

  return roundTo(passed / tested, 4);
}


// ============================================================================
// STEP 4: COMPUTE FIT SCORE — FitScore(C)
// ============================================================================
// FitScore(C) = [ α × WPS(C) + β × CTR(C) ] × 100
//
// α = 0.70 (weight of broad performance)
// β = 0.30 (weight of critical topic mastery)
// α + β = 1.00
//
// Result: 0 to 100 for each classification.
//
// This is the number that gets ranked to produce recommendations.
// ============================================================================

export function computeFitScore(
  wps: number,
  ctr: number,
  alpha: number,
  beta: number
): number {
  const raw = (alpha * wps + beta * ctr) * 100;
  return roundTo(raw, 2);
}


// ============================================================================
// STEP 5: COMPUTE SUBJECT & TOPIC SCORES (Difficulty-Weighted)
// ============================================================================
// Subject scores use difficulty weights: easy=1.0, medium=1.5, hard=2.0.
// This gives harder questions more credit.
//
// Score = Σ(isCorrect × difficultyWeight) / Σ(difficultyWeight) × 100
//
// Example for Math (40 questions: 12 easy, 20 medium, 8 hard):
//   Max = 12×1.0 + 20×1.5 + 8×2.0 = 58 points
//   Student: 10 easy, 14 medium, 5 hard correct
//   Score = (10×1.0 + 14×1.5 + 5×2.0) / 58 × 100 = 70.7%
//
// NOTE: perf(S) for subtopics uses simple correct/total (no difficulty weighting).
// Difficulty weighting only applies to subject and topic aggregates.
// ============================================================================

export function computeSubjectScores(
  responses: GradedResponse[],
  model: ScoringModel
): SubjectScore[] {
  const groups = new Map<string, GradedResponse[]>();

  for (const r of responses) {
    const existing = groups.get(r.subject) || [];
    existing.push(r);
    groups.set(r.subject, existing);
  }

  const results: SubjectScore[] = [];

  for (const [subject, group] of groups) {
    const { weightedCorrect, weightedTotal, rawCorrect } =
      computeWeightedTotals(group, model);

    results.push({
      subject,
      rawCorrect,
      rawTotal: group.length,
      weightedScore: weightedTotal > 0
        ? roundTo((weightedCorrect / weightedTotal) * 100, 2)
        : 0,
    });
  }

  return results;
}

export function computeTopicScores(
  responses: GradedResponse[],
  model: ScoringModel
): TopicScore[] {
  const groups = new Map<string, GradedResponse[]>();

  for (const r of responses) {
    const key = `${r.subject}|||${r.topic}`;
    const existing = groups.get(key) || [];
    existing.push(r);
    groups.set(key, existing);
  }

  const results: TopicScore[] = [];

  for (const [key, group] of groups) {
    const [subject, topic] = key.split("|||");
    const { weightedCorrect, weightedTotal, rawCorrect } =
      computeWeightedTotals(group, model);

    results.push({
      subject,
      topic,
      rawCorrect,
      rawTotal: group.length,
      weightedScore: weightedTotal > 0
        ? roundTo((weightedCorrect / weightedTotal) * 100, 2)
        : 0,
    });
  }

  return results;
}

/** Helper: compute difficulty-weighted correct and total */
function computeWeightedTotals(
  responses: GradedResponse[],
  model: ScoringModel
): { weightedCorrect: number; weightedTotal: number; rawCorrect: number } {
  let weightedCorrect = 0;
  let weightedTotal = 0;
  let rawCorrect = 0;

  for (const r of responses) {
    const weight = getDifficultyWeight(r.difficultyLevel, model);
    weightedTotal += weight;
    if (r.isCorrect) {
      weightedCorrect += weight;
      rawCorrect++;
    }
  }

  return { weightedCorrect, weightedTotal, rawCorrect };
}

function getDifficultyWeight(
  level: "easy" | "medium" | "hard",
  model: ScoringModel
): number {
  switch (level) {
    case "easy":   return model.difficultyEasyWeight;
    case "medium": return model.difficultyMediumWeight;
    case "hard":   return model.difficultyHardWeight;
  }
}


// ============================================================================
// STEP 6: COMPUTE READINESS TIER
// ============================================================================
// Overall Score = mean of all perf(S) values × 100
//
// This is the SIMPLE (unweighted) average — every subtopic counts equally
// regardless of importance. It's a "how prepared is this student overall?"
// measure, separate from the course-specific FitScores.
//
// Tiers (from the scoring document):
//   90–100 = "Highly Ready"
//   75–89  = "Ready"
//   60–74  = "Conditionally Ready"
//   Below 60 = "Not Yet Ready"
// ============================================================================

export function computeReadinessTier(
  subtopicPerfs: SubtopicPerformance[]
): ReadinessTier {
  if (subtopicPerfs.length === 0) {
    return { overallScore: 0, tier: "Not Yet Ready" };
  }

  const sum = subtopicPerfs.reduce((acc, sp) => acc + sp.perf, 0);
  const overallScore = roundTo((sum / subtopicPerfs.length) * 100, 2);

  let tier: ReadinessTier["tier"];
  if (overallScore >= 90) tier = "Highly Ready";
  else if (overallScore >= 75) tier = "Ready";
  else if (overallScore >= 60) tier = "Conditionally Ready";
  else tier = "Not Yet Ready";

  return { overallScore, tier };
}


// ============================================================================
// STEP 7: RANK CLASSIFICATIONS & TIE-BREAKING
// ============================================================================
// Sort all 8 FitScores from highest to lowest. Apply tie-breaking
// when two or more scores are within 3 points of each other:
//
//   1. Higher CTR wins
//   2. Higher distinctive-subject WPS wins
//   3. Report both as co-equal
//
// "Distinctive subject" = the subject most associated with that
// classification (e.g., Mathematics for EA, Language for HSSC).
// ============================================================================

export function rankClassifications(
  scores: ClassificationScore[],
  subtopicPerfs: SubtopicPerformance[],
  importanceEntries: ImportanceEntry[]
): ClassificationScore[] {
  // Sort by fitScore descending
  const sorted = [...scores].sort((a, b) => b.fitScore - a.fitScore);

  // Assign ranks, handling ties
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0) {
      sorted[i].fitRank = 1;
      continue;
    }

    const prev = sorted[i - 1];
    const curr = sorted[i];
    const diff = prev.fitScore - curr.fitScore;

    if (diff <= 3) {
      // Within 3 points — apply tie-breaking
      const winner = applyTieBreaking(
        prev, curr, subtopicPerfs, importanceEntries
      );

      if (winner === curr.code) {
        // Current should rank higher — swap them
        sorted[i - 1] = curr;
        sorted[i] = prev;
        sorted[i - 1].fitRank = i; // Keep same rank position
        sorted[i].fitRank = i + 1;
      } else if (winner === "tie") {
        // Co-equal — same rank
        sorted[i].fitRank = sorted[i - 1].fitRank;
      } else {
        // Previous wins — normal ranking
        sorted[i].fitRank = i + 1;
      }
    } else {
      sorted[i].fitRank = i + 1;
    }
  }

  return sorted;
}

/** Apply the 3-step tie-breaking rules */
function applyTieBreaking(
  a: ClassificationScore,
  b: ClassificationScore,
  subtopicPerfs: SubtopicPerformance[],
  importanceEntries: ImportanceEntry[]
): string {
  // Rule 1: Higher CTR wins
  if (Math.abs(a.ctr - b.ctr) > 0.001) {
    return a.ctr > b.ctr ? a.code : b.code;
  }

  // Rule 2: Higher distinctive-subject WPS wins
  const aDistinctiveSubject = DISTINCTIVE_SUBJECTS[a.code];
  const bDistinctiveSubject = DISTINCTIVE_SUBJECTS[b.code];

  // Compute WPS for only the distinctive subject of each classification
  const aDistinctivePerfs = subtopicPerfs.filter(
    (sp) => sp.subject === aDistinctiveSubject
  );
  const bDistinctivePerfs = subtopicPerfs.filter(
    (sp) => sp.subject === bDistinctiveSubject
  );

  const aDistWPS = computeWPS(aDistinctivePerfs, importanceEntries, a.code);
  const bDistWPS = computeWPS(bDistinctivePerfs, importanceEntries, b.code);

  if (Math.abs(aDistWPS - bDistWPS) > 0.001) {
    return aDistWPS > bDistWPS ? a.code : b.code;
  }

  // Rule 3: Co-equal
  return "tie";
}


// ============================================================================
// STEP 8: GENERATE RECOMMENDATIONS
// ============================================================================
// Assemble the recommendation report:
//   - Primary: highest-ranked classification
//   - Alternatives: 2nd and 3rd ranked
//   - Strengths: up to 5 subtopics the student actually performed well on
//   - Weaknesses: subtopics where perf(S) < 0.60 AND importance is High
//     for the primary classification (the "gap analysis")
//   - Study focus: plain-text advice based on the gaps
// ============================================================================

// A subtopic only counts as a strength if the student cleared the Proficient
// band on it. Without this floor a student who scored 0/170 was still handed
// five "strengths" — whichever subtopics happened to sort first among a field
// of tied zeroes.
const STRENGTH_MIN_PERF = 0.60;

// ...and only if enough questions were asked to mean anything. A lucky 1/1
// is not evidence of mastery, and it would otherwise outrank a solid 7/10.
const STRENGTH_MIN_QUESTIONS = 2;

export function generateRecommendations(
  rankedScores: ClassificationScore[],
  subtopicPerfs: SubtopicPerformance[],
  importanceEntries: ImportanceEntry[]
): Recommendation {
  const primary = rankedScores[0];
  const alternatives = rankedScores
    .slice(1, 3)
    .map((s) => s.code);

  // Top 5 strengths: highest perf(S) subtopics that clear the floor.
  // Ties on perf break toward the subtopic backed by more questions.
  const strengths = [...subtopicPerfs]
    .filter(
      (sp) =>
        sp.perf >= STRENGTH_MIN_PERF && sp.total >= STRENGTH_MIN_QUESTIONS
    )
    .sort((a, b) => b.perf - a.perf || b.total - a.total)
    .slice(0, 5)
    .map((sp) => sp.subtopic);

  // Gap analysis: High-importance subtopics for the primary classification
  // where the student scored below 0.60.
  const primaryHighImportance = importanceEntries.filter(
    (e) => e.classificationCode === primary.code && e.importanceWeight === 3
  );

  const perfMap = new Map<string, number>();
  for (const sp of subtopicPerfs) {
    const key = `${sp.subject}|||${sp.topic}|||${sp.subtopic}`;
    perfMap.set(key, sp.perf);
  }

  const weaknesses: string[] = [];
  for (const entry of primaryHighImportance) {
    const key = `${entry.subject}|||${entry.topic}|||${entry.subtopic}`;
    const perf = perfMap.get(key);

    // Never tested on this subtopic, so there is no gap to report. Treating
    // an untested subtopic as perf=0 surfaced permanent phantom gaps: any
    // importance row with no question behind it was flagged for every
    // student on every attempt, next to the sibling subtopic they were
    // actually tested on. Reporting a gap requires evidence of one.
    if (perf === undefined) continue;

    if (perf < 0.60) {
      weaknesses.push(entry.subtopic);
    }
  }

  // Generate study focus text
  let studyFocus: string;
  if (weaknesses.length === 0) {
    studyFocus = `Strong alignment with ${CLASSIFICATION_NAMES[primary.code]}. ` +
      `Continue building depth in your strongest areas to maximize readiness.`;
  } else if (weaknesses.length <= 3) {
    studyFocus = `Focus on strengthening: ${weaknesses.join(", ")}. ` +
      `These are critical topics for ${CLASSIFICATION_NAMES[primary.code]} ` +
      `where your performance is below the proficiency threshold.`;
  } else {
    studyFocus = `You have ${weaknesses.length} critical gaps for ` +
      `${CLASSIFICATION_NAMES[primary.code]}: ${weaknesses.slice(0, 3).join(", ")}, ` +
      `and others. Consider intensive review of these foundational topics ` +
      `before entering this program.`;
  }

  return {
    primaryClassificationCode: primary.code,
    alternativeClassificationCodes: alternatives,
    strengths,
    weaknesses,
    studyFocus,
  };
}


// ============================================================================
// STEP 9: COMPUTE UNIVERSITY PREDICTIONS
// ============================================================================
// The university prediction layer adjusts the importance weights
// using university-specific subject multipliers, then recomputes
// a "university-adjusted FitScore."
//
// Example for UP + Engineering (EA):
//   Normal importance of "Algebra" for EA = 3 (High)
//   UP multiplier for Mathematics = 1.25
//   Adjusted importance = 3 × 1.25 = 3.75
//
// This boosted importance makes Math performance count MORE
// when predicting UP acceptance chances.
//
// The adjusted FitScore is mapped to prediction tiers:
//   90–100 = "High Probability"
//   80–89  = "Good Probability"
//   70–79  = "Borderline"
//   <70    = "Low Probability"
// ============================================================================

export function computeUniversityPredictions(
  subtopicPerfs: SubtopicPerformance[],
  importanceEntries: ImportanceEntry[],
  universityWeights: UniversityWeight[],
  primaryClassificationCode: string,
  model: ScoringModel
): UniversityPrediction[] {
  const universities = ["UP", "ADMU", "DLSU", "UST"];
  const results: UniversityPrediction[] = [];

  for (const uniCode of universities) {
    // Get this university's subject weight multipliers
    const uniWeights = universityWeights.filter(
      (w) => w.universityCode === uniCode
    );

    // Build a lookup: subject → multiplier
    const subjectMultipliers = new Map<string, number>();
    for (const w of uniWeights) {
      subjectMultipliers.set(w.subject, w.weightMultiplier);
    }

    // Create adjusted importance entries by multiplying importance weights
    // by the university's subject multiplier
    const adjustedImportance: ImportanceEntry[] = importanceEntries.map((entry) => {
      const multiplier = subjectMultipliers.get(entry.subject) ?? 1.0;
      return {
        ...entry,
        importanceWeight: entry.importanceWeight * multiplier,
      };
    });

    // Compute university-adjusted WPS for the primary classification
    const adjWPS = computeWPS(
      subtopicPerfs,
      adjustedImportance,
      primaryClassificationCode
    );

    // CTR stays the same — it's a binary pass/fail check,
    // not affected by weight multipliers
    const ctr = computeCTR(
      subtopicPerfs,
      importanceEntries,  // Original, not adjusted
      primaryClassificationCode,
      model.criticalThreshold
    );

    // Compute adjusted FitScore
    const predictiveIndex = computeFitScore(
      adjWPS,
      ctr,
      model.alphaWeight,
      model.betaWeight
    );

    results.push({
      universityCode: uniCode,
      predictiveIndex,
      profileLabel: getPredictionLabel(predictiveIndex),
    });
  }

  return results;
}

function getPredictionLabel(index: number): UniversityPrediction["profileLabel"] {
  if (index >= 90) return "High Probability";
  if (index >= 80) return "Good Probability";
  if (index >= 70) return "Borderline";
  return "Low Probability";
}


// ============================================================================
// STEP 10: COMPUTE PERCENTILES
// ============================================================================
// Percentile = "What percentage of students scored lower than you?"
//
// For V1, this computes percentiles against ALL completed sessions.
// The caller passes in historical scores; this function figures out
// where the current student falls.
//
// NOTE: Percentiles are unreliable with < 100 students. Consider hiding
// them in the frontend until you have 500+ completed sessions.
// ============================================================================

export interface PercentileInput {
  targetType: "overall" | "subject" | "classification";
  targetCode: string;          // e.g., "overall", "Mathematics", "EA"
  studentScore: number;        // This student's score
  allScores: number[];         // All historical scores for this target
}

export interface PercentileResult {
  targetType: string;
  targetCode: string;
  percentileRank: number;  // 0 to 100
}

export function computePercentiles(
  inputs: PercentileInput[]
): PercentileResult[] {
  return inputs.map((input) => {
    const { targetType, targetCode, studentScore, allScores } = input;

    if (allScores.length === 0) {
      return { targetType, targetCode, percentileRank: 50 }; // Default to median
    }

    // Count how many historical scores are BELOW the student's score
    const below = allScores.filter((s) => s < studentScore).length;
    const percentile = Math.round((below / allScores.length) * 100);

    return {
      targetType,
      targetCode,
      percentileRank: Math.min(99, Math.max(1, percentile)),
    };
  });
}


// ============================================================================
// MASTER FUNCTION: COMPUTE ALL RESULTS
// ============================================================================
// This is the single entry point called by the finalize-exam Edge Function.
// It orchestrates all the steps above in sequence.
//
// The Edge Function's job is:
//   1. Fetch all raw data from the database
//   2. Call computeAllResults(data)
//   3. Write the returned results to the results tables
//
// This function does all the math; the Edge Function does all the I/O.
// ============================================================================

export function computeAllResults(
  responses: GradedResponse[],
  importanceEntries: ImportanceEntry[],
  universityWeights: UniversityWeight[],
  model: ScoringModel
): ScoringResults {
  // Step 1: Subtopic performance
  const subtopicScores = computeSubtopicPerformance(responses);

  // Step 2 & 3 & 4: Classification scores (WPS + CTR + FitScore for each)
  let classificationScores: ClassificationScore[] = ALL_CLASSIFICATION_CODES.map(
    (code) => {
      const wps = computeWPS(subtopicScores, importanceEntries, code);
      const ctr = computeCTR(
        subtopicScores, importanceEntries, code, model.criticalThreshold
      );
      const fitScore = computeFitScore(wps, ctr, model.alphaWeight, model.betaWeight);

      return {
        code,
        name: CLASSIFICATION_NAMES[code],
        wps,
        ctr,
        fitScore,
        fitRank: 0, // Will be set by ranking
      };
    }
  );

  // Step 5: Subject and topic scores (difficulty-weighted)
  const subjectScores = computeSubjectScores(responses, model);
  const topicScores = computeTopicScores(responses, model);

  // Step 6: Readiness tier
  const readinessTier = computeReadinessTier(subtopicScores);

  // Step 7: Rank classifications with tie-breaking
  classificationScores = rankClassifications(
    classificationScores, subtopicScores, importanceEntries
  );

  // Step 8: Recommendations
  const recommendations = generateRecommendations(
    classificationScores, subtopicScores, importanceEntries
  );

  // Step 9: University predictions
  const universityPredictions = computeUniversityPredictions(
    subtopicScores,
    importanceEntries,
    universityWeights,
    recommendations.primaryClassificationCode,
    model
  );

  return {
    subtopicScores,
    topicScores,
    subjectScores,
    classificationScores,
    readinessTier,
    recommendations,
    universityPredictions,
  };
}


// ============================================================================
// UTILITY
// ============================================================================

function roundTo(num: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(num * factor) / factor;
}