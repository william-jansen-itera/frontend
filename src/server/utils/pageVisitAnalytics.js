import { parseClientPrincipal } from '@/server/utils/auth';
import { getRequiredApplicationIdentifier } from '@/server/utils/sql';
import { classifyBrowserFamily, classifyDeviceClass } from '@/server/utils/userAgent';
import { isLocalDevelopmentHost } from '@/shared/clientPrincipal';
import { listPageVisitEvents, writePageVisitEvent } from '@/server/utils/analyticsStorage';

const ALLOWED_PAGE_PATHS = new Set(['/', '/about', '/contact']);
const IGNORED_ANALYTICS_IPS = new Set(
  String(process.env.ANALYTICS_IGNORED_IPS ?? '')
    .split(',')
    .map((value) => normalizeIpAddress(value))
    .filter(Boolean),
);

function normalizeHostName(value) {
  const normalizedValue = String(value ?? '').trim().toLowerCase();

  if (!normalizedValue) {
    return null;
  }

  if (normalizedValue.includes('://')) {
    try {
      return new URL(normalizedValue).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  if (normalizedValue.startsWith('[')) {
    const closingBracketIndex = normalizedValue.indexOf(']');
    return closingBracketIndex > 0 ? normalizedValue.slice(1, closingBracketIndex) : normalizedValue;
  }

  const firstColonIndex = normalizedValue.indexOf(':');
  return firstColonIndex >= 0 ? normalizedValue.slice(0, firstColonIndex) : normalizedValue;
}

function getReferrerHost(referer) {
  const normalizedReferer = String(referer ?? '').trim();

  if (!normalizedReferer) {
    return 'direct';
  }

  try {
    return new URL(normalizedReferer).host.toLowerCase() || 'direct';
  } catch {
    return 'direct';
  }
}

function normalizeIpAddress(value) {
  const normalizedValue = String(value ?? '').trim().toLowerCase();

  if (!normalizedValue) {
    return null;
  }

  return normalizedValue.startsWith('::ffff:') ? normalizedValue.slice(7) : normalizedValue;
}

function getClientIpAddress(request) {
  const forwardedFor = String(request.headers.get('x-forwarded-for') ?? '').trim();

  if (forwardedFor) {
    const firstForwardedAddress = forwardedFor
      .split(',')
      .map((value) => value.trim())
      .find(Boolean);

    if (firstForwardedAddress) {
      return firstForwardedAddress;
    }
  }

  const clientIp = String(request.headers.get('x-client-ip') ?? '').trim();

  return normalizeIpAddress(clientIp) || 'unknown';
}

function shouldIgnoreAnalyticsIpAddress(clientIp) {
  if (IGNORED_ANALYTICS_IPS.size === 0) {
    return false;
  }

  const normalizedClientIp = normalizeIpAddress(clientIp);
  return normalizedClientIp ? IGNORED_ANALYTICS_IPS.has(normalizedClientIp) : false;
}

function isLocalRequest(request) {
  const requestUrl = request?.url ? new URL(request.url) : null;
  const forwardedHost = normalizeHostName(request.headers.get('x-forwarded-host'));
  const host = normalizeHostName(request.headers.get('host'));
  const refererHost = normalizeHostName(request.headers.get('referer'));
  const externallyVisibleCandidates = [forwardedHost, host, refererHost].filter(Boolean);

  if (externallyVisibleCandidates.length > 0) {
    return externallyVisibleCandidates.every((hostName) => isLocalDevelopmentHost(hostName));
  }

  return isLocalDevelopmentHost(requestUrl?.hostname ?? null);
}

export function normalizeTrackedPagePath(pagePath) {
  const normalizedPagePath = String(pagePath ?? '').trim();
  return ALLOWED_PAGE_PATHS.has(normalizedPagePath) ? normalizedPagePath : null;
}

export function getPageVisitCounterDimensions(request, pagePath) {
  const normalizedPagePath = normalizeTrackedPagePath(pagePath);

  if (!normalizedPagePath) {
    throw new Error('Unsupported page path');
  }

  if (isLocalRequest(request)) {
    return null;
  }

  const clientIp = getClientIpAddress(request);

  if (shouldIgnoreAnalyticsIpAddress(clientIp)) {
    return null;
  }

  return {
    appIdentifier: getRequiredApplicationIdentifier(),
    pagePath: normalizedPagePath,
    isAuthenticated: parseClientPrincipal(request) ? 1 : 0,
    clientIp,
    referrerHost: getReferrerHost(request.headers.get('referer')),
    deviceClass: classifyDeviceClass(request.headers.get('user-agent')),
    browserFamily: classifyBrowserFamily(request.headers.get('user-agent')),
  };
}

export async function incrementPageVisitCounter(dimensions) {
  if (!dimensions) {
    return {
      status: 'ignored',
    };
  }

  const recordedAt = new Date().toISOString();
  const eventId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  await writePageVisitEvent({
    eventId,
    recordedAt,
    ...dimensions,
  });

  return {
    status: 'recorded',
  };
}

function sortGroupedRows(rows, keys) {
  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const leftValue = String(left?.[key] ?? '');
      const rightValue = String(right?.[key] ?? '');
      const comparison = leftValue.localeCompare(rightValue);

      if (comparison !== 0) {
        return comparison;
      }
    }

    return Number(right?.visitCount ?? 0) - Number(left?.visitCount ?? 0);
  });
}

export async function getPageVisitAnalyticsSummary() {
  const appIdentifier = getRequiredApplicationIdentifier();
  const events = await listPageVisitEvents(appIdentifier);
  const byPageDeviceBrowser = new Map();
  const byPage = new Map();

  for (const eventEntry of events) {
    if (!eventEntry) {
      continue;
    }

    const pagePath = normalizeTrackedPagePath(eventEntry.pagePath);

    if (!pagePath) {
      continue;
    }

    const deviceClass = String(eventEntry.deviceClass ?? '').trim() || 'unknown';
    const browserFamily = String(eventEntry.browserFamily ?? '').trim() || 'unknown';
    const detailedKey = `${pagePath}\u0000${deviceClass}\u0000${browserFamily}`;
    const pageOnlyKey = pagePath;

    byPageDeviceBrowser.set(detailedKey, {
      pagePath,
      deviceClass,
      browserFamily,
      visitCount: Number(byPageDeviceBrowser.get(detailedKey)?.visitCount ?? 0) + 1,
    });

    byPage.set(pageOnlyKey, {
      pagePath,
      visitCount: Number(byPage.get(pageOnlyKey)?.visitCount ?? 0) + 1,
    });
  }

  return {
    byPageDeviceBrowser: sortGroupedRows(Array.from(byPageDeviceBrowser.values()), ['pagePath', 'deviceClass', 'browserFamily']),
    byPage: sortGroupedRows(Array.from(byPage.values()), ['pagePath']),
    generatedAt: new Date().toISOString(),
  };
}