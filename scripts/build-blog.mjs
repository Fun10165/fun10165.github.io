#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const postsDir = path.join(rootDir, 'content', 'posts');
const blogDir = path.join(rootDir, 'blog');
const historyDir = path.join(rootDir, 'content', 'post-history');
const checkOnly = process.argv.includes('--check');

const IMAGE_EXTENSIONS = new Set([
  '.apng', '.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'
]);

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames || []), 'input'])],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []),
    ['className', /^language-./, 'math-inline', 'math-display']],
    input: [['type', 'checkbox'], ['checked'], ['disabled']],
    li: [...(defaultSchema.attributes?.li || []), ['className', 'task-list-item']],
    td: [...(defaultSchema.attributes?.td || []), ['align', 'left', 'right', 'center']],
    th: [...(defaultSchema.attributes?.th || []), ['align', 'left', 'right', 'center']],
    ul: [...(defaultSchema.attributes?.ul || []), ['className', 'contains-task-list']]
  }
};

// ── main ──

async function main() {
  const files = await listMarkdownFiles(postsDir);
  if (files.length === 0) {
    throw new BuildError(
      `No Markdown posts found in ${relativePath(postsDir)}. Add files like content/posts/my-post.md with frontmatter: title, date, description, tags.`
    );
  }

  const sourcePosts = await Promise.all(files.map(readPostSource));
  const slugToPost = new Map();
  for (const post of sourcePosts) {
    const existing = slugToPost.get(post.slug);
    if (existing) {
      throw new BuildError(
        `Duplicate slug "${post.slug}" in ${relativePath(existing.sourcePath)} and ${relativePath(post.sourcePath)}.`
      );
    }
    slugToPost.set(post.slug, post);
  }

  const sourcePathToSlug = new Map(sourcePosts.map((post) => [post.sourcePath, post.slug]));
  const posts = await Promise.all(
    sourcePosts.map(async (post) => ({
      ...post,
      html: await renderMarkdown(post, sourcePathToSlug)
    }))
  );

  posts.sort((a, b) => b.dateValue - a.dateValue || a.title.localeCompare(b.title));

  // ── version snapshots ──
  for (const post of posts) {
    await appendVersion(post);
  }

  if (checkOnly) {
    console.log(`Checked ${posts.length} blog post${posts.length === 1 ? '' : 's'} without writing files.`);
    return;
  }

  await fs.rm(blogDir, { force: true, recursive: true });
  await fs.mkdir(blogDir, { recursive: true });
  await fs.writeFile(path.join(blogDir, 'index.html'), renderBlogIndex(posts), 'utf8');
  // recent posts JSON for homepage
  const recent = posts.slice(0, 3).map((p) => {
    let coverUrl = '';
    if (p.cover) {
      if (/^https?:\/\//i.test(p.cover) || p.cover.startsWith('//')) {
        coverUrl = p.cover;
      } else {
        const targetPath = path.resolve(path.dirname(p.sourcePath), decodeUrlPath(p.cover));
        coverUrl = './' + relativePath(targetPath);
      }
    }
    return {
      title: p.title,
      date: p.dateText,
      description: p.description,
      slug: p.slug,
      cover: coverUrl,
      tags: p.tags
    };
  });
  await fs.writeFile(path.join(blogDir, 'recent.json'), JSON.stringify(recent), 'utf8');

  await Promise.all(
    posts.map(async (post) => {
      const out = path.join(blogDir, post.slug);
      await fs.mkdir(out, { recursive: true });
      await fs.writeFile(path.join(out, 'index.html'), renderPostPage(post), 'utf8');

      // history / compare pages
      await writeHistoryPages(post);
    })
  );

  console.log(`Built ${posts.length} blog post${posts.length === 1 ? '' : 's'} into ${relativePath(blogDir)}.`);
}

// ── file scanning ──

