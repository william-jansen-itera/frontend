import { parseClientPrincipal } from '@/server/utils/auth';
import { setTimeout as delay } from 'timers/promises';
import { confirmSqlIsResponsive, getRequiredApplicationIdentifier, isLikelySleepingSqlError, sql, withSqlConnection } from '@/server/utils/sql';
import { classifyBrowserFamily, classifyDeviceClass } from '@/server/utils/userAgent';
import { isLocalDevelopmentHost } from '@/shared/clientPrincipal';

const ALLOWED_PAGE_PATHS = new Set(['/', '/about', '/contact']);
const SQL_WAKE_RETRY_DELAY_MS = 10_000;
const SQL_WAKE_MAX_RETRIES = 3;

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

  return {
    appIdentifier: getRequiredApplicationIdentifier(),
    pagePath: normalizedPagePath,
    isAuthenticated: parseClientPrincipal(request) ? 1 : 0,
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

  const executeCounterWrite = () => withSqlConnection(async () => {
    const result = await new sql.Request()
      .input('app_identifier', sql.NVarChar(128), dimensions.appIdentifier)
      .input('page_path', sql.NVarChar(32), dimensions.pagePath)
      .input('is_authenticated', sql.Bit, dimensions.isAuthenticated)
      .input('referrer_host', sql.NVarChar(255), dimensions.referrerHost)
      .input('device_class', sql.NVarChar(32), dimensions.deviceClass)
      .input('browser_family', sql.NVarChar(32), dimensions.browserFamily)
      .query(`
        DECLARE @now DATETIME2(7) = SYSUTCDATETIME();

        UPDATE dbo.page_visit_counters
        SET
          visit_count = visit_count + 1,
          latest_visited_at = @now,
          updated_at = @now
        WHERE app_identifier = @app_identifier
          AND page_path = @page_path
          AND is_authenticated = @is_authenticated
          AND referrer_host = @referrer_host
          AND device_class = @device_class
          AND browser_family = @browser_family;

        IF @@ROWCOUNT = 0
        BEGIN
          BEGIN TRY
            INSERT INTO dbo.page_visit_counters (
              app_identifier,
              page_path,
              is_authenticated,
              referrer_host,
              device_class,
              browser_family,
              visit_count,
              first_visited_at,
              latest_visited_at,
              updated_at
            )
            VALUES (
              @app_identifier,
              @page_path,
              @is_authenticated,
              @referrer_host,
              @device_class,
              @browser_family,
              1,
              @now,
              @now,
              @now
            );
          END TRY
          BEGIN CATCH
            IF ERROR_NUMBER() IN (2601, 2627)
            BEGIN
              UPDATE dbo.page_visit_counters
              SET
                visit_count = visit_count + 1,
                latest_visited_at = @now,
                updated_at = @now
              WHERE app_identifier = @app_identifier
                AND page_path = @page_path
                AND is_authenticated = @is_authenticated
                AND referrer_host = @referrer_host
                AND device_class = @device_class
                AND browser_family = @browser_family;
            END
            ELSE
            BEGIN
              THROW;
            END
          END CATCH
        END;

        SELECT TOP 1
          visit_count AS visitCount,
          first_visited_at AS firstVisitedAt,
          latest_visited_at AS latestVisitedAt
        FROM dbo.page_visit_counters
        WHERE app_identifier = @app_identifier
          AND page_path = @page_path
          AND is_authenticated = @is_authenticated
          AND referrer_host = @referrer_host
          AND device_class = @device_class
          AND browser_family = @browser_family;
      `);

    return {
      status: 'recorded',
      counter: result.recordset[0] ?? null,
    };
  });

  let lastError;

  for (let attempt = 0; attempt <= SQL_WAKE_MAX_RETRIES; attempt += 1) {
    try {
      return await executeCounterWrite();
    } catch (error) {
      lastError = error;

      if (!isLikelySleepingSqlError(error) || attempt === SQL_WAKE_MAX_RETRIES) {
        throw error;
      }

      await delay(SQL_WAKE_RETRY_DELAY_MS);
      await confirmSqlIsResponsive();
    }
  }

  throw lastError;
}