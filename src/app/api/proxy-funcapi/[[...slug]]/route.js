import { NextResponse } from 'next/server';
import { getAccessToken } from '../../../../utils/msal';

export async function GET(request, { params }) {
  const { slug } = await params;
  const { search } = new URL(request.url);

  let slugPath = '';
  slugPath = Array.isArray(slug) ? slug.join('/') : slug;
  // Build the corresponding URL for funcapi
  const targetUrl = `https://mds-functions-william.azurewebsites.net/api/${slugPath}${search}`;

  console.log('Proxying to:', targetUrl);

  // Fetch the JWT
  const jwt = await getAccessToken();
  
  try {
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