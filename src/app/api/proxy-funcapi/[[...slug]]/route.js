import { NextResponse } from 'next/server';

export async function GET(request, { params }) {
  const { slug } = await params;
  const { search } = new URL(request.url);

  let slugPath = '';
  slugPath = Array.isArray(slug) ? slug.join('/') : slug;
  // Build the corresponding URL for funcapi
  const targetUrl = `https://mds-functions-william.azurewebsites.net/api/${slugPath}${search}`;

  console.log('Proxying to:', targetUrl);

  // Fetch the JWT from /.auth/me
  let jwt = null;
  try {
      const meRes = await fetch('/.auth/me', {
      headers: {
        Cookie: request.headers.get('cookie') || ''
      }
      });
      if (meRes.ok) {
        const meData = await meRes.json();
        // Try to get id_token or access_token
        jwt = meData?.idToken || (meData?.accessToken || null);
        // If the structure is an array (as in Azure SWA), extract from clientPrincipal
        if (!jwt && Array.isArray(meData?.clientPrincipal?.identityProvider)) {
          jwt = meData.clientPrincipal.identityProvider[0]?.id_token || null;
        }
        // If the structure is an array of identities
        if (!jwt && Array.isArray(meData?.identities)) {
          jwt = meData.identities[0]?.id_token || null;
        }
      }
  } catch (e) {
    console.error('Error fetching /.auth/me:', e);
  }

  const headers = {};
  if (jwt) {
    headers['Authorization'] = `Bearer ${jwt}`;
  }
  
  // You can now proxy the request as needed
  try {
  const response = await fetch(targetUrl, { method: 'GET', headers });
  const text = await response.text();
  return new NextResponse(text, { status: response.status });
  } catch (err) {
    console.error('Proxy error:', err);
    return new NextResponse('Proxy error', { status: 500 });
  }
}