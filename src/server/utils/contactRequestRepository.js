import { getRequiredApplicationIdentifier } from '@/server/utils/applicationIdentifier';
import {
  appendJsonLineBlobRecord,
  listJsonLineBlobRecords,
  sanitizeBlobMetadataValue,
  sanitizeBlobPathSegment,
} from '@/server/utils/blobEventLogStorage';

const CONTACT_REQUEST_RETENTION_DAYS = 30;

function buildContactRequestLogBlobName(appIdentifier) {
  return `analytics/${sanitizeBlobPathSegment(appIdentifier)}/contact-requests/events.ndjson`;
}

function buildContactRequestMetadata(eventPayload) {
  return {
    applicationidentifier: sanitizeBlobMetadataValue(eventPayload.appIdentifier),
    eventtype: 'contactrequest',
    contactprofile: sanitizeBlobMetadataValue(eventPayload.contactProfile),
    email: sanitizeBlobMetadataValue(eventPayload.email),
  };
}

function buildEventId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeText(value) {
  const normalizedValue = String(value ?? '').trim();
  return normalizedValue || null;
}

function normalizeBoolean(value) {
  return value === true;
}

function normalizeRecordedAt(value) {
  const normalizedValue = String(value ?? '').trim();

  if (!normalizedValue) {
    return null;
  }

  const parsedValue = new Date(normalizedValue);
  return Number.isNaN(parsedValue.getTime()) ? null : parsedValue.toISOString();
}

function getRetentionThresholdIso(now = new Date()) {
  return new Date(now.getTime() - (CONTACT_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1000)).toISOString();
}

function mapContactRequestEvent(eventEntry) {
  const createdAt = normalizeRecordedAt(eventEntry?.recordedAt);

  if (!createdAt) {
    return null;
  }

  return {
    eventId: normalizeText(eventEntry?.eventId) || buildEventId(),
    appIdentifier: normalizeText(eventEntry?.appIdentifier),
    contactProfile: normalizeText(eventEntry?.contactProfile) || 'individual',
    name: normalizeText(eventEntry?.name) || 'Unknown sender',
    company: normalizeText(eventEntry?.company),
    email: normalizeText(eventEntry?.email) || '',
    phone: normalizeText(eventEntry?.phone),
    wantsCall: normalizeBoolean(eventEntry?.wantsCall),
    message: normalizeText(eventEntry?.message) || '',
    userAgent: normalizeText(eventEntry?.userAgent),
    userAgentRaw: normalizeText(eventEntry?.userAgentRaw),
    createdAt,
  };
}

function compareContactRequestsDescending(left, right) {
  const recordedAtComparison = String(right?.createdAt ?? '').localeCompare(String(left?.createdAt ?? ''));

  if (recordedAtComparison !== 0) {
    return recordedAtComparison;
  }

  return String(right?.eventId ?? '').localeCompare(String(left?.eventId ?? ''));
}

export async function recordContactRequest({
  contactProfile,
  name,
  company = null,
  email,
  phone = null,
  wantsCall,
  message,
  userAgent = null,
  userAgentRaw = null,
}) {
  const appIdentifier = getRequiredApplicationIdentifier();
  const recordedAt = new Date().toISOString();
  const eventId = buildEventId();
  const eventPayload = {
    eventId,
    recordedAt,
    appIdentifier,
    contactProfile,
    name,
    company,
    email,
    phone,
    wantsCall: normalizeBoolean(wantsCall),
    message,
    userAgent,
    userAgentRaw,
  };
  const blobName = buildContactRequestLogBlobName(appIdentifier);

  await appendJsonLineBlobRecord({
    blobName,
    eventPayload,
    metadata: buildContactRequestMetadata(eventPayload),
  });

  return {
    eventId,
    recordedAt,
    blobName,
  };
}

export async function listRecentContactRequests() {
  const appIdentifier = getRequiredApplicationIdentifier();
  const retentionThresholdIso = getRetentionThresholdIso();
  const events = await listJsonLineBlobRecords(buildContactRequestLogBlobName(appIdentifier));

  return events
    .filter((eventEntry) => eventEntry && eventEntry.appIdentifier === appIdentifier)
    .map(mapContactRequestEvent)
    .filter((eventEntry) => eventEntry && eventEntry.createdAt >= retentionThresholdIso)
    .sort(compareContactRequestsDescending);
}