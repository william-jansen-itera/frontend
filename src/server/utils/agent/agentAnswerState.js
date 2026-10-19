const KNOWLEDGE_MODE_GROUNDED = 'grounded';
const KNOWLEDGE_MODE_BROAD = 'broad';

const STRUCTURED_ANSWER_STATE_RESPONSE_NAME = 'knowledge_trees_final_answer';

function normalizeKnowledgeMode(value) {
  const normalizedValue = String(value ?? '').trim().toLowerCase();

  if (normalizedValue === KNOWLEDGE_MODE_GROUNDED || normalizedValue === KNOWLEDGE_MODE_BROAD) {
    return normalizedValue;
  }

  return null;
}

function extractJsonObjectText(rawText) {
  const normalizedText = String(rawText ?? '').trim();

  if (!normalizedText) {
    return '';
  }

  const fencedMatch = normalizedText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBraceIndex = normalizedText.indexOf('{');
  const lastBraceIndex = normalizedText.lastIndexOf('}');

  if (firstBraceIndex >= 0 && lastBraceIndex > firstBraceIndex) {
    return normalizedText.slice(firstBraceIndex, lastBraceIndex + 1).trim();
  }

  return normalizedText;
}

function buildAnswerStateValidationError(message, retryInstruction) {
  return new Error(`${message} ${retryInstruction}`.trim());
}

function buildStructuredResponseRetryInstruction({ allowBroadMode, allowPersistence, requirePersistenceOfferForBroad }) {
  const validStates = !allowBroadMode
    ? [
      `- grounded answer: knowledgeMode="${KNOWLEDGE_MODE_GROUNDED}", isPermissionToBroadenRequest=false, isPersistenceOffer=false`,
    ]
    : requirePersistenceOfferForBroad
      ? [
        `- grounded answer: knowledgeMode="${KNOWLEDGE_MODE_GROUNDED}", isPermissionToBroadenRequest=false, isPersistenceOffer=false`,
        `- grounded permission request: knowledgeMode="${KNOWLEDGE_MODE_GROUNDED}", isPermissionToBroadenRequest=true, isPersistenceOffer=false`,
        `- broad answer: knowledgeMode="${KNOWLEDGE_MODE_BROAD}", isPermissionToBroadenRequest=false, isPersistenceOffer=true`,
      ]
      : !allowPersistence
        ? [
          `- grounded answer: knowledgeMode="${KNOWLEDGE_MODE_GROUNDED}", isPermissionToBroadenRequest=false, isPersistenceOffer=false`,
          `- grounded permission request: knowledgeMode="${KNOWLEDGE_MODE_GROUNDED}", isPermissionToBroadenRequest=true, isPersistenceOffer=false`,
          `- broad answer: knowledgeMode="${KNOWLEDGE_MODE_BROAD}", isPermissionToBroadenRequest=false, isPersistenceOffer=false`,
        ]
        : [
          `- grounded answer: knowledgeMode="${KNOWLEDGE_MODE_GROUNDED}", isPermissionToBroadenRequest=false, isPersistenceOffer=false`,
          `- grounded permission request: knowledgeMode="${KNOWLEDGE_MODE_GROUNDED}", isPermissionToBroadenRequest=true, isPersistenceOffer=false`,
          `- broad answer: knowledgeMode="${KNOWLEDGE_MODE_BROAD}", isPermissionToBroadenRequest=false, isPersistenceOffer=true or false`,
        ];

  return [
    'Return a JSON object with exactly these fields: answer, knowledgeMode, isPermissionToBroadenRequest, isPersistenceOffer, explanation.',
    'Use a non-empty string for answer and explanation.',
    ...validStates,
  ].join(' ');
}

function broadConfirmationAllowed({ allowBroadMode, requirePersistenceOfferForBroad }) {
  return allowBroadMode && requirePersistenceOfferForBroad;
}

export function buildStructuredAnswerStateResponseFormat({
  allowBroadMode = true,
  allowPersistence = true,
  requirePersistenceOfferForBroad = false,
} = {}) {
  const stateDescription = !allowBroadMode
    ? 'Only grounded answers are valid for this family.'
    : requirePersistenceOfferForBroad
      ? 'Grounded answers stay grounded, permission requests stay grounded with isPermissionToBroadenRequest=true, and completed broad answers must set isPersistenceOffer=true.'
      : !allowPersistence
        ? 'Grounded answers stay grounded, permission requests stay grounded with isPermissionToBroadenRequest=true, and broad answers must keep isPersistenceOffer=false.'
        : 'Return the final answer state using one of the allowed grounded or broad combinations for this family.';

  return {
    verbosity: 'medium',
    format: {
      type: 'json_schema',
      name: STRUCTURED_ANSWER_STATE_RESPONSE_NAME,
      strict: true,
      schema: {
        type: 'object',
        properties: {
          answer: {
            type: 'string',
            description: 'The final user-facing answer text.',
          },
          knowledgeMode: {
            type: 'string',
            enum: [KNOWLEDGE_MODE_GROUNDED, KNOWLEDGE_MODE_BROAD],
            description: 'Whether the final answer is grounded in tool-derived results or is a broader answer.',
          },
          isPermissionToBroadenRequest: {
            type: 'boolean',
            description: 'True only when the assistant is asking the user for permission to broaden while still staying grounded.',
          },
          isPersistenceOffer: {
            type: 'boolean',
            description: 'True only when the final answer is a completed broad answer whose user-facing text explicitly asks whether to save it in the tree.',
          },
          explanation: {
            type: 'string',
            description: `Brief internal rationale for the selected answer state. ${stateDescription}`,
          },
        },
        required: ['answer', 'knowledgeMode', 'isPermissionToBroadenRequest', 'isPersistenceOffer', 'explanation'],
        additionalProperties: false,
      },
    },
  };
}

