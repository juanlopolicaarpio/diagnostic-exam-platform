// ============================================================================
// EDGE FUNCTION — finalize-quiz/index.ts
// ============================================================================
// POST /finalize-quiz   body: { session_id }
//
// Marks a quiz attempt complete, computes a simple correct/total score, and
// returns the per-question review. Because the attempt is now over and the
// questions are locked, revealing correct_answer here is safe (same posture as
// get-results for the diagnostic exam).
//
// Quizzes are small, so there are no diagnostic tiers / percentiles — just the
// score and a question-by-question breakdown.
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

interface FinalizeQuizBody {
  session_id: string;
}

serve(
  withErrorHandling(async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      throw new ApiError(405, "Method not allowed. Use POST.");
    }

    const { userClient, adminClient } = createClients(req);
    const user = await authenticateUser(userClient);

    const body: FinalizeQuizBody = await req.json();
    if (!body.session_id) throw new ApiError(400, "Missing session_id.");
    requireUuid(body.session_id, "session_id");

    // ── Verify ownership ──
    const { data: session } = await adminClient
      .from("quiz_sessions")
      .select("id, user_id, status, quiz_id")
      .eq("id", body.session_id)
      .single();

    if (!session) throw new ApiError(404, "Quiz session not found.");
    if (session.user_id !== user.id) throw new ApiError(403, "This session does not belong to you.");

    // ── Load the frozen question list + content (for review) ──
    const { data: sessionQuestions } = await adminClient
      .from("quiz_session_questions")
      .select(
        "question_id, section_name, display_order, questions ( question_text, choice_a, choice_b, choice_c, choice_d, choice_e, correct_answer, subject, topic, subtopic )"
      )
      .eq("session_id", body.session_id)
      .order("display_order", { ascending: true });

    const { data: responses } = await adminClient
      .from("quiz_responses")
      .select("question_id, selected_answer, is_correct")
      .eq("session_id", body.session_id);

    const responseMap = new Map((responses || []).map((r) => [r.question_id, r]));

    const total = (sessionQuestions || []).length;
    let score = 0;
    const questions = (sessionQuestions || []).map((sq: any) => {
      const q = sq.questions || {};
      const resp = responseMap.get(sq.question_id);
      const isCorrect = !!resp?.is_correct;
      if (isCorrect) score += 1;
      return {
        question_id: sq.question_id,
        section: sq.section_name,
        display_order: sq.display_order,
        subject: q.subject,
        topic: q.topic,
        subtopic: q.subtopic,
        question_text: q.question_text,
        choice_a: q.choice_a,
        choice_b: q.choice_b,
        choice_c: q.choice_c,
        choice_d: q.choice_d,
        choice_e: q.choice_e,
        correct_answer: q.correct_answer,
        selected_answer: resp?.selected_answer ?? null,
        is_correct: isCorrect,
      };
    });

    // ── Persist the result (idempotent — re-finalizing recomputes) ──
    await adminClient
      .from("quiz_sessions")
      .update({
        status: "completed",
        score,
        total,
        completed_at: new Date().toISOString(),
      })
      .eq("id", body.session_id);

    return jsonResponse({
      session_id: body.session_id,
      quiz_id: session.quiz_id,
      score,
      total,
      percentage: total > 0 ? Math.round((score / total) * 1000) / 10 : 0,
      questions,
    });
  })
);
