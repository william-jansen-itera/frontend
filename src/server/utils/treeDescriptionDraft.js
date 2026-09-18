import {
  getProjectClient,
  getRequiredFoundryConfig,
} from '@/server/utils/foundryAgentClient';
import { getTreeRoutingProfile } from '@/server/utils/treeCatalog';

function formatTopicList(values) {
  return Array.from(new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean)));
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

  return `${normalizedSummary}.`;
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
          'Infer the tree language from the provided title, and write both summary and focusTopics in that same language.',
          'If the tree title is multilingual, prefer the dominant language used by the tree title rather than defaulting to English.',
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

export async function generateTreeDescriptionDraft(treeId, options = {}) {
  const tree = await getTreeRoutingProfile(treeId, options);
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