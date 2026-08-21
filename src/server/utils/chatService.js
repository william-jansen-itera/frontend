import { AIProjectClient } from '@azure/ai-projects';
import { DefaultAzureCredential } from '@azure/identity';
import { DEFAULT_TOOL_TOP, searchTreeContent } from '@/server/utils/azureSearch';
import {
  getAllowedTreeIds,
  getTreeRoutingProfile,
  getTreeRoutingProfiles,
  updateTreeDescriptionPublishedStates,
  updateTreeDescriptions,
} from '@/server/utils/treeCatalog';

const DEFAULT_AGENT_NAME = 'tree-search-agent';
const DEFAULT_HISTORY_LIMIT = 8;
const MAX_TOOL_ROUNDS = 5;
const AGENT_PREVIEW_FEATURES = 'WorkflowAgents=V1Preview';
const MAX_GENERATED_ROOT_NODES = 5;
const MAX_GENERATED_CHILDREN_PER_NODE = 5;
const MAX_GENERATED_LEAF_CHILDREN_PER_NODE = 10;
const MAX_GENERATED_TITLE_LENGTH = 255;
const MAX_CHAT_LEAF_TITLE_WORDS = 8;
const MAX_GENERATED_NOTES_LENGTH = 4000;
const CHAT_LEAF_ANCHOR_SELECTION_SCHEMA = {
  type: 'object',
  properties: {
    selectionDisposition: {
      type: 'string',
      enum: ['selected_anchor', 'no_anchor'],
    },
    selectedAnchorNodeId: {
      type: 'string',
    },
    selectedBreadcrumb: {
      type: 'string',
    },
    generatedLeafTitle: {
      type: 'string',
      maxLength: MAX_GENERATED_TITLE_LENGTH,
    },
  },
  required: ['selectionDisposition', 'selectedAnchorNodeId', 'selectedBreadcrumb', 'generatedLeafTitle'],
  additionalProperties: false,
};
const TURN_TYPE_DEFAULT = 'default';
const TURN_TYPE_NO_RESULT_OFFER = 'no_result_offer';
const TURN_TYPE_BROADER_ANSWER = 'broader_answer';
const FOLLOW_UP_OPTION_BROADER_ANSWER = 'broader_answer';
const ENABLE_PERMISSION_TO_BROADER_MODEL_REVIEW = true;
const ENABLE_PERMISSION_TO_BROADER_DETECTION = true;

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

const LEAF_NODE_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_GENERATED_TITLE_LENGTH,
    },
    notes: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_GENERATED_NOTES_LENGTH,
    },
  },
  required: ['title', 'notes'],
  additionalProperties: false,
};

const LEVEL_THREE_NODE_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_GENERATED_TITLE_LENGTH,
    },
    children: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_GENERATED_LEAF_CHILDREN_PER_NODE,
      items: LEAF_NODE_SCHEMA,
    },
  },
  required: ['title', 'children'],
  additionalProperties: false,
};

const LEVEL_TWO_NODE_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_GENERATED_TITLE_LENGTH,
    },
    children: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_GENERATED_CHILDREN_PER_NODE,
      items: LEVEL_THREE_NODE_SCHEMA,
    },
  },
  required: ['title', 'children'],
  additionalProperties: false,
};

const ROOT_NODE_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_GENERATED_TITLE_LENGTH,
    },
    children: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_GENERATED_CHILDREN_PER_NODE,
      items: LEVEL_TWO_NODE_SCHEMA,
    },
  },
  required: ['title', 'children'],
  additionalProperties: false,
};

const TREE_POPULATION_SCHEMA = {
  type: 'object',
  properties: {
    nodes: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_GENERATED_ROOT_NODES,
      items: ROOT_NODE_SCHEMA,
    },
  },
  required: ['nodes'],
  additionalProperties: false,
};

const GENERATED_CHILD_NODE_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_GENERATED_TITLE_LENGTH,
    },
  },
  required: ['title'],
  additionalProperties: false,
};

function buildGeneratedChildrenSchema(maxChildren) {
  return {
    type: 'object',
    properties: {
      children: {
        type: 'array',
        minItems: 1,
        maxItems: maxChildren,
        items: GENERATED_CHILD_NODE_SCHEMA,
      },
    },
    required: ['children'],
    additionalProperties: false,
  };
}

function buildGeneratedTitleArraySchema(exactTitleCount) {
  return {
    type: 'array',
    minItems: exactTitleCount,
    maxItems: exactTitleCount,
    items: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_GENERATED_TITLE_LENGTH,
    },
  };
}

const GENERATED_NOTES_SCHEMA = {
  type: 'object',
  properties: {
    notes: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_GENERATED_NOTES_LENGTH,
    },
  },
  required: ['notes'],
  additionalProperties: false,
};

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

function parseTreePopulationResponse(response) {
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

async function reviewGroundedResponse({ openAIClient, userMessage, assistantAnswer }) {
  const { modelDeploymentName } = getRequiredFoundryConfig();
  const response = await openAIClient.responses.create({
    model: modelDeploymentName,
    input: [
      {
        type: 'message',
        role: 'system',
        content: [
          'You are reviewing an assistant response from a grounded tree-search workflow.',
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

  const parsedResponse = parseTreePopulationResponse(response);

  if (parsedResponse.error) {
    throw new Error(parsedResponse.error);
  }

  const isRequestPermission = parsedResponse.parsed?.isRequestPermission;

  if (typeof isRequestPermission !== 'boolean') {
    throw new Error('Grounded response review returned an invalid payload.');
  }

  return {
    isRequestPermission,
    raw: parsedResponse.parsed,
  };
}

function buildBroaderAnswerOption() {
  return [
    {
      optionId: FOLLOW_UP_OPTION_BROADER_ANSWER,
      label: getFollowUpOptionLabel(FOLLOW_UP_OPTION_BROADER_ANSWER),
    },
  ];
}

function normalizeGeneratedNodeTitle(value) {
  return normalizeWhitespace(value).slice(0, MAX_GENERATED_TITLE_LENGTH);
}

function countTitleWords(value) {
  return normalizeWhitespace(value).split(' ').filter(Boolean).length;
}

function normalizeGeneratedNodeNotes(value) {
  return String(value ?? '').trim().slice(0, MAX_GENERATED_NOTES_LENGTH);
}

function validateGeneratedLeafNode(node, pathLabel) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`${pathLabel} must be an object.`);
  }

  if ('children' in node) {
    throw new Error(`${pathLabel} must not include children.`);
  }

  const title = normalizeGeneratedNodeTitle(node.title);
  const notes = normalizeGeneratedNodeNotes(node.notes);

  if (!title) {
    throw new Error(`${pathLabel} must include a non-empty title.`);
  }

  if (!notes) {
    throw new Error(`${pathLabel} must include non-empty notes.`);
  }

  return {
    title,
    notes,
  };
}

function validateGeneratedLevelThreeNode(node, pathLabel) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`${pathLabel} must be an object.`);
  }

  if ('notes' in node) {
    throw new Error(`${pathLabel} must not include notes.`);
  }

  const title = normalizeGeneratedNodeTitle(node.title);
  const children = Array.isArray(node.children) ? node.children : null;

  if (!title) {
    throw new Error(`${pathLabel} must include a non-empty title.`);
  }

  if (!children || children.length === 0 || children.length > MAX_GENERATED_LEAF_CHILDREN_PER_NODE) {
    throw new Error(`${pathLabel} must include between 1 and ${MAX_GENERATED_LEAF_CHILDREN_PER_NODE} leaf children.`);
  }

  return {
    title,
    children: children.map((childNode, childIndex) => validateGeneratedLeafNode(childNode, `${pathLabel}.children[${childIndex}]`)),
  };
}

