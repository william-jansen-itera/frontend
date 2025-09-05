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
  const headers = {};
  if (cookie) {
    headers['Authorization'] = `Bearer ${cookie.value}`;
  }
  
  // You can now proxy the request as needed
  try {
    const response = await fetch(targetUrl, { method: 'GET', headers });
    const text = await response.text();
    console.log('Got response:', text);
    return new NextResponse(text, { status: response.status });
  } catch (err) {
    console.error('Proxy error:', err);
    return new NextResponse('Proxy error', { status: 500 });
  }
}