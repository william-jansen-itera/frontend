import { invokeTreeSearchAgent } from '@/server/utils/agent/treeGrounding/treeAgentService';
import { invokeInvestmentAgent } from '@/server/utils/agent/investment/investmentAgentService';
import { INVESTMENT_FAMILY } from '@/server/utils/agent/investment/investmentAgentCatalog';
import {
  getHostedTreeGroundingPublishStatus,
  publishHostedTreeGroundingAgent,
  TREE_GROUNDING_FAMILY,
} from '@/server/utils/agent/treeGrounding/treeAgentCatalog';

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
  supportsHostedPublishing,
  invoke,
  getHostedPublishStatus,
  publishHostedAgent,
}) {
  return {
    family,
    label,
    description,
    orchestratorTool: buildFamilyToolDefinition({
      name: orchestratorToolName,
      description,
    }),
    supportsHostedPublishing,
    invoke,
    getHostedPublishStatus,
    publishHostedAgent,
  };
}

const FAMILY_REGISTRY = new Map([
  [INVESTMENT_FAMILY, buildFamilyRegistration({
    family: INVESTMENT_FAMILY,
    label: 'Investment',
    description: 'A deterministic investment tool that returns cached prices, recommendations, and event review results.',
    orchestratorToolName: 'ask_investment_family',
    supportsHostedPublishing: false,
    invoke: invokeInvestmentAgent,
  })],
  [TREE_GROUNDING_FAMILY, buildFamilyRegistration({
    family: TREE_GROUNDING_FAMILY,
    label: 'Tree Grounding',
    description: 'A hosted tree-backed search tool that returns grounded results from published trees with detailed descriptions.',
    orchestratorToolName: 'ask_tree_grounding_family',
    supportsHostedPublishing: true,
    invoke: invokeTreeSearchAgent,
    getHostedPublishStatus: getHostedTreeGroundingPublishStatus,
    publishHostedAgent: publishHostedTreeGroundingAgent,
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
    return FAMILY_REGISTRY.get(TREE_GROUNDING_FAMILY) ?? null;
  }

  return FAMILY_REGISTRY.get(normalizedFamily) ?? null;
}
