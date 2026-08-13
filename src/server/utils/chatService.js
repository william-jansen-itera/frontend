import { AIProjectClient } from '@azure/ai-projects';
import { DefaultAzureCredential } from '@azure/identity';
import { DEFAULT_TOOL_TOP, searchTreeContent } from '@/server/utils/azureSearch';
import { getAllowedTreeIds, getTreeRoutingProfiles } from '@/server/utils/treeCatalog';

const DEFAULT_AGENT_NAME = 'tree-search-agent';
const DEFAULT_HISTORY_LIMIT = 8;
const MAX_TOOL_ROUNDS = 5;
const AGENT_PREVIEW_FEATURES = 'WorkflowAgents=V1Preview';

let cachedProjectClient;

function getRequiredFoundryConfig() {
  const projectEndpoint = process.env.AZURE_AI_PROJECT_ENDPOINT;
  const modelDeploymentName = process.env.AZURE_AI_MODEL_DEPLOYMENT_NAME;
  const agentName = process.env.AZURE_AI_AGENT_NAME || DEFAULT_AGENT_NAME;

  if (!projectEndpoint) {
    throw new Error('AZURE_AI_PROJECT_ENDPOINT env var is not configured');
  }

  if (!modelDeploymentName) {
    throw new Error('AZURE_AI_MODEL_DEPLOYMENT_NAME env var is not configured');
  }

  return {
    projectEndpoint,
    modelDeploymentName,
    agentName,
  };
}

function getProjectClient() {
  if (!cachedProjectClient) {
    const { projectEndpoint } = getRequiredFoundryConfig();
    cachedProjectClient = new AIProjectClient(projectEndpoint, new DefaultAzureCredential());
  }

  return cachedProjectClient;
}

function slugifyToolSegment(value, fallbackValue) {
  const normalizedValue = String(value || fallbackValue || 'tree')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);

  return normalizedValue || String(fallbackValue || 'tree');
}

function buildToolName(tree) {
  const suffix = slugifyToolSegment(tree.name, tree.id);
  return `search_tree_${suffix}_${tree.id}`;
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .slice(-DEFAULT_HISTORY_LIMIT)
    .map((entry) => {
      const role = entry?.role === 'assistant' ? 'assistant' : 'user';
      const content = String(entry?.content ?? '').trim();

      if (!content) {
        return null;
      }

      return {
        type: 'message',
        role,
        content,
      };
    })
    .filter(Boolean);
}

function normalizeToolTop(value) {
  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_TOOL_TOP;
  }

  return Math.min(parsedValue, DEFAULT_TOOL_TOP);
}

function formatTopicList(values) {
  const topics = Array.from(new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean)));

  return topics;
}

function joinTopicList(values) {
  if (values.length === 0) {
    return '';
  }

  if (values.length === 1) {
    return values[0];
  }

  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }

  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

function buildDescriptionPromptTree(tree) {
  return {
    treeName: tree.name,
    nonLeafTitles: tree.nonLeafTitles ?? [],
    leafTitleExemplars: tree.leafTitleExemplars ?? [],
    breadcrumbExemplars: tree.breadcrumbExemplars ?? [],
    attachmentFileNameExemplars: tree.attachmentFileNameExemplars ?? [],
  };
}

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function sanitizeGeneratedSummary(summary) {
  const normalizedSummary = normalizeWhitespace(summary)
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[.\s]+$/, '');

  if (!normalizedSummary) {
    return '';
  }

  return normalizedSummary ? `${normalizedSummary}.` : '';
}

function buildAiToolDescription(tree, summary, focusTopics) {
  if (!summary) {
    return null;
  }

  const keywordTopics = Array.isArray(focusTopics) ? formatTopicList(focusTopics) : [];
  const keywordText = joinTopicList(keywordTopics);

  return [
    `Use this tool for ${tree.name}.`,
    summary,
    keywordText ? `Best for questions about ${keywordText}.` : null,
  ].filter(Boolean).join(' ');
}

