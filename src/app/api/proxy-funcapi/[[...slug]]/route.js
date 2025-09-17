
import { NextResponse } from 'next/server';
import { getFunctionAppAccessToken, decodeJwt } from '../../../../server/utils/functionAppToken';


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


  // Attach a token for the function API using client credential flow
  let jwt;

  let decoded;
  try {
    logTrace('Acquiring function app access token.');
    jwt = await getFunctionAppAccessToken();
    logTrace('Successfully acquired function app access token.');
  } catch (err) {
    logException(err);
    // Return the error in the response (testing only, not for production)
    return new NextResponse(`Failed to acquire function app access token: ${err.message || err.toString()}`, { status: 500 });
  }

  if (!jwt) {
    message = 'Failed to obtain function app access token.';
    logTrace(message);
    return new NextResponse('Unauthorized, failure to get access token', { status: 401 });
  } else {
    decoded = decodeJwt(jwt);
    console.log('Decoded JWT:', decoded);
    logTrace(JSON.stringify(decoded, null, 2));
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