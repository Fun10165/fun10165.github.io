import fs from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import remarkFootnotes from 'remark-footnotes';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

const postsDir = path.resolve('content/posts');
const imageExtensions = {
  '.apng': true,
  '.avif': true,
  '.gif': true,
  '.jpeg': true,
  '.jpg': true,
  '.png': true,
  '.svg': true,
  '.webp': true,
};

export const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames || []), 'input', 'section', 'nav'])],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []), ['className', /^language-./, 'math-inline', 'math-display']],
    input: [['type', 'checkbox'], ['checked'], ['disabled']],
    li: [...(defaultSchema.attributes?.li || []), ['className', 'task-list-item']],
    td: [...(defaultSchema.attributes?.td || []), ['align', 'left', 'right', 'center']],
    th: [...(defaultSchema.attributes?.th || []), ['align', 'left', 'right', 'center']],
    ul: [...(defaultSchema.attributes?.ul || []), ['className', 'contains-task-list']],
    section: [['class', 'footnotes'], ['data-footnotes']],
    a: [...(defaultSchema.attributes?.a || []), ['ariaBacklabel'], ['id'], ['href'], ['role'], ['dataFootnoteRef'], ['dataFootnoteBackref'], ['className', 'data-footnote-backref']],
    sup: [['dataFootnoteRef']],
    ol: [...(defaultSchema.attributes?.ol || []), ['dataFootnotes']],
    nav: [['class', 'toc']],
  },
};

function slugify(value) {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function markdownFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(fullPath);
    return entry.name.toLowerCase().endsWith('.md') ? [fullPath] : [];
  });
}

const sourcePathToSlug = new Map(
  markdownFiles(postsDir).map((sourcePath) => {
    const { data } = matter(fs.readFileSync(sourcePath, 'utf8'));
    const fallback = slugify(path.basename(sourcePath, path.extname(sourcePath)));
    return [path.resolve(sourcePath), String(data.slug || fallback)];
  }),
);


function rewriteUrl(value, sourcePath, isImage) {
  if (!value || value.startsWith('/') || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return value;
  const match = String(value).match(/^([^?#]*)([?#].*)?$/);
  const pathname = match?.[1] || '';
  const suffix = match?.[2] || '';
  let decoded;
  try {
    decoded = decodeURI(pathname);
  } catch {
    decoded = pathname;
  }

  const sourceDirectory = sourcePath ? path.dirname(sourcePath) : postsDir;
  const absoluteTarget = path.resolve(sourceDirectory, decoded);

  if (isImage && imageExtensions[path.extname(decoded).toLowerCase()]) {
    const relativeAsset = path.relative(postsDir, absoluteTarget).split(path.sep).join('/');
    return `/content/posts/${relativeAsset}${suffix}`;
  }

  if (!isImage && path.extname(decoded).toLowerCase() === '.md') {
    const slug = sourcePathToSlug.get(absoluteTarget);
    if (slug) return `/blog/${slug}/${suffix}`;
  }

  return value;
}

function visit(node, callback) {
  callback(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) visit(child, callback);
  }
}

export function rehypeRewriteLocalUrls() {
  return (tree, file) => {
    const sourcePath = file.path ? path.resolve(String(file.path)) : undefined;
    visit(tree, (node) => {
      if (node.type !== 'element') return;
      if (node.tagName === 'img' && typeof node.properties?.src === 'string') {
        node.properties.src = rewriteUrl(node.properties.src, sourcePath, true);
      }
      if (node.tagName === 'a' && typeof node.properties?.href === 'string') {
        node.properties.href = rewriteUrl(node.properties.href, sourcePath, false);
      }
    });
  };
}

export async function renderArchivedMarkdown(content, sourcePath) {
  const result = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFootnotes)
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeRewriteLocalUrls)
    .use(rehypeKatex, { strict: 'ignore', throwOnError: false })
    .use(rehypeSlug)
    .use(rehypeStringify)
    .process({ path: sourcePath, value: content });
  return String(result);
}