function parseDescriptionResponse(response) {
  const rawText = normalizeWhitespace(response?.output_text ?? '');

  if (!rawText) {
    return {
      rawText,
      parsed: null,
      error: 'Model returned an empty response.',
    };
  }

  try {
    return {
      rawText,
      parsed: JSON.parse(rawText),
      error: null,
    };
  } catch {
    return {
      rawText,
      parsed: null,
      error: 'Model response was not valid JSON.',
    };
  }
}

async function generateAiDescription(tree) {
  const project = getProjectClient();
  const openAIClient = project.getOpenAIClient();
  const { modelDeploymentName } = getRequiredFoundryConfig();
  const aiInput = buildDescriptionPromptTree(tree);
  const response = await openAIClient.responses.create({
    model: modelDeploymentName,
    input: [
      {
        type: 'message',
        role: 'system',
        content: [
          'You are generating one routing description for one search tool in a tree-based knowledge application.',
          'Your goal is to help another agent choose the correct tool for a user message.',
          'Write a short, discriminative summary of what this tool should be used for.',
          'Use nonLeafTitles to infer broad topic areas and use leafTitleExemplars, breadcrumbExemplars, and meaningful attachmentFileNameExemplars to infer concrete coverage.',
          'Prioritize distinguishing topics over generic organizational labels.',
          'Do not mention internal implementation details, API mechanics, or debugging metadata.',
          'Do not write a detailed article summary; optimize for routing usefulness and information density.',
          'If the evidence shows another distinct topic area that broadens what this tool should be used for, mention that area briefly in the summary.',
          'Return structured output only for this one tree with fields summary and focusTopics.',
          'The summary should be one concise sentence.',
          'The focusTopics field should list short topics that help identify when this tool is relevant.',
        ].join(' '),
      },
      {
        type: 'message',
        role: 'user',
        content: JSON.stringify(aiInput),
      },
    ],
    text: {
      verbosity: 'medium',
      format: {
        type: 'json_schema',
        name: 'tree_tool_description',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
            },
            focusTopics: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
          },
          required: ['summary', 'focusTopics'],
          additionalProperties: false,
        },
      },
    },
  });

  return {
    aiInput,
    response,
    parsedResponse: parseDescriptionResponse(response),
  };
}

async function applyToolDescriptions(treeList) {
  treeList.forEach((tree) => {
    tree.generatedToolDescription = null;
    tree.descriptionSource = 'pending';
    tree.includedInToolSet = false;
    tree.generationFailureReason = null;
    tree.aiInput = null;
    tree.aiModelOutput = null;
    tree.aiGeneratedSummary = null;
    tree.aiSelectedFocusTopics = [];
  });

  for (const tree of treeList) {
    try {
      const { aiInput, parsedResponse } = await generateAiDescription(tree);
      tree.aiInput = aiInput;
      tree.aiModelOutput = parsedResponse.parsed ?? parsedResponse.rawText;

      if (parsedResponse.error) {
        tree.descriptionSource = 'generation-failed';
        tree.generationFailureReason = parsedResponse.error;
        continue;
      }

      const generatedSummary = sanitizeGeneratedSummary(parsedResponse.parsed?.summary);

      if (!generatedSummary) {
        tree.descriptionSource = 'generation-failed';
        tree.generationFailureReason = 'Model response did not include a usable summary.';
        continue;
      }

      const generatedFocusTopics = Array.isArray(parsedResponse.parsed?.focusTopics)
        ? formatTopicList(parsedResponse.parsed.focusTopics)
        : [];
      const generatedDescription = buildAiToolDescription(
        tree,
        generatedSummary,
        generatedFocusTopics,
      );

      if (!generatedDescription) {
        tree.descriptionSource = 'generation-failed';
        tree.generationFailureReason = 'Model response could not be assembled into a tool description.';
        continue;
      }

      tree.generatedToolDescription = generatedDescription;
      tree.descriptionSource = 'ai';
      tree.aiGeneratedSummary = generatedSummary;
      tree.aiSelectedFocusTopics = generatedFocusTopics;
      tree.includedInToolSet = true;
    } catch (error) {
      tree.descriptionSource = 'generation-failed';
      tree.generationFailureReason = error instanceof Error ? error.message : 'Model generation failed.';
    }
  }
}

