class PurgeFunctionError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PurgeFunctionError';
    this.status = status;
  }
}

function matchesConfiguredMessage(message, configuredMessages) {
  return configuredMessages.some((configuredMessage) => String(configuredMessage).trim() === message);
}

function includesConfiguredMessage(message, configuredMessages) {
  return configuredMessages.some((configuredMessage) => {
    const normalizedMessage = String(configuredMessage).trim();
    return normalizedMessage ? message.includes(normalizedMessage) : false;
  });
}

function getRequiredPurgeFunctionConfig() {
  const functionUrl = String(process.env.AZURE_PURGE_FUNCTION_URL ?? '').trim();
  const functionKey = String(process.env.AZURE_PURGE_FUNCTION_KEY ?? '').trim();

  if (!functionUrl) {
    throw new Error('Azure purge function URL env var is not configured');
  }

  if (!functionKey) {
    throw new Error('Azure purge function key env var is not configured');
  }

  return {
    functionUrl,
    functionKey,
  };
}

export async function invokePurgeFunction(payload) {
  const config = getRequiredPurgeFunctionConfig();
  const response = await fetch(config.functionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-functions-key': config.functionKey,
    },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });

  const responseText = await response.text();
  let responseBody = null;

  if (responseText) {
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = { rawBody: responseText };
    }
  }

  if (!response.ok) {
    throw new PurgeFunctionError(
      String(responseBody?.error || responseBody?.rawBody || 'The purge function request failed.').trim(),
      response.status,
    );
  }

  return responseBody ?? {};
}

export function getPurgeProxyErrorStatus(error, {
  forbiddenMessages = [],
  badRequestMessages = [],
  badRequestIncludes = [],
  defaultStatus = 500,
} = {}) {
  const message = error instanceof Error ? error.message : 'The request failed';

  if (matchesConfiguredMessage(message, forbiddenMessages)) {
    return 403;
  }

  if (error instanceof PurgeFunctionError && (error.status === 400 || error.status === 404)) {
    return 400;
  }

  if (matchesConfiguredMessage(message, badRequestMessages) || includesConfiguredMessage(message, badRequestIncludes)) {
    return 400;
  }

  return defaultStatus;
}

export { PurgeFunctionError };