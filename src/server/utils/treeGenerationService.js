import {
  getProjectClient,
  getRequiredFoundryConfig,
} from '@/server/utils/foundryAgentClient';

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

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

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

function normalizeGeneratedNodeTitle(value) {
  return normalizeWhitespace(value).slice(0, MAX_GENERATED_TITLE_LENGTH);
}

function countTitleWords(value) {
  return normalizeWhitespace(value).split(' ').filter(Boolean).length;
}

function normalizeGeneratedNodeNotes(value) {
  return String(value ?? '').trim().slice(0, MAX_GENERATED_NOTES_LENGTH);
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

function buildTreePopulationPrompt({ treeName, description }) {
  return [
    `Tree name: ${treeName}.`,
    'This tree has four levels: root, level-2, level-3, and level-4 leaf nodes.',
    'Follow all instruction blocks exactly as written. Do not merge, reinterpret, or generalize instructions across blocks.',
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