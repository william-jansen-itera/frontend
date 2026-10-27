import { headers } from 'next/headers';

export async function getSiteOrigin() {
  if (process.env.SITE_URL?.trim()) {
    return new URL(process.env.SITE_URL.trim()).origin;
  }

  const requestHeaders = await headers();
  const host = (requestHeaders.get('x-forwarded-host') || requestHeaders.get('host'))?.split(',')[0].trim();
  const protocol = (requestHeaders.get('x-forwarded-proto') || (host?.startsWith('localhost') ? 'http' : 'https')).split(',')[0].trim();

  return new URL(`${protocol}://${host}`).origin;
}