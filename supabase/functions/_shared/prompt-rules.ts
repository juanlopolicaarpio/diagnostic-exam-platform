export const PROMPT_RULES = `
General item-writing rules:
- Do not overuse definition, identification, or label-recognition questions.
- Prefer applied exam-style tasks: interpret a sentence, revise a sentence, solve a problem, evaluate evidence, compare cases, infer from a passage, or apply a rule in context.
- A batch should not feel like ten versions of "Identify the..." or "Which term means...".
- If a subtopic name is a grammar/skill label, do not repeatedly name that label in the stem. Test the skill through examples instead.
- Never announce the hidden skill being tested. Do not write stems such as "identify the misused sequence marker," "choose the correct gerund," "pick the contrast marker," or similar label-revealing prompts. These hand students the strategy and reduce the item to label spotting.
- For skill-label subtopics, phrase the item as a natural task: a cloze, sentence revision, paragraph completion, sentence combination, or "Which choice best completes/improves the passage?" The student should have to notice the issue without being told which category to hunt for.
- Do not redundantly name in the stem what is already visible in the choices. If the choices are sequence markers, transitions, gerunds, clauses, verb forms, or other target constructions, the stem must ask for the best completion/revision, not say "uses a sequence marker," "choose the transition," or "which gerund."

English Language rules:
- Avoid metalanguage-heavy stems unless absolutely necessary.
- Do not write stems like "Which sentence uses coordination and subordination correctly..." because that announces the subtopic instead of testing it naturally.
- Do not write stems like "Identify the sentence in which the subordinating conjunction..." for the same reason.
- For coordination/subordination, ask students to choose the clearest or most logical sentence combination without naming "coordination" or "subordination" in the stem.
- For gerunds, relative clauses, embedded sentences, voice, reported speech, sequence markers, note-taking, and outlining, test through actual sentence/paragraph choices, not definitions.
- For sequence markers specifically, do not say "sequence marker" or "misused marker" in the stem. Show the sentence or short paragraph and ask for the best completion, revision, or transition.
- Bad: "Which sentence uses a sequence marker most naturally to introduce the first step in a process?" Better: "Which choice best begins the process?" or "Which sentence best completes the instruction?"
- For contrast, cause-effect, comparison, concession, and other transition/marker subtopics, hide the label in the same way; test logical fit through context.
- Prefer realistic sentences, short paragraphs, revisions, sentence combinations, transitions, concision, tone, and logical flow.
- Keep the stem simple; put the thinking in the sentence or paragraph context.

Rendering rule for chord-related geometry:
- The renderer breaks the normal word "chord" by detecting "or" inside it.
- Because the parser cannot be changed, write the word with an invisible word joiner between "o" and "r": cho⁠rd.
- Use this spelling everywhere a chord term is needed: cho⁠rd, cho⁠rds, second cho⁠rd, distance from the center to the cho⁠rd.
- Never write the normal word "chord" in generated question text, choices, explanations, or SVG labels.
`;
