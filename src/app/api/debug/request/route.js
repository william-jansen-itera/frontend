import { NextResponse } from 'next/server';
import { getRelevantPrincipalDetails, parseClientPrincipal } from '@/server/utils/auth';

export const dynamic = 'force-dynamic';

const INCLUDED_HEADER_NAMES = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'forwarded',
  'host',
  'referer',
  'user-agent',
  'via',
  'x-arr-log-id',
  'x-client-ip',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-ms-client-principal',
  'x-ms-geo-location',
  'x-ms-original-url',
  'x-ms-request-id',
]);

function shouldIncludeHeader(name) {
  const normalizedName = String(name ?? '').trim().toLowerCase();

  if (!normalizedName) {
    return false;
  }

  if (INCLUDED_HEADER_NAMES.has(normalizedName)) {
    return true;
  }

  return [
    'x-azure-',
    'x-ms-',
    'x-forwarded-',
    'x-vercel-',
  ].some((prefix) => normalizedName.startsWith(prefix)) || [
    'country',
    'region',
    'city',
    'geo',
    'continent',
    'latitude',
    'longitude',
  ].some((fragment) => normalizedName.includes(fragment));
}

function getHeaderSnapshot(headers) {
  return Array.from(headers.entries())
    .filter(([name]) => shouldIncludeHeader(name))
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .reduce((snapshot, [name, value]) => {
      snapshot[name] = value;
      return snapshot;
    }, {});
}

function getReferrerHost(referer) {
  if (!referer) {
    return null;
  }

  try {
    return new URL(referer).host || null;
  } catch {
    return null;
  }
}

export async function GET(request) {
  const principal = parseClientPrincipal(request);
  const principalDetails = getRelevantPrincipalDetails(principal);
  const headerSnapshot = getHeaderSnapshot(request.headers);
  const requestUrl = new URL(request.url);

  return NextResponse.json({
    request: {
      url: request.url,
      pathname: requestUrl.pathname,
      host: request.headers.get('host'),
      referrerHost: getReferrerHost(request.headers.get('referer')),
      userAgent: request.headers.get('user-agent'),
    },
    authenticated: Boolean(principalDetails),
    principal: principalDetails ? {
      identityProvider: principalDetails.identityProvider,
      userId: principalDetails.userId,
      userDetails: principalDetails.userDetails,
      userRoles: principalDetails.userRoles,
    } : null,
    headers: headerSnapshot,
  }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}