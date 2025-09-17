// Utility to decode a JWT access token and return the payload as JSON
export function decodeJwt(token) {
  const payload = token.split('.')[1];
  const decoded = Buffer.from(payload, 'base64url').toString('utf8');
  return JSON.parse(decoded);
}

import { ConfidentialClientApplication } from '@azure/msal-node';

export async function getFunctionAppAccessToken() {
  const clientId = process.env.AZURE_FUNC_CLIENT_ID;
  const clientSecret = process.env.AZURE_FUNC_CLIENT_SECRET;
  const tenantId = process.env.AZURE_TENANT_ID;
  const scope = process.env.AZURE_FUNCTION_SCOPE; // e.g. "api://<function-app-client-id>/.default"

  if (!clientId || !clientSecret || !tenantId || !scope) {
    throw new Error('Missing required environment variables for client credential flow');
  }

  const msalConfig = {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      clientSecret,
    },
  };

  const cca = new ConfidentialClientApplication(msalConfig);
  const result = await cca.acquireTokenByClientCredential({
    scopes: [scope],
  });
  if (!result || !result.accessToken) {
    throw new Error('Failed to acquire access token');
  }
  return result.accessToken;
}
