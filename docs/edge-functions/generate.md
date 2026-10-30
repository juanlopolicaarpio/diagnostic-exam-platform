# Question Generation Guide

## Live Prompt Source of Truth

Production AI generation uses the prompt rules in:

`supabase/functions/_shared/prompt-rules.ts`

Add durable global rules there when you want the deployed generator to follow them.
This document is the longer writing guide; the Edge Function imports the shared
rules file directly.

## Goal

Generate entrance-exam-quality diagnostic questions for all subjects, topics, and subtopics in the question bank.

Questions should be suitable for UPCAT, ACET, and similar entrance exams. They should test real readiness, not just memorization or recognition of labels.

Each question should be:

* Clear
* Defensible
* Varied
* Appropriate to the exact assigned topic and subtopic
* Matched to the stated difficulty level
* Useful for diagnosing what the student understands or does not understand

## Question Format

Each question should include:

* `difficulty_level`: `"easy"`, `"medium"`, or `"hard"`
* `question_text`
* `choice_a`
* `choice_b`
* `choice_c`
* `choice_d`
* `correct_answer`: `"a"`, `"b"`, `"c"`, or `"d"`

Use only four answer choices.

Do not create a fifth option.

## Exact Topic and Subtopic Alignment

This is a strict requirement.

Every generated question must directly test the selected subject, topic, and subtopic.

Do not drift into a neighboring topic or a related but different subtopic just to make the item easier to write.

Before finalizing each question, ask:

* Does this question clearly belong to the selected subject?
* Does it directly test the selected topic?
* Does it directly test the selected subtopic?
* Would a reviewer immediately understand why this item belongs in that exact subtopic?

If the answer is no, rewrite the question.

For example:

* A question for `Introduction to Limits` should test limits, not general substitution unless the limit concept is actually present.
* A question for `Analytic Geometry` should test analytic geometry, not plain algebra with coordinates added artificially.
* A question for `Gerunds` should test gerund usage in context, not general sentence correction unless the gerund issue is central.
* A question for a Science subtopic should test the assigned science concept, not a broad science fact from a neighboring unit.

## General Question Design Rule

Do not write questions that feel like artificial label drills.

Prefer questions that require the student to apply a concept in a realistic exam-style situation.

A good question usually has one of these forms:

* A short problem to solve
* A sentence or passage to interpret
* A small data set or scenario
* A real-world application
* A comparison between closely related ideas
* A question that requires logic, not just recall

Avoid using graph- or image-dependent items by default, because graphs and images cannot be assumed to render properly unless they are created through supported `svg_content`.

Do not create questions that require a diagram, chart, or graph unless it is truly necessary for the subtopic.

If a visual is not necessary, convert the item into a text-based, equation-based, table-based, or scenario-based question instead.

## Visuals, Graphs, and SVG Content

As a general rule, avoid generating questions that require graphs, diagrams, charts, or images.

If a graph or diagram is absolutely necessary:

1. Check existing questions that use `svg_content`.
2. Study how their graphs or diagrams are structured and rendered.
3. Follow the same SVG pattern and formatting conventions.
4. Make sure the visual is simple, readable, and directly necessary to answer the question.
5. Make sure the question still has enough text context so the item is understandable.
6. Do not invent a new visual format if an existing `svg_content` pattern can be reused.
7. Do not leave `svg_content` null if the question depends on a graph or diagram.

For Math and Science, graphs and diagrams are usually stored in `svg_content`. Follow existing examples instead of improvising.

If you are not confident the SVG will render correctly, do not use a visual-dependent question.

## Difficulty Calibration

Use this rule strictly:

**One move = easy.**

### Easy

Use for questions requiring only one direct step.

Examples:

* Direct substitution
* Single formula plug-in
* Reading information directly from an equation, sentence, or table
* Identifying a basic concept
* One-step equation or inequality
* Basic mean, median, mode, or range
* Basic vocabulary-in-context
* Basic grammar usage in a simple sentence
* Direct recall of a science fact or principle
* Simple unit conversion
* Non-indeterminate limit

Do not label direct substitution, simple recall, or single-formula use as medium.

### Medium

Use for questions requiring two steps, interpretation, or a choice of method.

Examples:

* Solving a problem that requires choosing the right formula
* Finding slope, then writing an equation
* Applying a grammar rule in context
* Interpreting a short passage
* Comparing two scientific concepts
* Reading a table and calculating a result
* Solving a `0/0` limit by factoring
* Solving an inequality that requires flipping the sign
* Weighted or combined mean
* Applying a scientific law to a simple scenario
* Balancing a simple chemical equation
* Using a formula after converting units

Do not label a single formula application as hard.

### Hard

Use for questions requiring three or more steps, deeper logic, a system, or a non-obvious technique.

Examples:

