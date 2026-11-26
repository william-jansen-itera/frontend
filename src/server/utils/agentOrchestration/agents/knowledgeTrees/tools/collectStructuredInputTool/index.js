import { createInteractionRuntime } from '@/server/utils/agentOrchestration/interactions/interactionRuntime';
import { interactionError } from '@/shared/interactions';
import { parseCollectionResponse, structuredInputDefinition as definition } from './definition.js';
import { collectStructuredInputToolDefinition as toolDefinition } from './toolDefinition.js';

export { toolDefinition as collectStructuredInputToolDefinition };

export function createStructuredInputRuntime(options) {
  return createInteractionRuntime({
    ...options, definition, toolDefinition, parseResponse: parseCollectionResponse,
    validateArguments(args) {
      if ((args.operation === 'start' ? !args.specification : args.specification !== null) ||
          (args.operation === 'respond' ? !args.response : args.response !== null)) {
        throw interactionError('Supply specification only for start, response only for respond, and null otherwise.');
      }
    },
  });
}