async function listMarkdownFiles(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => path.join(directory, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

// ── frontmatter parsing ──

async function readPostSource(sourcePath) {
  const raw = await fs.readFile(sourcePath, 'utf8');
  let parsed;
  try { parsed = matter(raw); }
  catch (error) { throw new BuildError(`${relativePath(sourcePath)} has invalid frontmatter: ${error.message}`); }

  const data = parsed.data || {};
  const title = normalizeRequiredString(data.title, 'title', sourcePath);
  const dateText = normalizeDate(data.date, sourcePath);
  const dateValue = Date.parse(`${dateText}T00:00:00Z`);
  if (Number.isNaN(dateValue)) throw new BuildError(`${relativePath(sourcePath)} has an invalid date "${dateText}". Use YYYY-MM-DD.`);

  const slugSource = normalizeOptionalString(data.slug) || path.basename(sourcePath, '.md');
  const slug = slugify(slugSource);
  if (!slug) throw new BuildError(`${relativePath(sourcePath)} has an empty slug after normalization.`);

  const cover = normalizeOptionalString(data.cover);

  return {
    content: parsed.content,
    cover,
    dateText,
    dateValue,
    description: normalizeOptionalString(data.description),
    slug,
    sourcePath,
    tags: normalizeTags(data.tags, sourcePath),
    title
  };
}

function normalizeRequiredString(value, field, sourcePath) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new BuildError(`${relativePath(sourcePath)} is missing required frontmatter field "${field}".`);
  return normalized;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeDate(value, sourcePath) {
  if (value === undefined || value === null || value === '')
    throw new BuildError(`${relativePath(sourcePath)} is missing required frontmatter field "date".`);
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
    throw new BuildError(`${relativePath(sourcePath)} has date "${text}". Use YYYY-MM-DD.`);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text)
    throw new BuildError(`${relativePath(sourcePath)} has invalid calendar date "${text}".`);
  return text;
}

function normalizeTags(value, sourcePath) {
  if (value === undefined || value === null || value === '') return [];
  const tags = Array.isArray(value) ? value : String(value).split(',');
  const normalized = tags.map((tag) => String(tag).trim()).filter(Boolean);
  if (normalized.length !== new Set(normalized).size)
    throw new BuildError(`${relativePath(sourcePath)} has duplicate tags.`);
  return normalized;
}

// ── Markdown rendering ──

async function renderMarkdown(post, sourcePathToSlug) {
  const outputDir = path.join(blogDir, post.slug);
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, sanitizeSchema)
    .use(rewriteRelativeUrls, {
      currentSlug: post.slug, outputDir,
      sourceDir: path.dirname(post.sourcePath), sourcePathToSlug
    })
    .use(rehypeKatex, { strict: 'ignore', throwOnError: false })
    .use(rehypeSlug)
    .use(rehypeStringify)
    .process(post.content);
  return String(file);
}

async function renderArchivedMarkdown(markdown, slug, sourceDir, sourcePathToSlug) {
  const outDir = path.join(blogDir, slug);
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, sanitizeSchema)
    .use(rewriteRelativeUrls, {
      currentSlug: slug, outputDir: outDir,
      sourceDir, sourcePathToSlug
    })
    .use(rehypeKatex, { strict: 'ignore', throwOnError: false })
    .use(rehypeSlug)
    .use(rehypeStringify)
    .process(markdown);
  return String(file);
}

function rewriteRelativeUrls(options) {
  return (tree) => {
    visitElements(tree, (node) => {
      if (node.tagName === 'img' && typeof node.properties?.src === 'string')
        node.properties.src = rewriteAssetUrl(node.properties.src, options);
      if (node.tagName === 'a' && typeof node.properties?.href === 'string')
        node.properties.href = rewriteLinkUrl(node.properties.href, options);
    });
  };
}

function visitElements(node, visitor) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'element') visitor(node);
  if (Array.isArray(node.children)) for (const child of node.children) visitElements(child, visitor);
}

function rewriteAssetUrl(rawUrl, options) {
  const parts = splitUrl(rawUrl);
  if (!isLocalPath(parts.pathname)) return rawUrl;
  const ext = path.extname(parts.pathname).toLowerCase();
  if (ext && !IMAGE_EXTENSIONS.has(ext)) return rawUrl;
  const targetPath = path.resolve(options.sourceDir, decodeUrlPath(parts.pathname));
  return joinUrlParts(relativeUrlPath(options.outputDir, targetPath), parts);
}