function buildAgentInstructions() {
  return [
    'You are an assistant for a tree-based knowledge application.',
    'Use the provided tools to find relevant information.',
    'Ask a brief clarification question when multiple tools may fit.',
    'Ground answers in tool results and say when no relevant result was found.',
    'If no relevant result was found, do not provide uncited background knowledge immediately. First say that no relevant result was found and ask whether the user wants a broader search or a general background answer.',
    'Answer concisely in one short paragraph unless the user asks for more detail.',
    'When the user asks a targeted follow-up question or explicitly asks for more detail, answer more fully and focus on the specific aspect they asked about with as much details as possible.',
    'Tool results include curated evidenceItems with source-labeled text. Prefer notes first. For attachment evidence, prefer fileContent, then ocrText, then imageDescriptionFiltered when grounding your answer.',
    'ocrText and imageDescriptionFiltered may be noisy or not written as natural language, but they can still contain important facts and domain terminology.',
    'When ocrText or imageDescriptionFiltered contains relevant facts, specific terms, labels, measurements, or technical language that fit the overall evidence, preserve and use those details in natural language.',
    'Do not force every ocrText or imageDescriptionFiltered fragment into the answer, and do not add unsupported facts when rewriting noisy text.',
    'Do not invent documents, notes, filenames, or paths that were not returned by the tools.',
  ].join('\n\n');
}

function buildToolDefinition(tree) {
  return {
    type: 'function',
    name: buildToolName(tree),
    description: tree.generatedToolDescription,
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: `Search phrase for the ${tree.name} tree.`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };
}

function getUsableEvidenceText(value) {
  const normalizedText = normalizeWhitespace(value);

  return normalizedText || null;
}

function buildNodeEvidenceItem(nodeDocument) {
  const notes = getUsableEvidenceText(nodeDocument?.notes);

  if (!notes) {
    return null;
  }

  return {
    kind: 'node',
    source: 'notes',
    text: notes,
  };
}

function buildAttachmentEvidenceItems(attachmentDocument) {
  const content = getUsableEvidenceText(attachmentDocument?.content);
  const ocrText = getUsableEvidenceText(attachmentDocument?.ocrText);
  const filteredImageDescription = getUsableEvidenceText(attachmentDocument?.imageDescriptionFiltered);
  const baseAttachment = {
    kind: 'attachment',
    fileName: attachmentDocument?.attachmentFileName || 'Attachment',
    blobName: attachmentDocument?.blobName || null,
    blobUrl: attachmentDocument?.blobUrl || null,
  };

  return [
    content
      ? {
        ...baseAttachment,
        source: 'fileContent',
        text: content,
      }
      : null,
    ocrText
      ? {
        ...baseAttachment,
        source: 'ocrText',
        text: ocrText,
      }
      : null,
    filteredImageDescription
      ? {
        ...baseAttachment,
        source: 'imageDescriptionFiltered',
        text: filteredImageDescription,
      }
      : null,
  ].filter(Boolean);
}

function buildAgentSearchResult(rawResult) {
  const results = (rawResult?.results ?? []).map((entry) => {
    const nodeEvidenceItem = buildNodeEvidenceItem(entry?.nodeDocument);
    const attachmentEvidenceItems = (entry?.attachmentDocuments ?? [])
      .flatMap((attachmentDocument) => buildAttachmentEvidenceItems(attachmentDocument));
    const evidenceItems = [nodeEvidenceItem, ...attachmentEvidenceItems].filter(Boolean);

    if (evidenceItems.length === 0) {
      return null;
    }

    return {
      treeId: entry.treeId,
      nodeId: entry.nodeId,
      title: entry.title,
      breadcrumb: entry.breadcrumb,
      nodeIdPath: entry.nodeIdPath,
      treeDisplayName: entry.treeDisplayName,
      matchSummary: entry.nodeHighlight
        || entry.attachmentSummaries?.find((attachment) => normalizeWhitespace(attachment?.summary))?.summary
        || null,
      evidenceItems,
      attachmentFileNames: attachmentEvidenceItems.map((item) => item.fileName),
    };
  }).filter(Boolean);

  return {
    count: results.length,
    results,
  };
}

