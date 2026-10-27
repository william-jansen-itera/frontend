import { isbot } from 'isbot';
import { parseClientPrincipal } from '@/server/utils/auth';
import { getRequiredApplicationIdentifier } from '@/server/utils/applicationIdentifier';
import { classifyBrowserFamily, classifyDeviceClass } from '@/server/utils/userAgent';
import { isLocalDevelopmentHost } from '@/shared/clientPrincipal';
import { listPageVisitEvents, writePageVisitEvent } from '@/server/utils/pageVisitAnalyticsRepository';

const ALLOWED_PAGE_PATHS = new Set(['/', '/about', '/contact']);
const IP_ADDRESS_COLLATOR = new Intl.Collator('en', { numeric: true });
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

function getParsedUrl(value) {
  const normalizedValue = String(value ?? '').trim();

  if (!normalizedValue) {
    return null;
  }

  try {
    return new URL(normalizedValue);
  } catch {
    return null;
  }
}

function getVisitSourceDetails(pageUrl, documentReferrer) {
  const parsedPageUrl = getParsedUrl(pageUrl);
  const parsedDocumentReferrer = getParsedUrl(documentReferrer);

  if (parsedPageUrl) {
    const source = String(
      parsedPageUrl.searchParams.get('src')
      ?? parsedPageUrl.searchParams.get('utm_src')
      ?? parsedPageUrl.searchParams.get('utm_source')
      ?? '',
    ).trim().toLowerCase();

    if (source) {
      return { source, sourceKind: 'tagged' };
    }
  }

  if (parsedDocumentReferrer) {
    const referrerHost = parsedDocumentReferrer.host.toLowerCase();
    const pageHost = parsedPageUrl?.host?.toLowerCase() ?? null;

    if (!referrerHost) {
      return { source: 'direct', sourceKind: 'invalidReferrer' };
    }

    if (referrerHost !== pageHost) {
      return { source: referrerHost, sourceKind: 'externalReferrer' };
    }

    return { source: 'direct', sourceKind: 'sameSiteReferrer' };
  }

  return { source: 'direct', sourceKind: String(documentReferrer ?? '').trim() ? 'invalidReferrer' : 'noReferrer' };
}

function normalizeIpAddress(value) {
  const normalizedValue = String(value ?? '').trim().toLowerCase();

  if (!normalizedValue) {
    return null;
  }

  const withoutIpv4MappedPrefix = normalizedValue.startsWith('::ffff:')
    ? normalizedValue.slice(7)
    : normalizedValue;

  if (withoutIpv4MappedPrefix.startsWith('[')) {
    const closingBracketIndex = withoutIpv4MappedPrefix.indexOf(']');
    return closingBracketIndex > 0
      ? withoutIpv4MappedPrefix.slice(1, closingBracketIndex)
      : withoutIpv4MappedPrefix;
  }

  const ipv4WithPortMatch = withoutIpv4MappedPrefix.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/);

  if (ipv4WithPortMatch) {
    return ipv4WithPortMatch[1];
  }

  return withoutIpv4MappedPrefix;
}

