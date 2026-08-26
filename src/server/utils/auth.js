import { normalizeClientPrincipal } from '@/shared/clientPrincipal';

function decodeBase64Json(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function parseClientPrincipal(request) {
  const encodedPrincipal = request.headers.get('x-ms-client-principal');
  return decodeBase64Json(encodedPrincipal);
}

export function getRelevantPrincipalDetails(principal) {
  return normalizeClientPrincipal(principal);
}