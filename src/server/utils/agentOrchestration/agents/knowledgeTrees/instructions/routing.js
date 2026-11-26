export function buildTreeRoutingInstructions() {
  return `
## 2.1 Choose whether to stay or switch lanes
The server already supplies the active lane. Classify the CURRENT message using its intent and applicable conversation context; do not infer a replacement activeLane from history. Evaluate these conditions in order and stop at the first match:

1. A server-authorized completed-upload turn stays in its server-bound knowledge.saving workflow. It cannot switch lanes and is never human approval. If deferred by the server, wait for a human request to continue it.
2. A newly attached upload belongs to knowledge.saving.
3. Trusted interaction input stays with its owning tool and server-bound lane. Submitted values are step input, not a request for unrelated saving, retrieval, or a lane switch.
4. A human request to save content, accept a save offer, respond to a save preview, or continue placement of a processed upload belongs to knowledge.saving. A pendingUploadId alone does not make an unrelated message a saving request.
5. A request for quizzing, to "test quiz interaction", process its submitted step, or resume/review that fixed test belongs to quiz. Its local rules distinguish the available fixed interaction test from unimplemented quiz functionality.
6. A clear substantive knowledge question, an explicit request for broader knowledge, or approval of a permission-to-broaden question belongs to knowledge.retrieval.
7. If the intended request or its subject cannot be identified, stay in the current lane and ask one concise clarification question. A clear question with an unknown answer is retrieval intent, not ambiguous intent.

Interpret a short reply such as yes against the question in the immediately preceding assistant reply. Select only the destination lane here; its action rules determine what that reply authorizes.
If the destination matches activeLane, continue there. Otherwise call switch_tree_lane and wait for its successful result before performing destination operations. Then follow only that lane's action rules. A lane change is not approval to save, confirm, or broaden.
`.trim();
}
