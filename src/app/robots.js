import { getSiteOrigin } from '@/server/utils/siteOrigin';

export default async function robots() {
  const origin = await getSiteOrigin();

  return {
    rules: {
      userAgent: '*',
      allow: '/',
    },
    sitemap: `${origin}/sitemap.xml`,
  };
}