function rewriteLinkUrl(rawUrl, options) {
  const parts = splitUrl(rawUrl);
  if (!isLocalPath(parts.pathname)) return rawUrl;
  if (path.extname(parts.pathname).toLowerCase() === '.md') {
    const targetPath = path.resolve(options.sourceDir, decodeUrlPath(parts.pathname));
    const targetSlug = options.sourcePathToSlug.get(targetPath);
    if (targetSlug) {
      const href = targetSlug === options.currentSlug ? './' : `../${targetSlug}/`;
      return joinUrlParts(href, { search: '', hash: parts.hash });
    }
  }
  const targetPath = path.resolve(options.sourceDir, decodeUrlPath(parts.pathname));
  return joinUrlParts(relativeUrlPath(options.outputDir, targetPath, parts.pathname.endsWith('/')), parts);
}

function splitUrl(rawUrl) {
  const hi = rawUrl.indexOf('#');
  const before = hi === -1 ? rawUrl : rawUrl.slice(0, hi);
  const hash = hi === -1 ? '' : rawUrl.slice(hi);
  const qi = before.indexOf('?');
  return { pathname: qi === -1 ? before : before.slice(0, qi), search: qi === -1 ? '' : before.slice(qi), hash };
}

function isLocalPath(pathname) {
  return Boolean(pathname) && !pathname.startsWith('/') && !pathname.startsWith('//') && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(pathname);
}

function decodeUrlPath(pathname) { try { return decodeURI(pathname); } catch { return pathname; } }

function relativeUrlPath(fromDir, toPath, keepTrailingSlash = false) {
  const rel = path.relative(fromDir, toPath).split(path.sep).join('/');
  const encoded = encodeURI(rel || '.');
  return keepTrailingSlash && !encoded.endsWith('/') ? `${encoded}/` : encoded;
}

function joinUrlParts(pathname, parts) { return `${pathname}${parts.search || ''}${parts.hash || ''}`; }