function validateGeneratedLevelTwoNode(node, pathLabel) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`${pathLabel} must be an object.`);
  }

  if ('notes' in node) {
    throw new Error(`${pathLabel} must not include notes.`);
  }

  const title = normalizeGeneratedNodeTitle(node.title);
  const children = Array.isArray(node.children) ? node.children : null;

  if (!title) {
    throw new Error(`${pathLabel} must include a non-empty title.`);
  }

  if (!children || children.length === 0 || children.length > MAX_GENERATED_CHILDREN_PER_NODE) {
    throw new Error(`${pathLabel} must include between 1 and ${MAX_GENERATED_CHILDREN_PER_NODE} structural children.`);
  }

  return {
    title,
    children: children.map((childNode, childIndex) => validateGeneratedLevelThreeNode(childNode, `${pathLabel}.children[${childIndex}]`)),
  };
}

function validateGeneratedRootNode(node, pathLabel) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`${pathLabel} must be an object.`);
  }

  if ('notes' in node) {
    throw new Error(`${pathLabel} must not include notes.`);
  }

  const title = normalizeGeneratedNodeTitle(node.title);
  const children = Array.isArray(node.children) ? node.children : null;

  if (!title) {
    throw new Error(`${pathLabel} must include a non-empty title.`);
  }

  if (!children || children.length === 0 || children.length > MAX_GENERATED_CHILDREN_PER_NODE) {
    throw new Error(`${pathLabel} must include between 1 and ${MAX_GENERATED_CHILDREN_PER_NODE} structural children.`);
  }

  return {
    title,
    children: children.map((childNode, childIndex) => validateGeneratedLevelTwoNode(childNode, `${pathLabel}.children[${childIndex}]`)),
  };
}

function countGeneratedNodes(nodes) {
  return nodes.reduce((totalCount, node) => {
    const childCount = Array.isArray(node.children) ? countGeneratedNodes(node.children) : 0;
    return totalCount + 1 + childCount;
  }, 0);
}

export function validateGeneratedTreePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Generated payload must be an object.');
  }

  const rootNodes = Array.isArray(payload.nodes) ? payload.nodes : null;

  if (!rootNodes || rootNodes.length === 0 || rootNodes.length > MAX_GENERATED_ROOT_NODES) {
    throw new Error(`Generated payload must include between 1 and ${MAX_GENERATED_ROOT_NODES} root nodes.`);
  }

  const nodes = rootNodes.map((node, nodeIndex) => validateGeneratedRootNode(node, `nodes[${nodeIndex}]`));

  return {
    nodes,
    rootNodeCount: nodes.length,
    totalNodeCount: countGeneratedNodes(nodes),
  };
}


function buildTreePopulationPrompt({ treeName, description }) {
  return [
    `Tree name: ${treeName}.`,
    'This tree has four levels: root, level-2, level-3, and level-4 leaf nodes.',
    'Follow all instruction blocks exactly as written. Do not merge, reinterpret, or generalize instructions across blocks.',

    // Corrected top-level topic rule
    'Use the stored tree description only to identify top-level topics. Top-level topics must be taken exactly as enumerated; do not reinterpret, merge, broaden, or reorganize them based on other parts of the description.',
    'During child-node generation (level-2, level-3, and leaf nodes), you may use relevant domain knowledge to expand and enrich the top-level topics, but all generated content must remain fully consistent with the ancestor chain.',

    '',
    'Extraction instruction:',
    'Extract all explicitly enumerated overall areas from the stored tree description. If the description lists N overall areas (e.g., “five overall areas: A, B, C, D, E”), extract each one as a separate top-level topic.',
    'Extract only major conceptual groups; do not infer new categories.',
    'Preserve original wording.',
    'Every extracted top-level topic must become a root node.',
    'Output a flat list of concise phrases.',

    '',
    'Root-level instruction:',
    'The number of root nodes must exactly match the number of extracted top-level topics.',
    'Do not merge or collapse topics.',
    'Each root node defines the primary semantic anchor for its entire branch.',
    'Use concise titles.',
    'Each root node must be a direct semantic parent of its level-2 children.',

    '',
    'Level-2 instruction:',
    `Generate between 1 and ${MAX_GENERATED_CHILDREN_PER_NODE} children per root node.`,
    'Each level-2 node must be a coherent subtopic of its root node and semantically derived from it.',
    'Use domain knowledge to expand the root topic into meaningful subtopics while staying fully aligned with the root.',

    '',
    'Level-3 instruction:',
    `Generate between 1 and ${MAX_GENERATED_CHILDREN_PER_NODE} children per level-2 node.`,
    'Each level-3 node must be a narrow, specific subtopic of its level-2 parent and root ancestor.',
    'Use domain knowledge to refine the level-2 topic into more specific areas that naturally support leaf-level detail.',

    '',
    'Leaf instruction:',
    `Generate between 1 and ${MAX_GENERATED_LEAF_CHILDREN_PER_NODE} leaf nodes per level-3 node.`,
    'Preferred number of leaf nodes is 5–10. Generate fewer than 5 only when the level-3 topic is genuinely narrow.',
    'Leaf nodes must be narrow, concrete, and actionable.',
    'Each leaf must be semantically derived from the entire ancestor chain (root → level-2 → level-3).',
    'Do not introduce concepts not implied by the ancestors.',
    'Use domain knowledge to produce realistic, actionable leaf-level details.',

    '',
    'General constraints:',
    'Upper levels organize the topic; leaves carry actionable detail.',
    'Do not produce duplicate sibling titles, empty categories, or structural-node notes.',
    'Do not place content intended for one level into another.',
    'All descendant nodes must reinforce the top-level topic of their branch.',
    'Use the rest of the stored tree description only to enrich and specify content without redirecting the top-level topic.',

    '',
    'Stored tree description:',
    description,
  ].filter(Boolean).join('\n');
}



