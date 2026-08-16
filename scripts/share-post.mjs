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
  await page.setViewport({ width: 760, height: 1200, deviceScaleFactor: 2 });
  const response = await page.goto(`${baseUrl}/blog/${slug}/share/`, { waitUntil: 'networkidle0' });
  if (!response?.ok()) throw new Error(`Share page returned HTTP ${response?.status()}`);
  await page.evaluate(() => document.fonts.ready);

  const outputDirectory = path.join(repoRoot, 'share');
  await fs.mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `${slug}.png`);
  await page.screenshot({ path: outputPath, fullPage: true });
  console.log(`Saved ${path.relative(process.cwd(), outputPath)}`);
} finally {
  await browser?.close();
  preview.kill('SIGTERM');
}
