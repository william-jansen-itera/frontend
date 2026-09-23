function normalizeUserAgent(userAgent) {
  return String(userAgent ?? '').toLowerCase();
}

export function classifyDeviceClass(userAgent) {
  const normalizedUserAgent = normalizeUserAgent(userAgent);

  if (!normalizedUserAgent) {
    return 'unknown';
  }

  if (/ipad|tablet|kindle|silk|playbook/.test(normalizedUserAgent) || (/android/.test(normalizedUserAgent) && !/mobile/.test(normalizedUserAgent))) {
    return 'tablet';
  }

  if (/iphone|ipod|android.*mobile|windows phone|mobile/.test(normalizedUserAgent)) {
    return 'mobile';
  }

  return 'desktop';
}

export function classifyBrowserFamily(userAgent) {
  const normalizedUserAgent = normalizeUserAgent(userAgent);

  if (!normalizedUserAgent) {
    return 'unknown';
  }

  if (normalizedUserAgent.includes('edg/')) {
    return 'edge';
  }

  if (normalizedUserAgent.includes('firefox/')) {
    return 'firefox';
  }

  if (normalizedUserAgent.includes('electron/')) {
    return 'electron';
  }

  if (normalizedUserAgent.includes('chrome/') || normalizedUserAgent.includes('crios/') || normalizedUserAgent.includes('chromium/')) {
    return 'chrome';
  }

  if (normalizedUserAgent.includes('safari/') && !normalizedUserAgent.includes('chrome/') && !normalizedUserAgent.includes('chromium/')) {
    return 'safari';
  }

  return 'unknown';
}

export function buildUserAgentSummary(userAgent) {
  const browserFamily = classifyBrowserFamily(userAgent);
  const deviceClass = classifyDeviceClass(userAgent);

  return `${browserFamily} on ${deviceClass}`;
}