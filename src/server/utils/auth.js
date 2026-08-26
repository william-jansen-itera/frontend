import {
  createLocalDevelopmentPrincipal,
  isLocalDevelopmentHost,
  normalizeClientPrincipal,
} from '@/shared/clientPrincipal';

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
  const decodedPrincipal = decodeBase64Json(encodedPrincipal);

  if (decodedPrincipal) {
    return decodedPrincipal;
  }

  const requestUrl = request?.url ? new URL(request.url) : null;

  if (isLocalDevelopmentHost(requestUrl?.hostname)) {
    return createLocalDevelopmentPrincipal();
  }

  return null;
}

export function getRelevantPrincipalDetails(principal) {
  return normalizeClientPrincipal(principal);
}