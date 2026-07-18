import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

const postDate = z.preprocess(
  (value) => value instanceof Date ? value.toISOString().slice(0, 10) : value,
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
);
const postTags = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === '') return [];
    const tags = Array.isArray(value) ? value : String(value).split(',');
    return tags.map((tag) => String(tag).trim()).filter(Boolean);
  },
  z.array(z.string().min(1)),
).superRefine((tags, context) => {
  if (new Set(tags).size !== tags.length) context.addIssue({ code: 'custom', message: 'Duplicate tags are not allowed.' });
});

const posts = defineCollection({
  loader: glob({ base: './content/posts', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string().trim().min(1),
    date: postDate,
    description: z.string().trim().min(1),
    tags: postTags,
    slug: z.string().trim().min(1).nullish().transform((value) => value || undefined),
    cover: z.string().nullish().transform((value) => value?.trim() || undefined),
    series: z.string().nullish().transform((value) => value?.trim() || undefined),
  }),
});

export const collections = { posts };
