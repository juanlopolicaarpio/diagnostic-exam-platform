// ============================================================================
// EDGE FUNCTION — submit-quiz-answer/index.ts
// ============================================================================
// POST /submit-quiz-answer
//   body: { session_id, question_id, selected_answer }
//
// Saves (or updates) a student's answer for one quiz question. Grades it
// server-side against questions.correct_answer and NEVER reveals correctness.
// Mirrors submit-answer, keyed on the quiz_* tables.
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

interface SubmitQuizAnswerBody {
  session_id: string;
  question_id: string;
  // null / "" means the student DESELECTED their choice (cleared the answer).
  selected_answer: string | null;
}

serve(
  withErrorHandling(async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      throw new ApiError(405, "Method not allowed. Use POST.");
    }

    const { userClient, adminClient } = createClients(req);
    const user = await authenticateUser(userClient);

    const body: SubmitQuizAnswerBody = await req.json();
    if (!body.session_id) throw new ApiError(400, "Missing session_id.");
    if (!body.question_id) throw new ApiError(400, "Missing question_id.");
    requireUuid(body.session_id, "session_id");
    requireUuid(body.question_id, "question_id");

    // The key must be present (a missing key is a client bug); present-but-empty
    // (null or "") is an explicit deselect.
    if (!("selected_answer" in body)) throw new ApiError(400, "Missing selected_answer.");

    const rawAnswer = body.selected_answer;
    const isDeselect =
      rawAnswer === null || (typeof rawAnswer === "string" && rawAnswer.trim() === "");

    let selectedAnswer: string | null = null;
    if (!isDeselect) {
      if (typeof rawAnswer !== "string") {
        throw new ApiError(400, "Invalid selected_answer. Must be a, b, c, d, e, or null.");
      }
      selectedAnswer = rawAnswer.trim().toLowerCase();
      if (!["a", "b", "c", "d", "e"].includes(selectedAnswer)) {
        throw new ApiError(400, `Invalid answer: "${rawAnswer}". Must be a, b, c, d, e, or null.`);
      }
    }

    // ── Verify session ownership + status ──
    const { data: session } = await adminClient
      .from("quiz_sessions")
      .select("id, user_id, status")
      .eq("id", body.session_id)
      .single();

    if (!session) throw new ApiError(404, "Quiz session not found.");
    if (session.user_id !== user.id) throw new ApiError(403, "This session does not belong to you.");
    if (session.status !== "in_progress") {
      throw new ApiError(400, `Cannot submit answers. Session status: ${session.status}`);
    }

    // ── Verify the question belongs to this session, and grab correct_answer ──
    const { data: sq } = await adminClient
      .from("quiz_session_questions")
      .select("id, locked, questions!inner ( correct_answer )")
      .eq("session_id", body.session_id)
      .eq("question_id", body.question_id)
      .single();

    if (!sq) throw new ApiError(404, "Question not found in this session.");
    if (sq.locked) throw new ApiError(400, "This question is locked.");

    // ── Grade server-side ──
    const correctAnswer = String((sq.questions as any).correct_answer || "").toLowerCase();
    const isCorrect = selectedAnswer !== null && selectedAnswer === correctAnswer;

    // ── Upsert (atomic on the unique (session_id, question_id) constraint) ──
    const { error: upsertError } = await adminClient
      .from("quiz_responses")
      .upsert(
        {
          session_id: body.session_id,
          question_id: body.question_id,
          selected_answer: selectedAnswer,
          is_correct: isCorrect,
          answered_at: new Date().toISOString(),
        },
        { onConflict: "session_id,question_id" }
      );

    if (upsertError) {
      throw new ApiError(500, "Failed to save your answer. Please try again.");
    }

    // Never reveal correctness during the attempt.
    return jsonResponse({ success: true });
  })
);