async function requestGeneratedTreeNodes(tree) {
  const project = getProjectClient();
  const openAIClient = project.getOpenAIClient();
  const { modelDeploymentName } = getRequiredFoundryConfig();

  return openAIClient.responses.create({
    model: modelDeploymentName,
    input: [
      {
        type: 'message',
        role: 'system',
        content: buildTreePopulationPrompt({
          treeName: tree.name,
          description: tree.description,
        }),
      },
    ],
    text: {
      verbosity: 'medium',
      format: {
        type: 'json_schema',
        name: 'generated_tree_nodes',
        strict: true,
        schema: TREE_POPULATION_SCHEMA,
      },
    },
  });
}

export async function generateTreeNodesFromDescription(tree) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestGeneratedTreeNodes(tree);
    const parsedResponse = parseTreePopulationResponse(response);

    if (parsedResponse.error) {
      lastError = new Error(parsedResponse.error);
      continue;
    }

    try {
      return validateGeneratedTreePayload(parsedResponse.parsed);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Generated payload was invalid.');
    }
  }

  throw lastError ?? new Error('Generated payload was invalid.');
}

function buildChildNodeGenerationPrompt({ treeName, breadcrumbTitles, generateLeafChildren = false }) {
  const normalizedTreeName = normalizeWhitespace(treeName);
  const breadcrumbPath = breadcrumbTitles.map((title) => normalizeWhitespace(title)).filter(Boolean).join(' > ');
  const maxChildren = generateLeafChildren ? MAX_GENERATED_LEAF_CHILDREN_PER_NODE : MAX_GENERATED_CHILDREN_PER_NODE;

  return [
    'Generate immediate child node titles for a tree-based knowledge application.',
    'Use the tree title and breadcrumb path below as the only semantic context.',
    `Generate between 1 and ${maxChildren} immediate ${generateLeafChildren ? 'leaf ' : ''}children for the final node in the breadcrumb path.`,
    'Return valid JSON only, matching the provided schema.',
    'Each child must include title only.',
    'Do not generate grandchildren, notes, explanations, numbering, or extra properties.',
    generateLeafChildren
      ? 'Use concise, low-level, narrowly scoped titles that fit naturally as leaf topics below the final node in the breadcrumb path.'
      : 'Use concise, specific titles that fit naturally as the next structural layer below the final node in the breadcrumb path.',
    'Avoid duplicate titles within the generated output when possible.',
    '',
    'Tree title:',
    normalizedTreeName,
    '',
    'Breadcrumb path:',
    breadcrumbPath,
  ].filter(Boolean).join('\n');
}

export function validateGeneratedChildTitlePayload(payload, maxChildren = MAX_GENERATED_CHILDREN_PER_NODE) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Generated child payload must be an object.');
  }

  const children = Array.isArray(payload.children) ? payload.children : null;

  if (!children || children.length === 0 || children.length > maxChildren) {
    throw new Error(`Generated child payload must include between 1 and ${maxChildren} children.`);
  }

  return {
    children: children.map((child, childIndex) => {
      if (!child || typeof child !== 'object' || Array.isArray(child)) {
        throw new Error(`children[${childIndex}] must be an object.`);
      }

      const title = normalizeGeneratedNodeTitle(child.title);

      if (!title) {
        throw new Error(`children[${childIndex}] must include a non-empty title.`);
      }

      return { title };
    }),
  };
}

async function requestGeneratedChildTitles({ treeName, breadcrumbTitles, generateLeafChildren = false }) {
  const project = getProjectClient();
  const openAIClient = project.getOpenAIClient();
  const { modelDeploymentName } = getRequiredFoundryConfig();
  const maxChildren = generateLeafChildren ? MAX_GENERATED_LEAF_CHILDREN_PER_NODE : MAX_GENERATED_CHILDREN_PER_NODE;

  return openAIClient.responses.create({
    model: modelDeploymentName,
    input: [
      {
        type: 'message',
        role: 'system',
        content: buildChildNodeGenerationPrompt({ treeName, breadcrumbTitles, generateLeafChildren }),
      },
    ],
    text: {
      verbosity: 'medium',
      format: {
        type: 'json_schema',
        name: 'generated_child_titles',
        strict: true,
        schema: buildGeneratedChildrenSchema(maxChildren),
      },
    },
  });
}

export async function generateChildTitlesFromBreadcrumb({ treeName, breadcrumbTitles, generateLeafChildren = false }) {
  let lastError = null;
  const maxChildren = generateLeafChildren ? MAX_GENERATED_LEAF_CHILDREN_PER_NODE : MAX_GENERATED_CHILDREN_PER_NODE;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestGeneratedChildTitles({ treeName, breadcrumbTitles, generateLeafChildren });
    const parsedResponse = parseTreePopulationResponse(response);

    if (parsedResponse.error) {
      lastError = new Error(parsedResponse.error);
      continue;
    }

    try {
      return validateGeneratedChildTitlePayload(parsedResponse.parsed, maxChildren);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Generated child payload was invalid.');
    }
  }

  throw lastError ?? new Error('Generated child payload was invalid.');
}

function buildLeafNoteGenerationPrompt({ treeName, breadcrumbTitles }) {
  const normalizedTreeName = normalizeWhitespace(treeName);
  const breadcrumbPath = breadcrumbTitles.map((title) => normalizeWhitespace(title)).filter(Boolean).join(' > ');

  return [
    'Generate notes for a leaf node in a tree-based knowledge application.',
    'Use the tree title and breadcrumb path below as the only semantic context.',
    'Return valid JSON only, matching the provided schema.',
    'The notes must contain actionable detailed information and concrete facts relevant to the leaf topic.',
    'You may organize the notes into short subsections when that improves clarity, but every subsection must contain substantive content.',
    'Do not return empty structure, outline-only headings, hierarchy suggestions, placeholders, or meta commentary.',
    'Write concise but substantive notes that a user could keep as working reference material for this leaf topic.',
    'Prefer specific guidance, clear factual statements, and practical details over generic framing.',
    `Keep the notes within ${MAX_GENERATED_NOTES_LENGTH} characters.`,
    'Use a mix of short explanatory paragraphs and lists when helpful, rather than lists only.',
    'When listing steps or procedures, use numbered lists.',
    'For non-step lists such as facts, examples, warnings, options, or checklists, use bullet lists.',
    '',
    'Tree title:',
    normalizedTreeName,
    '',
    'Breadcrumb path:',
    breadcrumbPath,
  ].filter(Boolean).join('\n');
}