* Multi-step word problems
* Compound inequalities
* Systems of equations
* Rationalizing limits using a conjugate
* Recovering a function from given outputs
* Multi-step geometry reasoning
* Multi-step scientific computation
* Interpreting an experimental setup
* Predicting the effect of changing one variable in a scientific system
* Combining memorized facts with reasoning
* Evaluating competing explanations or conclusions

## Distractor Design

Every wrong option should reflect a plausible student mistake.

Good distractors may come from:

* Sign errors
* Dropped negatives
* Forgetting to flip an inequality sign
* Using the reciprocal instead of the negative reciprocal
* Swapping numerator and denominator
* Using the wrong formula
* Applying the right formula to the wrong variable
* Forgetting a unit conversion
* Confusing similar terms
* Choosing a memorized fact that does not fit the scenario
* Misreading the question’s condition
* Choosing a statement that is partly true but does not answer the question

Avoid filler distractors.

Do not include a distractor that could also be considered correct.

## Distinct Purpose

No two questions in the same subtopic should test the exact same single move.

Within each subtopic, spread questions across the important sub-skills.

For example, for Linear Functions and Inequalities, include a mix of:

* Slope
* Intercepts
* Parallel lines
* Perpendicular lines
* Inequality sign-flip
* Compound inequalities
* Word problems
* Recovering a function from outputs

For Science subtopics, include a mix of:

* Basic concept recall
* Formula application
* Unit conversion
* Data or table interpretation
* Cause-and-effect reasoning
* Experimental reasoning
* Real-world application
* Comparison of similar concepts

## Math Question Guidelines

Math questions should emphasize solving, computation, and reasoning.

Use equations often. Avoid too much theory-only questioning.

A strong Math batch should include:

* Direct computation
* Algebraic manipulation
* Word problems
* Coordinate or equation interpretation
* Formula application
* Multi-step reasoning
* Conceptual questions only when the concept is important for problem-solving

Avoid graph-dependent Math questions unless the graph is absolutely necessary and can be properly represented through `svg_content`.

Math questions should not just ask for definitions unless the definition is essential.

### Math Formatting

Use inline math in `\( ... \)`.

Preferred formatting:

* Fractions: `\dfrac`, `\tfrac`
* Radicals: `\sqrt`
* Geometry: `\triangle`, `\cong`, `\angle`
* Limits: `\displaystyle\lim_{x\to a}`
* Degrees: `°`

Do not put a currency symbol inside math. For example, write `300 pesos`, not `\₱300`.

Choices may be plain strings or math expressions inside `\( ... \)`.

## English Question Guidelines

English questions should feel like real UPCAT, ACET, or SAT-style language questions.

Avoid making the question bank feel like a grammar-label drill.

Do not overuse stems such as:

* “What is a gerund?”
* “The gerund functions as a ___.”
* “Identify the part of speech.”
* “Choose the grammatically correct sentence.”
* “Which revision best corrects the sentence?”

Instead, test English through actual examples.

Use:

* Sentences with realistic errors
* Short paragraphs
* Context-based grammar
* Reading comprehension
* Logical flow
* Word choice in context
* Concision
* Tone and formality
* Sentence combination
* Transitions
* Main idea and inference
* Evidence-based reasoning

The student should usually have to read an actual sentence or short passage and decide what makes sense.

The stem should be simple. The thinking should come from the example itself.

### Underlined Text in English Questions

If an English question refers to an underlined word, phrase, clause, or sentence, the relevant text must actually be underlined in `question_text`.

Do not write “the underlined portion” unless there is a visibly underlined portion in the text.

Use the same underline formatting convention already used in the existing question bank.

If the existing bank uses HTML, follow that pattern, such as:

`The committee postponed <u>reviewing the proposal</u> until Friday.`

The answer choices should then directly address the underlined portion.

### Better English Item Styles

Prefer items like these:

* A sentence with an actually underlined portion, followed by four possible replacements
* A short paragraph with one sentence that does not logically fit
* A sentence where the student must choose the word that best fits the context
* A passage where the student must infer the author’s point
* A paragraph where the student must choose the best transition
* A sentence pair where the student must combine ideas clearly
* A sentence with a modifier, verb tense, pronoun, gerund, or parallelism issue embedded naturally
* A short argument where the student must identify the assumption, flaw, or best support

## Science Question Guidelines

Science questions should include both memorization and problem-solving.

Do not make Science purely theory-based.

A strong Science batch should include:

* Concept recall
* Equations and computations
* Unit conversions
* Data or table interpretation
* Experimental design
* Cause-and-effect reasoning
* Real-world applications
* Predicting outcomes when a variable changes

Use equations where appropriate, especially in Physics, Chemistry, Earth Science, and quantitative Biology.

However, do not force equations into topics where conceptual reasoning is more appropriate.

