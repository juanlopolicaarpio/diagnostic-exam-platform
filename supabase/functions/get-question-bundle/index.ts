// ============================================================================
// EDGE FUNCTION — get-question-bundle/index.ts
// ============================================================================
// GET /get-question-bundle?session_id=X&section=math
//
// Fetches all questions for a specific section of the student's exam.
// Returns questions with their stimuli, instructions, visual assets,
// and any existing responses (for resume scenarios).
//
// CRITICAL SECURITY RULE:
//   This function NEVER returns correct_answer to the frontend.
//   The question data is fetched with all fields, but correct_answer
//   is stripped from the response before sending.
//
// WHAT THE FRONTEND GETS:
//   - Question text and choices
//   - Stimulus (shared passage) if applicable
//   - Instruction block if applicable
//   - Visual asset URLs if applicable
//   - The student's existing selected_answer (for resume)
//   - Time remaining for the section
//
// PERFORMANCE NOTE:
//   This is called 6 times per exam (once per section). At 10K
//   concurrent users, that's 60K calls total — but spread over
//   2.5 hours. The query is fast because:
//   1. session_questions is indexed on (session_id, section_name)
//   2. questions table is read-only during exams
//   3. The result set is small (15-40 questions per section)
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClients,
  authenticateUser,
  ApiError,
  jsonResponse,
  withErrorHandling,
  SECTION_CONFIG,
  requireSectionName,
  requireUuid,
} from "../_shared/utils.ts";
import {
  readClock,
  reanchorSection,
  touchActivity,
} from "../_shared/section-clock.ts";

