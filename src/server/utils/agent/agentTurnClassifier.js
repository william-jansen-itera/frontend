import { getRequiredFoundryConfig } from '@/server/utils/foundryAgentClient';
import {
  captureTimingEntry,
  serializeDebugValue,
} from '@/server/utils/agent/agentDebug';
import {
  getAgentToolResultData,
  getAgentToolResultMeta,
} from '@/server/utils/agent/agentToolResult';

export const TURN_TYPE_DEFAULT = 'default';
export const TURN_TYPE_NO_RESULT_OFFER = 'no_result_offer_broadening';
export const TURN_TYPE_BROADER_ANSWER = 'broader_answer';
export const FOLLOW_UP_OPTION_BROADER_ANSWER = 'broader_answer';

const ENABLE_PERMISSION_TO_BROADER_MODEL_REVIEW = true;

const GROUNDED_RESPONSE_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    isRequestPermission: {
      type: 'boolean',
    },
  },
  required: ['isRequestPermission'],
  additionalProperties: false,
};

const BROADENING_PATTERNS = [
  /\b(?:background|prior|pre[- ]existing|preexisting|pretrained|pre[- ]trained|training|trained|parametric|internal|built[- ]in|innate|world|common|general|public|publicly available)\s+(?:background\s+)?(?:knowledge|information|understanding|explanation|answer|references?|sources?|data)\b/,
  /\b(?:my|the model's|the model(?:'s)?)\s+(?:own\s+)?(?:knowledge|training(?: data)?|trained knowledge|internal knowledge|parametric knowledge|model weights)\b/,
  /\b(?:from|using|use|rely on|relying on|draw on|drawing on|fall back to|fallback to|switch to|answer from|answering from|based on)\s+(?:my\s+)?(?:own\s+)?(?:background|general|prior|training|pretrained|pre[- ]trained|internal|parametric|world|common)\s+(?:knowledge|understanding|information|data)\b/,
  /\bwhat I (?:already know|was trained on|learned during training|know generally)\b/,
  /\b(?:from|in) my (?:training data|memory|model weights)\b/,
  /\bwithout (?:using |relying on )?(?:the )?(?:provided|retrieved|available|current)\s+(?:context|documents?|sources?|materials?|tools?|knowledge base)\b/,
  /\b(?:beyond|outside|look beyond|go beyond|outside of)\s+(?:the )?(?:provided|retrieved|available|current|given)\s+(?:context|documents?|sources?|materials?|tools?|knowledge base|corpus)\b/,
  /\banswer without (?:the )?(?:retrieved |provided )?(?:sources?|documents?|context|tools?)\b/,
  /\b(?:broad(?:er)?|wide(?:r)?|expand(?:ed|ing)?|widen(?:ed|ing)?|extensive|comprehensive|unrestricted|open[- ]ended)\s+(?:search|scope|answer|query|information|resources?)\b/,
  /\b(?:broaden|widen|expand|relax)\s+(?:the\s+)?(?:search|scope|query|constraints?)\b/,
  /\b(?:search|look|answer|check|consult)\s+more\s+(?:broadly|widely|extensively|comprehensively)\b/,
  /\b(?:search|look(?: this up)?|check)\s+(?:the\s+)?(?:web|internet|online)\b/,
  /\b(?:web|internet|online)\s+search\b/,
  /\b(?:external|public|outside|third[- ]party|open(?:\s+web)?)\s+(?:knowledge|sources?|resources?|information|references?|tools?)\b/,
  /\b(?:consult|use|include|check|look at|look up)\s+(?:external|public|broader|wider|additional|outside)\s+(?:sources?|resources?|knowledge|information|references?)\b/,
  /\blook beyond the current tools\b/,
  /\boutside the available tools\b/,
  /\bcast a wider net\b/,
  /\bswitch to broader knowledge\b/,
  /(?:\bbaggrundsviden\b|\b(?:generel|almindelig|intern|parametrisk|offentlig|offentligt tilgængelig)\s+(?:viden|information|forståelse|forklaring|svar|kilder?|data)\b)/,
  /\b(?:min|modellens|modellens egen)\s+(?:egen\s+)?(?:viden|træningsdata|trænet viden|interne viden|parametriske viden|modelvægte)\b/,
  /\b(?:fra|ved brug af|bruge|støtte mig til|basere svaret på|svare fra|skifte til)\s+(?:min\s+)?(?:egen\s+)?(?:baggrunds|generel|intern|parametrisk|trænings|offentlig)\s+(?:viden|forståelse|information|data)\b/,
  /\bhvad jeg (?:allerede ved|blev trænet på|ved generelt)\b/,
  /\b(?:fra|i) mine? (?:træningsdata|modelvægte)\b/,
  /\buden at (?:bruge|støtte sig til) (?:de )?(?:givne|fundne|tilgængelige|aktuelle)\s+(?:kilder|dokumenter|kontekst|materialer|værktøjer|vidensbase)\b/,
  /\b(?:ud over|uden for|gå ud over|se ud over) (?:den )?(?:givne|fundne|tilgængelige|aktuelle)\s+(?:kontekst|dokumenter|kilder|materialer|værktøjer|vidensbase|korpus)\b/,
  /\bsvare uden (?:de )?(?:fundne |givne )?(?:kilder|dokumenter|kontekst|værktøjer)\b/,
  /\b(?:bredere|videre|udvidet|omfattende|uindskrænket|åbent)\s+(?:søgning|scope|svar|forespørgsel|information|ressourcer)\b/,
  /\b(?:udvide|gøre bredere|gøre videre|slække på)\s+(?:søgn(?:ingen)?|scope|forespørgslen|begrænsningerne)\b/,
  /\b(?:søge|kigge|svare|tjekke|undersøge)\s+mere\s+(?:bredt|vidt|omfattende)\b/,
  /\b(?:søger|kigger|svarer|tjekker|undersøger)\s+(?:mere\s+)?(?:bredt|bredere|vidt|omfattende)\b/,
  /\b(?:søge|slå op|tjekke)\s+(?:på )?(?:webben|internettet|nettet|online)\b/,
  /\b(?:web|internet|nettet|online)\s+søgning\b/,
  /\b(?:eksterne|offentlige|udenforstående|tredjeparts|åbne)\s+(?:kilder|ressourcer|viden|information|referencer|værktøjer)\b/,
  /\b(?:bruge|inddrage|tjekke|kigge på|slå op i)\s+(?:eksterne|offentlige|bredere|yderligere|udenforstående)\s+(?:kilder|ressourcer|viden|information|referencer)\b/,
  /\bse ud over de nuværende værktøjer\b/,
  /\buden for de tilgængelige værktøjer\b/,
  /\bkaste et bredere net\b/,
  /\bskift(?:e|er) til baggrundsviden\b/,
].map((pattern) => new RegExp(pattern, 'i'));