Avoid graph- or diagram-dependent Science questions unless the visual is absolutely necessary and can be properly represented through `svg_content`.

### Science Difficulty Calibration

Science easy questions may ask for:

* A direct fact
* A simple definition
* A one-step formula substitution
* Identifying a process from a description
* Reading a value directly from a table or text description

Science medium questions may ask for:

* Two-step calculation
* Unit conversion plus formula use
* Interpreting a simple experiment
* Comparing two processes
* Explaining cause and effect
* Applying a concept to a real scenario

Science hard questions may ask for:

* Multi-step calculation
* Analyzing an experimental setup
* Predicting the effect of changing variables
* Interpreting conflicting data
* Combining two or more science concepts
* Choosing the best conclusion from evidence

### Science Examples by Type

Physics:

* Use formulas for speed, acceleration, force, work, power, energy, density, pressure, electricity, and waves where appropriate.
* Use text-based or table-based motion descriptions instead of graph-dependent items whenever possible.
* Avoid making all Physics questions definition-only.

Chemistry:

* Include balancing equations, mole relationships, concentration, pH, atomic structure, periodic trends, bonding, and reaction types where appropriate.
* Use computations when the subtopic supports them.
* Include conceptual questions that distinguish similar ideas, such as ionic vs. covalent bonding or acid vs. base behavior.

Biology:

* Include both memorization and reasoning.
* Use processes and scenarios where possible.
* Cover cells, genetics, ecology, evolution, human body systems, photosynthesis, respiration, and classification where relevant.
* Ask students to interpret outcomes, not just name parts.
* Avoid diagram-dependent questions unless the diagram is necessary and can be correctly represented.

Earth Science:

* Include weather, climate, rocks, plate tectonics, earthquakes, volcanoes, astronomy, and environmental systems where relevant.
* Use sequences, data tables, and cause-effect reasoning.
* Include calculations only when appropriate.
* Avoid map-, chart-, or diagram-dependent questions unless necessary.

## Other Subject Guidelines

For any other subject, follow the same principle:

The question should test useful understanding, not just memorized labels.

For each topic and subtopic, include a balanced mix of:

* Recall
* Application
* Interpretation
* Problem-solving
* Real-world examples
* Logic or evidence-based reasoning

If a topic is fact-heavy, include memorization questions, but still vary the format.

If a topic is skill-heavy, prioritize actual tasks, computations, or examples.

## Topic and Subtopic Coverage

Generate questions according to the actual subject, topic, and subtopic assigned.

Do not drift into a neighboring subtopic just to make the question easier.

Each question should clearly belong to its assigned subtopic.

For every subject, topic, and subtopic, create a varied set of questions that covers the major skills inside that area.

A subtopic should not have 20 questions that all test the same idea.

## Answer-Position Balance

Spread correct answers roughly evenly across `a`, `b`, `c`, and `d` within each subtopic.

After generating a batch, count the correct answers.

If one answer letter clusters too much, permute the choices while preserving the correct key.

## Quality Checklist

Before finalizing a question batch, check that:

* Each question directly matches the assigned subject.
* Each question directly matches the assigned topic.
* Each question directly matches the assigned subtopic.
* The item does not drift into a neighboring topic or subtopic.
* Each item matches its assigned difficulty.
* The correct answer is unambiguous.
* Every distractor is plausible.
* No two items test the exact same move.
* Math questions use equations and computation where appropriate.
* Science questions include both concept recall and application.
* English questions use actual sentences, passages, context, and logic instead of label drills.
* If an English question refers to an underlined portion, that portion is actually underlined in the text.
* Avoid graph-, chart-, diagram-, or image-dependent questions unless absolutely necessary.
* If a visual is necessary, `svg_content` is created by following existing SVG question patterns.
* The batch includes a mix of recall, application, interpretation, and reasoning.
* Math notation renders correctly.
* Currency symbols are not placed inside math mode.
* Correct answers are balanced across `a`, `b`, `c`, and `d`.
* The questions are appropriate for entrance-exam diagnostic use.

## Sample Question Object

Use this structure when generating each item:

```js
{
  difficulty_level: "medium",
  question_text: "A student walks 120 meters east, then 50 meters west. If the entire walk takes 34 seconds, what is the student's average velocity?",
  choice_a: "\\(2.06\\text{ m/s east}\\)",
  choice_b: "\\(3.53\\text{ m/s east}\\)",
  choice_c: "\\(2.06\\text{ m/s west}\\)",
  choice_d: "\\(5.00\\text{ m/s east}\\)",
  correct_answer: "a"
}
```

## Final Instruction

Generate questions that are not merely correct, but useful for diagnosing readiness.

Each question must be connected exactly to the selected subject, topic, and subtopic.

Prioritize actual exam-style thinking: solve, interpret, compare, infer, compute, and apply.