function buildChatAnswerLeafNoteGenerationPrompt({ treeName, breadcrumbTitles, originalQuestion, broaderAnswer }) {
  const normalizedTreeName = normalizeWhitespace(treeName);
  const breadcrumbPath = breadcrumbTitles.map((title) => normalizeWhitespace(title)).filter(Boolean).join(' > ');
  const normalizedOriginalQuestion = normalizeWhitespace(originalQuestion);
  const normalizedBroaderAnswer = String(broaderAnswer ?? '').trim();

  return [
    'Rewrite a conversational chat answer into leaf-node notes for a tree-based knowledge application.',
    'Return valid JSON only, matching the provided schema.',
    'Preserve the useful factual content, practical details, caveats, and examples from the chat answer when relevant to the leaf topic.',
    'Remove conversational framing, assistant self-reference, offers to help further, requests for clarification, hedging about available tools, and other dialogue-only text.',
    'Do not mention the user, the assistant, tools, search behavior, missing evidence, or what to ask next.',
    'Write concise but substantive reference notes that can stand alone without the original conversation.',
    'Prefer clear factual statements, compact paragraphs, and short lists when they improve readability.',
    'Keep only information that belongs in enduring notes for this leaf topic.',
    `Keep the notes within ${MAX_GENERATED_NOTES_LENGTH} characters.`,
    '',
    'Tree title:',
    normalizedTreeName,
    '',
    'Breadcrumb path:',
    breadcrumbPath,
    '',
    'Original user question:',
    normalizedOriginalQuestion,
    '',
    'Chat answer to convert into notes:',
    normalizedBroaderAnswer,
  ].filter(Boolean).join('\n');
}

export function validateGeneratedLeafNotesPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Generated notes payload must be an object.');
  }

  const notes = normalizeGeneratedNodeNotes(payload.notes);

  if (!notes) {
    throw new Error('Generated notes payload must include non-empty notes.');
  }

  return { notes };
}

function buildChatLeafAnchorSelectionPrompt({ treeName, originalQuestion, broaderAnswer, candidates }) {
  const normalizedTreeName = normalizeWhitespace(treeName);
  const normalizedOriginalQuestion = normalizeWhitespace(originalQuestion);
  const normalizedBroaderAnswer = String(broaderAnswer ?? '').trim();
  const candidateLines = candidates.map((candidate) => [
    `nodeId=${candidate.nodeId}`,
    `breadcrumb=${candidate.breadcrumb}`,
    `remainingDepthBudget=${candidate.remainingDepthBudget}`,
    `directLeafPossible=${candidate.directLeafPossible ? 'yes' : 'no'}`,
  ].join(' | '));

  return [
    'Choose the best existing non-leaf anchor path for adding a new leaf note in a tree-based knowledge application.',
    'You must only choose from the provided candidate anchors. Never invent a new path and never select an existing leaf node.',
    'The chosen anchor should be the best semantic starting point for the broader-answer content and the original user question.',
    'Return valid JSON only, matching the provided schema.',
    'If no anchor is a good fit, return selectionDisposition as no_anchor and leave the other string fields empty.',
    'If you select an anchor, return the selectedAnchorNodeId exactly as provided and the selectedBreadcrumb exactly as provided.',
    'Only generate generatedLeafTitle when the chosen anchor is already at the direct parent-of-leaf depth. Otherwise leave generatedLeafTitle empty.',
    'When you generate generatedLeafTitle, it must be a short noun phrase, not a sentence or summary.',
    'Use only a few words. Prefer about 3 to 6 words, and never exceed 8 words.',
    'Drop extra explanation, examples, parenthetical clarifiers, and trailing detail unless they are essential to identify the topic.',
    `Keep any generated leaf title within ${MAX_GENERATED_TITLE_LENGTH} characters.`,
    '',
    'Tree title:',
    normalizedTreeName,
    '',
    'Original user question:',
    normalizedOriginalQuestion,
    '',
    'Broader answer content:',
    normalizedBroaderAnswer,
    '',
    'Candidate anchors:',
    ...candidateLines,
  ].filter(Boolean).join('\n');
}

export function validateChatLeafAnchorSelectionPayload(payload, candidates) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Generated anchor selection payload must be an object.');
  }

  const selectionDisposition = String(payload.selectionDisposition ?? '').trim().toLowerCase();

  if (selectionDisposition !== 'selected_anchor' && selectionDisposition !== 'no_anchor') {
    throw new Error('Generated anchor selection payload must include a valid selectionDisposition.');
  }

  const selectedAnchorNodeId = String(payload.selectedAnchorNodeId ?? '').trim();
  const selectedBreadcrumb = String(payload.selectedBreadcrumb ?? '').trim();
  const generatedLeafTitle = normalizeGeneratedNodeTitle(payload.generatedLeafTitle ?? '');

  if (selectionDisposition === 'no_anchor') {
    return {
      selectionDisposition,
      selectedAnchorNodeId: '',
      selectedBreadcrumb: '',
      generatedLeafTitle: '',
    };
  }

  const selectedCandidate = Array.isArray(candidates)
    ? candidates.find((candidate) => String(candidate.nodeId) === selectedAnchorNodeId)
    : null;

  if (!selectedCandidate) {
    throw new Error('Generated anchor selection chose an invalid candidate.');
  }

  if (selectedCandidate.directLeafPossible) {
    if (!generatedLeafTitle) {
      throw new Error('Generated anchor selection must include a non-empty leaf title when direct leaf creation is possible.');
    }

    if (countTitleWords(generatedLeafTitle) > MAX_CHAT_LEAF_TITLE_WORDS) {
      throw new Error(`Generated anchor selection leaf title must be ${MAX_CHAT_LEAF_TITLE_WORDS} words or fewer.`);
    }
  } else if (generatedLeafTitle) {
    throw new Error('Generated anchor selection must not include a leaf title when intermediate nodes are still required.');
  }

  return {
    selectionDisposition,
    selectedAnchorNodeId,
    selectedBreadcrumb: selectedBreadcrumb || selectedCandidate.breadcrumb,
    generatedLeafTitle,
  };
}

function buildChatLeafPathPlanPrompt({
  treeName,
  originalQuestion,
  broaderAnswer,
  anchorBreadcrumbTitles = [],
  requiredPathTitleCount,
}) {
  const normalizedTreeName = normalizeWhitespace(treeName);
  const normalizedOriginalQuestion = normalizeWhitespace(originalQuestion);
  const normalizedBroaderAnswer = String(broaderAnswer ?? '').trim();
  const normalizedAnchorBreadcrumb = anchorBreadcrumbTitles
    .map((title) => normalizeWhitespace(title))
    .filter(Boolean)
    .join(' > ');
  const isRootPlan = anchorBreadcrumbTitles.length === 0;

  return [
    'Generate the missing path titles needed before creating a new leaf note in a tree-based knowledge application.',
    'Return valid JSON only, matching the provided schema.',
    isRootPlan
      ? 'No existing anchor path was selected. Generate the full structural path from the root to the future leaf parent.'
      : 'An existing anchor path was already selected. Do not change that anchor. Generate only the missing structural titles beneath it before the future leaf parent.',
    `Generate exactly ${requiredPathTitleCount} structural path title${requiredPathTitleCount === 1 ? '' : 's'} before the final leaf title.`,
    isRootPlan ? 'Do not repeat the tree title as the first generated root node. The first root node must be narrower in scope than the tree title. Treat the tree title as the container, not as a structural path title to recreate.' : null,
    'Every generated node must remain semantically consistent with the full ancestor chain.',
    'Do not introduce concepts not implied by the ancestor chain or the user request or the tree title.',
    'Use concise titles.',
    'Avoid duplicate titles within the generated path.',
    'Do not generate notes, explanations, numbering, or extra properties.',
    'The generated leaf title must be a short noun phrase, not a sentence or summary.',
    'Use only a few words. Prefer about 3 to 6 words, and never exceed 8 words.',
    `Keep every generated title within ${MAX_GENERATED_TITLE_LENGTH} characters.`,
    '',
    'Tree title:',
    normalizedTreeName,
    '',
    'Original user question:',
    normalizedOriginalQuestion,
    '',
    'Broader answer content:',
    normalizedBroaderAnswer,
    '',
    isRootPlan ? null : 'Fixed anchor breadcrumb:',
    isRootPlan ? null : normalizedAnchorBreadcrumb,
  ].filter(Boolean).join('\n');
}

