// ============================================================================
// EDGE FUNCTION — assemble-quiz/index.ts
// ============================================================================
// POST /assemble-quiz   body: { quiz_id?: string, code?: string }
//
// Creates (or resumes) a quiz session for the authenticated student and
// returns the ordered question list WITHOUT correct answers.
//
// Mirrors assemble-exam, but quizzes are flexible: any size, any section mix,
// and there is no fixed SECTION_CONFIG / 170-question assumption. The quiz
// itself defines its sections and their order via quiz_questions.display_order.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClients,
  authenticateUser,
  ApiError,
  jsonResponse,
  withErrorHandling,
} from "../_shared/utils.ts";

interface AssembleQuizBody {
  quiz_id?: string;
  code?: string;
}

// Columns a student is allowed to see while taking the quiz. NEVER correct_answer.
const QUESTION_SELECT =
  "id, question_text, choice_a, choice_b, choice_c, choice_d, choice_e, stimulus_id, instruction_id, render_markup, difficulty_level, subject, topic, subtopic";

serve(
  withErrorHandling(async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      throw new ApiError(405, "Method not allowed. Use POST.");
    }

    const { userClient, adminClient } = createClients(req);
    const user = await authenticateUser(userClient);

    const body: AssembleQuizBody = await req.json().catch(() => ({}));

    // ── Resolve the quiz (must be published) ──
    let quizQuery = adminClient
      .from("quizzes")
      .select("id, code, title, is_published")
      .limit(1);
    if (body.quiz_id) quizQuery = quizQuery.eq("id", body.quiz_id);
    else if (body.code) quizQuery = quizQuery.eq("code", body.code);
    else throw new ApiError(400, "Provide quiz_id or code.");

    const { data: quiz } = await quizQuery.maybeSingle();
    if (!quiz) throw new ApiError(404, "Quiz not found.");
    if (!quiz.is_published) throw new ApiError(400, "This quiz is not published.");

    // ── Resume an existing in-progress attempt ──
    const { data: existing } = await adminClient
      .from("quiz_sessions")
      .select("id, status")
      .eq("user_id", user.id)
      .eq("quiz_id", quiz.id)
      .eq("status", "in_progress")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let sessionId: string;
    let isResumed = false;

    if (existing) {
      sessionId = existing.id;
      isResumed = true;
    } else {
      // Create the session
      const { data: newSession, error: sessErr } = await adminClient
        .from("quiz_sessions")
        .insert({ user_id: user.id, quiz_id: quiz.id, status: "in_progress" })
        .select("id")
        .single();
      if (sessErr || !newSession) throw new ApiError(500, "Failed to create quiz session.");
      sessionId = newSession.id;

      // Snapshot the quiz's questions into the session
      const { data: quizQuestions, error: qqErr } = await adminClient
        .from("quiz_questions")
        .select("question_id, section_name, display_order")
        .eq("quiz_id", quiz.id)
        .order("display_order", { ascending: true });

      if (qqErr || !quizQuestions || quizQuestions.length === 0) {
        await adminClient.from("quiz_sessions").delete().eq("id", sessionId);
        throw new ApiError(500, "This quiz has no questions.");
      }

      const rows = quizQuestions.map((q) => ({
        session_id: sessionId,
        question_id: q.question_id,
        section_name: q.section_name,
        display_order: q.display_order,
        locked: false,
      }));

      const BATCH = 50;
      for (let i = 0; i < rows.length; i += BATCH) {
        const { error } = await adminClient
          .from("quiz_session_questions")
          .insert(rows.slice(i, i + BATCH));
        if (error) {
          await adminClient.from("quiz_session_questions").delete().eq("session_id", sessionId);
          await adminClient.from("quiz_sessions").delete().eq("id", sessionId);
          throw new ApiError(500, "Failed to assemble quiz questions.");
        }
      }
    }

    // ── Load the session's questions + content (no correct answers) ──
    const { data: sessionQuestions } = await adminClient
      .from("quiz_session_questions")
      .select(`id, question_id, section_name, display_order, questions ( ${QUESTION_SELECT} )`)
      .eq("session_id", sessionId)
      .order("display_order", { ascending: true });

    const questions = (sessionQuestions || []).map((sq: any) => {
      const q = sq.questions || {};
      return {
        quiz_session_question_id: sq.id,
        question_id: sq.question_id,
        section_name: sq.section_name,
        display_order: sq.display_order,
        question_text: q.question_text,
        choice_a: q.choice_a,
        choice_b: q.choice_b,
        choice_c: q.choice_c,
        choice_d: q.choice_d,
        choice_e: q.choice_e,
        stimulus_id: q.stimulus_id,
        instruction_id: q.instruction_id,
        render_markup: q.render_markup,
        difficulty_level: q.difficulty_level,
        subject: q.subject,
        topic: q.topic,
        subtopic: q.subtopic,
      };
    });

    return jsonResponse({
      session_id: sessionId,
      quiz: { id: quiz.id, code: quiz.code, title: quiz.title },
      status: "in_progress",
      is_resumed: isResumed,
      total_questions: questions.length,
      questions,
    });
  })
);
