import path from 'path';
import { randomUUID } from 'crypto';
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

export async function uploadNodeAttachment({ treeId, nodeId, file }) {
  const arrayBuffer = await file.arrayBuffer();
  const blobName = buildBlobName({ treeId, nodeId, fileName: file.name });
  const containerClient = getContainerClient();
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.uploadData(Buffer.from(arrayBuffer), {
    blobHTTPHeaders: {
      blobContentType: file.type || 'application/octet-stream',
    },
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

  const containerClient = getContainerClient();
  await containerClient.deleteBlob(blobName, {
    deleteSnapshots: 'include',
  });
}

export async function deleteNodeAttachmentBlobIfExists(blobName) {
  if (!blobName) {
    return false;
  }

  const containerClient = getContainerClient();
  const response = await containerClient.deleteBlobIfExists(blobName, {
    deleteSnapshots: 'include',
  });

  return response.succeeded;
}