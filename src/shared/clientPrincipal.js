function getClaimValue(claims, type) {
  return claims.find((claim) => claim?.typ === type)?.val ?? null;
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