function buildCitationEntries(result, toolName) {
  return (result?.results ?? []).map((entry) => ({
    toolName,
    treeId: entry.treeId,
    nodeId: entry.nodeId,
    title: entry.title,
    breadcrumb: entry.breadcrumb,
    nodeIdPath: entry.nodeIdPath,
    treeDisplayName: entry.treeDisplayName,
    attachmentFileNames: entry.attachmentFileNames ?? [],
  }));
}

function dedupeCitations(citations) {
  const citationsByKey = new Map();

  citations.forEach((citation) => {
    const key = `${citation.treeId}::${citation.nodeId}::${citation.toolName}`;

    if (!citationsByKey.has(key)) {
      citationsByKey.set(key, citation);
    }
  });

  return Array.from(citationsByKey.values());
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

  const contentText = textOutput.content
    .filter((item) => item?.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n\n');

  return contentText;
}

function serializeDebugValue(value) {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {
      serializationError: 'Value could not be serialized for debug output.',
      valueType: typeof value,
      stringValue: String(value),
    };
  }
}

function buildResponseDebugSnapshot(response) {
  return serializeDebugValue({
    id: response?.id ?? null,
    status: response?.status ?? null,
    output_text: typeof response?.output_text === 'string' ? response.output_text : null,
    usage: response?.usage ?? null,
    error: response?.error ?? null,
    incomplete_details: response?.incomplete_details ?? null,
  });
}

function buildToolHandlerResult({ toolOutput, searchResult = null }) {
  return {
    toolOutput,
    debug: {
      searchResult,
      toolOutput,
    },
  };
}

function normalizeToolHandlerResult(result) {
  if (result && typeof result === 'object' && 'toolOutput' in result && 'debug' in result) {
    return result;
  }

  return {
    toolOutput: result,
    debug: {
      searchResult: null,
      toolOutput: result,
    },
  };
}

function attachDebugToError(error, debug) {
  const normalizedDebug = serializeDebugValue(debug);

  if (error instanceof Error) {
    error.debug = normalizedDebug;
    return error;
  }

  const wrappedError = new Error(String(error ?? 'Hosted agent request failed'));
  wrappedError.debug = normalizedDebug;
  return wrappedError;
}

function isNotFoundError(error) {
  const statusCode = error?.statusCode || error?.code;
  return statusCode === 404 || String(error?.message || '').includes('404');
}

async function buildTreeSearchContext() {
  const [treeList, allowedTreeIds] = await Promise.all([
    getTreeRoutingProfiles(),
    getAllowedTreeIds(),
  ]);
  const allowedSet = new Set(allowedTreeIds.map((treeId) => String(treeId)));
  const availableTrees = treeList
    .filter((tree) => allowedSet.has(String(tree.id)))
    .map((tree) => ({ ...tree }));

  await applyToolDescriptions(availableTrees);

  if (availableTrees.length === 0) {
    throw new Error('No trees are available for the current application');
  }

  const handlerMap = new Map();
  const includedTrees = availableTrees.filter((tree) => tree.includedInToolSet && tree.generatedToolDescription);
  const tools = includedTrees.map((tree) => {
    const toolName = buildToolName(tree);

    handlerMap.set(toolName, async ({ query, top }) => {
      const normalizedQuery = String(query ?? '').trim();

      if (!normalizedQuery) {
        return buildToolHandlerResult({
          toolOutput: {
            count: 0,
            results: [],
          },
          searchResult: {
            count: 0,
            results: [],
          },
        });
      }

      const rawResult = await searchTreeContent({
        searchText: normalizedQuery,
        treeId: String(tree.id),
        top: normalizeToolTop(top),
        allowedTreeIds: [String(tree.id)],
        defaultTop: DEFAULT_TOOL_TOP,
      });

      return buildToolHandlerResult({
        toolOutput: buildAgentSearchResult(rawResult),
        searchResult: rawResult,
      });
    });

    return buildToolDefinition(tree);
  });

  return {
    availableTrees,
    includedTrees,
    tools,
    handlerMap,
  };
}