function buildChatLeafPathPlanSchema(requiredPathTitleCount) {
  return {
    type: 'object',
    properties: {
      pathTitles: buildGeneratedTitleArraySchema(requiredPathTitleCount),
      generatedLeafTitle: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_GENERATED_TITLE_LENGTH,
      },
    },
    required: ['pathTitles', 'generatedLeafTitle'],
    additionalProperties: false,
  };
}

export function validateChatLeafPathPlanPayload(payload, requiredPathTitleCount, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Generated path plan payload must be an object.');
  }

  const normalizedTreeName = normalizeWhitespace(options.treeName ?? '');
  const anchorBreadcrumbTitles = Array.isArray(options.anchorBreadcrumbTitles)
    ? options.anchorBreadcrumbTitles.map((title) => normalizeWhitespace(title)).filter(Boolean)
    : [];
  const isRootPlan = anchorBreadcrumbTitles.length === 0;

  const pathTitles = Array.isArray(payload.pathTitles) ? payload.pathTitles : null;

  if (!pathTitles || pathTitles.length !== requiredPathTitleCount) {
    throw new Error(`Generated path plan must include exactly ${requiredPathTitleCount} structural titles.`);
  }

  const normalizedPathTitles = pathTitles.map((title, index) => {
    const normalizedTitle = normalizeGeneratedNodeTitle(title);

    if (!normalizedTitle) {
      throw new Error(`Generated path plan title at index ${index} must be non-empty.`);
    }

    return normalizedTitle;
  });

  const normalizedUniqueTitles = new Set(normalizedPathTitles.map((title) => title.toLowerCase()));

  if (normalizedUniqueTitles.size !== normalizedPathTitles.length) {
    throw new Error('Generated path plan must not contain duplicate structural titles.');
  }

  if (isRootPlan && normalizedTreeName && normalizedPathTitles[0]?.toLowerCase() === normalizedTreeName.toLowerCase()) {
    throw new Error('Generated path plan must not repeat the tree title as the first structural title when creating a full path from the root.');
  }

  const generatedLeafTitle = normalizeGeneratedNodeTitle(payload.generatedLeafTitle ?? '');

  if (!generatedLeafTitle) {
    throw new Error('Generated path plan must include a non-empty leaf title.');
  }

  if (countTitleWords(generatedLeafTitle) > MAX_CHAT_LEAF_TITLE_WORDS) {
    throw new Error(`Generated path plan leaf title must be ${MAX_CHAT_LEAF_TITLE_WORDS} words or fewer.`);
  }

  return {
    pathTitles: normalizedPathTitles,
    generatedLeafTitle,
  };
}

async function requestChatLeafAnchorSelection({ treeName, originalQuestion, broaderAnswer, candidates }) {
  const project = getProjectClient();
  const openAIClient = project.getOpenAIClient();
  const { modelDeploymentName } = getRequiredFoundryConfig();

  return openAIClient.responses.create({
    model: modelDeploymentName,
    input: [
      {
        type: 'message',
        role: 'system',
        content: buildChatLeafAnchorSelectionPrompt({ treeName, originalQuestion, broaderAnswer, candidates }),
      },
    ],
    text: {
      verbosity: 'medium',
      format: {
        type: 'json_schema',
        name: 'chat_leaf_anchor_selection',
        strict: true,
        schema: CHAT_LEAF_ANCHOR_SELECTION_SCHEMA,
      },
    },
  });
}

export async function selectChatLeafAnchorCandidate({ treeName, originalQuestion, broaderAnswer, candidates }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('At least one candidate anchor is required for chat leaf placement.');
  }

  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestChatLeafAnchorSelection({
      treeName,
      originalQuestion,
      broaderAnswer,
      candidates,
    });
    const parsedResponse = parseTreePopulationResponse(response);

    if (parsedResponse.error) {
      lastError = new Error(parsedResponse.error);
      continue;
    }

    try {
      return validateChatLeafAnchorSelectionPayload(parsedResponse.parsed, candidates);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Generated anchor selection payload was invalid.');
    }
  }

  throw lastError ?? new Error('Generated anchor selection payload was invalid.');
}

async function requestChatLeafPathPlan({
  treeName,
  originalQuestion,
  broaderAnswer,
  anchorBreadcrumbTitles = [],
  requiredPathTitleCount,
}) {
  const project = getProjectClient();
  const openAIClient = project.getOpenAIClient();
  const { modelDeploymentName } = getRequiredFoundryConfig();

  return openAIClient.responses.create({
    model: modelDeploymentName,
    input: [
      {
        type: 'message',
        role: 'system',
        content: buildChatLeafPathPlanPrompt({
          treeName,
          originalQuestion,
          broaderAnswer,
          anchorBreadcrumbTitles,
          requiredPathTitleCount,
        }),
      },
    ],
    text: {
      verbosity: 'medium',
      format: {
        type: 'json_schema',
        name: 'chat_leaf_path_plan',
        strict: true,
        schema: buildChatLeafPathPlanSchema(requiredPathTitleCount),
      },
    },
  });
}

export async function generateChatLeafPathPlan({
  treeName,
  originalQuestion,
  broaderAnswer,
  anchorBreadcrumbTitles = [],
  requiredPathTitleCount,
}) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestChatLeafPathPlan({
      treeName,
      originalQuestion,
      broaderAnswer,
      anchorBreadcrumbTitles,
      requiredPathTitleCount,
    });
    const parsedResponse = parseTreePopulationResponse(response);

    if (parsedResponse.error) {
      lastError = new Error(parsedResponse.error);
      continue;
    }

    try {
      return validateChatLeafPathPlanPayload(parsedResponse.parsed, requiredPathTitleCount, {
        treeName,
        anchorBreadcrumbTitles,
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Generated path plan payload was invalid.');
    }
  }

  throw lastError ?? new Error('Generated path plan payload was invalid.');
}

