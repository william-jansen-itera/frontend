// src/app/api/proxy-funcapi/route.js
import { NextResponse } from 'next/server';

export async function GET(request) {
  // Extract the path and query from the incoming request
  const { search, pathname } = new URL(request.url);
  // Remove '/api/proxy-funcapi' from the pathname to get the funcapi path
  const funcapiPath = pathname.replace(/^\/api\/proxy-funcapi/, "");
  // Build the target URL for funcapi
  const targetUrl = `https://mds-functions-william.azurewebsites.net/api${funcapiPath}${search}`;

  // Forward authentication cookie if present
  const cookie = request.cookies.get('AppServiceAuthSession');
  let headers = {};
  if (cookie) {
    headers['Cookie'] = `AppServiceAuthSession=${cookie.value}`;
  }

  // Forward the request to funcapi
  const response = await fetch(targetUrl, { headers });
  const text = await response.text();
  return new NextResponse(text, { status: response.status });
}

export async function POST(request) {
  const { search, pathname } = new URL(request.url);
  const funcapiPath = pathname.replace(/^\/api\/proxy-funcapi/, "");
  const targetUrl = `https://mds-functions-william.azurewebsites.net/api${funcapiPath}${search}`;

  const cookie = request.cookies.get('AppServiceAuthSession');
  let headers = {};
  if (cookie) {
    headers['Cookie'] = `AppServiceAuthSession=${cookie.value}`;
  }

  // Forward body and headers
  const body = await request.text();
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body
  });
  const text = await response.text();
  return new NextResponse(text, { status: response.status });
}
