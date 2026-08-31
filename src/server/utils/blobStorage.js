import path from 'path';
import { randomUUID } from 'crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';

const blobConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const blobAccountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;
const blobContainerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
const applicationIdentifier = process.env.APPLICATION_IDENTIFIER;

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

function getBlobClient(blobName) {
  const containerClient = getContainerClient();
  return containerClient.getBlobClient(blobName);
}

function sanitizeFileNameSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function buildBlobName({ treeId, nodeId, fileName }) {
  const extension = path.extname(fileName);
  const baseName = path.basename(fileName, extension) || 'file';
  const safeBaseName = sanitizeFileNameSegment(baseName).slice(0, 80) || 'file';
  const safeExtension = sanitizeFileNameSegment(extension).slice(0, 12);

  return `notes/${treeId}/${nodeId}/${randomUUID()}-${safeBaseName}${safeExtension}`;
}

function buildBlobMetadata({ treeId, nodeId, blobName, originalFileName }) {
  const metadata = {
    treeid: String(treeId),
    nodeid: String(nodeId),
    sourcetype: 'attachment',
    blobname: blobName,
    originalfilename: String(originalFileName),
  };

  if (applicationIdentifier) {
    metadata.applicationidentifier = applicationIdentifier;
  }

  return metadata;
}

export async function uploadNodeAttachment({ treeId, nodeId, file }) {
  const arrayBuffer = await file.arrayBuffer();
  const blobName = buildBlobName({ treeId, nodeId, fileName: file.name });
  const containerClient = getContainerClient();
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.uploadData(Buffer.from(arrayBuffer), {
    blobHTTPHeaders: {
      blobContentType: file.type || 'application/octet-stream',
    },
    metadata: buildBlobMetadata({ treeId, nodeId, blobName, originalFileName: file.name }),
  });

  return {
    blobName,
    blobUrl: blockBlobClient.url,
    contentType: file.type || 'application/octet-stream',
    byteSize: file.size,
  };
}

export async function deleteNodeAttachmentBlob(blobName) {
  if (!blobName) {
    return;
  }

  const blobClient = getBlobClient(blobName);

  await blobClient.delete({
    deleteSnapshots: 'include',
  });
}

export async function deleteNodeAttachmentBlobIfExists(blobName) {
  if (!blobName) {
    return false;
  }

  const blobClient = getBlobClient(blobName);
  const response = await blobClient.deleteIfExists({
    deleteSnapshots: 'include',
  });

  return response.succeeded;
}

export async function restoreNodeAttachmentBlobIfDeleted(blobName) {
  if (!blobName) {
    return false;
  }

  const blobClient = getBlobClient(blobName);

  try {
    await blobClient.undelete();

    // Azure AI Search blob indexers rely on LastModified for change detection.
    // Undelete restores the blob without bumping that timestamp, so resave the
    // existing metadata to force the blob indexer to pick the document up again.
    const properties = await blobClient.getProperties();
    await blobClient.setMetadata(properties.metadata || {});

    return true;
  } catch (error) {
    if (error?.statusCode === 404 || error?.details?.errorCode === 'BlobNotFound') {
      return false;
    }

    throw error;
  }
}

export async function downloadNodeAttachmentBlob(blobName) {
  if (!blobName) {
    throw new Error('Blob name is required');
  }

  const blobClient = getBlobClient(blobName);
  const properties = await blobClient.getProperties();
  const metadata = properties.metadata || {};

  if (metadata.sourcetype !== 'attachment') {
    throw new Error('Requested blob is not an attachment');
  }

  if (applicationIdentifier && metadata.applicationidentifier !== applicationIdentifier) {
    throw new Error('Requested blob is outside the allowed application scope');
  }

  const buffer = await blobClient.downloadToBuffer();

  return {
    content: buffer,
    contentType: properties.contentType || 'application/octet-stream',
    contentLength: buffer.length,
    originalFileName: metadata.originalfilename || path.basename(blobName),
    lastModified: properties.lastModified ?? null,
    etag: properties.etag ?? null,
  };
}