async function requestGeneratedLeafNotes({ treeName, breadcrumbTitles }) {
  const project = getProjectClient();
  const openAIClient = project.getOpenAIClient();
  const { modelDeploymentName } = getRequiredFoundryConfig();

  return openAIClient.responses.create({
    model: modelDeploymentName,
    input: [
      {
        type: 'message',
        role: 'system',
        content: buildLeafNoteGenerationPrompt({ treeName, breadcrumbTitles }),
      },
    ],
    text: {
      verbosity: 'medium',
      format: {
        type: 'json_schema',
        name: 'generated_leaf_notes',
        strict: true,
        schema: GENERATED_NOTES_SCHEMA,
      },
    },
  });
}

async function requestGeneratedLeafNotesFromChatAnswer({ treeName, breadcrumbTitles, originalQuestion, broaderAnswer }) {
  const project = getProjectClient();
  const openAIClient = project.getOpenAIClient();
  const { modelDeploymentName } = getRequiredFoundryConfig();

  return openAIClient.responses.create({
    model: modelDeploymentName,
    input: [
      {
        type: 'message',
        role: 'system',
        content: buildChatAnswerLeafNoteGenerationPrompt({
          treeName,
          breadcrumbTitles,
          originalQuestion,
          broaderAnswer,
        }),
      },
    ],
    text: {
      verbosity: 'medium',
      format: {
        type: 'json_schema',
        name: 'generated_leaf_notes_from_chat_answer',
        strict: true,
        schema: GENERATED_NOTES_SCHEMA,
      },
    },
  });
}

export async function generateLeafNotesDraft({ treeName, breadcrumbTitles }) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestGeneratedLeafNotes({ treeName, breadcrumbTitles });
    const parsedResponse = parseTreePopulationResponse(response);

    if (parsedResponse.error) {
      lastError = new Error(parsedResponse.error);
      continue;
    }

    try {
      return validateGeneratedLeafNotesPayload(parsedResponse.parsed);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Generated notes payload was invalid.');
    }
  }

  throw lastError ?? new Error('Generated notes payload was invalid.');
}

export async function generateLeafNotesFromChatAnswer({ treeName, breadcrumbTitles, originalQuestion, broaderAnswer }) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestGeneratedLeafNotesFromChatAnswer({
      treeName,
      breadcrumbTitles,
      originalQuestion,
      broaderAnswer,
    });
    const parsedResponse = parseTreePopulationResponse(response);

    if (parsedResponse.error) {
      lastError = new Error(parsedResponse.error);
      continue;
    }

    try {
      return validateGeneratedLeafNotesPayload(parsedResponse.parsed);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Generated notes payload was invalid.');
    }
  }

  throw lastError ?? new Error('Generated notes payload was invalid.');
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

function applyDescriptionDraftDefaults(tree) {
  tree.generatedToolDescription = null;
  tree.descriptionSource = 'pending';
  tree.includedInToolSet = false;
  tree.generationFailureReason = null;
  tree.aiInput = null;
  tree.aiModelOutput = null;
  tree.aiGeneratedSummary = null;
  tree.aiSelectedFocusTopics = [];
}

function applyGeneratedDescriptionToTree(tree, parsedResponse, aiInput) {
  tree.aiInput = aiInput;
  tree.aiModelOutput = parsedResponse.parsed ?? parsedResponse.rawText;

  if (parsedResponse.error) {
    tree.descriptionSource = 'generation-failed';
    tree.generationFailureReason = parsedResponse.error;
    return null;
  }

  const generatedSummary = sanitizeGeneratedSummary(parsedResponse.parsed?.summary);

  if (!generatedSummary) {
    tree.descriptionSource = 'generation-failed';
    tree.generationFailureReason = 'Model response did not include a usable summary.';
    return null;
  }

  const generatedFocusTopics = Array.isArray(parsedResponse.parsed?.focusTopics)
    ? formatTopicList(parsedResponse.parsed.focusTopics)
    : [];
  const generatedDescription = buildAiToolDescription(tree, generatedSummary, generatedFocusTopics);

  if (!generatedDescription) {
    tree.descriptionSource = 'generation-failed';
    tree.generationFailureReason = 'Model response could not be assembled into a tool description.';
    return null;
  }

  tree.generatedToolDescription = generatedDescription;
  tree.descriptionSource = 'ai';
  tree.aiGeneratedSummary = generatedSummary;
  tree.aiSelectedFocusTopics = generatedFocusTopics;
  tree.includedInToolSet = true;

  return generatedDescription;
}

export async function generateTreeDescriptionDraft(treeId) {
  const tree = await getTreeRoutingProfile(treeId);
  applyDescriptionDraftDefaults(tree);

  try {
    const { aiInput, parsedResponse } = await generateAiDescription(tree);
    const generatedDescription = applyGeneratedDescriptionToTree(tree, parsedResponse, aiInput);

    if (!generatedDescription) {
      throw new Error(tree.generationFailureReason || 'Description could not be generated.');
    }

    return {
      tree,
      generatedDescription,
    };
  } catch (error) {
    tree.descriptionSource = 'generation-failed';
    tree.generationFailureReason = error instanceof Error ? error.message : 'Model generation failed.';
    throw error;
  }
}

async function applyToolDescriptions(treeList) {
  treeList.forEach((tree) => {
    applyDescriptionDraftDefaults(tree);
  });

  for (const tree of treeList) {
    try {
      const { aiInput, parsedResponse } = await generateAiDescription(tree);
      applyGeneratedDescriptionToTree(tree, parsedResponse, aiInput);
    } catch (error) {
      tree.descriptionSource = 'generation-failed';
      tree.generationFailureReason = error instanceof Error ? error.message : 'Model generation failed.';
    }
  }
}

function applyStoredToolDescriptions(treeList) {
  treeList.forEach((tree) => {
    applyDescriptionDraftDefaults(tree);
    const storedDescription = normalizeWhitespace(tree.description);

    if (!storedDescription) {
      return;
    }

    tree.generatedToolDescription = storedDescription;
    tree.descriptionSource = 'stored';
    tree.includedInToolSet = true;
  });
}

