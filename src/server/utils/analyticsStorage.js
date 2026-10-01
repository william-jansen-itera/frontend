import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';

const blobConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const blobAccountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;
const blobContainerName = process.env.AZURE_STORAGE_CONTAINER_NAME;

function getContainerClient() {
  if (!blobContainerName) {
    throw new Error('Azure Blob container env var is not configured');
  }

  if (blobConnectionString) {
    return BlobServiceClient
      .fromConnectionString(blobConnectionString)
      .getContainerClient(blobContainerName);
  }

  if (!blobAccountUrl) {
    throw new Error('Azure Blob connection env vars are not configured');
  }

  return new BlobServiceClient(blobAccountUrl, new DefaultAzureCredential())
    .getContainerClient(blobContainerName);
}

function sanitizePathSegment(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

function sanitizeMetadataValue(value) {
  return String(value ?? '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .trim()
    .slice(0, 1024);
}

function buildPageVisitPrefix(appIdentifier) {
  return `analytics/${sanitizePathSegment(appIdentifier)}/page-visits`;
}

function buildPageVisitLogBlobName(appIdentifier) {
  return `${buildPageVisitPrefix(appIdentifier)}/events.ndjson`;
}

function buildPageVisitMetadata(eventPayload) {
  return {
    applicationidentifier: sanitizeMetadataValue(eventPayload.appIdentifier),
    eventtype: 'pagevisit',
    pagepath: sanitizeMetadataValue(eventPayload.pagePath),
    deviceclass: sanitizeMetadataValue(eventPayload.deviceClass),
    browserfamily: sanitizeMetadataValue(eventPayload.browserFamily),
  };
}

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === 'object' ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

async function downloadBlobText(blobClient) {
  if (!(await blobClient.exists())) {
    return null;
  }

  const content = await blobClient.downloadToBuffer();
  return content.toString('utf8');
}

export async function writePageVisitEvent(eventPayload) {
  const containerClient = getContainerClient();
  const blobName = buildPageVisitLogBlobName(eventPayload.appIdentifier);
  const appendBlobClient = containerClient.getAppendBlobClient(blobName);
  const content = Buffer.from(`${JSON.stringify(eventPayload)}\n`, 'utf8');

  await appendBlobClient.createIfNotExists({
    blobHTTPHeaders: {
      blobContentType: 'application/x-ndjson; charset=utf-8',
    },
    metadata: buildPageVisitMetadata(eventPayload),
  });

  await appendBlobClient.appendBlock(content, content.length);

  return {
    blobName,
    recordedAt: eventPayload.recordedAt,
  };
}

export async function listPageVisitEvents(appIdentifier) {
  const containerClient = getContainerClient();
  const logBlobName = buildPageVisitLogBlobName(appIdentifier);
  const logBlobClient = containerClient.getBlobClient(logBlobName);
  const logContent = await downloadBlobText(logBlobClient);

  return logContent ? parseJsonLines(logContent) : [];
}