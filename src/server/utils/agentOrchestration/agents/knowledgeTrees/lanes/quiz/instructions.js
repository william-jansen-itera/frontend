export function buildQuizInstructions() {
  return `
## Decide the quiz-lane action
Apply these rules only when quiz is active. The only implemented workflow here is the fixed multistep interaction test; actual quiz generation, questions, reference answers, grading, and scoring are not implemented. Do not pretend the test is a quiz or launch it merely because the human requests a real quiz.

1. For trusted captured interaction input owned by test_multistep_interaction, call test_multistep_interaction operation="process" with its exact saved ID. The server captured the values before this model call; do not invent, replace, or resubmit them. This turn authorizes only the owning tool, not other tools or lane switches. Input owned by the shared collector follows its shared rules instead.
2. For an explicit human resume request, use operation="resume" with the supplied saved interaction ID, or the trusted current interaction ID if present. If neither is available, pass interactionId=null: the tool finds this user's most recently updated unfinished, unexpired test interaction in this application across conversations. Do not require the human to copy an ID, reconstruct state from history, or invent an identity. If none is found, explain that and ask before starting a new test. Use operation="status" with an exact ID to review without advancing.
3. For a human request to "test quiz interaction" (or its language equivalent), call operation="start", interactionId=null. The tool defines the fixed steps and available actions, including Back, Continue, Submit, Cancel, and Resume; never invent inputs, steps, identities, or successful transitions. This remains an interaction test, not actual quiz functionality.
   The separate Yes/No step only collects an answer and advances to the final review. No does not cancel, and neither answer approves or executes an action. Final Submit and Cancel remain separate.
4. For a real quiz request, explain that quiz functionality is not implemented yet. For unclear test intent, ask one concise clarification question. Do not search, broaden, save notes, or silently substitute the fixed test for a quiz.

## Presentation and response outcomes
Report only the actual saved tool state. The server renders its validated interaction card; do not recreate buttons or forms in Markdown. You may include interaction={"interactionId":"<actual tool ID>"} in the final structured reply to reference that card, or null when absent. Never generate an arbitrary interaction definition.
Keep interaction IDs internal to tool arguments and structured metadata. Do not display them in the answer, card text, or instructions to the human; the human can request resume without providing an ID.
Use knowledgeMode="grounded", isPermissionToBroadenRequest=false, isPersistenceOffer=false, persistenceAction="none", and isWaitingForContinuation=false. Waiting for human input is not an automated continuation. Interaction-cache writes are not note-save outcomes.
Tree-search and saving tools are unavailable in quiz. A separate clear request for retrieval or saving requires switch_tree_lane before those operations; leaving quiz does not complete or delete a saved interaction. Explicitly resume it to present its current step again.
`.trim();
}
