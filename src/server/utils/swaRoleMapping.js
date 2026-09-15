import { ClientSecretCredential, DefaultAzureCredential } from '@azure/identity';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const OBJECT_ID_CLAIM_TYPES = [
  'http://schemas.microsoft.com/identity/claims/objectidentifier',
  'oid',
];

function createGraphCredential() {
  const tenantId = String(process.env.AZURE_TENANT_ID ?? '').trim();
  const clientId = String(process.env.AZURE_CLIENT_ID ?? '').trim();
  const clientSecret = String(process.env.AZURE_CLIENT_SECRET ?? '').trim();

  if (tenantId && clientId && clientSecret) {
    return new ClientSecretCredential(tenantId, clientId, clientSecret);
  }

  return new DefaultAzureCredential();
}

const graphCredential = createGraphCredential();

function getConfiguredRoleMappings() {
  return [
    { groupId: String(process.env.MDSUSERS_ENTRA_GROUP_ID ?? '').trim(), role: 'mdsusers' },
    { groupId: String(process.env.MDSADMINS_ENTRA_GROUP_ID ?? '').trim(), role: 'mdsadmins' },
  ].filter((mapping) => mapping.groupId);
}

function normalizeClaims(claims) {
  return Array.isArray(claims) ? claims : [];
}

function getClaimValue(claims, claimType) {
  return normalizeClaims(claims).find((claim) => claim?.typ === claimType)?.val ?? null;
}

export function getEntraObjectIdFromRoleSourcePayload(payload) {
  const claims = normalizeClaims(payload?.claims);

  for (const claimType of OBJECT_ID_CLAIM_TYPES) {
    const claimValue = getClaimValue(claims, claimType);

    if (claimValue) {
      return String(claimValue).trim();
    }
  }

  return null;
}

async function getGraphAccessToken() {
  const accessToken = await graphCredential.getToken(GRAPH_SCOPE);

  if (!accessToken?.token) {
    throw new Error('Graph access token acquisition returned no token');
  }

  return accessToken.token;
}

async function callGraphJson(path, body) {
  const accessToken = await getGraphAccessToken();
  const response = await fetch(`${GRAPH_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`Graph request failed with ${response.status}: ${responseText || response.statusText}`);
  }

  return response.json();
}

export async function resolveRolesFromRoleSourcePayload(payload) {
  const configuredRoleMappings = getConfiguredRoleMappings();

  if (configuredRoleMappings.length === 0) {
    return [];
  }

  const objectId = getEntraObjectIdFromRoleSourcePayload(payload);

  if (!objectId) {
    return [];
  }

  const groupIds = configuredRoleMappings.map((mapping) => mapping.groupId);
  const graphResult = await callGraphJson(`/users/${encodeURIComponent(objectId)}/checkMemberGroups`, {
    groupIds,
  });
  const matchedGroupIds = new Set(Array.isArray(graphResult?.value) ? graphResult.value : []);

  return configuredRoleMappings
    .filter((mapping) => matchedGroupIds.has(mapping.groupId))
    .map((mapping) => mapping.role);
}