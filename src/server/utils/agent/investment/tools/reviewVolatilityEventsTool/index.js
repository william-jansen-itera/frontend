import {
  buildInvestmentToolResult,
  normalizeTicker,
} from '@/server/utils/agent/investment/tools/investmentToolShared';
import {
  buildVolatilityAnalysisPath,
  getRequiredInvestmentPersistenceTreeId,
  VOLATILITY_ANALYSIS_STATE_FILE_NAME,
} from '@/server/utils/agent/investment/investmentPersistenceConfig';
import { readSingleInvestmentTextAttachmentByFileName } from '@/server/utils/agent/investment/investmentTreeRepository';

export const GET_VOLATILITY_EVENTS_TOOL = 'get_volatility_events';

const REVIEW_TYPES = Object.freeze([
  'rotation_events',
  'episode_low_updates',
  'ma_gate_events',
  'blocked_triggers',
  'all_days',
  'active_episode',
  'custom',
]);

export const reviewVolatilityEventsToolOutputSchema = {
  type: 'object',
  properties: {
    ticker: {
      type: 'string',
    },
    reviewType: {
      type: 'string',
      enum: REVIEW_TYPES,
    },
    appliedFilters: {
      type: 'object',
      properties: {
        eventTypes: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['rotation', 're-rotation', 'none'],
          },
        },
        detailKeywords: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        includeNoneWithDetails: {
          type: 'boolean',
        },
        latest: {
          type: ['integer', 'null'],
        },
        fromDate: {
          type: ['string', 'null'],
        },
        toDate: {
          type: ['string', 'null'],
        },
      },
      required: ['eventTypes', 'detailKeywords', 'includeNoneWithDetails', 'latest', 'fromDate', 'toDate'],
      additionalProperties: false,
    },
    matchedCount: {
      type: 'integer',
    },
    summary: {
      type: 'object',
      properties: {
        rotationCount: {
          type: 'integer',
        },
        rerotationCount: {
          type: 'integer',
        },
        noneCount: {
          type: 'integer',
        },
        hasActiveEpisode: {
          type: 'boolean',
        },
      },
      required: ['rotationCount', 'rerotationCount', 'noneCount', 'hasActiveEpisode'],
      additionalProperties: false,
    },
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: {
            type: ['string', 'null'],
          },
          close: {
            type: ['number', 'null'],
          },
          mode: {
            type: ['string', 'null'],
            enum: ['NEUTRAL', 'VOLATILITY', null],
          },
          rotationsUsed: {
            type: 'integer',
          },
          shares: {
            type: 'integer',
          },
          movingAverage: {
            type: ['number', 'null'],
          },
          details: {
            type: 'array',
            description: 'Chronological event-detail messages for that day. A single item may itself be a pipe-delimited summary string.',
            items: {
              type: 'string',
            },
          },
          eventType: {
            type: 'string',
            enum: ['rotation', 're-rotation', 'none'],
          },
        },
        required: ['date', 'close', 'mode', 'rotationsUsed', 'shares', 'movingAverage', 'details', 'eventType'],
        additionalProperties: false,
      },
    },
  },
  required: ['ticker', 'reviewType', 'appliedFilters', 'matchedCount', 'summary', 'events'],
  additionalProperties: false,
};

export const reviewVolatilityEventsToolDefinition = {
  type: 'function',
  name: GET_VOLATILITY_EVENTS_TOOL,
  description: 'Review persisted volatility event entries for a ticker. Load the latest saved recommendation state for that ticker and deterministically return filtered events. Use this instead of passing eventEntries through the model. eventTypes, detailKeywords, and includeNoneWithDetails only affect custom reviewType calls.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      ticker: {
        type: 'string',
        description: 'Stock ticker symbol, such as MSFT or AAPL.',
      },
      reviewType: {
        type: 'string',
        enum: REVIEW_TYPES,
        description: 'Choose the event review mode. Use active_episode for the latest active volatility episode, rotation_events for both rotation and re-rotation events, and custom for explicit filters.',
      },
      latest: {
        type: ['integer', 'null'],
        description: 'Optional number of final matches to keep after filtering, while preserving chronological order. Pass null when no result limit was requested.',
      },
      fromDate: {
        type: ['string', 'null'],
        description: 'Optional inclusive start date in YYYY-MM-DD format. Pass null when no lower date bound was requested.',
      },
      toDate: {
        type: ['string', 'null'],
        description: 'Optional inclusive end date in YYYY-MM-DD format. Pass null when no upper date bound was requested.',
      },
      eventTypes: {
        type: 'array',
        description: 'Only for custom reviewType. Exact eventType values to keep. For non-custom reviewType values, pass [].',
        items: {
          type: 'string',
          enum: ['rotation', 're-rotation', 'none'],
        },
      },
      detailKeywords: {
        type: 'array',
        description: 'Only for custom reviewType. Case-insensitive substrings that must appear in details. For non-custom reviewType values, pass [].',
        items: {
          type: 'string',
        },
      },
      includeNoneWithDetails: {
        type: 'boolean',
        description: 'Only for custom reviewType. When true, eventType=none rows with non-empty details may also match. For non-custom reviewType values, pass false.',
      },
    },
    required: ['ticker', 'reviewType', 'latest', 'fromDate', 'toDate', 'eventTypes', 'detailKeywords', 'includeNoneWithDetails'],
    additionalProperties: false,
  },
};

