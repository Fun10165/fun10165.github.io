#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import puppeteer from 'puppeteer-core';

const repoRoot = path.resolve(import.meta.dirname, '..');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Preview server did not become ready at ${url}`);
}

const slug = process.argv[2]?.trim();
if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
  console.error('Usage: npm run share -- <slug>');
  process.exit(1);
}

console.log(`Building site for share image of "${slug}"...`);
await run('npm', ['run', 'build']);

const port = await freePort();
const preview = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: repoRoot,
  stdio: 'ignore',
});
const baseUrl = `http://127.0.0.1:${port}`;
let browser;
try {
  await waitForServer(baseUrl, 30_000);
  browser = await puppeteer.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const scale = 2;
  const cssWidth = 760;
  const sliceHeight = 1200;
  await page.setViewport({ width: cssWidth, height: sliceHeight, deviceScaleFactor: scale });
  const response = await page.goto(`${baseUrl}/blog/${slug}/share/`, { waitUntil: 'networkidle0' });
  if (!response?.ok()) throw new Error(`Share page returned HTTP ${response?.status()}`);
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({
    content: 'html, body { scrollbar-width: none; } ::-webkit-scrollbar { display: none; }',
  });
  const contentHeight = await page.evaluate(() => document.documentElement.offsetHeight);

  const outputDirectory = path.join(repoRoot, 'share');
  await fs.mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `${slug}.png`);

  // Chrome caps the painted surface at roughly 16384 device pixels, so a single
  // capture repeats the page for long posts. Capture fixed-size viewport tiles and stitch them.
  const scratchDirectory = path.join(outputDirectory, `.${slug}-slices`);
  await fs.rm(scratchDirectory, { recursive: true, force: true });
  await fs.mkdir(scratchDirectory, { recursive: true });
  const sliceCount = Math.max(1, Math.ceil(contentHeight / sliceHeight));
  const pageTallerThanSlice = contentHeight > sliceHeight;
  const tiles = [];
  try {
    for (let index = 0; index < sliceCount; index += 1) {
      const top = Math.min(index * sliceHeight, Math.max(0, contentHeight - sliceHeight));
      const rows = Math.min(sliceHeight, contentHeight - index * sliceHeight) * scale;
      await page.evaluate((offset) => window.scrollTo(0, offset), top);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      const file = path.join(scratchDirectory, `slice-${String(index).padStart(3, '0')}.png`);
      await page.screenshot({ path: file, captureBeyondViewport: false });
      // Chrome clamps scrolling, so a trailing tile is anchored to the page bottom and the
      // wanted rows sit at the bottom of that capture. A page shorter than the viewport is
      // the opposite case: its rows sit at the top.
      const fromBottom = pageTallerThanSlice && rows < sliceHeight * scale;
      tiles.push({ file, rows, fromBottom });
    }

    const inputs = tiles.flatMap((tile) => ['-i', tile.file]);
    const cropFilters = tiles.map((tile, index) => {
      const label = tiles.length === 1 ? 'out' : `s${index}`;
      const offset = tile.fromBottom ? `ih-${tile.rows}` : '0';
      return `[${index}:v]crop=${cssWidth * scale}:${tile.rows}:0:${offset}[${label}]`;
    });
    const filter = tiles.length === 1
      ? cropFilters[0]
      : `${cropFilters.join(';')};${tiles.map((_, index) => `[s${index}]`).join('')}vstack=inputs=${tiles.length}[out]`;
    await run('ffmpeg', [
      '-v', 'error', '-y',
      ...inputs,
      '-filter_complex', filter,
      '-map', '[out]',
      outputPath,
    ]);
  } finally {
    await fs.rm(scratchDirectory, { recursive: true, force: true });
  }
  console.log(`Saved ${path.relative(process.cwd(), outputPath)}`);
} finally {
  await browser?.close();
  preview.kill('SIGTERM');
}
