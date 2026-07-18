import type { APIRoute } from 'astro';

import { getPosts, postSlug, SITE_URL } from '../../lib/site';

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export const GET: APIRoute = async ({ site }) => {
  const posts = await getPosts();
  const root = site ?? new URL(SITE_URL);
  const postEntries = posts
    .map((post) => {
      const location = escapeXml(new URL(`/blog/${postSlug(post)}/`, root).href);
      return `  <url><loc>${location}</loc><lastmod>${escapeXml(post.data.date)}</lastmod></url>`;
    })
    .join('\n');

  const document = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${escapeXml(new URL('/', root).href)}</loc></url>`,
    `  <url><loc>${escapeXml(new URL('/blog/', root).href)}</loc></url>`,
    postEntries,
    '</urlset>',
  ].join('\n');

  return new Response(document, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
