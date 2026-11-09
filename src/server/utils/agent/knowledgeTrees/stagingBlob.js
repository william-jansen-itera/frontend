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