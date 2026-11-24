import {
  RETRIEVAL_LANE, SAVING_LANE, SWITCH_TREE_LANE_TOOL,
  assertTreeLaneTool, buildTreeLaneInstruction,
} from './treeLaneState.js';
import { createSwitchTreeLaneHandler } from './tools/switchTreeLaneTool/index.js';

export function createTreeLaneRuntime({ state, persist, previewUploadId, uploadId, pendingUploadId }) {
  let current = state;
  let switchedAway = false;
  let savingResultThisTurn = false;
  const completedCalls = new Map();
  const update = async (patch) => {
    current = await persist(current.version, patch);
    return current;
  };
  return {
    get state() { return current; },
    get confirmationRevoked() { return switchedAway; },
    instruction: () => buildTreeLaneInstruction(current),
    wrapHandlers(handlerMap, toolPolicies) {
      handlerMap.set(SWITCH_TREE_LANE_TOOL, createSwitchTreeLaneHandler({
        getState: () => current,
        previewUploadId,
        uploadId,
        transition: async (activeLane) => {
          if (current.activeLane === SAVING_LANE && savingResultThisTurn) {
            throw new Error('Report the saving workflow result in this lane first. A preview requires a later human reply; switch lanes on that later turn if requested.');
          }
          if (current.activeLane === SAVING_LANE) switchedAway = true;
          await update({
            activeLane, stage: 'idle', previewId: null,
            uploadId: activeLane === SAVING_LANE ? uploadId ?? pendingUploadId ?? null : null,
          });
        },
      }));
      toolPolicies.set(SWITCH_TREE_LANE_TOOL, { requiresUserApproval: false });
      for (const [toolName, handler] of handlerMap) {
        if (toolName === SWITCH_TREE_LANE_TOOL) continue;
        handlerMap.set(toolName, async (...args) => {
          assertTreeLaneTool(current, toolName);
          const key = JSON.stringify([toolName, args[0]]);
          if (completedCalls.has(key)) {
            const completed = completedCalls.get(key);
            if (completed.output?.toolResultType === 'tree_note_preview' && completed.output.data.previewId !== current.previewId) {
              throw new Error('This preview has been superseded. Use the latest preview rather than retrying an earlier proposal.');
            }
            return completed.result;
          }
          if (['revise_save_preview', 'confirm_save_to_tree'].includes(toolName) &&
              (!current.previewId || args[0]?.previewId !== current.previewId || switchedAway)) {
            throw new Error('This preview is not active in the saving workflow. Request and display a new preview before later human confirmation.');
          }
          await update({});
          const result = await handler(...args);
          const output = result?.toolOutput ?? result;
          if (current.activeLane === SAVING_LANE && output?.toolResultType) savingResultThisTurn = true;
          if (output?.toolResultType === 'tree_note_preview') {
            await update({ stage: 'awaiting_approval', previewId: output.data.previewId, uploadId: null });
          } else if (['tree_note_created', 'tree_note_updated', 'tree_attachment_saved'].includes(output?.toolResultType)) {
            await update({ stage: 'completed', previewId: null, uploadId: null });
          } else if (output?.toolResultType === 'temporary_upload_note') {
            await update({ stage: 'upload_processing', previewId: null, uploadId });
          }
          if (output && !output.error) completedCalls.set(key, { result, output });
          return result;
        });
      }
    },
    async finishResponse(answerState) {
      if (current.activeLane === SAVING_LANE && current.stage === 'idle') {
        await update({ stage: 'awaiting_details' });
      }
      if (current.previewId && !answerState.answer.includes(`<!-- Preview ID: ${current.previewId} -->`)) {
        await update({ stage: 'idle', previewId: null });
      }
    },
    validateAnswer(answerState) {
      if (current.activeLane === SAVING_LANE &&
          (answerState.knowledgeMode !== 'grounded' || answerState.isPermissionToBroadenRequest || answerState.isPersistenceOffer)) {
        return 'The active lane is knowledge.saving. Return a grounded saving-tool status or clarification with isPermissionToBroadenRequest=false and isPersistenceOffer=false. Switch to knowledge.retrieval before a broader or substantive knowledge answer.';
      }
      if (current.activeLane === RETRIEVAL_LANE && answerState.persistenceAction !== 'none') {
        return 'The active lane is knowledge.retrieval. A save outcome must be reported in knowledge.saving; a transition does not itself save anything.';
      }
      return null;
    },
  };
}
