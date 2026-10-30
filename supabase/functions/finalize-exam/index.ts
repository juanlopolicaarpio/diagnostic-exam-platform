// ============================================================================
// EDGE FUNCTION — finalize-exam/index.ts
// ============================================================================
// POST /finalize-exam
//
// THE BIG ONE. This endpoint:
//   1. Verifies all 6 sections are completed
//   2. Checks minimum attempt rate (≥70%)
//   3. Fetches all responses + question metadata + importance matrix
//   4. Runs the FULL scoring engine (perf → WPS → CTR → FitScore → etc.)
//   5. Stores ALL results into 8 result tables
//   6. Marks the session as completed
//
// PERFORMANCE:
//   This runs once per student. At 10K students, they won't all finalize
//   at the exact same moment — they're spread across the last ~30 minutes.
//   Expected execution time: 200-500ms per call.
//
// IDEMPOTENCY:
//   If this function crashes mid-computation or is called twice, it must
//   produce the same result. We achieve this by:
//   1. Checking if session is already 'completed' → return early
//   2. Deleting any partial results before writing new ones
//   This means you can safely retry a failed finalization.
//
// DATA FLOW:
//   Database → [fetch responses, questions, importance] → Scoring Engine → [write results] → Database
//
//   The scoring engine is pure functions — it takes data in and returns
//   results out. This function is the "glue" that connects the database
//   to the engine and writes the outputs back.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClients,
  authenticateUser,
  ApiError,
  jsonResponse,
  withErrorHandling,
  SECTION_ORDER,
  requireUuid,
} from "../_shared/utils.ts";

// Import the scoring engine
// In Supabase Edge Functions, you can import from relative paths
// or from the _shared folder. The scoring engine files should be
// placed in _shared/ or bundled with this function.
import {
  computeAllResults,
  type GradedResponse,
  type ImportanceEntry,
  type UniversityWeight,
  type ScoringModel,
  type ScoringResults,
} from "../_shared/scoring-engine.ts";

interface FinalizeBody {
  session_id: string;
}