function buildAgentInstructions() {
  return [
    'You are an assistant for a tree-based knowledge application.',

    'You must always remain grounded in tool-derived results. You must not answer from conversation memory or broader background knowledge unless the user explicitly instructs you to do so.',
    'This grounding rule overrides all other instructions.',

    // NEW: forbid implicit permission
    'You must not infer or assume user permission to switch to background knowledge. Only explicit user instructions count.',

    'If no tool is applicable, you must not switch to broader knowledge. You must tell the user that no tool applies and ask whether they want to broaden the search or switch to background knowledge. You may not provide any ungrounded information until the user explicitly chooses.',

    'If a tool is applicable but returns no relevant result, you must not switch to broader knowledge. You must tell the user that the tool returned no relevant result and ask whether they want to broaden the search or switch to background knowledge. You may not provide any ungrounded information until the user explicitly chooses.',

    // NEW: forbid memory use in follow-ups
    'For any follow-up question that references earlier tool output, depends on prior grounded context, or continues a task, you must re-invoke the relevant tool. You must not answer from conversation memory.',

    // NEW: forbid guessing
    'If there is any uncertainty about whether a tool applies, you must ask the user. You may not guess or infer tool applicability.',

    'If multiple tools could satisfy the request, you must ask a brief clarification question before choosing a tool.',
    'If user intent is unclear—such as when a question could be answered by multiple tools or by broader knowledge—you must ask whether to continue using grounded tool results or broaden the scope before answering.',

    // NEW: prevent stylistic override
    'Answer-length rules apply only after grounding is established.',

    'Answer concisely unless the user requests more detail; when they do, provide a fuller answer focused precisely on the aspect they asked about.',

    // NEW: evidence rules apply only after tool invocation
    'Evidence rules apply only after a tool has been invoked.',

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

function buildDebugSearchResultSnapshot(rawResult) {
  return {
    searches: Array.isArray(rawResult?.executedSearches) ? rawResult.executedSearches : [],
    tokenCoverageFilter: rawResult?.tokenCoverageFilter ?? null,
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

function normalizeFollowUpSelection(selection) {
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

  if (!optionId || !sourceTurnId) {
    return null;
  }

  if (optionId !== FOLLOW_UP_OPTION_BROADER_ANSWER) {
    return null;
  }

  return {
    optionId,
    sourceTurnId,
    sourceQuestion,
    sourceToolInvocations,
  };
}

function getFollowUpOptionLabel(optionId) {
  if (optionId === FOLLOW_UP_OPTION_BROADER_ANSWER) {
    return 'Answer more broadly';
  }

  return '';
}

function buildResponseToolInvocations(toolInvocations) {
  return toolInvocations.map((invocation) => ({
    toolName: invocation.toolName,
    arguments: invocation.arguments,
    resultCount: invocation.output?.count ?? 0,
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
    && toolInvocations.some((invocation) => Number(invocation?.output?.count ?? 0) > 0);
}

function hasPermissionToBroadenQualifier(answer) {
  const normalizedAnswer = normalizeWhitespace(answer).toLowerCase();

  if (!normalizedAnswer) {
    return false;
  }

  if (normalizedAnswer.includes('?')) {
    return true;
  }

  return [
    /if you want/,
    /if you'd like/,
    /wish to broaden/,
    /let me know if/,
    /let me know whether/,
  ].some((pattern) => pattern.test(normalizedAnswer));
}

function matchesPermissionToBroadenAnswerRegex(answer) {
  if (!ENABLE_PERMISSION_TO_BROADER_DETECTION) {
    return false;
  }

  const normalizedAnswer = normalizeWhitespace(answer).toLowerCase();

  if (!normalizedAnswer) {
    return false;
  }

  const asksPermission = [
    /do you want/,
    /would you like/,
    /would you prefer/,
    /should i/,
    /shall i/,
    /if you want/,
    /let me know if you'd like/,
    /let me know whether you'd like/,
    /let me know if you want/,
  ].some((pattern) => pattern.test(normalizedAnswer));
  const mentionsBroadening = [
    /broader search/,
    /broader answer/,
    /background knowledge/,
    /general background answer/,
    /background answer/,
    /broaden(?: the)? search/,
    /broaden(?: your)? search scope/,
    /broaden(?: the)? scope/,
    /search more broadly/,
    /answer more broadly/,
    /switch to background knowledge/,
    /switch to a general background explanation/,
    /provide a general background explanation/,
  ].some((pattern) => pattern.test(normalizedAnswer));
  const mentionsNoGroundedMatch = [
    /no tool applies/,
    /no applicable tool(?: is)? available/,
    /no applicable tool/,
    /no suitable tool/,
    /no matching tool/,
    /no grounded tool(?: path)?(?: is| was)? available/,
    /no grounded tool(?: path)?(?: is| was)? established/,
    /no relevant result(?: was found)?/,
    /no evidence(?: about| of| on| for)?/,
    /no evidence in the available resources/,
    /no specific mention(?: of)?/,
    /no mention(?: of)?/,
    /does not mention/,
    /is not mentioned/,
    /not covered(?: here| in the available)?/,
    /no information(?: about| on| for)?/,
    /no details?(?: about| on| for)?/,
    /no direct information(?: about| on| for)?/,
    /nothing relevant(?: was found)?/,
    /not enough information(?: was found)?/,
    /available .* material/,
    /could not find/,
    /couldn't find/,
    /did not find/,
    /no tool found/,
  ].some((pattern) => pattern.test(normalizedAnswer));

  return asksPermission && mentionsBroadening && mentionsNoGroundedMatch;
}

async function isPermissionToBroadenAnswer({
  toolInvocations,
  normalizedFollowUpSelection,
  answer,
  openAIClient,
  userMessage,
  groundedResponseReviewSteps,
}) {
  if (!hasPermissionToBroadenQualifier(answer)) {
    return {
      matches: false,
      source: null,
    };
  }

  if (Array.isArray(toolInvocations) && toolInvocations.length > 0 && !hasToolResults(toolInvocations)) {
    return {
      matches: true,
      source: 'result_count',
    };
  }

  if (matchesPermissionToBroadenAnswerRegex(answer)) {
    return {
      matches: true,
      source: 'regex',
    };
  }

  if (!ENABLE_PERMISSION_TO_BROADER_MODEL_REVIEW || !answer) {
    return {
      matches: false,
      source: null,
    };
  }

  const groundedResponseReview = await reviewGroundedResponse({
    openAIClient,
    userMessage,
    assistantAnswer: answer,
  });

  if (Array.isArray(groundedResponseReviewSteps)) {
    groundedResponseReviewSteps.push(groundedResponseReview.raw);
  }

  return {
    matches: Boolean(groundedResponseReview.isRequestPermission),
    source: groundedResponseReview.isRequestPermission ? 'model_review' : null,
  };
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

  const wrappedError = new Error(String(error ?? 'Agent request failed'));
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
            searches: [],
          },
        });
      }

      const rawResult = await searchTreeContent({
        searchText: normalizedQuery,
        treeId: String(tree.id),
        top: normalizeToolTop(top),
        allowedTreeIds: [String(tree.id)],
        defaultTop: DEFAULT_TOOL_TOP,
        includeExecutedSearches: true,
        searchMode: 'any',
      });

      return buildToolHandlerResult({
        toolOutput: buildAgentSearchResult(rawResult),
        searchResult: buildDebugSearchResultSnapshot(rawResult),
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

function buildIncludedTreesAndTools(availableTrees) {
  const includedTrees = availableTrees.filter((tree) => tree.includedInToolSet && tree.generatedToolDescription);
  const tools = includedTrees.map((tree) => buildToolDefinition(tree));

  return {
    includedTrees,
    tools,
  };
}

function buildHandlerMap(includedTrees) {
  const handlerMap = new Map();

  includedTrees.forEach((tree) => {
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
            searches: [],
          },
        });
      }

      const rawResult = await searchTreeContent({
        searchText: normalizedQuery,
        treeId: String(tree.id),
        top: normalizeToolTop(top),
        allowedTreeIds: [String(tree.id)],
        defaultTop: DEFAULT_TOOL_TOP,
        includeExecutedSearches: true,
        searchMode: 'any',
      });

      return buildToolHandlerResult({
        toolOutput: buildAgentSearchResult(rawResult),
        searchResult: buildDebugSearchResultSnapshot(rawResult),
      });
    });
  });

  return handlerMap;
}