function buildTreeToolPreview(availableTrees) {
  return availableTrees.map((tree) => ({
    name: buildToolName(tree),
    description: tree.generatedToolDescription,
    treeId: tree.id ?? null,
    treeName: tree.name ?? null,
    topLevelTopics: tree.topLevelTopics ?? [],
    supportingTopics: tree.supportingTopics ?? [],
    nonLeafTitles: tree.nonLeafTitles ?? [],
    leafTitleExemplars: tree.leafTitleExemplars ?? [],
    breadcrumbExemplars: tree.breadcrumbExemplars ?? [],
    attachmentFileNameExemplars: tree.attachmentFileNameExemplars ?? [],
    descriptionSource: tree.descriptionSource ?? 'pending',
    includedInToolSet: Boolean(tree.includedInToolSet),
    aiInput: tree.aiInput ?? null,
    aiModelOutput: tree.aiModelOutput ?? null,
    aiGeneratedSummary: tree.aiGeneratedSummary ?? null,
    aiSelectedFocusTopics: tree.aiSelectedFocusTopics ?? [],
    generationFailureReason: tree.generationFailureReason ?? null,
  }));
}

async function createOrUpdateAgent() {
  const project = getProjectClient();
  const { agentName, modelDeploymentName } = getRequiredFoundryConfig();
  const { availableTrees, includedTrees, tools } = await buildTreeSearchContext();
  const definition = {
    kind: 'prompt',
    model: modelDeploymentName,
    instructions: buildAgentInstructions(),
    tools,
  };

  try {
    const agent = await project.agents.update(agentName, definition, {
      foundryFeatures: AGENT_PREVIEW_FEATURES,
    });

    return {
      agent,
      availableTrees,
      includedTrees,
      tools,
    };
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    const agent = await project.agents.create(agentName, definition, {
      foundryFeatures: AGENT_PREVIEW_FEATURES,
    });

    return {
      agent,
      availableTrees,
      includedTrees,
      tools,
    };
  }
}

async function getHostedAgent() {
  const project = getProjectClient();
  const { agentName } = getRequiredFoundryConfig();

  try {
    return await project.agents.get(agentName, {
      foundryFeatures: AGENT_PREVIEW_FEATURES,
    });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    throw new Error(
      `Foundry agent "${agentName}" was not found. Run the dedicated agent sync flow before calling /api/chat.`,
    );
  }
}

export async function syncHostedAgent() {
  const syncResult = await createOrUpdateAgent();

  return {
    agent: syncResult.agent,
    tools: buildTreeToolPreview(syncResult.availableTrees),
  };
}

async function createAgentResponse(openAIClient, agentName, payload) {
  return openAIClient.responses.create(payload, {
    body: {
      agent: {
        name: agentName,
        type: 'agent_reference',
      },
    },
  });
}

