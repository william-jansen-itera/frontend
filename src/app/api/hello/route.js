// src/app/api/hello/route.js
import { NextResponse } from 'next/server';

export async function GET(request) {
  // Try to get the x-ms-client-principal header
  const principalHeader = request.headers.get('x-ms-client-principal');
  let userName = 'Anonymous';
  if (principalHeader) {
    try {
      const principal = JSON.parse(Buffer.from(principalHeader, 'base64').toString('utf8'));
      console.log('principal: ', principal);
      userName = principal.userDetails || 'Authenticated User';
    } catch (e) {
      userName = 'Invalid principal';
    }
  }
  return new NextResponse(`Hello from next API, ${userName}!`);
}