async function buildTreeSearchContextFromStoredDescriptions() {
  const [treeList, allowedTreeIds] = await Promise.all([
    getTreeRoutingProfiles(),
    getAllowedTreeIds(),
  ]);
  const allowedSet = new Set(allowedTreeIds.map((treeId) => String(treeId)));
  const availableTrees = treeList
    .filter((tree) => allowedSet.has(String(tree.id)))
    .map((tree) => ({ ...tree }));

  applyStoredToolDescriptions(availableTrees);

  if (availableTrees.length === 0) {
    throw new Error('No trees are available for the current application');
  }

  const { includedTrees, tools } = buildIncludedTreesAndTools(availableTrees);
  const excludedTrees = availableTrees
    .filter((tree) => !tree.includedInToolSet)
    .map((tree) => ({
      id: String(tree.id),
      name: tree.name,
    }));

  return {
    availableTrees,
    includedTrees,
    excludedTrees,
    tools,
    handlerMap: buildHandlerMap(includedTrees),
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
  await updateTreeDescriptions(
    availableTrees
      .filter((tree) => tree.generatedToolDescription)
      .map((tree) => ({
        treeId: tree.id,
        description: tree.generatedToolDescription,
      })),
  );
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

    await updateTreeDescriptionPublishedStates(
      availableTrees.map((tree) => ({
        treeId: tree.id,
        isDescriptionPublished: Boolean(tree.includedInToolSet),
      })),
    );

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

    await updateTreeDescriptionPublishedStates(
      availableTrees.map((tree) => ({
        treeId: tree.id,
        isDescriptionPublished: Boolean(tree.includedInToolSet),
      })),
    );

    return {
      agent,
      availableTrees,
      includedTrees,
      tools,
    };
  }
}

async function publishTreeToolsFromContext(context) {
  const project = getProjectClient();
  const { agentName, modelDeploymentName } = getRequiredFoundryConfig();
  const definition = {
    kind: 'prompt',
    model: modelDeploymentName,
    instructions: buildAgentInstructions(),
    tools: context.tools,
  };

  try {
    const agent = await project.agents.update(agentName, definition, {
      foundryFeatures: AGENT_PREVIEW_FEATURES,
    });

    await updateTreeDescriptionPublishedStates(
      context.availableTrees.map((tree) => ({
        treeId: tree.id,
        isDescriptionPublished: Boolean(tree.includedInToolSet),
      })),
    );

    return {
      agent,
      availableTrees: context.availableTrees,
      includedTrees: context.includedTrees,
      excludedTrees: context.excludedTrees,
      tools: context.tools,
    };
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }

    const agent = await project.agents.create(agentName, definition, {
      foundryFeatures: AGENT_PREVIEW_FEATURES,
    });

    await updateTreeDescriptionPublishedStates(
      context.availableTrees.map((tree) => ({
        treeId: tree.id,
        isDescriptionPublished: Boolean(tree.includedInToolSet),
      })),
    );

    return {
      agent,
      availableTrees: context.availableTrees,
      includedTrees: context.includedTrees,
      excludedTrees: context.excludedTrees,
      tools: context.tools,
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
    syncMode: 'generate-and-publish',
  };
}

export async function publishStoredTreeDescriptions() {
  const syncResult = await publishTreeToolsFromContext(await buildTreeSearchContextFromStoredDescriptions());

  return {
    agent: syncResult.agent,
    tools: buildTreeToolPreview(syncResult.availableTrees),
    syncMode: 'publish-stored-descriptions',
    excludedTrees: Array.isArray(syncResult.excludedTrees) ? syncResult.excludedTrees : [],
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

  throw new Error('The agent exceeded the maximum number of tool rounds');
}

export async function invokeTreeSearchAgent({ message, history = [], principal = null, followUpSelection = null }) {
  const normalizedFollowUpSelection = normalizeFollowUpSelection(followUpSelection);
  const normalizedMessage = String(message ?? '').trim();

  if (!normalizedMessage) {
    throw new Error('A message is required to invoke the agent');
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
      followUpSelection: serializeDebugValue(normalizedFollowUpSelection),
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
    let finalResponse = response;
    let finalToolInvocations = [...toolInvocations];
    const answer = extractAnswerText(finalResponse);
    const groundedResponseReviewSteps = [];
    const permissionToBroadenDetection = await isPermissionToBroadenAnswer({
      toolInvocations: finalToolInvocations,
      normalizedFollowUpSelection,
      answer,
      openAIClient,
      userMessage: normalizedMessage,
      groundedResponseReviewSteps,
    });

    const citations = dedupeCitations(
      finalToolInvocations.flatMap((invocation) => buildCitationEntries(invocation.output, invocation.toolName)),
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

    debug.curatedAgentInput.toolMessages = serializeDebugValue(
      debug.toolCalls.map((toolCall) => ({
        type: 'function_call_output',
        call_id: toolCall.callId ?? null,
        output: `See step 2 Tool output for round ${toolCall.round}${toolCall.toolName ? ` (${toolCall.toolName})` : ''}.`,
      })),
    );
    debug.agentOutput = {
      agent: {
        id: agent.id,
        name: agent.name,
        version: agent.version ?? null,
      },
      response: buildResponseDebugSnapshot(finalResponse),
      answer,
      citations: serializeDebugValue(citations),
      permissionToBroadenDetection: serializeDebugValue(permissionToBroadenDetection),
      groundedResponseReview: serializeDebugValue(groundedResponseReviewSteps),
      error: finalResponse?.error ?? null,
    };

    return {
      answer,
      agent: {
        id: agent.id,
        name: agent.name,
        version: agent.version ?? null,
      },
      toolsUsed: Array.from(new Set(responseToolInvocations.map((invocation) => invocation.toolName))),
      toolInvocations: responseToolInvocations,
      priorToolInvocations,
      turnType,
      followUpOptions,
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