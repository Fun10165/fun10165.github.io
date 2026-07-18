import { getCollection, type CollectionEntry } from 'astro:content';

export const SITE_URL = 'https://fun10165.github.io';
export const SITE_TITLE = 'Fun10165';
export const SITE_DESCRIPTION = 'Notes from Fun10165 on systems, learning, and the web.';

export type Post = CollectionEntry<'posts'>;

export function postSlug(post: Post): string {
  const source = post.data.slug || post.id.replace(/\.md$/i, '').split('/').at(-1) || post.id;
  const slug = source
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`Post ${post.id} has an empty slug.`);
  return slug;
}

export function comparePostsNewestFirst(a: Post, b: Post): number {
  return b.data.date.localeCompare(a.data.date) || a.data.title.localeCompare(b.data.title, 'zh-CN');
}

export async function getPosts(): Promise<Post[]> {
  const posts = (await getCollection('posts')).sort(comparePostsNewestFirst);
  const seen = new Map<string, string>();
  for (const post of posts) {
    const slug = postSlug(post);
    const previous = seen.get(slug);
    if (previous) throw new Error(`Duplicate post slug "${slug}" in ${previous} and ${post.id}`);
    seen.set(slug, post.id);
  }
  return posts;
}

export function formatPostDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

export function estimateReadingTime(content: string): string {
  const withoutCode = content.replace(/```[\s\S]*?```/g, ' ');
  const cjkCharacters = withoutCode.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length || 0;
  const latinWords = withoutCode
    .replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return `${Math.max(1, Math.ceil(cjkCharacters / 400 + latinWords / 200))} min read`;
}

export function postCoverUrl(post: Post): string | undefined {
  const cover = post.data.cover;
  if (!cover) return undefined;
  if (/^(?:https?:)?\/\//i.test(cover) || cover.startsWith('/')) return cover;
  const directory = post.id.includes('/') ? post.id.slice(0, post.id.lastIndexOf('/') + 1) : '';
  const normalized = new URL(`${directory}${cover.replace(/^\.\//, '')}`, 'https://content.local/').pathname.slice(1);
  return `/content/posts/${normalized}`;
}

export function postSourcePath(post: Post): string {
  return `content/posts/${post.id}`;
}


export interface HistoryVersion {
  id: string;
  createdAt: string;
  hash: string;
  title: string;
  date: string;
  description: string;
  tags: string[];
  cover?: string;
  content: string;
}
