import {
  appendJsonLineBlobRecord,
  listJsonLineBlobRecords,
  sanitizeBlobMetadataValue,
  sanitizeBlobPathSegment,
} from '@/server/utils/blobEventLogStorage';

function buildPageVisitPrefix(appIdentifier) {
  return `analytics/${sanitizeBlobPathSegment(appIdentifier)}/page-visits`;
}

function buildPageVisitLogBlobName(appIdentifier) {
  return `${buildPageVisitPrefix(appIdentifier)}/events.ndjson`;
}

function buildPageVisitMetadata(eventPayload) {
  return {
    applicationidentifier: sanitizeBlobMetadataValue(eventPayload.appIdentifier),
    eventtype: 'pagevisit',
    pagepath: sanitizeBlobMetadataValue(eventPayload.pagePath),
    clientip: sanitizeBlobMetadataValue(eventPayload.clientIp),
    deviceclass: sanitizeBlobMetadataValue(eventPayload.deviceClass),
    browserfamily: sanitizeBlobMetadataValue(eventPayload.browserFamily),
  };
}

export async function writePageVisitEvent(eventPayload) {
  const blobName = buildPageVisitLogBlobName(eventPayload.appIdentifier);
  await appendJsonLineBlobRecord({
    blobName,
    eventPayload,
    metadata: buildPageVisitMetadata(eventPayload),
  });

  return {
    blobName,
    recordedAt: eventPayload.recordedAt,
  };
}

export async function listPageVisitEvents(appIdentifier) {
  const logBlobName = buildPageVisitLogBlobName(appIdentifier);
  return listJsonLineBlobRecords(logBlobName);
}