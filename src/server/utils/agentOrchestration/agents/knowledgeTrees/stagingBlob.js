import { createHash } from 'node:crypto';
import { getRequiredApplicationIdentifier } from '@/server/utils/applicationIdentifier';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';

function getStagingContainer() {
  const containerName = process.env.CHAT_UPLOAD_CONTAINER_NAME;
  const connectionString = process.env.CHAT_UPLOAD_STORAGE_CONNECTION_STRING;
  const accountUrl = process.env.CHAT_UPLOAD_STORAGE_ACCOUNT_URL;

  if (!containerName || (!connectionString && !accountUrl)) {
    throw new Error('Temporary chat upload storage is not configured.');
  }

  const client = connectionString
    ? BlobServiceClient.fromConnectionString(connectionString)
    : new BlobServiceClient(accountUrl, new DefaultAzureCredential());

  return client.getContainerClient(containerName);
}

export async function uploadStagingBlob({ uploadId, ownerObjectId, fileName, contentType, bytes }) {
  const blobName = `uploads/${uploadId}/${fileName}`;
  await getStagingContainer().getBlockBlobClient(blobName).uploadData(bytes, {
    blobHTTPHeaders: { blobContentType: contentType },
    metadata: {
      uploadid: uploadId,
      ownerobjectid: ownerObjectId,
      applicationidentifier: getRequiredApplicationIdentifier(),
      originalfilename: fileName.replace(/[^\x20-\x7e]/g, ' ').slice(0, 255),
    },
  });
  return blobName;
}

export async function deleteStagingBlob(blobName) {
  return getStagingContainer().getBlobClient(blobName).deleteIfExists({ deleteSnapshots: 'include' });
}

export async function readVerifiedStagingFile({ upload, ownerObjectId }) {
  if (!upload?.blobName || upload.status !== 'succeeded' ||
      !Number.isSafeInteger(upload.byteSize) || upload.byteSize < 1 || upload.byteSize > 10 * 1024 * 1024) {
    throw new Error('The original upload is no longer available. Preview again.');
  }
  const blob = getStagingContainer().getBlobClient(upload.blobName);
  const properties = await blob.getProperties();
  if (properties.contentLength !== upload.byteSize ||
      properties.metadata?.uploadid?.toLowerCase() !== String(upload.id).toLowerCase() ||
      properties.metadata?.ownerobjectid !== ownerObjectId ||
      properties.metadata?.applicationidentifier !== getRequiredApplicationIdentifier()) {
    throw new Error('The staged file no longer matches the owned upload. Preview again.');
  }
  const bytes = await blob.downloadToBuffer();
  if (bytes.length !== upload.byteSize || createHash('sha256').update(bytes).digest('hex') !== upload.sha256) {
    throw new Error('The original uploaded file changed. Preview again.');
  }
  return {
    name: upload.fileName,
    type: upload.contentType,
    size: bytes.length,
    arrayBuffer: async () => bytes,
  };
}