// ============================================================================
// EDGE FUNCTION — get-results/index.ts
// ============================================================================
// GET /get-results?session_id=X
//
// Returns ALL precomputed results for a completed exam session.
//
// THIS IS THE SIMPLEST ENDPOINT.
// No computation happens here — everything was precomputed and stored
// by finalize-exam. This endpoint just reads from 8 result tables
// and assembles a structured JSON response.
//
// WHY PRECOMPUTE:
//   If 10,000 students all view their results page at the same time,
//   we don't want to re-run the scoring engine 10,000 times.
//   Compute once (during finalize), read many times (here).
//   This endpoint should respond in <50ms.
//
// RESPONSE STRUCTURE:
//   The response matches the API contract from the roadmap document.
//   The frontend team can build their results dashboard directly
//   from this JSON shape.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClients,
  authenticateUser,
  ApiError,
  jsonResponse,
  withErrorHandling,
  requireUuid,
} from "../_shared/utils.ts";

serve(
  withErrorHandling(async (req: Request): Promise<Response> => {
    if (req.method !== "GET") {
      throw new ApiError(405, "Method not allowed. Use GET.");
    }

    const { userClient, adminClient } = createClients(req);
    const user = await authenticateUser(userClient);

    // Parse session_id from query params
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("session_id");

    if (!sessionId) throw new ApiError(400, "Missing session_id parameter.");
    requireUuid(sessionId, "session_id");

    // ── STEP 1: Verify session ownership and completion ──
    const { data: session, error: sessionError } = await adminClient
      .from("diagnostic_sessions")
      .select("id, user_id, status, completed_at, started_at")
      .eq("id", sessionId)
      .single();

    if (sessionError || !session) {
      throw new ApiError(404, "Session not found.");
    }

    if (session.user_id !== user.id) {
      throw new ApiError(403, "This session does not belong to you.");
    }

    if (session.status !== "completed") {
      throw new ApiError(
        400,
        `Results are not available. Session status: ${session.status}. ` +
        `Please complete and finalize your exam first.`
      );
    }

    // ── STEP 2: Fetch all results in parallel ──
    // These 8 queries can run concurrently since they're independent reads.
    // Promise.all sends them all at once and waits for all to complete.
    // This is faster than running them sequentially.
    const [
      readinessResult,
      subjectResult,
      topicResult,
      subtopicResult,
      classificationResult,
      recommendationResult,
      predictionResult,
      percentileResult,
      questionResult,
    ] = await Promise.all([
      adminClient
        .from("session_readiness_tiers")
        .select("overall_score, readiness_tier")
        .eq("session_id", sessionId)
        .single(),

      adminClient
        .from("session_subject_scores")
        .select("subject, raw_correct, raw_total, weighted_score")
        .eq("session_id", sessionId)
        .order("subject"),

      adminClient
        .from("session_topic_scores")
        .select("subject, topic, raw_correct, raw_total, weighted_score")
        .eq("session_id", sessionId)
        .order("subject")
        .order("topic"),

      adminClient
        .from("session_subtopic_scores")
        .select("subject, topic, subtopic, raw_correct, raw_total, perf_score, mastery_band")
        .eq("session_id", sessionId)
        .order("subject")
        .order("topic")
        .order("subtopic"),

      adminClient
        .from("session_classification_scores")
        .select(`
          classification_code,
          wps_score,
          ctr_score,
          fit_score,
          fit_rank,
          course_classifications!inner (name)
        `)
        .eq("session_id", sessionId)
        .order("fit_rank"),

      adminClient
        .from("session_recommendations")
        .select(`
          primary_classification_code,
          alternative_classification_codes,
          strengths,
          weaknesses,
          study_focus
        `)
        .eq("session_id", sessionId)
        .single(),

      adminClient
        .from("session_university_predictions")
        .select("university_code, predictive_index, profile_label")
        .eq("session_id", sessionId)
        .order("predictive_index", { ascending: false }),

      adminClient
        .from("session_percentiles")
        .select("target_type, target_code, percentile_rank")
        .eq("session_id", sessionId),

      // Full question-by-question review list.
      // Safe to expose correct_answer here because the session is completed
      // and locked — the exam is over, so there is nothing left to cheat on.
      // session_responses is embedded (left join) so unanswered questions
      // still appear with a null selected_answer.
      adminClient
        .from("session_questions")
        .select(`
          id,
          question_id,
          display_order,
          section_name,
          questions!inner (
            question_text,
            render_markup,
            svg_content,
            subject,
            topic,
            correct_answer,
            choice_a,
            choice_b,
            choice_c,
            choice_d,
            choice_e,
            stimuli (
              stimulus_title,
              stimulus_text
            ),
            instructions (
              title,
              instruction_text
            )
          ),
          session_responses (
            selected_answer,
            is_correct
          )
        `)
        .eq("session_id", sessionId)
        .order("display_order", { ascending: true }),
    ]);

    // ── STEP 3: Assemble the response ──
    // Map the readiness tier to an advisory message
    const readiness = readinessResult.data;
    const tierMessages: Record<string, string> = {
      "Highly Ready":
        "Exceptional readiness across the board. All recommendations are strongly supported by your performance.",
      "Ready":
        "Solid readiness demonstrated. Your course recommendations are reliable and well-supported.",
      "Conditionally Ready":
        "You show promise but need bridging work in specific areas. Review the gap analysis below.",
      "Not Yet Ready":
        "Significant review is needed before entering college. Focus on the priority study areas identified below.",
    };

    // Build classification results with names
    const classifications = (classificationResult.data || []).map((c: any) => ({
      code: c.classification_code,
      name: c.course_classifications?.name || c.classification_code,
      wps: Number(c.wps_score),
      ctr: Number(c.ctr_score),
      fit_score: Number(c.fit_score),
      rank: c.fit_rank,
    }));

    // Look up classification name for primary recommendation
    const primaryCode = recommendationResult.data?.primary_classification_code;
    const primaryClassification = classifications.find(
      (c: any) => c.code === primaryCode
    );

    // Build the response matching the API contract
    const response = {
      session_id: sessionId,
      started_at: session.started_at,
      completed_at: session.completed_at,

      readiness: readiness
        ? {
            overall_score: Number(readiness.overall_score),
            tier: readiness.readiness_tier,
            message: tierMessages[readiness.readiness_tier] || "",
          }
        : null,

      subjects: (subjectResult.data || []).map((s: any) => ({
        subject: s.subject,
        raw_correct: s.raw_correct,
        raw_total: s.raw_total,
        weighted_score: Number(s.weighted_score),
      })),

      topics: (topicResult.data || []).map((t: any) => ({
        subject: t.subject,
        topic: t.topic,
        raw_correct: t.raw_correct,
        raw_total: t.raw_total,
        weighted_score: Number(t.weighted_score),
      })),

      subtopics: (subtopicResult.data || []).map((s: any) => ({
        subject: s.subject,
        topic: s.topic,
        subtopic: s.subtopic,
        raw_correct: s.raw_correct,
        raw_total: s.raw_total,
        perf_score: Number(s.perf_score),
        mastery_band: s.mastery_band,
      })),

      classifications,

      recommendations: recommendationResult.data
        ? {
            primary: {
              code: primaryCode,
              name: primaryClassification?.name || primaryCode,
              fit_score: primaryClassification?.fit_score || 0,
            },
            alternatives: (
              recommendationResult.data.alternative_classification_codes || []
            ).map((code: string) => {
              const cls = classifications.find((c: any) => c.code === code);
              return {
                code,
                name: cls?.name || code,
                fit_score: cls?.fit_score || 0,
              };
            }),
            strengths: recommendationResult.data.strengths || [],
            weaknesses: recommendationResult.data.weaknesses || [],
            study_focus: recommendationResult.data.study_focus || "",
          }
        : null,

      predictions: (predictionResult.data || []).map((p: any) => ({
        university: p.university_code,
        predictive_index: Number(p.predictive_index),
        profile: p.profile_label,
      })),

      percentiles: (percentileResult.data || []).map((p: any) => ({
        target: p.target_type,
        code: p.target_code,
        percentile_rank: p.percentile_rank,
      })),

      // Question-by-question review list (for /results/review).
      // Ordered by display_order, i.e. the exact order the student sat them.
      questions: (questionResult.data || []).map((sq: any) => {
        const q = sq.questions || {};
        // session_responses embeds as an array (0 or 1 row per question).
        const resp = Array.isArray(sq.session_responses)
          ? sq.session_responses[0]
          : sq.session_responses;

        return {
          session_question_id: sq.id,
          question_id: sq.question_id,
          section: sq.section_name,
          subject: q.subject ?? null,
          topic: q.topic ?? null,
          question_text: q.question_text ?? null,
          render_markup: q.render_markup ?? null,
          svg_content: q.svg_content ?? null,
          choices: {
            a: q.choice_a ?? null,
            b: q.choice_b ?? null,
            c: q.choice_c ?? null,
            d: q.choice_d ?? null,
            e: q.choice_e ?? null,
          },
          selected_answer: resp?.selected_answer ?? null,
          correct_answer: q.correct_answer ?? null,
          is_correct: resp ? resp.is_correct === true : false,
          instruction: q.instructions
            ? {
                title: q.instructions.title,
                text: q.instructions.instruction_text,
              }
            : null,
          stimulus: q.stimuli
            ? {
                title: q.stimuli.stimulus_title,
                text: q.stimuli.stimulus_text,
              }
            : null,
        };
      }),
    };

    return jsonResponse(response);
  })
);
