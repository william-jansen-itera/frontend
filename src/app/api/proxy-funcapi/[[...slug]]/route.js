import { NextResponse } from 'next/server';
import { getAccessToken } from '../../../../utils/msal';


export async function GET(request, { params }) {
  const { logTrace, logException } = await import('../../../../server/utils/logging');
  const { slug } = await params;
  const { search } = new URL(request.url);

  let slugPath = '';
  slugPath = Array.isArray(slug) ? slug.join('/') : slug;
  // Build the corresponding URL for funcapi
  const targetUrl = `https://mds-functions-william.azurewebsites.net/api/${slugPath}${search}`;

  let message = 'Will call ' + targetUrl;
  logTrace(message);
  console.log(message);

  // Fetch the JWT
  message = 'Getting access token.';
  console.log(message);
  logTrace(message);
  const jwt = await getAccessToken();
  if (!jwt) {
    message = 'Failed to obtain access token.';
    logTrace(message);
    return new NextResponse('Unauthorized, failure to get access token', { status: 401 });
  }

  try {
    message = 'Proxying to: ' + targetUrl;
    console.log(message);
    logTrace(message);
    const response = await fetch(targetUrl, {
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
    });  
    const text = await response.text();
    return new NextResponse(text, { status: response.status });
  } catch (err) {
    console.error('Proxy error:', err);
    logException(err);
    return new NextResponse('Proxy error', { status: 500 });
  }
}