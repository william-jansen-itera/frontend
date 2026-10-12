import { invokeKnowledgeTreesAgent } from '@/server/utils/agent/knowledgeTrees/treeAgentService';
import { invokeInvestmentAgent } from '@/server/utils/agent/investment/investmentAgentService';
import { invokeEmailAgent } from '@/server/utils/agent/email/emailAgentService';
import {
  INVESTMENT_FAMILY,
  getInvestmentPromptAgentPublishStatus,
  listDefinedInvestmentTools,
  publishInvestmentPromptAgent,
  unpublishInvestmentPromptAgent,
} from '@/server/utils/agent/investment/investmentAgentCatalog';
import {
  EMAIL_FAMILY,
  getEmailPromptAgentPublishStatus,
  listDefinedEmailTools,
  publishEmailPromptAgent,
  unpublishEmailPromptAgent,
} from '@/server/utils/agent/email/emailAgentCatalog';
import {
  getKnowledgeTreesPromptAgentPublishStatus,
  KNOWLEDGE_TREES_FAMILY,
  listDefinedKnowledgeTreesTools,
  publishKnowledgeTreesPromptAgent,
  unpublishKnowledgeTreesPromptAgent,
} from '@/server/utils/agent/knowledgeTrees/treeAgentCatalog';

function buildFamilyToolDefinition({ name, description }) {
  return {
    type: 'function',
    name,
    description,
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The end-user request to hand off to this agent family.',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  };
}

function buildFamilyRegistration({
  family,
  label,
  description,
  orchestratorToolName,
  supportsPromptAgentPublishing,
  requiresPublishedPromptAgent,
  invoke,
  listDefinedTools,
  getPromptAgentPublishStatus,
  publishPromptAgent,
  unpublishPromptAgent,
}) {
  return {
    family,
    label,
    description,
    orchestratorTool: buildFamilyToolDefinition({
      name: orchestratorToolName,
      description,
    }),
    supportsPromptAgentPublishing,
    requiresPublishedPromptAgent,
    invoke,
    listDefinedTools,
    getPromptAgentPublishStatus,
    publishPromptAgent,
    unpublishPromptAgent,
  };
}

const FAMILY_REGISTRY = new Map([
  [INVESTMENT_FAMILY, buildFamilyRegistration({
    family: INVESTMENT_FAMILY,
    label: 'Investment',
    description: 'A deterministic investment tool that returns cached prices, recommendations, and event review results.',
    orchestratorToolName: 'ask_investment_family',
    supportsPromptAgentPublishing: true,
    requiresPublishedPromptAgent: true,
    invoke: invokeInvestmentAgent,
    listDefinedTools: listDefinedInvestmentTools,
    getPromptAgentPublishStatus: getInvestmentPromptAgentPublishStatus,
    publishPromptAgent: publishInvestmentPromptAgent,
    unpublishPromptAgent: unpublishInvestmentPromptAgent,
  })],
  [EMAIL_FAMILY, buildFamilyRegistration({
    family: EMAIL_FAMILY,
    label: 'Email',
    description: 'An email assistant that uses IMAP and SMTP-backed tools with personal-cache working datasets.',
    orchestratorToolName: 'ask_email_family',
    supportsPromptAgentPublishing: true,
    requiresPublishedPromptAgent: true,
    invoke: invokeEmailAgent,
    listDefinedTools: listDefinedEmailTools,
    getPromptAgentPublishStatus: getEmailPromptAgentPublishStatus,
    publishPromptAgent: publishEmailPromptAgent,
    unpublishPromptAgent: unpublishEmailPromptAgent,
  })],
  [KNOWLEDGE_TREES_FAMILY, buildFamilyRegistration({
    family: KNOWLEDGE_TREES_FAMILY,
    label: 'Knowledge Trees',
    description: 'A tree-backed prompt tool that returns grounded results from published knowledge trees with detailed descriptions.',
    orchestratorToolName: 'ask_knowledge_trees_family',
    supportsPromptAgentPublishing: true,
    requiresPublishedPromptAgent: true,
    invoke: invokeKnowledgeTreesAgent,
    listDefinedTools: listDefinedKnowledgeTreesTools,
    getPromptAgentPublishStatus: getKnowledgeTreesPromptAgentPublishStatus,
    publishPromptAgent: publishKnowledgeTreesPromptAgent,
    unpublishPromptAgent: unpublishKnowledgeTreesPromptAgent,
  })],
]);

export function listRegisteredAgentFamilies() {
  return Array.from(FAMILY_REGISTRY.keys());
}

export function listAgentFamilyRegistrations() {
  return Array.from(FAMILY_REGISTRY.values());
}

export function listAgentFamilyToolDefinitions() {
  return listAgentFamilyRegistrations()
    .map((registration) => registration?.orchestratorTool ?? null)
    .filter(Boolean);
}

export function getAgentFamilyRegistrationByToolName(toolName) {
  const normalizedToolName = String(toolName ?? '').trim();

  if (!normalizedToolName) {
    return null;
  }

  return listAgentFamilyRegistrations().find(
    (registration) => String(registration?.orchestratorTool?.name ?? '').trim() === normalizedToolName,
  ) ?? null;
}

export function getAgentFamilyRegistration(family) {
  const normalizedFamily = String(family ?? '').trim();

  if (!normalizedFamily) {
    return FAMILY_REGISTRY.get(KNOWLEDGE_TREES_FAMILY) ?? null;
  }

  return FAMILY_REGISTRY.get(normalizedFamily) ?? null;
}
