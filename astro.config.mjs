import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import sitemap from '@astrojs/sitemap';
import remarkFootnotes from 'remark-footnotes';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';

import { rehypeRewriteLocalUrls, sanitizeSchema } from './src/lib/markdown.mjs';

export default defineConfig({
  site: 'https://fun10165.github.io',
  output: 'static',
  trailingSlash: 'always',
  integrations: [sitemap()],
  markdown: {
    processor: unified({
      remarkPlugins: [remarkGfm, remarkFootnotes, remarkMath],
      rehypePlugins: [
        rehypeRaw,
        [rehypeSanitize, sanitizeSchema],
        rehypeRewriteLocalUrls,
        [rehypeKatex, { strict: 'ignore', throwOnError: false }],
        rehypeSlug,
      ],
    }),
    syntaxHighlight: false,
  },
});
