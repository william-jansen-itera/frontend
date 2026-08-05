import { NextResponse } from 'next/server';
import { downloadNodeAttachmentBlob } from '@/server/utils/blobStorage';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const blobName = searchParams.get('blobName');

  if (!blobName) {
    return NextResponse.json({ error: 'blobName is required' }, { status: 400 });
  }

  try {
    const attachment = await downloadNodeAttachmentBlob(blobName);

    return new NextResponse(attachment.content, {
      status: 200,
      headers: {
        'Content-Type': attachment.contentType,
        'Content-Length': String(attachment.contentLength),
        'Content-Disposition': `inline; filename="${attachment.originalFileName.replace(/"/g, '')}"`,
        'Cache-Control': 'private, max-age=300',
        ...(attachment.lastModified ? { 'Last-Modified': attachment.lastModified.toUTCString() } : {}),
        ...(attachment.etag ? { ETag: attachment.etag } : {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load attachment';
    const status = /outside the allowed application scope|not an attachment/i.test(message) ? 403 : 404;

    return NextResponse.json({ error: message }, { status });
  }
}