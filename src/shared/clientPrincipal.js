function getClaimValue(claims, type) {
  return claims.find((claim) => claim?.typ === type)?.val ?? null;
}

function createClaim(type, value) {
  return {
    typ: type,
    val: value,
  };
}

function isLocalHostName(hostname) {
  const normalizedHostname = String(hostname ?? '').trim().toLowerCase();
  return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1';
}

function normalizeRoleName(role) {
  return String(role ?? '').trim().toLowerCase();
}

export function isLocalDevelopmentHost(hostname) {
  return isLocalHostName(hostname);
}

export function createLocalDevelopmentPrincipal(overrides = {}) {
  const objectId = String(overrides.objectId ?? overrides.userId ?? '9dd8fd64-44a8-4560-80e7-0ef65374745c').trim();
  const userDetails = String(overrides.userDetails ?? 'testuser1@altskavaek.onmicrosoft.com').trim();
  const displayName = String(overrides.displayName ?? 'test user 1').trim();
  const identityProvider = String(overrides.identityProvider ?? 'aad').trim();
  const tenantId = String(overrides.tenantId ?? 'a18232f7-c6f8-48da-b8e1-838c7fac8ab1').trim();
  const issuer = String(overrides.issuer ?? 'https://login.microsoftonline.com/a18232f7-c6f8-48da-b8e1-838c7fac8ab1/v2.0').trim();
  const audience = String(overrides.audience ?? 'b82efeaa-410b-4d9a-9bc1-64a1a3f71ec9').trim();
  const expiresAtEpoch = String(overrides.expiresAtEpoch ?? '1787741761').trim();
  const userRoles = Array.isArray(overrides.userRoles) && overrides.userRoles.length > 0
    ? overrides.userRoles
    : ['mdsadmin', 'mdsusers', 'anonymous', 'authenticated'];
  const claims = [
    createClaim('name', displayName),
    createClaim('preferred_username', userDetails),
    createClaim('http://schemas.microsoft.com/identity/claims/objectidentifier', objectId),
    createClaim('http://schemas.microsoft.com/identity/claims/tenantid', tenantId),
    createClaim('iss', issuer),
    createClaim('aud', audience),
    createClaim('exp', expiresAtEpoch),
  ];

  return {
    identityProvider,
    userId: objectId,
    userDetails,
    userRoles,
    claims,
  };
}

export function normalizeClientPrincipal(principal) {
  if (!principal) {
    return null;
  }

  const claims = Array.isArray(principal.claims) ? principal.claims : [];

  return {
    identityProvider: principal.identityProvider ?? null,
    userId: principal.userId ?? null,
    userDetails: principal.userDetails ?? null,
    userRoles: Array.isArray(principal.userRoles) ? principal.userRoles : [],
    displayName: getClaimValue(claims, 'name'),
    preferredUsername: getClaimValue(claims, 'preferred_username'),
    objectId: getClaimValue(claims, 'http://schemas.microsoft.com/identity/claims/objectidentifier'),
    tenantId: getClaimValue(claims, 'http://schemas.microsoft.com/identity/claims/tenantid'),
    issuer: getClaimValue(claims, 'iss'),
    audience: getClaimValue(claims, 'aud'),
    expiresAtEpoch: getClaimValue(claims, 'exp'),
    claims,
  };
}

export function hasClientPrincipalRole(principal, role) {
  const normalizedRole = normalizeRoleName(role);

  if (!normalizedRole) {
    return false;
  }

  const normalizedPrincipal = normalizeClientPrincipal(principal);
  const userRoles = Array.isArray(normalizedPrincipal?.userRoles) ? normalizedPrincipal.userRoles : [];

  return userRoles.some((userRole) => normalizeRoleName(userRole) === normalizedRole);
}