serve(
  withErrorHandling(async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      throw new ApiError(405, "Method not allowed. Use POST.");
    }

    const { userClient, adminClient } = createClients(req);
    const user = await authenticateUser(userClient);

    const body: FinalizeBody = await req.json();
    if (!body.session_id) throw new ApiError(400, "Missing session_id.");
    requireUuid(body.session_id, "session_id");

    // ── STEP 1: Verify session ──
    const { data: session, error: sessionError } = await adminClient
      .from("diagnostic_sessions")
      .select("id, user_id, status, template_id")
      .eq("id", body.session_id)
      .single();

    if (sessionError || !session) {
      throw new ApiError(404, "Session not found.");
    }

    if (session.user_id !== user.id) {
      throw new ApiError(403, "This session does not belong to you.");
    }

    // Already completed — return early (idempotent)
    if (session.status === "completed") {
      return jsonResponse({
        success: true,
        results_ready: true,
        session_id: body.session_id,
        message: "Results have already been computed.",
      });
    }

    if (session.status !== "ready_to_finalize") {
      throw new ApiError(
        400,
        `Cannot finalize. Session status: ${session.status}. All sections must be submitted first.`
      );
    }

    // ── STEP 2: Verify all sections are completed ──
    const { data: sections } = await adminClient
      .from("session_sections")
      .select("section_name, status")
      .eq("session_id", body.session_id);

    const completedSections = new Set(
      (sections || [])
        .filter((s: any) => s.status === "completed")
        .map((s: any) => s.section_name)
    );
    const incompleteSections = SECTION_ORDER.filter(
      (sectionName) => !completedSections.has(sectionName)
    );

    if (incompleteSections.length > 0) {
      throw new ApiError(
        400,
        `Cannot finalize. These sections are not completed: ${incompleteSections.join(", ")}`
      );
    }

    // ── STEP 3: Fetch all responses with question metadata ──
    // This is the main data fetch. We join:
    //   session_responses → session_questions → questions
    // to get: selected_answer, is_correct, subject, topic, subtopic, difficulty
    const { data: responsesRaw, error: respError } = await adminClient
      .from("session_responses")
      .select(`
        selected_answer,
        is_correct,
        session_questions!inner (
          question_id,
          questions!inner (
            subject,
            topic,
            subtopic,
            difficulty_level,
            correct_answer
          )
        )
      `)
      .eq("session_id", body.session_id);

    if (respError) {
      console.error("Failed to fetch responses:", respError);
      throw new ApiError(500, "Failed to load exam responses.");
    }

    if (!responsesRaw || responsesRaw.length === 0) {
      throw new ApiError(400, "No responses found for this session.");
    }

    // ── STEP 4: Check minimum attempt rate (≥70%) ──
    const totalQuestions = 170;
    const attemptedCount = responsesRaw.filter(
      (r: any) => r.selected_answer !== null
    ).length;
    const attemptRate = attemptedCount / totalQuestions;

    // The algorithm doc says: "student must attempt at least 70% of all questions"
    // If below 70%, we still compute results but flag it
    const insufficientData = attemptRate < 0.70;

    // ── STEP 5: Transform database rows into scoring engine input ──
    const gradedResponses: GradedResponse[] = responsesRaw.map((r: any) => {
      const q = r.session_questions.questions;
      return {
        questionId: r.session_questions.question_id,
        subject: q.subject,
        topic: q.topic,
        subtopic: q.subtopic,
        difficultyLevel: q.difficulty_level,
        selectedAnswer: r.selected_answer,
        correctAnswer: q.correct_answer,
        isCorrect: r.is_correct,
      };
    });

    // ── STEP 6: Fetch the importance matrix ──
    const { data: importanceRaw } = await adminClient
      .from("subtopic_classification_importance")
      .select("subject, topic, subtopic, classification_code, importance_label, importance_weight");

    if (!importanceRaw || importanceRaw.length === 0) {
      throw new ApiError(500, "Importance matrix not found. Contact admin.");
    }

    const importanceRatings: ImportanceEntry[] = importanceRaw.map((r: any) => ({
      subject: r.subject,
      topic: r.topic,
      subtopic: r.subtopic,
      classificationCode: r.classification_code,
      importanceWeight: r.importance_weight,
    }));

    // ── STEP 7: Fetch university subject weights ──
    const { data: uniWeightsRaw } = await adminClient
      .from("university_subject_weights")
      .select("university_code, subject, weight_multiplier")
      .eq("is_active", true);

    const universityWeights: UniversityWeight[] = (uniWeightsRaw || []).map(
      (r: any) => ({
        universityCode: r.university_code,
        subject: r.subject,
        weightMultiplier: r.weight_multiplier,
      })
    );

    // ── STEP 8: Fetch the active scoring model ──
    const { data: scoringModelRaw } = await adminClient
      .from("scoring_models")
      .select("*")
      .lte("active_from", new Date().toISOString())
      .order("active_from", { ascending: false })
      .limit(1)
      .single();

    if (!scoringModelRaw) {
      throw new ApiError(500, "No active scoring model found. Contact admin.");
    }

    const model: ScoringModel = {
      difficultyEasyWeight: Number(scoringModelRaw.difficulty_easy_weight),
      difficultyMediumWeight: Number(scoringModelRaw.difficulty_medium_weight),
      difficultyHardWeight: Number(scoringModelRaw.difficulty_hard_weight),
      alphaWeight: Number(scoringModelRaw.alpha_weight),
      betaWeight: Number(scoringModelRaw.beta_weight),
      criticalThreshold: Number(scoringModelRaw.critical_threshold),
    };

    // ── STEP 9: RUN THE SCORING ENGINE ──
    // This is the single call that computes EVERYTHING.
    // Pure function: data in → results out. No side effects.
    const results: ScoringResults = computeAllResults(
      gradedResponses,
      importanceRatings,
      universityWeights,
      model
    );

    // ── STEP 10: Clear any partial results (idempotency) ──
    // If a previous finalization attempt partially wrote results,
    // we delete them before writing fresh ones.
    const resultTables = [
      "session_subtopic_scores",
      "session_topic_scores",
      "session_subject_scores",
      "session_classification_scores",
      "session_readiness_tiers",
      "session_university_predictions",
      "session_percentiles",
      "session_recommendations",
    ];

    for (const table of resultTables) {
      await adminClient.from(table).delete().eq("session_id", body.session_id);
    }

    // ── STEP 11: Write all results to the database ──
    // Each result type goes into its corresponding table.
    // These are all INSERT operations (not upserts) because we
    // just cleared any existing results.

    // 11a. Subtopic scores
    if (results.subtopicScores.length > 0) {
      const { error } = await adminClient
        .from("session_subtopic_scores")
        .insert(
          results.subtopicScores.map((s) => ({
            session_id: body.session_id,
            subject: s.subject,
            topic: s.topic,
            subtopic: s.subtopic,
            raw_correct: s.correct,
            raw_total: s.total,
            perf_score: s.perf,
            mastery_band: s.masteryBand,
          }))
        );
      assertNoWriteError(error, "write subtopic scores");
    }

    // 11b. Topic scores
    if (results.topicScores.length > 0) {
      const { error } = await adminClient
        .from("session_topic_scores")
        .insert(
          results.topicScores.map((t) => ({
            session_id: body.session_id,
            subject: t.subject,
            topic: t.topic!,
            raw_correct: t.rawCorrect,
            raw_total: t.rawTotal,
            weighted_score: t.weightedScore,
          }))
        );
      assertNoWriteError(error, "write topic scores");
    }

    // 11c. Subject scores
    if (results.subjectScores.length > 0) {
      const { error } = await adminClient
        .from("session_subject_scores")
        .insert(
          results.subjectScores.map((s) => ({
            session_id: body.session_id,
            subject: s.subject,
            raw_correct: s.rawCorrect,
            raw_total: s.rawTotal,
            weighted_score: s.weightedScore,
          }))
        );
      assertNoWriteError(error, "write subject scores");
    }

    // 11d. Classification scores (the 8 FitScores)
    if (results.classificationScores.length > 0) {
      const { error } = await adminClient
        .from("session_classification_scores")
        .insert(
          results.classificationScores.map((c) => ({
            session_id: body.session_id,
            classification_code: c.code,
            wps_score: c.wps,
            ctr_score: c.ctr,
            fit_score: c.fitScore,
            fit_rank: c.fitRank,
          }))
        );
      assertNoWriteError(error, "write classification scores");
    }

    // 11e. Readiness tier
    {
      const { error } = await adminClient
        .from("session_readiness_tiers")
        .insert({
          session_id: body.session_id,
          overall_score: results.readinessTier.overallScore,
          readiness_tier: results.readinessTier.tier,
        });
      assertNoWriteError(error, "write readiness tier");
    }

    // 11f. University predictions
    if (results.universityPredictions.length > 0) {
      const { error } = await adminClient
        .from("session_university_predictions")
        .insert(
          results.universityPredictions.map((p) => ({
            session_id: body.session_id,
            university_code: p.universityCode,
            predictive_index: p.predictiveIndex,
            profile_label: p.profileLabel,
          }))
        );
      assertNoWriteError(error, "write university predictions");
    }

    // 11g. Recommendations
    {
      const { error } = await adminClient
        .from("session_recommendations")
        .insert({
          session_id: body.session_id,
          primary_classification_code: results.recommendations.primaryClassificationCode,
          alternative_classification_codes: results.recommendations.alternativeClassificationCodes,
          strengths: results.recommendations.strengths,
          weaknesses: results.recommendations.weaknesses,
          study_focus: results.recommendations.studyFocus,
        });
      assertNoWriteError(error, "write recommendations");
    }

    // 11h. Percentiles
    // Compute percentiles by comparing this student's scores to all
    // completed sessions. In V2, move this to a batch job.
    try {
      const percentileRows = await computePercentiles(
        adminClient,
        body.session_id,
        results
      );

      if (percentileRows.length > 0) {
        const { error } = await adminClient
          .from("session_percentiles")
          .insert(percentileRows);
        if (error) console.error("Failed to write percentiles:", error);
      }
    } catch (e) {
      // Percentiles are non-critical — don't fail finalization over them
      console.error("Percentile computation failed (non-critical):", e);
    }

    // ── STEP 12: Mark session as completed ──
    const { error: completeError } = await adminClient
      .from("diagnostic_sessions")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", body.session_id);

    assertNoWriteError(completeError, "mark session completed");

    // ── STEP 13: Return success ──
    return jsonResponse({
      success: true,
      results_ready: true,
      session_id: body.session_id,
      insufficient_data: insufficientData,
      attempt_rate: Math.round(attemptRate * 100),
    });
  })
);