function getClientIpAddress(request) {
  const forwardedFor = String(request.headers.get('x-forwarded-for') ?? '').trim();

  if (forwardedFor) {
    const firstForwardedAddress = forwardedFor
      .split(',')
      .map((value) => normalizeIpAddress(value))
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

export function getPageVisitCounterDimensions(request, payload) {
  const normalizedPagePath = normalizeTrackedPagePath(payload?.pagePath);

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
    referrerHost: getReferrerHost(payload?.documentReferrer),
    ...getVisitSourceDetails(payload?.pageUrl, payload?.documentReferrer),
    deviceClass: classifyDeviceClass(request.headers.get('user-agent')),
    browserFamily: classifyBrowserFamily(request.headers.get('user-agent')),
    userAgent: String(request.headers.get('user-agent') ?? '').trim().slice(0, 512),
    isWebDriver: payload?.isWebDriver === true,
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
  const byPageSource = new Map();
  const byIp = new Map();
  const bySubnetUserAgent = new Map();
  const byIpBrowserFamily = new Map();
  const byBotIpBrowserFamily = new Map();

  for (const eventEntry of events) {
    if (!eventEntry) {
      continue;
    }

    const pagePath = normalizeTrackedPagePath(eventEntry.pagePath);

    if (!pagePath) {
      continue;
    }

    const knownBot = isbot(String(eventEntry.userAgent ?? ''));
    const isWebDriver = eventEntry.isWebDriver === true;

    if (knownBot || isWebDriver) {
      const clientIp = String(eventEntry.clientIp ?? '').trim() || 'unknown';
      const browserFamily = String(eventEntry.browserFamily ?? '').trim() || 'unknown';
      const deviceClass = String(eventEntry.deviceClass ?? '').trim() || 'unknown';
      const detection = knownBot && isWebDriver ? 'both' : knownBot ? 'userAgent' : 'webDriver';
      const botKey = `${clientIp}\u0000${browserFamily}\u0000${deviceClass}\u0000${detection}`;

      byBotIpBrowserFamily.set(botKey, {
        clientIp,
        browserFamily,
        deviceClass,
        detection,
        visitCount: Number(byBotIpBrowserFamily.get(botKey)?.visitCount ?? 0) + 1,
      });
      continue;
    }

    const deviceClass = String(eventEntry.deviceClass ?? '').trim() || 'unknown';
    const browserFamily = String(eventEntry.browserFamily ?? '').trim() || 'unknown';
    const source = String(eventEntry.source ?? '').trim() || 'direct';
    const sourceKind = String(eventEntry.sourceKind ?? '').trim() || 'notRecorded';
    const clientIp = String(eventEntry.clientIp ?? '').trim() || 'unknown';
    const detailedKey = `${pagePath}\u0000${deviceClass}\u0000${browserFamily}`;
    const pageOnlyKey = pagePath;
    const pageSourceKey = `${pagePath}\u0000${source}\u0000${sourceKind}`;

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

    byPageSource.set(pageSourceKey, {
      pagePath,
      source,
      sourceKind,
      visitCount: Number(byPageSource.get(pageSourceKey)?.visitCount ?? 0) + 1,
    });

    byIp.set(clientIp, {
      clientIp,
      visitCount: Number(byIp.get(clientIp)?.visitCount ?? 0) + 1,
    });

    const ipBrowserKey = `${clientIp}\u0000${browserFamily}\u0000${deviceClass}`;

    byIpBrowserFamily.set(ipBrowserKey, {
      clientIp,
      browserFamily,
      deviceClass,
      visitCount: Number(byIpBrowserFamily.get(ipBrowserKey)?.visitCount ?? 0) + 1,
    });

    const userAgent = String(eventEntry.userAgent ?? '').trim();
    const userAgentStatus = !Object.hasOwn(eventEntry, 'userAgent') ? 'notRecorded'
      : !userAgent || userAgent === 'unknown' ? 'missing' : 'present';
    const key = `${clientIp}\u0000${userAgentStatus}\u0000${userAgentStatus === 'present' ? userAgent : ''}`;

    bySubnetUserAgent.set(key, {
      clientIp,
      userAgent: userAgentStatus === 'present' ? userAgent : '',
      userAgentStatus,
      visitCount: Number(bySubnetUserAgent.get(key)?.visitCount ?? 0) + 1,
    });
  }

  return {
    byPageDeviceBrowser: sortGroupedRows(Array.from(byPageDeviceBrowser.values()), ['pagePath', 'deviceClass', 'browserFamily']),
    byPage: sortGroupedRows(Array.from(byPage.values()), ['pagePath']),
    byPageSource: sortGroupedRows(Array.from(byPageSource.values()), ['pagePath', 'source', 'sourceKind']),
    byIp: Array.from(byIp.values())
      .sort((left, right) => right.visitCount - left.visitCount || left.clientIp.localeCompare(right.clientIp))
      .slice(0, 20)
      .sort((left, right) => IP_ADDRESS_COLLATOR.compare(left.clientIp, right.clientIp)),
    bySubnetUserAgent: Array.from(bySubnetUserAgent.values())
      .sort((left, right) => right.visitCount - left.visitCount
        || left.clientIp.localeCompare(right.clientIp)
        || left.userAgent.localeCompare(right.userAgent))
      .slice(0, 20)
      .sort((left, right) => IP_ADDRESS_COLLATOR.compare(left.clientIp, right.clientIp)
        || left.userAgentStatus.localeCompare(right.userAgentStatus)
        || left.userAgent.localeCompare(right.userAgent)),
    byIpBrowserFamily: Array.from(byIpBrowserFamily.values())
      .sort((left, right) => right.visitCount - left.visitCount
        || left.clientIp.localeCompare(right.clientIp)
        || left.browserFamily.localeCompare(right.browserFamily)
        || left.deviceClass.localeCompare(right.deviceClass))
      .slice(0, 20)
      .sort((left, right) => IP_ADDRESS_COLLATOR.compare(left.clientIp, right.clientIp)
        || left.browserFamily.localeCompare(right.browserFamily)
        || left.deviceClass.localeCompare(right.deviceClass)),
    byBotIpBrowserFamily: Array.from(byBotIpBrowserFamily.values())
      .sort((left, right) => right.visitCount - left.visitCount
        || left.clientIp.localeCompare(right.clientIp)
        || left.browserFamily.localeCompare(right.browserFamily)
        || left.deviceClass.localeCompare(right.deviceClass)
        || left.detection.localeCompare(right.detection))
      .slice(0, 20)
      .sort((left, right) => IP_ADDRESS_COLLATOR.compare(left.clientIp, right.clientIp)
        || left.browserFamily.localeCompare(right.browserFamily)
        || left.deviceClass.localeCompare(right.deviceClass)
        || left.detection.localeCompare(right.detection)),
    generatedAt: new Date().toISOString(),
  };
}