const CONSENT_ASK_PATTERNS = [
  /\bshould I\b/,
  /\bshall I\b/,
  /\bmay I\b/,
  /\bcan I\b/,
  /\bcould I\b/,
  /\bdo you want(?: me to)?\b/,
  /\bwould you like(?: me to)?\b/,
  /\bwould you prefer(?: (?:me|that I) to)?\b/,
  /\bwant me to\b/,
  /\bwould you rather I\b/,
  /\bdo you want me to (?:go ahead|proceed|continue)\b/,
  /\bis it okay if I\b/,
  /\bis that okay\b/,
  /\bis that alright\b/,
  /\bare you okay with\b/,
  /\bare you alright with\b/,
  /\bdo I have your (?:permission|consent|go[- ]ahead)\b/,
  /\bwith your (?:permission|consent|approval|go[- ]ahead)\b/,
  /\bif you (?:consent|approve|agree|allow it|give the go[- ]ahead)\b/,
  /\bif that(?:'s| is) (?:okay|alright|all right|fine|acceptable)\b/,
  /\bplease confirm\b/,
  /\bplease (?:let me know|tell me) (?:if|whether)\b/,
  /\bok(?:ay)? to proceed\b/,
  /\bokay if I\b/,
  /\bmind if I\b/,
  /\blet me know if\b/,
  /\blet me know whether\b/,
  /\btell me if\b/,
  /\btell me whether\b/,
  /\bif you(?:'d| would)? like\b/,
  /\bif you want\b/,
  /\bif you'd prefer\b/,
  /\bif you need me to\b/,
  /\bjust say the word\b/,
  /\bsay the word\b/,
  /\bgive me the go[- ]ahead\b/,
  /\bhappy to .{0,80}\bif you(?:'d| would)? like\b/,
  /\bI can .{0,80}\bif you(?:'d| would)? like\b/,
  /\bI could .{0,80}\bif you(?:'d| would)? like\b/,
  /\bwould that be (?:okay|alright|helpful|useful)\b/,
  /\bshall I (?:proceed|continue|go ahead)\b/,
  /\bskal jeg\b/,
  /\bmå jeg\b/,
  /\bkan jeg\b/,
  /\bkunne jeg\b/,
  /\bvil du\b/,
  /\bvil du have(?:,?\s+at jeg)?\b/,
  /\bvil du gerne have(?:,?\s+at jeg)?\b/,
  /(?:^|[\s([{"'“”‘’])ønsker du(?:,?\s+at jeg)?(?=$|[\s,.;:!?])/,
  /\bforetrækker du(?:,?\s+at jeg)?\b/,
  /\bvil du hellere have,?\s+at jeg\b/,
  /\bvil du have mig til at (?:gå videre|fortsætte|fortsætte med det)\b/,
  /\ber det okay hvis jeg\b/,
  /\ber det i orden hvis jeg\b/,
  /\ber det fint hvis jeg\b/,
  /\ber du okay med\b/,
  /\ber du med på\b/,
  /\bhar jeg din(?:t)? (?:samtykke|godkendelse|go[- ]ahead|grønt lys)\b/,
  /\bmed din(?:t)? (?:samtykke|godkendelse|go[- ]ahead|grønt lys)\b/,
  /\bhvis du (?:samtykker|godkender|er enig|giver grønt lys)\b/,
  /\bhvis det er (?:okay|i orden|fint|acceptabelt)\b/,
  /\bvenligst bekræfte\b/,
  /\blad mig vide (?:om|hvis)\b/,
  /\ber det okay at fortsætte\b/,
  /\bokay hvis jeg\b/,
  /\bhvis du vil\b/,
  /\bhvis du gerne vil\b/,
  /\bhvis du foretrækker det\b/,
  /\bhvis du har brug for at jeg\b/,
  /\bsige til\b/,
  /\bgive mig grønt lys\b/,
  /\bdet gør jeg gerne .{0,80}\bhvis du (?:vil|gerne vil)\b/,
  /\bjeg kan .{0,80}\bhvis du (?:vil|gerne vil)\b/,
  /\bjeg kunne .{0,80}\bhvis du (?:vil|gerne vil)\b/,
  /\bville det være (?:okay|i orden|hjælpsomt|nyttigt)\b/,
  /\bskal jeg (?:fortsætte|gå videre)\b/,
].map((pattern) => new RegExp(pattern, 'i'));

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function extractAnswerText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const textOutput = Array.isArray(response?.output)
    ? response.output.find((item) => item?.type === 'message' && Array.isArray(item.content))
    : null;

  if (!textOutput) {
    return '';
  }

  return textOutput.content
    .filter((item) => item?.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

function getToolInvocationResultCount(invocation) {
  const metaResultCount = Number(getAgentToolResultMeta(invocation?.output)?.resultCount);

  if (Number.isFinite(metaResultCount)) {
    return metaResultCount;
  }

  const toolData = getAgentToolResultData(invocation?.output);

  if (Number.isFinite(Number(toolData?.count))) {
    return Number(toolData.count);
  }

  if (Array.isArray(toolData?.priceHistory)) {
    return toolData.priceHistory.length;
  }

  return toolData ? 1 : 0;
}

function buildResponseToolInvocations(toolInvocations) {
  return toolInvocations.map((invocation) => ({
    toolName: invocation.toolName,
    arguments: invocation.arguments,
    resultCount: getToolInvocationResultCount(invocation),
  }));
}

function buildPriorToolInvocations(normalizedFollowUpSelection) {
  return Array.isArray(normalizedFollowUpSelection?.sourceToolInvocations)
    ? normalizedFollowUpSelection.sourceToolInvocations.map((invocation) => ({
      toolName: invocation.toolName,
      arguments: '{}',
      resultCount: Number(invocation?.resultCount ?? 0),
    }))
    : [];
}

function hasToolResults(toolInvocations) {
  return Array.isArray(toolInvocations)
    && toolInvocations.some((invocation) => getToolInvocationResultCount(invocation) > 0);
}

function mentionsBroadening(answer) {
  const normalizedAnswer = normalizeWhitespace(answer);

  if (!normalizedAnswer) {
    return false;
  }

  return BROADENING_PATTERNS.some((pattern) => pattern.test(normalizedAnswer));
}

function mentionsPermission(answer) {
  const normalizedAnswer = normalizeWhitespace(answer);

  if (!normalizedAnswer) {
    return false;
  }

  return CONSENT_ASK_PATTERNS.some((pattern) => pattern.test(normalizedAnswer));
}

function getFollowUpOptionLabel(optionId) {
  if (optionId === FOLLOW_UP_OPTION_BROADER_ANSWER) {
    return 'Answer more broadly';
  }

  return '';
}

function buildBroaderAnswerOption() {
  return [
    {
      optionId: FOLLOW_UP_OPTION_BROADER_ANSWER,
      label: getFollowUpOptionLabel(FOLLOW_UP_OPTION_BROADER_ANSWER),
    },
  ];
}

async function reviewIsPermissionToBroadenResponse({ openAIClient, userMessage, assistantAnswer }) {
  const { modelDeploymentName } = getRequiredFoundryConfig();
  const response = await openAIClient.responses.create({
    model: modelDeploymentName,
    input: [
      {
        type: 'message',
        role: 'system',
        content: [
          'You are reviewing an assistant response from a grounded tool workflow.',
          'Determine whether the assistant response is a request-permission message.',
          'Return isRequestPermission=true only when the assistant is asking whether to broaden the search or provide a general background explanation without already answering from background knowledge.',
          'This includes cases where no grounded tool path was established and cases where grounded results were returned but did not meaningfully answer the question.',
          'Return isRequestPermission=false for clarification questions, grounded answers, or background-knowledge answers.',
          'Return JSON only.',
        ].join(' '),
      },
      {
        type: 'message',
        role: 'user',
        content: JSON.stringify({
          userMessage,
          assistantAnswer,
        }),
      },
    ],
    text: {
      verbosity: 'medium',
      format: {
        type: 'json_schema',
        name: 'grounded_response_review',
        strict: true,
        schema: GROUNDED_RESPONSE_REVIEW_SCHEMA,
      },
    },
  });

  const rawText = normalizeWhitespace(response?.output_text ?? '');

  if (!rawText) {
    throw new Error('Model returned an empty response.');
  }

  let parsedResponse;

  try {
    parsedResponse = JSON.parse(rawText);
  } catch {
    throw new Error('Model response was not valid JSON.');
  }

  if (typeof parsedResponse?.isRequestPermission !== 'boolean') {
    throw new Error('Grounded response review returned an invalid payload.');
  }

  return {
    isRequestPermission: parsedResponse.isRequestPermission,
    raw: parsedResponse,
  };
}

async function isPermissionToBroadenAnswer({
  toolInvocations,
  answer,
  openAIClient,
  userMessage,
  groundedResponseReviewSteps,
  debugTiming = null,
}) {
  const hasAnyToolInvocations = Array.isArray(toolInvocations) && toolInvocations.length > 0;
  const hasAnyToolResults = hasToolResults(toolInvocations);
  const shouldOfferBroaderAnswerFromEmptyToolResults = hasAnyToolInvocations && !hasAnyToolResults;

  if (shouldOfferBroaderAnswerFromEmptyToolResults) {
    return {
      matches: true,
      source: 'result_count',
    };
  }

  if (!mentionsBroadening(answer)) {
    return {
      matches: false,
      source: null,
    };
  }

  if (mentionsPermission(answer)) {
    return {
      matches: true,
      source: 'regex',
    };
  }

  if (!(ENABLE_PERMISSION_TO_BROADER_MODEL_REVIEW && Boolean(answer))) {
    return {
      matches: false,
      source: null,
    };
  }

  const reviewStartedAt = new Date().toISOString();
  const reviewStartedAtMs = Date.now();
  const groundedResponseReview = await reviewIsPermissionToBroadenResponse({
    openAIClient,
    userMessage,
    assistantAnswer: answer,
  });

  if (debugTiming && typeof debugTiming === 'object') {
    debugTiming.startedAt = reviewStartedAt;
    debugTiming.completedAt = new Date().toISOString();
    debugTiming.durationMs = Date.now() - reviewStartedAtMs;
    debugTiming.executed = true;
  }

  if (Array.isArray(groundedResponseReviewSteps)) {
    groundedResponseReviewSteps.push(groundedResponseReview.raw);
  }

  return {
    matches: Boolean(groundedResponseReview.isRequestPermission),
    source: groundedResponseReview.isRequestPermission ? 'model_review' : null,
  };
}

export function normalizeFollowUpSelection(selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    return null;
  }

  const optionId = String(selection.optionId ?? '').trim();
  const sourceTurnId = String(selection.sourceTurnId ?? '').trim();
  const sourceQuestion = String(selection.sourceQuestion ?? '').trim();
  const sourceToolInvocations = Array.isArray(selection.sourceToolInvocations)
    ? selection.sourceToolInvocations
      .map((invocation) => ({
        toolName: String(invocation?.toolName ?? '').trim(),
        resultCount: Number(invocation?.resultCount ?? 0),
      }))
      .filter((invocation) => invocation.toolName)
    : [];

  if (!optionId || !sourceTurnId || optionId !== FOLLOW_UP_OPTION_BROADER_ANSWER) {
    return null;
  }

  return {
    optionId,
    sourceTurnId,
    sourceQuestion,
    sourceToolInvocations,
  };
}

export async function classifyAgentTurn({
  finalResponse,
  finalToolInvocations,
  normalizedFollowUpSelection,
  openAIClient,
  normalizedMessage,
  debug = null,
}) {
  const answer = extractAnswerText(finalResponse);
  const groundedResponseReviewSteps = [];
  const permissionToBroadenDetection = await captureTimingEntry(
    debug?.timings?.broaderAnswerDetection ?? null,
    async () => isPermissionToBroadenAnswer({
      toolInvocations: finalToolInvocations,
      answer,
      openAIClient,
      userMessage: normalizedMessage,
      groundedResponseReviewSteps,
      debugTiming: debug?.timings?.broaderAnswerReview ?? null,
    }),
  );
  const followUpOptions = permissionToBroadenDetection.matches
    ? buildBroaderAnswerOption()
    : [];
  const responseToolInvocations = buildResponseToolInvocations(finalToolInvocations);
  const priorToolInvocations = buildPriorToolInvocations(normalizedFollowUpSelection);
  const staysInBroaderLane = normalizedFollowUpSelection?.optionId === FOLLOW_UP_OPTION_BROADER_ANSWER
    && responseToolInvocations.length === 0;
  const turnType = staysInBroaderLane
    ? TURN_TYPE_BROADER_ANSWER
    : followUpOptions.length > 0
      ? TURN_TYPE_NO_RESULT_OFFER
      : TURN_TYPE_DEFAULT;
  const usedBroaderKnowledge = turnType === TURN_TYPE_BROADER_ANSWER;
  const isGrounded = !usedBroaderKnowledge;

  if (debug) {
    debug.turnClassification = serializeDebugValue({
      turnType,
      isGrounded,
      usedBroaderKnowledge,
      permissionToBroadenDetection,
      groundedResponseReview: groundedResponseReviewSteps,
      responseToolInvocations,
      priorToolInvocations,
    });
  }

  return {
    answer,
    turnType,
    isGrounded,
    usedBroaderKnowledge,
    permissionToBroadenDetection,
    groundedResponseReviewSteps,
    followUpOptions,
    responseToolInvocations,
    priorToolInvocations,
  };
}
