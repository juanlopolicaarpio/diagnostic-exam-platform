// ============================================================================
// Tests for the scoring engine.
//
// The scoring engine is the highest-consequence code in this system: it decides
// what a student is told about their future. It is also the easiest thing here
// to test, because every function in it is pure — data in, data out, no
// database, no network, no clock.
//
// Run:  deno test supabase/functions/_shared/scoring-engine.test.ts
// or:   npm run test:scoring
//
// Two of these tests exist because of real bugs that shipped. They are marked
// REGRESSION. If one of them ever fails again, the bug is back.
// ============================================================================

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  computeCTR,
  computeFitScore,
  computeReadinessTier,
  computeSubjectScores,
  computeSubtopicPerformance,
  computeWPS,
  type GradedResponse,
  type ImportanceEntry,
  type ScoringModel,
} from "./scoring-engine.ts";

// ── Test data builders ──────────────────────────────────────────────────────
//
// Building a GradedResponse by hand is 8 fields of noise per row, which buries
// the one thing each test actually cares about. These helpers let each test
// state only what matters and inherit sane defaults for the rest.

let idCounter = 0;

function response(over: Partial<GradedResponse> = {}): GradedResponse {
  idCounter += 1;
  return {
    questionId: `q${idCounter}`,
    subject: "Mathematics",
    topic: "Algebra",
    subtopic: "Factoring",
    difficultyLevel: "medium",
    selectedAnswer: "a",
    correctAnswer: "a",
    isCorrect: true,
    ...over,
  };
}

/** N responses for one subtopic, `correct` of them right. */
function attempts(
  correct: number,
  total: number,
  over: Partial<GradedResponse> = {},
): GradedResponse[] {
  return Array.from({ length: total }, (_, i) =>
    response({ ...over, isCorrect: i < correct })
  );
}

function importance(
  subtopic: string,
  classificationCode: string,
  importanceWeight: number,
  over: Partial<ImportanceEntry> = {},
): ImportanceEntry {
  return {
    subject: "Mathematics",
    topic: "Algebra",
    subtopic,
    classificationCode,
    importanceWeight,
    ...over,
  };
}

const MODEL: ScoringModel = {
  difficultyEasyWeight: 1.0,
  difficultyMediumWeight: 1.5,
  difficultyHardWeight: 2.0,
  alphaWeight: 0.7,
  betaWeight: 0.3,
  criticalThreshold: 0.6,
};

// ── computeSubtopicPerformance ──────────────────────────────────────────────

Deno.test("subtopic perf is correct/total, grouped by subject+topic+subtopic", () => {
  const perfs = computeSubtopicPerformance([
    ...attempts(3, 4, { subtopic: "Factoring" }),
    ...attempts(1, 2, { subtopic: "Inequalities" }),
  ]);

  assertEquals(perfs.length, 2);

  const factoring = perfs.find((p) => p.subtopic === "Factoring")!;
  assertEquals(factoring.correct, 3);
  assertEquals(factoring.total, 4);
  assertEquals(factoring.perf, 0.75);

  const inequalities = perfs.find((p) => p.subtopic === "Inequalities")!;
  assertEquals(inequalities.perf, 0.5);
});

Deno.test("same subtopic name under a different subject is not merged", () => {
  // "Data Analysis" exists under both Mathematics and Science. If the grouping
  // key were the subtopic alone, these two would collapse into one row and the
  // importance matrix lookup would then match the wrong subject.
  const perfs = computeSubtopicPerformance([
    ...attempts(2, 2, { subject: "Mathematics", subtopic: "Data Analysis" }),
    ...attempts(0, 2, { subject: "Science", topic: "Biology", subtopic: "Data Analysis" }),
  ]);

  assertEquals(perfs.length, 2);
  assertEquals(perfs.find((p) => p.subject === "Mathematics")!.perf, 1);
  assertEquals(perfs.find((p) => p.subject === "Science")!.perf, 0);
});