function slugify(value) {
  return String(value).normalize('NFKD').toLowerCase().trim()
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ── version history ──

function hashContent(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

async function appendVersion(post) {
  if (checkOnly) return;
  const h = hashContent(post.content);

  await fs.mkdir(historyDir, { recursive: true });
  const historyPath = path.join(historyDir, `${post.slug}.json`);
  let versions = [];
  try { versions = JSON.parse(await fs.readFile(historyPath, 'utf8')); }
  catch { /* file missing or corrupt — start fresh */ }

  if (!Array.isArray(versions)) versions = [];

  // skip if latest version hash matches
  if (versions.length > 0 && versions.at(-1).hash === h) return;

  const version = {
    id: String(versions.length + 1),
    createdAt: new Date().toISOString(),
    hash: h,
    title: post.title,
    date: post.dateText,
    description: post.description,
    tags: post.tags,
    cover: post.cover,
    content: post.content
  };

  versions.push(version);
  await fs.writeFile(historyPath, JSON.stringify(versions, null, 2), 'utf8');
}

async function readVersions(slug) {
  const p = path.join(historyDir, `${slug}.json`);
  try {
    const raw = await fs.readFile(p, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch { return []; }
}

// ── history / compare pages ──

async function writeHistoryPages(post) {
  const versions = await readVersions(post.slug);
  if (versions.length === 0) return;

  const histDir = path.join(blogDir, post.slug, 'history');
  await fs.mkdir(histDir, { recursive: true });

  // history index
  await fs.writeFile(path.join(histDir, 'index.html'), renderHistoryIndex(post, versions), 'utf8');

  // individual version pages
  for (const v of versions) {
    const vDir = path.join(histDir, v.id);
    await fs.mkdir(vDir, { recursive: true });

    // render archived markdown — reuse same source dir so relative links work
    const sourcePathToSlug = new Map([[post.sourcePath, post.slug]]);
    const rendered = await renderArchivedMarkdown(v.content, post.slug, path.dirname(post.sourcePath), sourcePathToSlug);

    await fs.writeFile(path.join(vDir, 'index.html'), renderVersionPage(post, v, rendered), 'utf8');
  }

  // compare page
  const cmpDir = path.join(blogDir, post.slug, 'compare');
  await fs.mkdir(cmpDir, { recursive: true });
  await fs.writeFile(path.join(cmpDir, 'index.html'), renderComparePage(post, versions), 'utf8');
}

function renderHistoryIndex(post, versions) {
  const list = versions.toReversed().map((v) => `
    <article class="post-card">
      <p class="post-meta">${escapeHtml(v.createdAt.slice(0, 10))} <span style="color:var(--muted)">· v${escapeHtml(v.id)}</span></p>
      <h2><a href="./${escapeAttribute(v.id)}/">${escapeHtml(v.title)}</a></h2>
      ${v.description ? `<p>${escapeHtml(v.description)}</p>` : ''}
    </article>
  `).join('\n');

  return htmlDocument({
    content: `<main class="shell">
      ${siteNav('../../../')}
      <section class="hero-panel">
        <p class="eyebrow"><a href="../../">${escapeHtml(post.title)}</a> · History</p>
        <h1>Version History</h1>
        <p>${versions.length} snapshot${versions.length === 1 ? '' : 's'} — <a href="../compare/">compare versions</a></p>
      </section>
      <section class="post-list" aria-label="Post versions">${list}</section>
    </main>`,
    description: `Version history for ${post.title}`,
    rootPrefix: '../../../',
    title: `History · ${post.title} · Fun10165`
  });
}

function renderVersionPage(post, version, renderedHtml) {
  return htmlDocument({
    content: `<main class="shell">
      ${siteNav('../../../../')}
      <article class="article-panel">
        <header class="post-header">
          <p class="post-meta">v${escapeHtml(version.id)} · ${escapeHtml(version.createdAt.slice(0, 10))}${renderTags(version.tags || [])}</p>
          <h1>${escapeHtml(version.title)}</h1>
          ${version.description ? `<p class="description">${escapeHtml(version.description)}</p>` : ''}
        </header>
        <div class="content">${renderedHtml}</div>
      </article>
      <p style="margin-top:1rem;color:var(--muted);font-size:0.85rem;">
        <a href="../">← Back to history</a> &nbsp;·&nbsp; <a href="../../">Current version</a>
      </p>
    </main>`,
    description: version.description || version.title,
    rootPrefix: '../../../../',
    title: `v${version.id} · ${post.title} · Fun10165`
  });
}

function renderComparePage(post, versions) {
  const data = JSON.stringify(versions.map((v) => ({
    id: v.id,
    createdAt: v.createdAt.slice(0, 10),
    title: v.title,
    hash: v.hash,
    content: v.content
  })));

  const safeData = data.replaceAll('</script>', '<\\/script>');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Compare · ${escapeHtml(post.title)} · Fun10165</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root { --paper: rgba(255,251,244,0.88); --panel: rgba(46,62,79,0.92); --text: #1f2b38; --muted: #5d6a77; --accent: #d4653f; --accent-2: #2f7f78; --line: rgba(31,43,56,0.12); --shadow: 0 20px 60px rgba(31,43,56,0.16); --ins: #d4edda; --del-bg: #f8d7da; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; color:var(--text); font-family:"IBM Plex Sans",sans-serif; line-height:1.7; background-color:#efe5d2; background-image:linear-gradient(rgba(239,229,210,0.82),rgba(239,229,210,0.92)),url('../../../bg-landscape.webp'); background-attachment:fixed; background-position:center; background-size:cover; }
    a { color:var(--accent-2); text-decoration-thickness:0.08em; text-underline-offset:0.18em; } a:hover { color:var(--accent); }
    .shell { width:min(900px,calc(100% - 2rem)); margin:0 auto; padding:1rem 0 4rem; }
    .nav { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:1rem 0 1.5rem; }
    .brand { display:inline-flex; align-items:center; gap:0.8rem; color:inherit; font-size:0.88rem; font-weight:700; letter-spacing:0.04em; text-decoration:none; text-transform:uppercase; }
    .brand-mark { display:inline-grid; width:2.5rem; height:2.5rem; place-items:center; border-radius:0.9rem; color:#fdf7ea; background:var(--panel); box-shadow:var(--shadow); }
    .nav-links { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:0.75rem; }
    .nav-links a { padding:0.65rem 1rem; border:1px solid var(--line); border-radius:999px; color:var(--muted); background:rgba(255,255,255,0.45); text-decoration:none; transition:transform 180ms ease, border-color 180ms ease, background 180ms ease; }
    .nav-links a:hover { transform:translateY(-2px); border-color:rgba(212,101,63,0.45); background:rgba(255,255,255,0.72); }
    .panel { border:1px solid rgba(31,43,56,0.08); border-radius:2rem; background:var(--paper); box-shadow:var(--shadow); backdrop-filter:blur(18px); padding:clamp(1.4rem,4vw,2rem); margin:0.75rem 0; }
    h1,h2 { font-family:"DM Serif Display",Georgia,serif; line-height:1.12; }
    h1 { margin:0 0 0.5rem; font-size:clamp(2rem,6vw,3.5rem); }
    h2 { font-size:1.4rem; margin:1.5rem 0 0.75rem; }
    select { padding:0.5rem 0.75rem; border-radius:0.75rem; border:1px solid var(--line); font:inherit; background:var(--paper); }
    .diff-line { padding:0.15rem 0.5rem; border-radius:0.25rem; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:0.88rem; white-space:pre-wrap; word-break:break-all; }
    .diff-add { background:var(--ins); }
    .diff-del { background:var(--del-bg); }
    .diff-context { color:var(--muted); }
    @media (max-width:640px) { .nav { align-items:flex-start; flex-direction:column; } .nav-links { justify-content:flex-start; } }
  </style>
</head>
<body>
<main class="shell">
  ${siteNav('../../../')}
  <section class="panel">
    <h1>Compare Versions · ${escapeHtml(post.title)}</h1>
    <p style="color:var(--muted)">
      <a href="../history/">← Back to history</a> &nbsp;·&nbsp; <a href="../">Current version</a>
    </p>
    <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center;margin:1rem 0">
      <label>From <select id="v1"></select></label>
      <label>To <select id="v2"></select></label>
      <button id="diffBtn" style="padding:0.5rem 1rem;border-radius:0.75rem;border:1px solid var(--line);font:inherit;cursor:pointer;background:var(--panel);color:#fdf7ea;">Compare</button>
    </div>
    <div id="diffOutput"></div>
  </section>
</main>
<script>
  var VERSIONS = ${safeData};
  var v1 = document.getElementById('v1');
  var v2 = document.getElementById('v2');
  var btn = document.getElementById('diffBtn');
  var out = document.getElementById('diffOutput');

  VERSIONS.forEach(function(v, i) {
    var opt1 = document.createElement('option');
    opt1.value = i;
    opt1.textContent = 'v' + v.id + ' (' + v.createdAt + ')';
    v1.appendChild(opt1);
    var opt2 = opt1.cloneNode(true);
    v2.appendChild(opt2);
  });
  if (VERSIONS.length >= 2) { v2.selectedIndex = VERSIONS.length - 1; }

  function lcs(a, b) {
    var m = a.length, n = b.length;
    var dp = new Array(m + 1);
    for (var i = 0; i <= m; i++) { dp[i] = new Array(n + 1); for (var j = 0; j <= n; j++) dp[i][j] = 0; }
    for (var i = 1; i <= m; i++)
      for (var j = 1; j <= n; j++)
        dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
    var i = m, j = n, ops = [];
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i-1] === b[j-1]) { ops.unshift({t:'eq', l:a[i-1]}); i--; j--; }
      else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { ops.unshift({t:'add', l:b[j-1]}); j--; }
      else { ops.unshift({t:'del', l:a[i-1]}); i--; }
    }
    return ops;
  }

  function escape(s) {
    return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  }

  btn.onclick = function() {
    var a = VERSIONS[parseInt(v1.value)];
    var b = VERSIONS[parseInt(v2.value)];
    var diff = lcs(a.content.split('\\n'), b.content.split('\\n'));
    var html = '<h2>v' + a.id + ' → v' + b.id + '</h2>';
    diff.forEach(function(op) {
      if (op.t === 'eq') html += '<div class="diff-line diff-context"> ' + escape(op.l) + '</div>';
      else if (op.t === 'add') html += '<div class="diff-line diff-add">+' + escape(op.l) + '</div>';
      else html += '<div class="diff-line diff-del">-' + escape(op.l) + '</div>';
    });
    out.innerHTML = html;
  };
</script>
</body>
</html>`;
}

// ── page renderers ──

function renderBlogIndex(posts) {
  const list = posts.map((post) => {
    const coverHtml = post.cover
      ? `<img src="${escapeAttribute(rewriteCoverUrl(post.cover, post.slug, post.sourcePath))}" alt="" class="post-cover" />`
      : '';
    return `<article class="post-card">
        ${coverHtml}
        <p class="post-meta"><time datetime="${escapeHtml(post.dateText)}">${formatDate(post.dateText)}</time>${renderTags(post.tags)}</p>
        <h2><a href="./${escapeAttribute(post.slug)}/">${escapeHtml(post.title)}</a></h2>
        ${post.description ? `<p>${escapeHtml(post.description)}</p>` : ''}
      </article>`;
  }).join('\n');

  return htmlDocument({
    content: `<main class="shell">
      ${siteNav('../')}
      <section class="hero-panel">
        <p class="eyebrow">Blog</p>
        <h1>Notes from Fun10165</h1>
        <p>Static posts generated from Markdown, with GitHub-flavored Markdown and KaTeX math rendered at build time.</p>
      </section>
      <section class="post-list" aria-label="Blog posts">${list}</section>
    </main>`,
    description: 'Notes from Fun10165.',
    rootPrefix: '../',
    title: 'Blog · Fun10165'
  });
}

function renderPostPage(post) {
  const coverHtml = post.cover
    ? `<img src="${escapeAttribute(rewriteCoverUrl(post.cover, post.slug, post.sourcePath))}" alt="" class="post-cover-hero" />`
    : '';
  return htmlDocument({
    content: `<main class="shell">
      ${siteNav('../../')}
      <article class="article-panel">
        <header class="post-header">
          ${coverHtml}
          <p class="post-meta"><time datetime="${escapeHtml(post.dateText)}">${formatDate(post.dateText)}</time>${renderTags(post.tags)}</p>
          <h1>${escapeHtml(post.title)}</h1>
          ${post.description ? `<p class="description">${escapeHtml(post.description)}</p>` : ''}
        </header>
        <div class="content">${post.html}</div>
      </article>
      <p style="margin-top:1rem;color:var(--muted);font-size:0.85rem;">
        <a href="./history/">View history</a> &nbsp;·&nbsp; <a href="./compare/">Compare versions</a>
      </p>
    </main>`,
    description: post.description || post.title,
    rootPrefix: '../../',
    title: `${post.title} · Fun10165`
  });
}

function rewriteCoverUrl(cover, slug, sourcePath) {
  if (!cover) return '';
  // absolute URL — leave as-is
  if (/^https?:\/\//i.test(cover) || cover.startsWith('//')) return cover;
  // relative — rewrite to output dir
  const sourceDir = path.dirname(sourcePath);
  const outputDir = path.join(blogDir, slug);
  const targetPath = path.resolve(sourceDir, decodeUrlPath(cover));
  return relativeUrlPath(outputDir, targetPath);
}

function htmlDocument({ content, description, rootPrefix, title }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttribute(description)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/katex.min.css" />
  <style>
    :root { --paper: rgba(255,251,244,0.88); --panel: rgba(46,62,79,0.92); --text: #1f2b38; --muted: #5d6a77; --accent: #d4653f; --accent-2: #2f7f78; --line: rgba(31,43,56,0.12); --shadow: 0 20px 60px rgba(31,43,56,0.16); }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin:0; min-height:100vh; color:var(--text); font-family:"IBM Plex Sans",sans-serif; line-height:1.7; background-color:#efe5d2; background-image:linear-gradient(rgba(239,229,210,0.82),rgba(239,229,210,0.92)),url('${rootPrefix}bg-landscape.webp'); background-attachment:fixed; background-position:center; background-size:cover; }
    a { color:var(--accent-2); text-decoration-thickness:0.08em; text-underline-offset:0.18em; } a:hover { color:var(--accent); }
    .shell { width:min(900px,calc(100% - 2rem)); margin:0 auto; padding:1rem 0 4rem; }
    .nav { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:1rem 0 1.5rem; }
    .brand { display:inline-flex; align-items:center; gap:0.8rem; color:inherit; font-size:0.88rem; font-weight:700; letter-spacing:0.04em; text-decoration:none; text-transform:uppercase; }
    .brand-mark { display:inline-grid; width:2.5rem; height:2.5rem; place-items:center; border-radius:0.9rem; color:#fdf7ea; background:var(--panel); box-shadow:var(--shadow); }
    .nav-links { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:0.75rem; }
    .nav-links a { padding:0.65rem 1rem; border:1px solid var(--line); border-radius:999px; color:var(--muted); background:rgba(255,255,255,0.45); text-decoration:none; transition:transform 180ms ease, border-color 180ms ease, background 180ms ease; }
    .nav-links a:hover { transform:translateY(-2px); border-color:rgba(212,101,63,0.45); background:rgba(255,255,255,0.72); }
    .hero-panel, .article-panel, .post-card { border:1px solid rgba(31,43,56,0.08); border-radius:2rem; background:var(--paper); box-shadow:var(--shadow); backdrop-filter:blur(18px); }
    .hero-panel { padding:clamp(2rem,6vw,4rem); margin:0.75rem 0 1.5rem; }
    .article-panel { padding:clamp(1.4rem,4vw,3rem); }
    .post-card { padding:1.4rem 1.6rem; }
    .post-card + .post-card { margin-top:1rem; }
    .eyebrow, .post-meta { color:var(--accent); font-size:0.82rem; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; }
    .tag-list { display:inline-flex; flex-wrap:wrap; gap:0.35rem; margin-left:0.7rem; }
    .tag { color:var(--muted); letter-spacing:0.04em; }
    h1,h2,h3,h4 { margin:1.7em 0 0.45em; font-family:"DM Serif Display",Georgia,serif; line-height:1.12; }
    h1 { margin-top:0; font-size:clamp(2.2rem,7vw,4.8rem); }
    h2 { font-size:clamp(1.7rem,4vw,2.7rem); }
    h3 { font-size:1.55rem; }
    h4 { font-size:1.25rem; }
    .post-card h2 { margin:0.2rem 0 0.45rem; }
    .post-card h2 a { color:inherit; text-decoration:none; }
    .description { color:var(--muted); font-size:1.1rem; }
    .content { overflow-wrap:break-word; }
    .content>:first-child { margin-top:0; }
    .content>:last-child { margin-bottom:0; }
    blockquote { margin:1.5rem 0; padding:0.1rem 0 0.1rem 1.2rem; border-left:0.25rem solid var(--accent); color:var(--muted); }
    pre, code { border-radius:0.75rem; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    code { padding:0.15rem 0.35rem; background:rgba(31,43,56,0.08); }
    pre { overflow-x:auto; padding:1rem; background:rgba(31,43,56,0.9); color:#fdf7ea; }
    pre code { padding:0; background:transparent; color:inherit; }
    table { width:100%; margin:1.5rem 0; border-collapse:collapse; overflow:hidden; border-radius:1rem; }
    th, td { padding:0.75rem 0.9rem; border:1px solid var(--line); text-align:left; vertical-align:top; }
    th { background:rgba(46,62,79,0.08); }
    img { max-width:100%; height:auto; border-radius:1rem; box-shadow:0 10px 30px rgba(31,43,56,0.12); }
    hr { border:0; border-top:1px solid var(--line); margin:2rem 0; }
    .contains-task-list { padding-left:1.1rem; list-style:none; }
    .task-list-item input { margin-right:0.55rem; }
    .katex-display { overflow-x:auto; overflow-y:hidden; padding:0.4rem 0; }
    .post-cover { width:100%; max-height:240px; object-fit:cover; margin-bottom:0.9rem; }
    .post-cover-hero { width:100%; max-height:360px; object-fit:cover; margin-bottom:1.2rem; border-radius:1.2rem; }
    @media (max-width:640px) { .nav { align-items:flex-start; flex-direction:column; } .nav-links { justify-content:flex-start; } }
  </style>
</head>
<body>
${content}
</body>
</html>`;
}

function siteNav(rootPrefix) {
  return `<nav class="nav" aria-label="Primary navigation">
    <a class="brand" href="${rootPrefix}"><span class="brand-mark">F</span><span>Fun10165</span></a>
    <div class="nav-links">
      <a href="${rootPrefix}">Home</a>
      <a href="${rootPrefix}blog/">Blog</a>
    </div>
  </nav>`;
}

function renderTags(tags) {
  if (tags.length === 0) return '';
  return `<span class="tag-list">${tags.map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join('')}</span>`;
}

function formatDate(dateText) {
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC', year: 'numeric' })
    .format(new Date(`${dateText}T00:00:00Z`));
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}

function relativePath(filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join('/') || '.';
}

class BuildError extends Error {
  constructor(message) { super(message); this.name = 'BuildError'; }
}

main().catch((error) => {
  if (error instanceof BuildError) { console.error(`build-blog: ${error.message}`); process.exitCode = 1; return; }
  console.error(error);
  process.exitCode = 1;
});