async function loadPersistedEventEntries(normalizedTicker) {
  const persistedDocument = await readSingleInvestmentTextAttachmentByFileName({
    treeId: getRequiredInvestmentPersistenceTreeId(),
    pathSegments: buildVolatilityAnalysisPath(normalizedTicker),
    fileName: VOLATILITY_ANALYSIS_STATE_FILE_NAME,
  });

  if (!persistedDocument?.text) {
    return [];
  }

  try {
    const parsedDocument = JSON.parse(persistedDocument.text);
    return Array.isArray(parsedDocument?.eventEntries) ? parsedDocument.eventEntries : [];
  } catch {
    return [];
  }
}

function normalizeLatest(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return null;
  }

  return parsedValue;
}

function normalizeOptionalDate(value) {
  const normalizedValue = String(value ?? '').trim();
  return normalizedValue || null;
}

function normalizeStringArray(values = []) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
}

function normalizeEntryDetails(details) {
  if (Array.isArray(details)) {
    return details.map((detail) => String(detail ?? '')).filter(Boolean);
  }

  const normalizedDetail = String(details ?? '').trim();
  return normalizedDetail ? [normalizedDetail] : [];
}

function findLatestActiveEpisodeEntries(entries) {
  if (!entries.length) {
    return [];
  }

  const latestEntry = entries[entries.length - 1];

  if (latestEntry.mode !== 'VOLATILITY') {
    return [];
  }

  let episodeStartIndex = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].mode !== 'VOLATILITY') {
      episodeStartIndex = index + 1;
      break;
    }
  }

  return entries.slice(episodeStartIndex);
}

function buildReviewFilterConfig({ reviewType, eventTypes, detailKeywords, includeNoneWithDetails }) {
  switch (reviewType) {
    case 'rotation_events':
      return { eventTypes: ['rotation', 're-rotation'], detailKeywords: [], includeNoneWithDetails: false, activeEpisodeOnly: false };
    case 'episode_low_updates':
      return { eventTypes: [], detailKeywords: ['episode low'], includeNoneWithDetails: true, activeEpisodeOnly: true };
    case 'ma_gate_events':
      return { eventTypes: ['none'], detailKeywords: ['Blocked by MA gate', 'MA gate skipped - insufficient data'], includeNoneWithDetails: true, activeEpisodeOnly: false };
    case 'blocked_triggers':
      return { eventTypes: ['none'], detailKeywords: ['Blocked by MA gate'], includeNoneWithDetails: true, activeEpisodeOnly: false };
    case 'all_days':
      return { eventTypes: ['rotation', 're-rotation', 'none'], detailKeywords: [], includeNoneWithDetails: true, activeEpisodeOnly: false };
    case 'active_episode':
      return { eventTypes: [], detailKeywords: [], includeNoneWithDetails: true, activeEpisodeOnly: true };
    case 'custom':
      return {
        eventTypes: normalizeStringArray(eventTypes),
        detailKeywords: normalizeStringArray(detailKeywords),
        includeNoneWithDetails: Boolean(includeNoneWithDetails),
        activeEpisodeOnly: false,
      };
    default:
      return { eventTypes: ['rotation', 're-rotation'], detailKeywords: [], includeNoneWithDetails: true, activeEpisodeOnly: false };
  }
}

function matchesKeyword(details, detailKeywords) {
  if (!detailKeywords.length) {
    return true;
  }

  const normalizedDetails = Array.isArray(details) ? details.map((detail) => String(detail ?? '').toLowerCase()) : [];

  return detailKeywords.some((keyword) => {
    const normalizedKeyword = String(keyword ?? '').toLowerCase();
    return normalizedDetails.some((detail) => detail.includes(normalizedKeyword));
  });
}