Deno.test("mastery bands sit on the documented boundaries", () => {
  const band = (correct: number, total: number) =>
    computeSubtopicPerformance(attempts(correct, total))[0].masteryBand;

  assertEquals(band(8, 10), "Advanced");          // 0.80 — boundary, inclusive
  assertEquals(band(79, 100), "Proficient");      // 0.79 — just under
  assertEquals(band(6, 10), "Proficient");        // 0.60 — boundary, inclusive
  assertEquals(band(59, 100), "Developing");      // 0.59 — just under
  assertEquals(band(4, 10), "Developing");        // 0.40 — boundary, inclusive
  assertEquals(band(39, 100), "Needs Improvement");
});

// ── computeWPS ──────────────────────────────────────────────────────────────

Deno.test("WPS weights each subtopic by its importance for that classification", () => {
  // Worked example from the engine's own docs:
  //   (0.80x1 + 0.60x2 + 0.90x3) / (1+2+3) = 4.70/6 = 0.7833
  const perfs = computeSubtopicPerformance([
    ...attempts(8, 10, { subtopic: "A" }),
    ...attempts(6, 10, { subtopic: "B" }),
    ...attempts(9, 10, { subtopic: "C" }),
  ]);

  const matrix = [
    importance("A", "BMA", 1),
    importance("B", "BMA", 2),
    importance("C", "BMA", 3),
  ];

  assertEquals(computeWPS(perfs, matrix, "BMA"), 0.7833);
});

Deno.test("WPS ignores subtopics with no importance entry for the classification", () => {
  const perfs = computeSubtopicPerformance([
    ...attempts(10, 10, { subtopic: "Rated" }),
    ...attempts(0, 10, { subtopic: "Unrated" }),
  ]);

  // Only "Rated" is in the matrix, so the zero score on "Unrated" must not
  // drag the average down.
  assertEquals(computeWPS(perfs, [importance("Rated", "EA", 2)], "EA"), 1);
});

Deno.test("WPS is 0 when nothing the student was tested on is rated", () => {
  const perfs = computeSubtopicPerformance(attempts(10, 10, { subtopic: "Unrated" }));
  assertEquals(computeWPS(perfs, [importance("Other", "EA", 3)], "EA"), 0);
});

// ── computeCTR ──────────────────────────────────────────────────────────────

Deno.test("CTR is passed / tested among High-importance subtopics", () => {
  const perfs = computeSubtopicPerformance([
    ...attempts(8, 10, { subtopic: "Crit1" }), // 0.80 — passes 0.60
    ...attempts(3, 10, { subtopic: "Crit2" }), // 0.30 — fails
  ]);

  const matrix = [importance("Crit1", "EA", 3), importance("Crit2", "EA", 3)];
  assertEquals(computeCTR(perfs, matrix, "EA", 0.6), 0.5);
});

Deno.test("REGRESSION: untested critical subtopics are excluded from the CTR denominator", () => {
  // The bug: the denominator was every High-importance subtopic for the
  // classification, including ones the exam never asked about. Because the
  // importance matrix is broader than the question bank, this capped CTR at a
  // level no student could clear -- BMA had 22 of 58 critical subtopics
  // unrepresented, capping a perfect student at 0.62.
  //
  // The student below aced BOTH critical subtopics they were actually given.
  // CTR must be 1.0, not 2/4.
  const perfs = computeSubtopicPerformance([
    ...attempts(10, 10, { subtopic: "Tested1" }),
    ...attempts(10, 10, { subtopic: "Tested2" }),
  ]);

  const matrix = [
    importance("Tested1", "BMA", 3),
    importance("Tested2", "BMA", 3),
    importance("NotInTheBank1", "BMA", 3),
    importance("NotInTheBank2", "BMA", 3),
  ];

  assertEquals(computeCTR(perfs, matrix, "BMA", 0.6), 1);
});

Deno.test("CTR is 1.0 when the classification has no critical subtopics at all", () => {
  const perfs = computeSubtopicPerformance(attempts(0, 10, { subtopic: "X" }));
  assertEquals(computeCTR(perfs, [importance("X", "SNC", 1)], "SNC", 0.6), 1);
});

