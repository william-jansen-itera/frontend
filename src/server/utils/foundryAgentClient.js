import { AIProjectClient } from '@azure/ai-projects';
import { DefaultAzureCredential } from '@azure/identity';

const DEFAULT_AGENT_NAME = 'tree-search-agent';
const DEFAULT_INVESTMENT_AGENT_NAME = 'investment-agent';
export const AGENT_PREVIEW_FEATURES = 'WorkflowAgents=V1Preview';

let cachedProjectClient;

export function getRequiredFoundryConfig() {
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

export function getRequiredFoundryFamilyConfig(family) {
  const baseConfig = getRequiredFoundryConfig();
  const normalizedFamily = String(family ?? '').trim();

  if (normalizedFamily === 'investment') {
    return {
      ...baseConfig,
      agentName: process.env.AZURE_AI_INVESTMENT_AGENT_NAME || DEFAULT_INVESTMENT_AGENT_NAME,
    };
  }

  return baseConfig;
}

export function getProjectClient() {
  if (!cachedProjectClient) {
    const { projectEndpoint } = getRequiredFoundryConfig();
    cachedProjectClient = new AIProjectClient(projectEndpoint, new DefaultAzureCredential());
  }

  return cachedProjectClient;
}

export function isNotFoundError(error) {
  const statusCode = error?.statusCode || error?.code;
  return statusCode === 404 || String(error?.message || '').includes('404');
}

export async function deleteProjectPromptAgent(agentName) {
  const project = getProjectClient();
  const deleteAgent = project?.agents?.delete ?? project?.agents?.deleteAgent ?? null;

  if (typeof deleteAgent !== 'function') {
    throw new Error('The installed Foundry SDK does not expose prompt-agent deletion.');
  }

  return deleteAgent.call(project.agents, agentName, {
    foundryFeatures: AGENT_PREVIEW_FEATURES,
  });
}
