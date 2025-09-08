import { NextResponse } from 'next/server';
import { getAccessToken } from '../../../../utils/msal';
import { logTrace, logException } from '../../../../utils/appInsights';

export async function GET(request, { params }) {
  const { slug } = await params;
  const { search } = new URL(request.url);

  let slugPath = '';
  slugPath = Array.isArray(slug) ? slug.join('/') : slug;
  // Build the corresponding URL for funcapi
  const targetUrl = `https://mds-functions-william.azurewebsites.net/api/${slugPath}${search}`;

  const message = 'will call ' + targetUrl;
  logTrace(message);
  console.log(message);

  // Fetch the JWT
  message = 'Getting access token.';
  logTrace(message);
  const jwt = await getAccessToken();
  if (!jwt) {
    logTrace('Failed to obtain access token.');
    return new NextResponse('Unauthorized, failure to get access token', { status: 401 });
  }

  try {
    message = 'Proxying to: ' + targetUrl;
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
    return new NextResponse('Proxy error', { status: 500 });
  }
}