export function validateReportedAnswerState(
  state,
  {
    allowBroadMode = true,
    allowPersistence = true,
    requirePersistenceOfferForBroad = false,
  } = {},
) {
  const knowledgeMode = normalizeKnowledgeMode(state?.knowledgeMode);
  const isPermissionToBroadenRequest = state?.isPermissionToBroadenRequest === true;
  const isPersistenceOffer = state?.isPersistenceOffer === true;
  const explanation = String(state?.explanation ?? '').trim() || null;
  const allowsBroadConfirmation = broadConfirmationAllowed({
    allowBroadMode,
    requirePersistenceOfferForBroad,
  });
  const retryInstruction = buildStructuredResponseRetryInstruction({
    allowBroadMode,
    allowPersistence,
    requirePersistenceOfferForBroad,
  });

  if (!knowledgeMode) {
    throw buildAnswerStateValidationError(
      `Invalid answer state: knowledgeMode must be "${KNOWLEDGE_MODE_GROUNDED}" or "${KNOWLEDGE_MODE_BROAD}".`,
      retryInstruction,
    );
  }

  if (!allowBroadMode && knowledgeMode === KNOWLEDGE_MODE_BROAD) {
    throw buildAnswerStateValidationError(
      'Invalid answer state: this family does not support broad answers.',
      retryInstruction,
    );
  }

  if (isPermissionToBroadenRequest && knowledgeMode !== KNOWLEDGE_MODE_GROUNDED) {
    throw buildAnswerStateValidationError(
      'Invalid answer state: a broad-confirmation request must stay in grounded mode.',
      retryInstruction,
    );
  }

  if (!allowsBroadConfirmation && isPermissionToBroadenRequest) {
    throw buildAnswerStateValidationError(
      'Invalid answer state: this family does not use broad-confirmation turns.',
      retryInstruction,
    );
  }

  if (isPermissionToBroadenRequest && isPersistenceOffer) {
    throw buildAnswerStateValidationError(
      'Invalid answer state: a broad-confirmation request cannot offer persistence.',
      retryInstruction,
    );
  }

  if (isPersistenceOffer && knowledgeMode !== KNOWLEDGE_MODE_BROAD) {
    throw buildAnswerStateValidationError(
      'Invalid answer state: persistence can only be offered from a completed broad answer.',
      retryInstruction,
    );
  }

  if (!allowPersistence && isPersistenceOffer) {
    throw buildAnswerStateValidationError(
      'Invalid answer state: this family does not allow persistence offers.',
      retryInstruction,
    );
  }

  if (requirePersistenceOfferForBroad && knowledgeMode === KNOWLEDGE_MODE_BROAD && !isPersistenceOffer) {
    throw buildAnswerStateValidationError(
      'Invalid answer state: completed broad answers in this family must offer persistence.',
      retryInstruction,
    );
  }

  return {
    knowledgeMode,
    isPermissionToBroadenRequest,
    isPersistenceOffer,
    explanation,
  };
}

export function parseStructuredAnswerStateResponse(
  response,
  {
    allowBroadMode = true,
    allowPersistence = true,
    requirePersistenceOfferForBroad = false,
  } = {},
) {
  const rawText = String(response?.output_text ?? '').trim();

  if (!rawText) {
    throw new Error('The model returned an empty final response.');
  }

  let parsedResponse;
  const jsonText = extractJsonObjectText(rawText);

  try {
    parsedResponse = JSON.parse(jsonText);
  } catch {
    throw new Error('The final response was not valid JSON.');
  }

  const answer = String(parsedResponse?.answer ?? '').trim();

  if (!answer) {
    throw new Error('The final response did not include a non-empty answer.');
  }

  const validatedState = validateReportedAnswerState(parsedResponse, {
    allowBroadMode,
    allowPersistence,
    requirePersistenceOfferForBroad,
  });

  return {
    answer,
    ...validatedState,
  };
}

export function buildStructuredAnswerStateFinalResponseValidator({
  allowBroadMode = true,
  allowPersistence = true,
  requirePersistenceOfferForBroad = false,
} = {}) {
  const retryInstruction = buildStructuredResponseRetryInstruction({
    allowBroadMode,
    allowPersistence,
    requirePersistenceOfferForBroad,
  });

  return async ({ response }) => {
    try {
      parseStructuredAnswerStateResponse({
        ...response,
      }, {
        allowBroadMode,
        allowPersistence,
        requirePersistenceOfferForBroad,
      });
      return null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'The final response was invalid.';

      return `${errorMessage} Retry by returning valid JSON only. ${retryInstruction}`;
    }
  };
}