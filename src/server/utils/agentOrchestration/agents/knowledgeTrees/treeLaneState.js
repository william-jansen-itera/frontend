export const RETRIEVAL_LANE = 'knowledge.retrieval';
export const SAVING_LANE = 'knowledge.saving';
export const QUIZ_LANE = 'quiz';
export const SWITCH_TREE_LANE_TOOL = 'switch_tree_lane';

const SAVING_TOOLS = new Set([
  'process_upload', 'preview_save_to_tree', 'revise_save_preview', 'confirm_save_to_tree',
]);
const STAGES = new Set(['idle', 'upload_processing', 'awaiting_details', 'awaiting_approval', 'completed']);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/i;

export function assertTreeContextId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error(`A valid ${label} is required.`);
  }
  return value;
}

export function assertTreeLane(lane) {
  if (lane !== RETRIEVAL_LANE && lane !== SAVING_LANE && lane !== QUIZ_LANE) {
    throw new Error(`Unknown Knowledge Trees lane: ${String(lane)}.`);
  }
  return lane;
}

export function validateTreeConversation(state) {
  if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.version) || state.version < 0) {
    throw new Error('Invalid Knowledge Trees conversation state.');
  }
  assertTreeLane(state.activeLane);
  for (const key of ['quizId', 'quizSetupId']) {
    if (state[key] !== null) assertTreeContextId(state[key], key);
    if (state[key] !== null && state.activeLane !== QUIZ_LANE) {
      throw new Error('Quiz bindings require the quiz lane.');
    }
  }
  if (!STAGES.has(state.stage) ||
      (state.activeLane !== SAVING_LANE && state.stage !== 'idle') ||
      (state.previewId !== null && typeof state.previewId !== 'string') ||
      (state.uploadId !== null && typeof state.uploadId !== 'string') ||
      (state.stage === 'awaiting_approval' && !state.previewId) ||
      (state.stage === 'upload_processing' && !state.uploadId)) {
    throw new Error('Invalid Knowledge Trees workflow state.');
  }
  if (state.turn !== null) {
    const turn = state.turn;
    assertTreeContextId(turn?.id, 'turnId');
    if (!['running', 'completed', 'failed'].includes(turn.status)) {
      throw new Error('Invalid Knowledge Trees turn state.');
    }
  }
  return state;
}

export function buildTreeLaneContext(state) {
  return {
    conversationId: state.conversationId,
    version: state.version,
    activeLane: state.activeLane,
    stage: state.stage,
    previewId: state.previewId,
    uploadId: state.uploadId,
    ...(state.quizId ? { quizId: state.quizId } : {}),
    ...(state.quizSetupId ? { quizSetupId: state.quizSetupId } : {}),
  };
}

export function buildTreeLaneInstruction(state) {
  return [
    `Trusted Knowledge Trees turn context: ${JSON.stringify(buildTreeLaneContext(state))}`,
    'Match activeLane exactly to the published [lane: ...] heading. Apply shared, routing, and only the active lane\'s rules and its ancestor common rules. Knowledge common rules apply only to knowledge.retrieval and knowledge.saving, never quiz. Other lane rules are inactive.',
    ...(state.activeLane === QUIZ_LANE ? [
      'The quiz lane permits quiz, collect_structured_input, and switch_tree_lane. Use quiz for source-grounded questions and grading, and the collector for setup selections. Tree search and saving tools are unavailable here.',
    ] : []),
    `Before acting in another lane call ${SWITCH_TREE_LANE_TOOL}. Its successful result supplies the updated trusted context, which replaces this context.`,
    'A lane switch is not approval to save, broaden, or confirm. A workflow stage is not human approval.',
  ].join('\n');
}

export function isTreeLaneToolAllowed(activeLane, toolName) {
  if ([SWITCH_TREE_LANE_TOOL, 'collect_structured_input'].includes(toolName)) return true;
  const requiredLane = SAVING_TOOLS.has(toolName) ? SAVING_LANE
    : toolName === 'quiz' ? QUIZ_LANE
      : toolName.startsWith('search_tree_') ? RETRIEVAL_LANE : null;
  return Boolean(requiredLane) && activeLane === requiredLane;
}

export function assertTreeLaneTool(state, toolName) {
  assertTreeLane(state.activeLane);
  if (!isTreeLaneToolAllowed(state.activeLane, toolName)) {
    throw new Error(`Tool ${toolName} is not allowed in ${state.activeLane}. Request a valid lane switch before calling it.`);
  }
}