function matchesDateRange(entryDate, fromDate, toDate) {
  const normalizedEntryDate = normalizeOptionalDate(entryDate);

  if (!normalizedEntryDate) {
    return !fromDate && !toDate;
  }

  if (fromDate && normalizedEntryDate < fromDate) {
    return false;
  }

  if (toDate && normalizedEntryDate > toDate) {
    return false;
  }

  return true;
}

function shouldKeepEntry(entry, filterConfig, fromDate, toDate) {
  if (!matchesDateRange(entry?.date, fromDate, toDate)) {
    return false;
  }

  const eventType = String(entry?.eventType ?? 'none');
  const details = Array.isArray(entry?.details) ? entry.details : [];
  const hasNonEmptyDetails = details.length > 0;
  const keywordMatch = matchesKeyword(details, filterConfig.detailKeywords);
  const eventTypeMatch = !filterConfig.eventTypes.length || filterConfig.eventTypes.includes(eventType);

  if (eventTypeMatch && keywordMatch) {
    return true;
  }

  if (filterConfig.includeNoneWithDetails && eventType === 'none' && hasNonEmptyDetails) {
    return keywordMatch;
  }

  return false;
}

function summarizeEvents(events, entries) {
  return {
    rotationCount: events.filter((entry) => entry.eventType === 'rotation').length,
    rerotationCount: events.filter((entry) => entry.eventType === 're-rotation').length,
    noneCount: events.filter((entry) => entry.eventType === 'none').length,
    hasActiveEpisode: findLatestActiveEpisodeEntries(entries).length > 0,
  };
}

export function buildReviewVolatilityEventsHandler({ includeDebug = false } = {}) {
  return async function reviewVolatilityEventsHandler({
    ticker,
    reviewType,
    latest,
    fromDate,
    toDate,
    eventTypes,
    detailKeywords,
    includeNoneWithDetails,
  }) {
    const normalizedTicker = normalizeTicker(ticker);
    const persistedEntries = await loadPersistedEventEntries(normalizedTicker);
    const normalizedEntries = Array.isArray(persistedEntries)
      ? persistedEntries.map((entry) => ({
        date: entry?.date ?? null,
        close: Number.isFinite(entry?.close) ? entry.close : null,
        mode: entry?.mode ?? null,
        rotationsUsed: Number(entry?.rotationsUsed ?? 0),
        shares: Number(entry?.shares ?? 0),
        movingAverage: Number.isFinite(entry?.movingAverage) ? entry.movingAverage : null,
        details: normalizeEntryDetails(entry?.details),
        eventType: ['rotation', 're-rotation', 'none'].includes(entry?.eventType) ? entry.eventType : 'none',
      }))
      : [];
    const normalizedReviewType = REVIEW_TYPES.includes(reviewType) ? reviewType : 'rotation_events';
    const normalizedFromDate = normalizeOptionalDate(fromDate);
    const normalizedToDate = normalizeOptionalDate(toDate);
    const normalizedLatest = normalizeLatest(latest);
    const filterConfig = buildReviewFilterConfig({
      reviewType: normalizedReviewType,
      eventTypes,
      detailKeywords,
      includeNoneWithDetails,
    });
    const candidateEntries = filterConfig.activeEpisodeOnly
      ? findLatestActiveEpisodeEntries(normalizedEntries)
      : normalizedEntries;
    const filteredEntries = candidateEntries.filter((entry) => (
      shouldKeepEntry(entry, filterConfig, normalizedFromDate, normalizedToDate)
    ));
    const limitedEntries = normalizedLatest === null
      ? filteredEntries
      : filteredEntries.slice(-normalizedLatest);
    const output = {
      ticker: normalizedTicker,
      reviewType: normalizedReviewType,
      appliedFilters: {
        eventTypes: filterConfig.eventTypes,
        detailKeywords: filterConfig.detailKeywords,
        includeNoneWithDetails: filterConfig.includeNoneWithDetails,
        latest: normalizedLatest,
        fromDate: normalizedFromDate,
        toDate: normalizedToDate,
      },
      matchedCount: limitedEntries.length,
      summary: summarizeEvents(limitedEntries, normalizedEntries),
      events: limitedEntries,
    };

    return buildInvestmentToolResult({
      toolName: GET_VOLATILITY_EVENTS_TOOL,
      toolResultType: 'event_review',
      data: output,
      includeDebug,
    });
  };
}