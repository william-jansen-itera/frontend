import { interactionError } from '@/shared/interactions';
import { createStructuredInputRuntime, collectStructuredInputToolDefinition } from './tools/collectStructuredInputTool/index.js';
import { createQuizRuntime } from './lanes/quiz/quizRuntime.js';

export function createTreeInteractionRuntime(options) {
  const quizRuntime = createQuizRuntime(options);
  const runtimes = new Map([
    ['quiz', { runtime: quizRuntime, toolName: 'quiz' }],
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
      if (reference) await select(reference.workflow).prepare(input);
      else if (quizRuntime.hasBoundQuiz) await select('quiz').prepare(input);
    },
    needsCatalog: (input) => (input.submission ?? input.context)?.workflow === 'quiz' ||
      !(input.submission ?? input.context) && quizRuntime.hasBoundQuiz,
    configure: (context) => quizRuntime.configure(context),
    async processSubmission() {
      if (current?.toolName !== collectStructuredInputToolDefinition.name) return null;
      const processed = await current.runtime.processSubmission();
      if (processed?.resumed) await quizRuntime.onCollectionResult('resume', { data: { interaction: processed.interaction } });
      return processed;
    },
    async collect(args) {
      const output = await select('structured-input').handle(args);
      await quizRuntime.onCollectionResult(args.operation, output);
      return output;
    },
    quiz: (args) => select('quiz').handle(args),
    quizProgress: () => quizRuntime.progress(),
    instruction: () => current?.runtime.instruction() ?? '',
    validateAnswer(answerState) {
      if (!current && answerState.interaction) return 'Reference only the actual saved interaction from this turn, or omit interaction. Never invent an interactionId.';
      return current?.runtime.validateAnswer(answerState) ?? null;
    },
    present: () => current?.runtime.present() ?? null,
    recovery: () => current?.runtime.recovery() ?? null,
  };
}
