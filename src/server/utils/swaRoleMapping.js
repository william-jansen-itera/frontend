import { ClientSecretCredential, DefaultAzureCredential } from '@azure/identity';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const DEFAULT_USER_SEARCH_LIMIT = 8;
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

function getConfiguredRoleGroupId(role) {
  const normalizedRole = String(role ?? '').trim().toLowerCase();

  if (!normalizedRole) {
    return null;
  }

  return getConfiguredRoleMappings().find((mapping) => mapping.role === normalizedRole)?.groupId ?? null;
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

function escapeGraphFilterLiteral(value) {
  return String(value ?? '').replace(/'/g, "''");
}

function buildGraphUrl(path, searchParams = null) {
  const url = new URL(`${GRAPH_BASE_URL}${path}`);

  if (searchParams) {
    Object.entries(searchParams).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') {
        return;
      }

      url.searchParams.set(key, String(value));
    });
  }

  return url;
}

function mapGraphUser(user) {
  if (!user?.id) {
    return null;
  }

  const userPrincipalName = String(user.userPrincipalName ?? '').trim() || null;
  const mail = String(user.mail ?? '').trim() || null;

  return {
    objectId: String(user.id).trim(),
    displayName: String(user.displayName ?? '').trim() || userPrincipalName || mail || 'Unknown user',
    userDetails: userPrincipalName || mail || String(user.id).trim(),
    userPrincipalName,
    mail,
  };
}

async function callGraphJson(path, { method = 'GET', body = null, searchParams = null } = {}) {
  const accessToken = await getGraphAccessToken();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
  };

  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(buildGraphUrl(path, searchParams), {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });

  if (!response.ok) {
    const error = new Error();
    const responseText = await response.text();
    error.message = `Graph request failed with ${response.status}: ${responseText || response.statusText}`;
    error.status = response.status;
    throw error;
  }

  return response.json();
}

async function getMatchedGroupIdsForObjectId(objectId, groupIds) {
  const normalizedObjectId = String(objectId ?? '').trim();
  const normalizedGroupIds = Array.isArray(groupIds)
    ? groupIds.map((groupId) => String(groupId ?? '').trim()).filter(Boolean)
    : [];

  if (!normalizedObjectId || normalizedGroupIds.length === 0) {
    return new Set();
  }

  const graphResult = await callGraphJson(`/users/${encodeURIComponent(normalizedObjectId)}/checkMemberGroups`, {
    method: 'POST',
    body: {
      groupIds: normalizedGroupIds,
    },
  });

  return new Set(Array.isArray(graphResult?.value) ? graphResult.value : []);
}

async function isUserInConfiguredRoleGroup(objectId, role) {
  const groupId = getConfiguredRoleGroupId(role);

  if (!groupId) {
    throw new Error(`Entra group ID for role ${role} is not configured`);
  }

  const matchedGroupIds = await getMatchedGroupIdsForObjectId(objectId, [groupId]);
  return matchedGroupIds.has(groupId);
}

export async function getEntraUserByObjectId(objectId, options = {}) {
  const normalizedObjectId = String(objectId ?? '').trim();
  const requiredRole = String(options?.requiredRole ?? '').trim().toLowerCase() || null;

  if (!normalizedObjectId) {
    return null;
  }

  try {
    const graphResult = await callGraphJson(`/users/${encodeURIComponent(normalizedObjectId)}`, {
      searchParams: {
        '$select': 'id,displayName,userPrincipalName,mail',
      },
    });

    if (requiredRole && !(await isUserInConfiguredRoleGroup(normalizedObjectId, requiredRole))) {
      return null;
    }

    return mapGraphUser(graphResult);
  } catch (error) {
    if (Number(error?.status) === 404) {
      return null;
    }

    throw error;
  }
}

export async function searchEntraUsers(query, options = {}) {
  const normalizedQuery = String(query ?? '').trim();
  const requestedLimit = Number.parseInt(String(options?.limit ?? ''), 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 20))
    : DEFAULT_USER_SEARCH_LIMIT;
  const requiredRole = String(options?.requiredRole ?? 'mdsusers').trim().toLowerCase() || null;

  if (normalizedQuery.length < 2) {
    return [];
  }

  const escapedQuery = escapeGraphFilterLiteral(normalizedQuery);
  const graphResult = await callGraphJson('/users', {
    searchParams: {
      '$select': 'id,displayName,userPrincipalName,mail',
      '$top': String(limit),
      '$filter': `startsWith(displayName,'${escapedQuery}') or startsWith(userPrincipalName,'${escapedQuery}') or startsWith(mail,'${escapedQuery}')`,
    },
  });

  const users = (Array.isArray(graphResult?.value) ? graphResult.value : [])
    .map((user) => mapGraphUser(user))
    .filter(Boolean);

  if (!requiredRole) {
    return users;
  }

  const eligibleUsers = await Promise.all(
    users.map(async (user) => ((await isUserInConfiguredRoleGroup(user.objectId, requiredRole)) ? user : null)),
  );

  return eligibleUsers.filter(Boolean);
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
  const matchedGroupIds = await getMatchedGroupIdsForObjectId(objectId, groupIds);

  return configuredRoleMappings
    .filter((mapping) => matchedGroupIds.has(mapping.groupId))
    .map((mapping) => mapping.role);
}