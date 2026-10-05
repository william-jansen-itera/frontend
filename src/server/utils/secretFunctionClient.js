class SecretFunctionError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SecretFunctionError';
    this.status = status;
  }
}

function getRequiredSecretFunctionConfig() {
  const functionUrl = String(process.env.AZURE_SECRET_FUNCTION_URL ?? '').trim();
  const functionKey = String(process.env.AZURE_SECRET_FUNCTION_KEY ?? '').trim();

  if (!functionUrl) {
    throw new Error('Azure secret function URL env var is not configured');
  }

  if (!functionKey) {
    throw new Error('Azure secret function key env var is not configured');
  }

  return {
    functionUrl,
    functionKey,
  };
}

export async function invokeSecretFunction(payload) {
  const config = getRequiredSecretFunctionConfig();
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
    throw new SecretFunctionError(
      String(responseBody?.error || responseBody?.rawBody || 'The secret function request failed.').trim(),
      response.status,
    );
  }

  return responseBody ?? {};
}

export function getSecretProxyErrorStatus(error, defaultStatus = 500) {
  if (error instanceof SecretFunctionError && (error.status === 400 || error.status === 404)) {
    return 400;
  }

  return defaultStatus;
}

export { SecretFunctionError };