async function runToolLoop({ response, openAIClient, agentName, handlerMap, debugRounds }) {
  const toolInvocations = [];
  let currentResponse = response;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const functionCalls = Array.isArray(currentResponse?.output)
      ? currentResponse.output.filter((item) => item?.type === 'function_call')
      : [];

    if (functionCalls.length === 0) {
      return {
        response: currentResponse,
        toolInvocations,
      };
    }

    const functionOutputs = [];
    const roundDebug = [];

    for (const functionCall of functionCalls) {
      const toolName = functionCall.name;
      const handler = handlerMap.get(toolName);
      let parsedArguments = null;
      let output;
      let toolDebug = {
        searchResult: null,
        toolOutput: null,
      };
      let executionError = null;

      try {
        parsedArguments = JSON.parse(functionCall.arguments || '{}');

        if (!handler) {
          output = {
            error: `No handler is registered for tool ${toolName}.`,
          };
        } else {
          const handlerResult = normalizeToolHandlerResult(await handler(parsedArguments));
          output = handlerResult.toolOutput;
          toolDebug = handlerResult.debug;
        }
      } catch (error) {
        executionError = error instanceof Error ? error.message : 'Tool execution failed';
        output = {
          error: executionError,
        };
      }

      const functionCallOutput = {
        type: 'function_call_output',
        call_id: functionCall.call_id,
        output: JSON.stringify(output),
      };

      toolInvocations.push({
        toolName,
        arguments: functionCall.arguments || '{}',
        output,
      });
      roundDebug.push({
        round: round + 1,
        callId: functionCall.call_id ?? null,
        toolName,
        parsedArguments: serializeDebugValue(parsedArguments),
        searchResult: serializeDebugValue(toolDebug.searchResult),
        toolOutput: serializeDebugValue(output),
        agentToolInput: serializeDebugValue(functionCallOutput),
        error: executionError,
      });
      functionOutputs.push(functionCallOutput);
    }

    currentResponse = await createAgentResponse(openAIClient, agentName, {
      input: functionOutputs,
      previous_response_id: currentResponse.id,
    });
    debugRounds.push(...roundDebug);
  }

  throw new Error('The hosted agent exceeded the maximum number of tool rounds');
}

export async function invokeTreeSearchAgent({ message, history = [], principal = null }) {
  const normalizedMessage = String(message ?? '').trim();

  if (!normalizedMessage) {
    throw new Error('A message is required to invoke the hosted agent');
  }

  const project = getProjectClient();
  const openAIClient = project.getOpenAIClient();
  const agent = await getHostedAgent();
  const { handlerMap } = await buildTreeSearchContext();
  const normalizedHistory = normalizeHistory(history);
  const initialInput = [
    ...normalizedHistory,
    {
      type: 'message',
      role: 'user',
      content: normalizedMessage,
    },
  ];
  const debug = {
    userQuery: {
      message: normalizedMessage,
      history: serializeDebugValue(normalizedHistory),
    },
    toolCalls: [],
    curatedAgentInput: {
      initialMessages: serializeDebugValue(initialInput),
      toolMessages: [],
    },
    agentOutput: null,
  };

  try {
    const initialResponse = await createAgentResponse(openAIClient, agent.name, {
      input: initialInput,
    });

    const { response, toolInvocations } = await runToolLoop({
      response: initialResponse,
      openAIClient,
      agentName: agent.name,
      handlerMap,
      debugRounds: debug.toolCalls,
    });
    const citations = dedupeCitations(
      toolInvocations.flatMap((invocation) => buildCitationEntries(invocation.output, invocation.toolName)),
    );
    const answer = extractAnswerText(response);

    debug.curatedAgentInput.toolMessages = serializeDebugValue(
      debug.toolCalls.map((toolCall) => toolCall.agentToolInput).filter(Boolean),
    );
    debug.agentOutput = {
      agent: {
        id: agent.id,
        name: agent.name,
        version: agent.version ?? null,
      },
      response: buildResponseDebugSnapshot(response),
      answer,
      citations: serializeDebugValue(citations),
      error: response?.error ?? null,
    };

    return {
      answer,
      agent: {
        id: agent.id,
        name: agent.name,
        version: agent.version ?? null,
      },
      toolsUsed: Array.from(new Set(toolInvocations.map((invocation) => invocation.toolName))),
      toolInvocations: toolInvocations.map((invocation) => ({
        toolName: invocation.toolName,
        arguments: invocation.arguments,
        resultCount: invocation.output?.count ?? 0,
      })),
      citations,
      principal: principal
        ? {
          userId: principal.userId ?? null,
          userDetails: principal.userDetails ?? null,
        }
        : null,
      debug,
    };
  } catch (error) {
    throw attachDebugToError(error, debug);
  }
}