Deno.test("CTR is 1.0 when none of the critical subtopics were tested", () => {
  // No evidence either way — the student must not be penalised for a gap in
  // the exam's coverage.
  const perfs = computeSubtopicPerformance(attempts(5, 10, { subtopic: "Unrelated" }));
  assertEquals(computeCTR(perfs, [importance("Critical", "HAMS", 3)], "HAMS", 0.6), 1);
});

Deno.test("CTR threshold is inclusive at the boundary", () => {
  const perfs = computeSubtopicPerformance(attempts(6, 10, { subtopic: "Crit" })); // exactly 0.60
  assertEquals(computeCTR(perfs, [importance("Crit", "EA", 3)], "EA", 0.6), 1);
});

// ── computeFitScore ─────────────────────────────────────────────────────────

Deno.test("FitScore blends WPS and CTR by alpha/beta, on a 0-100 scale", () => {
  // (0.7 x 0.80 + 0.3 x 0.50) x 100 = 71
  assertEquals(computeFitScore(0.8, 0.5, 0.7, 0.3), 71);
  assertEquals(computeFitScore(1, 1, 0.7, 0.3), 100);
  assertEquals(computeFitScore(0, 0, 0.7, 0.3), 0);
});

Deno.test("a cratered CTR drags a strong WPS down", () => {
  // The gatekeeper case from the scoring doc: strong overall performance but a
  // total failure on the field's critical topics.
  const strongEverywhere = computeFitScore(0.9, 1, 0.7, 0.3);
  const failedTheCriticals = computeFitScore(0.9, 0, 0.7, 0.3);

  assertEquals(strongEverywhere, 93);
  assertEquals(failedTheCriticals, 63);
});

// ── computeSubjectScores ────────────────────────────────────────────────────

Deno.test("subject scores weight hard questions more than easy ones", () => {
  // Two questions, one easy one hard, one correct each way. If the hard one is
  // the correct one the score must be higher, even though raw correct/total is
  // identical.
  const hardRight = computeSubjectScores([
    response({ difficultyLevel: "easy", isCorrect: false }),
    response({ difficultyLevel: "hard", isCorrect: true }),
  ], MODEL)[0];

  const easyRight = computeSubjectScores([
    response({ difficultyLevel: "easy", isCorrect: true }),
    response({ difficultyLevel: "hard", isCorrect: false }),
  ], MODEL)[0];

  assertEquals(hardRight.rawCorrect, easyRight.rawCorrect); // same raw score
  assertEquals(hardRight.weightedScore > easyRight.weightedScore, true);

  // 2.0 / (1.0 + 2.0) = 66.67
  assertEquals(hardRight.weightedScore, 66.67);
  assertEquals(easyRight.weightedScore, 33.33);
});

Deno.test("subject scores split by subject", () => {
  const scores = computeSubjectScores([
    ...attempts(2, 2, { subject: "Mathematics" }),
    ...attempts(0, 2, { subject: "Science" }),
  ], MODEL);

  assertEquals(scores.length, 2);
  assertEquals(scores.find((s) => s.subject === "Mathematics")!.weightedScore, 100);
  assertEquals(scores.find((s) => s.subject === "Science")!.weightedScore, 0);
});

// ── computeReadinessTier ────────────────────────────────────────────────────

Deno.test("readiness tiers sit on the documented boundaries", () => {
  const tierFor = (perf: number) =>
    computeReadinessTier([{
      subject: "Mathematics", topic: "Algebra", subtopic: "X",
      correct: 0, total: 10, perf, masteryBand: "",
    }]).tier;

  assertEquals(tierFor(0.95), "Highly Ready");
  assertEquals(tierFor(0.90), "Highly Ready");        // boundary, inclusive
  assertEquals(tierFor(0.8999), "Ready");
  assertEquals(tierFor(0.75), "Ready");               // boundary, inclusive
  assertEquals(tierFor(0.7499), "Conditionally Ready");
  assertEquals(tierFor(0.60), "Conditionally Ready"); // boundary, inclusive
  assertEquals(tierFor(0.5999), "Not Yet Ready");
});

Deno.test("a student with no responses is Not Yet Ready, not a crash", () => {
  const result = computeReadinessTier([]);
  assertEquals(result.overallScore, 0);
  assertEquals(result.tier, "Not Yet Ready");
});
