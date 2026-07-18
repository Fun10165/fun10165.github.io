import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';

import { getPosts, postSlug, SITE_TITLE, SITE_URL } from '../../lib/site';

export const GET: APIRoute = async ({ site }) => {
  const posts = await getPosts();
  const root = site ?? new URL(SITE_URL);
  const blogUrl = new URL('/blog/', root);
  const feedUrl = new URL('/blog/feed.xml', root);

  return rss({
    title: `${SITE_TITLE} Blog`,
    description: `Notes from ${SITE_TITLE}`,
    site: blogUrl,
    xmlns: { atom: 'http://www.w3.org/2005/Atom' },
    customData: [
      '<language>zh-CN</language>',
      `<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
      `<atom:link href="${feedUrl.href}" rel="self" type="application/rss+xml"/>`,
    ].join(''),
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: new Date(`${post.data.date}T00:00:00Z`),
      link: postSlug(post),
      categories: post.data.tags,
    })),
  });
};
