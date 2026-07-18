import type { HistoryVersion } from './site';

const historyModules = import.meta.glob<unknown>('../../content/post-history/*.json', {
  eager: true,
  import: 'default',
});

const recordKeys: Record<string, true> = {
  id: true,
  createdAt: true,
  hash: true,
  title: true,
  date: true,
  description: true,
  tags: true,
  cover: true,
  content: true,
};

function invalid(source: string, recordIndex: number | undefined, detail: string): never {
  const location = recordIndex === undefined ? source : `${source}, record ${recordIndex + 1}`;
  throw new Error(`Invalid post history (${location}): ${detail}`);
}

function requireString(
  record: Record<string, unknown>,
  key: keyof HistoryVersion,
  source: string,
  recordIndex: number,
): string {
  const value = record[key];
  if (typeof value !== 'string') invalid(source, recordIndex, `"${key}" must be a string`);
  return value;
}

function validateVersion(value: unknown, source: string, recordIndex: number): HistoryVersion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(source, recordIndex, 'each version must be an object');
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!recordKeys[key]) invalid(source, recordIndex, `unknown field "${key}"`);
  }

  const id = requireString(record, 'id', source, recordIndex);
  if (!id || id.trim() !== id || id === '.' || id === '..' || /[\\/?#]/u.test(id)) {
    invalid(source, recordIndex, '"id" must be a non-empty, single URL path segment');
  }

  const createdAt = requireString(record, 'createdAt', source, recordIndex);
  const timestamp = new Date(createdAt);
  if (Number.isNaN(timestamp.valueOf()) || timestamp.toISOString() !== createdAt) {
    invalid(source, recordIndex, '"createdAt" must be an ISO 8601 UTC timestamp');
  }

  const hash = requireString(record, 'hash', source, recordIndex);
  if (!/^[0-9a-f]{16}$/u.test(hash)) {
    invalid(source, recordIndex, '"hash" must be a 16-character lowercase hexadecimal digest');
  }

  const title = requireString(record, 'title', source, recordIndex);
  if (!title.trim()) invalid(source, recordIndex, '"title" must not be empty');

  const date = requireString(record, 'date', source, recordIndex);
  const midnight = new Date(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(date)
    || Number.isNaN(midnight.valueOf())
    || midnight.toISOString().slice(0, 10) !== date
  ) {
    invalid(source, recordIndex, '"date" must be a valid YYYY-MM-DD date');
  }

  const description = requireString(record, 'description', source, recordIndex);
  const content = requireString(record, 'content', source, recordIndex);

  if (!Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== 'string' || !tag.trim())) {
    invalid(source, recordIndex, '"tags" must be an array of non-empty strings');
  }
  const tags = record.tags as string[];

  if (record.cover !== undefined && typeof record.cover !== 'string') {
    invalid(source, recordIndex, '"cover" must be a string when present');
  }

  return {
    id,
    createdAt,
    hash,
    title,
    date,
    description,
    tags,
    ...(record.cover === undefined ? {} : { cover: record.cover as string }),
    content,
  };
}

function validateHistory(value: unknown, source: string): readonly HistoryVersion[] {
  if (!Array.isArray(value)) invalid(source, undefined, 'the root value must be an array');

  const versions = value.map((record, index) => validateVersion(record, source, index));
  const seenIds = new Set<string>();
  for (const [index, version] of versions.entries()) {
    if (seenIds.has(version.id)) invalid(source, index, `duplicate version id "${version.id}"`);
    seenIds.add(version.id);
  }
  return versions;
}

const histories = new Map<string, readonly HistoryVersion[]>();
for (const [source, rawHistory] of Object.entries(historyModules)) {
  const fileName = source.slice(source.lastIndexOf('/') + 1);
  const slug = fileName.slice(0, -'.json'.length);
  if (!slug) invalid(source, undefined, 'the filename must include a slug');
  if (histories.has(slug)) invalid(source, undefined, `duplicate history for slug "${slug}"`);
  histories.set(slug, validateHistory(rawHistory, source));
}

export function getPostHistory(slug: string): readonly HistoryVersion[] {
  return histories.get(slug) ?? [];
}
