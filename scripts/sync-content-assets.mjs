#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const sourceRoot = path.resolve('content/posts');
const destinationRoot = path.resolve('public/content/posts');
const imageExtensions = new Set([
  '.apng', '.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp',
]);

let copied = 0;

async function copyImages(sourceDirectory, relativeDirectory = '') {
  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const relativePath = path.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      await copyImages(sourcePath, relativePath);
      continue;
    }
    if (!entry.isFile() || !imageExtensions.has(path.extname(entry.name).toLowerCase())) continue;

    const destinationPath = path.join(destinationRoot, relativePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
    copied += 1;
  }
}

await fs.rm(destinationRoot, { recursive: true, force: true });
await copyImages(sourceRoot);
console.log(`Content assets: ${copied} image${copied === 1 ? '' : 's'} synchronized.`);
