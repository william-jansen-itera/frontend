import { AIProjectClient } from '@azure/ai-projects';
import { DefaultAzureCredential } from '@azure/identity';

const DEFAULT_AGENT_NAME = 'tree-search-agent';
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
