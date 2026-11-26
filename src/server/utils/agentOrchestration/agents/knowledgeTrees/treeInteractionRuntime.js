import { interactionError } from '@/shared/interactions';
import { createInteractionTestRuntime, testInteractionToolDefinition } from './lanes/quiz/tools/testInteractionTool/index.js';
import { createStructuredInputRuntime, collectStructuredInputToolDefinition } from './tools/collectStructuredInputTool/index.js';

export function createTreeInteractionRuntime(options) {
  const runtimes = new Map([
    ['interaction-test', {
      runtime: createInteractionTestRuntime({ ...options, isAllowed: options.isQuizAllowed }),
      toolName: testInteractionToolDefinition.name,
    }],
    ['structured-input', {
      runtime: createStructuredInputRuntime({
        ...options,
        isAllowed: () => !options.uploadId && !options.previewUploadId && !options.pendingUploadId,
      }),
      toolName: collectStructuredInputToolDefinition.name,
    }],
  ]);
  let current = null;
  function select(workflow) {
    const selected = runtimes.get(workflow);
    if (!selected || current && current !== selected && !current.runtime.completed) {
      throw interactionError('Use only the owning interaction tool in this turn.', 409);
    }
    current = selected;
    return selected.runtime;
  }
  return {
    get controlsTurn() { return current?.runtime.controlsTurn ?? false; },
    get toolName() { return current?.toolName ?? null; },
    async prepare(input) {
      const reference = input.submission ?? input.context;
      if (reference) await select(reference.workflow ?? 'interaction-test').prepare(input);
    },
    processSubmission: () => current?.toolName === collectStructuredInputToolDefinition.name
      ? current.runtime.processSubmission() : null,
    handle: (args) => select('interaction-test').handle(args),
    collect: (args) => select('structured-input').handle(args),
    instruction: () => current?.runtime.instruction() ?? '',
    validateAnswer(answerState) {
      if (!current && answerState.interaction) return 'Reference only the actual saved interaction from this turn, or omit interaction. Never invent an interactionId.';
      return current?.runtime.validateAnswer(answerState) ?? null;
    },
    present: () => current?.runtime.present() ?? null,
    recovery: () => current?.runtime.recovery() ?? null,
  };
}