// ============================================================================
// PERCENTILE COMPUTATION
// ============================================================================
// Compares this student's scores against all other completed sessions.
// Returns percentile rows for: overall, each subject, each classification.
//
// NOTE: At low student counts (<100), percentiles are unreliable.
// Consider hiding them in the frontend until you have 500+ sessions.
// In V2, move this to a periodic batch job instead of computing
// per-finalization.
// ============================================================================

async function computePercentiles(
  client: any,
  sessionId: string,
  results: ScoringResults
): Promise<any[]> {
  const rows: any[] = [];

  // Overall percentile (based on readiness score)
  const { data: allOverall } = await client
    .from("session_readiness_tiers")
    .select("overall_score")
    .neq("session_id", sessionId);

  if (allOverall && allOverall.length > 0) {
    const allScores = allOverall.map((r: any) => Number(r.overall_score));
    rows.push({
      session_id: sessionId,
      target_type: "overall",
      target_code: "overall",
      percentile_rank: computePercentile(
        results.readinessTier.overallScore,
        allScores
      ),
    });
  }

  // Subject percentiles
  for (const subjectScore of results.subjectScores) {
    const { data: allSubject } = await client
      .from("session_subject_scores")
      .select("weighted_score")
      .eq("subject", subjectScore.subject)
      .neq("session_id", sessionId);

    if (allSubject && allSubject.length > 0) {
      const allScores = allSubject.map((r: any) => Number(r.weighted_score));
      rows.push({
        session_id: sessionId,
        target_type: "subject",
        target_code: subjectScore.subject,
        percentile_rank: computePercentile(
          subjectScore.weightedScore,
          allScores
        ),
      });
    }
  }

  // Classification percentiles (FitScore)
  for (const classScore of results.classificationScores) {
    const { data: allClass } = await client
      .from("session_classification_scores")
      .select("fit_score")
      .eq("classification_code", classScore.code)
      .neq("session_id", sessionId);

    if (allClass && allClass.length > 0) {
      const allScores = allClass.map((r: any) => Number(r.fit_score));
      rows.push({
        session_id: sessionId,
        target_type: "classification",
        target_code: classScore.code,
        percentile_rank: computePercentile(classScore.fitScore, allScores),
      });
    }
  }

  return rows;
}

function computePercentile(studentScore: number, allScores: number[]): number {
  if (allScores.length === 0) return 50;

  const below = allScores.filter((score) => score < studentScore).length;
  const percentile = Math.round((below / allScores.length) * 100);

  return Math.min(99, Math.max(1, percentile));
}

function assertNoWriteError(error: unknown, operation: string): void {
  if (error) {
    console.error(`Failed to ${operation}:`, error);
    throw new ApiError(500, "Failed to save exam results. Please retry finalization.");
  }
}
