#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import matter from 'gray-matter';

const postsDir = path.resolve('content/posts');
const historyDir = path.resolve('content/post-history');
const checkOnly = process.argv.includes('--check');
const entries = await fs.readdir(postsDir, { withFileTypes: true });
const sourceFiles = entries
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
  .map((entry) => path.join(postsDir, entry.name))
  .sort();

await fs.mkdir(historyDir, { recursive: true });
const seenSlugs = new Set();
const pendingSnapshots = [];
let appended = 0;

function slugify(value) {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').trim();
}

function normalizeTags(value) {
  const tags = Array.isArray(value) ? value : value == null || value === '' ? [] : String(value).split(',');
  return [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))];
}

for (const sourcePath of sourceFiles) {
  const raw = await fs.readFile(sourcePath, 'utf8');
  const { data, content } = matter(raw);
  const slugSource = String(data.slug || path.basename(sourcePath, path.extname(sourcePath))).trim();
  const slug = slugify(slugSource);
  if (!slug) throw new Error(`${path.relative(process.cwd(), sourcePath)} has an empty slug`);
  if (seenSlugs.has(slug)) throw new Error(`Duplicate post slug: ${slug}`);
  seenSlugs.add(slug);

  const historyPath = path.join(historyDir, `${slug}.json`);
  let versions = [];
  try {
    versions = JSON.parse(await fs.readFile(historyPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!Array.isArray(versions)) throw new Error(`${path.relative(process.cwd(), historyPath)} must contain an array`);

  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  if (versions.at(-1)?.hash === hash) continue;
  if (checkOnly) {
    pendingSnapshots.push(path.relative(process.cwd(), sourcePath));
    continue;
  }

  versions.push({
    id: String(versions.length + 1),
    createdAt: new Date().toISOString(),
    hash,
    title: String(data.title || '').trim(),
    date: normalizeDate(data.date),
    description: String(data.description || '').trim(),
    tags: normalizeTags(data.tags),
    cover: data.cover ? String(data.cover).trim() : '',
    content,
  });
  await fs.writeFile(historyPath, `${JSON.stringify(versions, null, 2)}\n`, 'utf8');
  appended += 1;
}

if (checkOnly && pendingSnapshots.length > 0) {
  throw new Error(`Missing current history snapshots for: ${pendingSnapshots.join(', ')}. Run npm run build, then stage the updated history files.`);
}

console.log(checkOnly
  ? `History snapshots: ${sourceFiles.length} current.`
  : `History snapshots: ${appended} appended, ${sourceFiles.length - appended} unchanged.`);
