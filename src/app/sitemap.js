import { getSiteOrigin } from '@/server/utils/siteOrigin';

export default async function sitemap() {
  const origin = await getSiteOrigin();

  return ['/', '/about', '/contact'].map((path) => ({
    url: new URL(path, origin).href,
  }));
}