serve(
  withErrorHandling(async (req: Request): Promise<Response> => {
    if (req.method !== "GET") {
      throw new ApiError(405, "Method not allowed. Use GET.");
    }

    const { userClient, adminClient } = createClients(req);
    const user = await authenticateUser(userClient);

    // ── Parse query parameters ──
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("session_id");
    const sectionName = url.searchParams.get("section");

    if (!sessionId) throw new ApiError(400, "Missing session_id parameter.");
    if (!sectionName) throw new ApiError(400, "Missing section parameter.");

    requireUuid(sessionId, "session_id");
    const validatedSectionName = requireSectionName(sectionName);

    // ── STEP 1: Verify session ownership and status ──
    const { data: session, error: sessionError } = await adminClient
      .from("diagnostic_sessions")
      .select("id, user_id, status, current_section")
      .eq("id", sessionId)
      .single();

    if (sessionError || !session) {
      throw new ApiError(404, "Session not found.");
    }

    if (session.user_id !== user.id) {
      throw new ApiError(403, "This session does not belong to you.");
    }

    if (session.status === "completed") {
      throw new ApiError(400, "This exam has already been completed.");
    }

    if (session.status === "expired") {
      throw new ApiError(400, "This exam session has expired.");
    }

    // ── STEP 2: Verify section status ──
    const { data: sectionData, error: sectionError } = await adminClient
      .from("session_sections")
      .select(
        "id, status, started_at, time_limit_seconds, submitted_at, elapsed_seconds, last_activity_at"
      )
      .eq("session_id", sessionId)
      .eq("section_name", validatedSectionName)
      .single();

    if (sectionError || !sectionData) {
      throw new ApiError(404, "Section not found for this session.");
    }

    if (sectionData.status === "completed") {
      throw new ApiError(400, `Section "${sectionName}" has already been submitted and locked.`);
    }

    const nowIso = new Date().toISOString();

    // If section is not_started and it's the current section, start it
    if (sectionData.status === "not_started") {
      if (session.current_section !== sectionName) {
        throw new ApiError(
          400,
          `Section "${sectionName}" is not available yet. Current section: ${session.current_section}`
        );
      }

      // Start the section. The clock begins when the student actually opens
      // the section, not when the previous one was submitted.
      await adminClient
        .from("session_sections")
        .update({
          status: "in_progress",
          started_at: nowIso,
          last_activity_at: nowIso,
        })
        .eq("id", sectionData.id);

      sectionData.started_at = nowIso;
      sectionData.last_activity_at = nowIso;
      sectionData.status = "in_progress";
    }

    // ── STEP 3: Compute time remaining ──
    // Opening the bundle is itself proof the student is back, so a section
    // that kept running while they were disconnected is re-anchored here
    // rather than handing them a countdown that already drained away.
    const clock = readClock(sectionData, Date.parse(nowIso));

    if (clock.needsReanchor) {
      await reanchorSection(adminClient, sectionData.id, clock, nowIso);
    } else {
      await touchActivity(adminClient, sectionData.id, nowIso);
    }

    const timeRemainingSeconds = clock.remainingSeconds;

    // ── STEP 4: Fetch session questions with full question data ──
    // This is the main query. It joins:
    //   session_questions → questions → stimulus → instruction
    // to build the complete question bundle.
    const { data: sessionQuestions, error: sqError } = await adminClient
      .from("session_questions")
      .select(`
        id,
        question_id,
        display_order,
        locked,
        questions!inner (
          id,
          question_text,
          render_markup,
          svg_content,
          choice_a,
          choice_b,
          choice_c,
          choice_d,
          choice_e,
          stimulus_id,
          instruction_id,
          stimuli (
            id,
            stimulus_group_key,
            stimulus_type,
            stimulus_title,
            stimulus_text
          ),
          instructions (
            id,
            code,
            title,
            instruction_text
          )
        )
      `)
      .eq("session_id", sessionId)
      .eq("section_name", validatedSectionName)
      .order("display_order", { ascending: true });

    if (sqError) {
      console.error("Question fetch failed:", sqError);
      throw new ApiError(500, "Failed to load questions.");
    }

    // ── STEP 5: Fetch visual assets for these questions ──
    const questionIds = (sessionQuestions || []).map(
      (sq: any) => sq.questions.id
    );

    let visualAssets: any[] = [];
    if (questionIds.length > 0) {
      const { data: qva } = await adminClient
        .from("question_visual_assets")
        .select(`
          *,
          visual_assets (*)
        `)
        .in("question_id", questionIds)
        .order("display_order", { ascending: true });

      visualAssets = qva || [];
    }

    // Build a map of question_id → visual assets for fast lookup
    const visualMap = new Map<string, any[]>();
    const rawVisualMap = new Map<string, any[]>();
    for (const va of visualAssets) {
      const existing = visualMap.get(va.question_id) || [];
      const asset = va.visual_assets || {};
      existing.push({
        ...asset,
        display_order: va.display_order,
        marked_segment: va.marked_segment,
        passage_question_range: va.passage_question_range,
        question_visual_asset_id: va.id,
        question_id: va.question_id,
        visual_asset_id: va.visual_asset_id,
      });
      visualMap.set(va.question_id, existing);

      const rawExisting = rawVisualMap.get(va.question_id) || [];
      rawExisting.push(va);
      rawVisualMap.set(va.question_id, rawExisting);
    }

    // ── STEP 6: Fetch existing responses (for resume) ──
    const sessionQuestionIds = (sessionQuestions || []).map((sq: any) => sq.id);

    let existingResponses = new Map<string, string | null>();
    if (sessionQuestionIds.length > 0) {
      const { data: responses } = await adminClient
        .from("session_responses")
        .select("session_question_id, selected_answer")
        .in("session_question_id", sessionQuestionIds);

      for (const r of responses || []) {
        existingResponses.set(r.session_question_id, r.selected_answer);
      }
    }

    // ── STEP 7: Build the response ──
    // CRITICAL: correct_answer is NOT included in the response.
    // The frontend receives question text, choices, and metadata only.
    const questions = (sessionQuestions || []).map((sq: any) => {
      const q = sq.questions;
      return {
        session_question_id: sq.id,
        question_id: sq.question_id || q.id,
        display_order: sq.display_order,
        locked: sq.locked,
        question_text: q.question_text,
        render_markup: q.render_markup,
        svg_content: q.svg_content || null,
        choices: {
          a: q.choice_a,
          b: q.choice_b,
          c: q.choice_c,
          d: q.choice_d,
          e: q.choice_e || null, // null if question has only 4 choices
        },
        stimulus: q.stimuli
          ? {
              group_key: q.stimuli.stimulus_group_key,
              type: q.stimuli.stimulus_type,
              title: q.stimuli.stimulus_title,
              text: q.stimuli.stimulus_text,
            }
          : null,
        instruction: q.instructions
          ? {
              code: q.instructions.code,
              title: q.instructions.title,
              text: q.instructions.instruction_text,
            }
          : null,
        visual_assets: visualMap.get(q.id) || [],
        _vis: rawVisualMap.get(q.id) || [],
        selected_answer: existingResponses.get(sq.id) || null,
      };
    });

    // Get the section config for display info
    const sectionConfig = SECTION_CONFIG.find((s) => s.name === sectionName)!;

    return jsonResponse({
      session_id: sessionId,
      section: sectionName,
      display_name: sectionConfig.displayName,
      time_limit_seconds: sectionData.time_limit_seconds,
      time_remaining_seconds: timeRemainingSeconds,
      question_count: questions.length,
      questions,
    });
  })
);
