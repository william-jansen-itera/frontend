import { NextResponse } from 'next/server';
import { requireAuthenticatedPrincipal } from '@/server/utils/auth';
import { getAuditMetadata } from '@/server/utils/tree/treeCatalog';
import { getOwnedChatUpload } from '@/server/utils/agent/knowledgeTrees/chatUploadRepository';
import { extractUploadFilenameWords } from '@/server/utils/agent/knowledgeTrees/uploadValidation.mjs';

export const runtime = 'nodejs';

export async function GET(request, { params }) {
  try {
    const principal = requireAuthenticatedPrincipal(request);
    const ownerObjectId = getAuditMetadata(principal).updatedByObjectId;
    if (!ownerObjectId) {
      return NextResponse.json({ error: 'An authenticated user is required.' }, { status: 401 });
    }
    const { uploadId } = await params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) {
      return NextResponse.json({ error: 'Upload was not found.' }, { status: 404 });
    }
    const upload = await getOwnedChatUpload({ uploadId, ownerObjectId });
    if (!upload) {
      return NextResponse.json({ error: 'Upload was not found.' }, { status: 404 });
    }
    return NextResponse.json({
      uploadId: String(upload.id), fileName: extractUploadFilenameWords(upload.fileName).join(' '), status: upload.status,
      note: upload.status === 'succeeded' ? upload.note : null,
      caption: upload.status === 'succeeded' ? upload.caption : null,
      failureSummary: upload.status === 'failed' ? upload.failureSummary : null,
      expiresAt: upload.expiresAt,
    });
  } catch (error) {
    return NextResponse.json({ error: error.status ? error.message : 'Could not read chat upload.' }, { status: error.status || 500 });
  }
}