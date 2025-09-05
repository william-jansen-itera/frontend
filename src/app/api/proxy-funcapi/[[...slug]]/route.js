import { NextResponse } from 'next/server';

export async function GET(request, { params }) {
  const { slug } = await params;
  const { search } = new URL(request.url);

  let slugPath = '';
  slugPath = Array.isArray(slug) ? slug.join('/') : slug;
  // Build the corresponding URL for funcapi
  const targetUrl = `https://mds-functions-william.azurewebsites.net/api/${slugPath}${search}`;

  console.log('Proxying to:', targetUrl);

  const cookie = request.cookies.get('StaticWebAppsAuthCookie');
  //console.log('StaticWebAppsAuthCookie:', cookie);
  const headers = {};
  if (cookie) {
    headers['Authorization'] = `Bearer ${cookie.value}`;
  }
  // Log outgoing headers for debugging
  console.log('Outgoing headers:', headers);
  
  // You can now proxy the request as needed
  try {
    const response = await fetch(targetUrl, { method: 'GET', headers });
    const text = await response.text();
    // For debugging: include the cookie value and outgoing headers in the response
    return new NextResponse(
      JSON.stringify({
        response: text,
        StaticWebAppsAuthCookie: cookie ? cookie.value : null,
        outgoingHeaders: headers
      }),
      {
        status: response.status,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  } catch (err) {
    console.error('Proxy error:', err);
    return new NextResponse('Proxy error', { status: 500 });
  }
}