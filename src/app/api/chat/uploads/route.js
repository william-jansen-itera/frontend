import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireAuthenticatedPrincipal } from '@/server/utils/auth';
import { getAuditMetadata } from '@/server/utils/tree/treeCatalog';
import { createChatUpload } from '@/server/utils/agent/knowledgeTrees/chatUploadRepository';
import { deleteStagingBlob, uploadStagingBlob } from '@/server/utils/agent/knowledgeTrees/stagingBlob';
import { validateChatUpload } from '@/server/utils/agent/knowledgeTrees/uploadValidation.mjs';

export const runtime = 'nodejs';

export async function POST(request) {
  try {
    const principal = requireAuthenticatedPrincipal(request);
    const ownerObjectId = getAuditMetadata(principal).updatedByObjectId;
    if (!ownerObjectId) {
      return NextResponse.json({ error: 'An authenticated user is required.' }, { status: 401 });
    }
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data')) {
      return NextResponse.json({ error: 'A multipart file upload is required.' }, { status: 415 });
    }
    const declaredLength = Number(request.headers.get('content-length'));
    if (declaredLength > 11 * 1024 * 1024) {
      return NextResponse.json({ error: 'Chat uploads must be 10 MB or less.' }, { status: 413 });
    }
    const formData = await request.formData();
    const files = formData.getAll('file');
    if (files.length !== 1 || Array.from(formData.keys()).some((key) => key !== 'file')) {
      return NextResponse.json({ error: 'Exactly one file is required.' }, { status: 400 });
    }
    const file = files[0];
    const { fileName } = validateChatUpload(file);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length !== file.size) {
      return NextResponse.json({ error: 'Upload size did not match the file.' }, { status: 400 });
    }

    const uploadId = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
    const contentType = String(file.type || 'application/octet-stream').slice(0, 255);
    const blobName = await uploadStagingBlob({ uploadId, ownerObjectId, fileName, contentType, bytes });

    try {
      await createChatUpload({
        uploadId, ownerObjectId, fileName, contentType, byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), blobName, createdAt, expiresAt,
      });
    } catch (error) {
      await deleteStagingBlob(blobName);
      throw error;
    }

    return NextResponse.json({ uploadId, fileName, expiresAt: expiresAt.toISOString(), status: 'staged' }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.status ? error.message : 'Could not stage chat upload.' }, { status: error.status || 500 });
  }
}