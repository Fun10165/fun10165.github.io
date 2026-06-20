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
import remarkFootnotes from 'remark-footnotes';
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
  tagNames: [...new Set([...(defaultSchema.tagNames || []), 'input', 'section', 'nav'])],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []),
    ['className', /^language-./, 'math-inline', 'math-display']],
    input: [['type', 'checkbox'], ['checked'], ['disabled']],
    li: [...(defaultSchema.attributes?.li || []), ['className', 'task-list-item']],
    td: [...(defaultSchema.attributes?.td || []), ['align', 'left', 'right', 'center']],
    th: [...(defaultSchema.attributes?.th || []), ['align', 'left', 'right', 'center']],
    ul: [...(defaultSchema.attributes?.ul || []), ['className', 'contains-task-list']],
    section: [['class', 'footnotes'], ['data-footnotes']],
    a: [...(defaultSchema.attributes?.a || []), ['ariaBacklabel'], ['id'], ['href'], ['role'], ['dataFootnoteRef'], ['dataFootnoteBackref'], ['className', 'data-footnote-backref']],
    sup: [['dataFootnoteRef']],
    ol: [...(defaultSchema.attributes?.ol || []), ['dataFootnotes']],
    nav: [['class', 'toc']]
  }
};

// ── main ──

async function main() {
  const files = await listMarkdownFiles(postsDir);
  if (files.length === 0) {
    throw new BuildError(`No Markdown posts found in ${relativePath(postsDir)}.`);
  }

  const sourcePosts = await Promise.all(files.map(readPostSource));
  const slugToPost = new Map();
  for (const post of sourcePosts) {
    if (slugToPost.has(post.slug))
      throw new BuildError(`Duplicate slug "${post.slug}".`);
    slugToPost.set(post.slug, post);
  }

  const sourcePathToSlug = new Map(sourcePosts.map(p => [p.sourcePath, p.slug]));
  const posts = await Promise.all(sourcePosts.map(async (post) => ({
    ...post,
    html: await renderMarkdown(post, sourcePathToSlug)
  })));

  posts.sort((a, b) => b.dateValue - a.dateValue || a.title.localeCompare(b.title));

  // compute reading time and TOC for each post
  for (const post of posts) {
    post.readingTime = estimateReadingTime(post.content);
    post.toc = extractToc(post.html);
  }

  // ── version snapshots ──
  for (const post of posts) await appendVersion(post);

  if (checkOnly) {
    console.log(`Checked ${posts.length} blog post${posts.length === 1 ? '' : 's'} without writing files.`);
    return;
  }

  // ── write output ──
  await fs.rm(blogDir, { force: true, recursive: true });
  await fs.mkdir(blogDir, { recursive: true });
  await fs.writeFile(path.join(blogDir, 'index.html'), renderBlogIndex(posts), 'utf8');

  await Promise.all(posts.map(async (post, i) => {
    const prev = i > 0 ? posts[i - 1] : null;
    const next = i < posts.length - 1 ? posts[i + 1] : null;
    const out = path.join(blogDir, post.slug);
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'index.html'), renderPostPage(post, prev, next, posts), 'utf8');
    await writeHistoryPages(post);
  }));

  // ── feeds / sitemap / tags / series / search ──
  await fs.writeFile(path.join(blogDir, 'feed.xml'), renderRssFeed(posts), 'utf8');
  await fs.writeFile(path.join(blogDir, 'sitemap.xml'), renderSitemap(posts), 'utf8');
  await writeTagPages(posts);
  await writeSeriesPages(posts);
  await writeSearchPage(posts);
  await writeHomepageRecentPosts(posts.slice(0, 3));

  console.log(`Built ${posts.length} blog post${posts.length === 1 ? '' : 's'} into ${relativePath(blogDir)}.`);
}

// ── file scanning ──

async function listMarkdownFiles(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map(e => path.join(directory, e.name))
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
  if (Number.isNaN(dateValue)) throw new BuildError(`${relativePath(sourcePath)} has invalid date "${dateText}".`);

  const slugSource = normalizeOptionalString(data.slug) || path.basename(sourcePath, '.md');
  const slug = slugify(slugSource);
  if (!slug) throw new BuildError(`${relativePath(sourcePath)} has empty slug.`);

  return {
    content: parsed.content,
    cover: normalizeOptionalString(data.cover),
    dateText,
    dateValue,
    description: normalizeOptionalString(data.description),
    series: normalizeOptionalString(data.series),
    slug,
    sourcePath,
    tags: normalizeTags(data.tags, sourcePath),
    title
  };
}

function normalizeRequiredString(value, field, sourcePath) {
  const n = normalizeOptionalString(value);
  if (!n) throw new BuildError(`${relativePath(sourcePath)} missing "${field}".`);
  return n;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeDate(value, sourcePath) {
  if (value === undefined || value === null || value === '')
    throw new BuildError(`${relativePath(sourcePath)} missing "date".`);
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
    throw new BuildError(`${relativePath(sourcePath)} date "${text}" invalid. Use YYYY-MM-DD.`);
  return text;
}

function normalizeTags(value, sourcePath) {
  if (value === undefined || value === null || value === '') return [];
  const tags = Array.isArray(value) ? value : String(value).split(',');
  const n = tags.map(t => String(t).trim()).filter(Boolean);
  if (n.length !== new Set(n).size) throw new BuildError(`${relativePath(sourcePath)} duplicate tags.`);
  return n;
}

// ── reading time ──

function estimateReadingTime(markdown) {
  const words = markdown.replace(/```[\s\S]*?```/g, '').replace(/[^\u4e00-\u9fff\w]/g, ' ').split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 200));
  return `${minutes} min read`;
}

// ── TOC extraction ──

function extractToc(html) {
  const re = /<h([23])\s+id="([^"]*)">([\s\S]*?)<\/h[23]>/gi;
  const items = [];
  let m;
  while ((m = re.exec(html))) {
    items.push({ level: parseInt(m[1]), id: m[2], text: m[3].replace(/<[^>]+>/g, '').trim() });
  }
  if (items.length < 2) return '';
  return '<nav class="toc"><h3>Contents</h3><ul>' +
    items.map(i => `<li class="toc-h${i.level}"><a href="#${i.id}">${escapeHtml(i.text)}</a></li>`).join('') +
    '</ul></nav>';
}

// ── Markdown rendering ──

async function renderMarkdown(post, sourcePathToSlug) {
  const outputDir = path.join(blogDir, post.slug);
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFootnotes, { inlineNotes: false })
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
    .use(remarkParse).use(remarkGfm).use(remarkFootnotes, { inlineNotes: false }).use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw)
    .use(rehypeSanitize, sanitizeSchema)
    .use(rewriteRelativeUrls, { currentSlug: slug, outputDir: outDir, sourceDir, sourcePathToSlug })
    .use(rehypeKatex, { strict: 'ignore', throwOnError: false }).use(rehypeSlug).use(rehypeStringify)
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
  if (Array.isArray(node.children)) for (const c of node.children) visitElements(c, visitor);
}

function rewriteAssetUrl(rawUrl, options) {
  const parts = splitUrl(rawUrl);
  if (!isLocalPath(parts.pathname)) return rawUrl;
  const ext = path.extname(parts.pathname).toLowerCase();
  if (ext && !IMAGE_EXTENSIONS.has(ext)) return rawUrl;
  const tp = path.resolve(options.sourceDir, decodeUrlPath(parts.pathname));
  return joinUrlParts(relativeUrlPath(options.outputDir, tp), parts);
}

function rewriteLinkUrl(rawUrl, options) {
  const parts = splitUrl(rawUrl);
  if (!isLocalPath(parts.pathname)) return rawUrl;
  if (path.extname(parts.pathname).toLowerCase() === '.md') {
    const tp = path.resolve(options.sourceDir, decodeUrlPath(parts.pathname));
    const ts = options.sourcePathToSlug.get(tp);
    if (ts) {
      const h = ts === options.currentSlug ? './' : `../${ts}/`;
      return joinUrlParts(h, { search: '', hash: parts.hash });
    }
  }
  const tp = path.resolve(options.sourceDir, decodeUrlPath(parts.pathname));
  return joinUrlParts(relativeUrlPath(options.outputDir, tp, parts.pathname.endsWith('/')), parts);
}

function splitUrl(rawUrl) {
  const hi = rawUrl.indexOf('#');
  const before = hi === -1 ? rawUrl : rawUrl.slice(0, hi);
  const hash = hi === -1 ? '' : rawUrl.slice(hi);
  const qi = before.indexOf('?');
  return { pathname: qi === -1 ? before : before.slice(0, qi), search: qi === -1 ? '' : before.slice(qi), hash };
}

function isLocalPath(pn) { return Boolean(pn) && !pn.startsWith('/') && !pn.startsWith('//') && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(pn); }
function decodeUrlPath(pn) { try { return decodeURI(pn); } catch { return pn; } }
function relativeUrlPath(from, to, keepSlash) {
  const rel = path.relative(from, to).split(path.sep).join('/');
  const e = encodeURI(rel || '.');
  return keepSlash && !e.endsWith('/') ? `${e}/` : e;
}
function joinUrlParts(pn, parts) { return `${pn}${parts.search || ''}${parts.hash || ''}`; }
function slugify(v) { return String(v).normalize('NFKD').toLowerCase().trim().replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

// ── version history ──

function hashContent(c) { return crypto.createHash('sha256').update(c, 'utf8').digest('hex').slice(0, 16); }

async function appendVersion(post) {
  if (checkOnly) return;
  const h = hashContent(post.content);
  await fs.mkdir(historyDir, { recursive: true });
  const hp = path.join(historyDir, `${post.slug}.json`);
  let versions = [];
  try { versions = JSON.parse(await fs.readFile(hp, 'utf8')); } catch { }
  if (!Array.isArray(versions)) versions = [];
  if (versions.length && versions.at(-1).hash === h) return;
  const v = { id: String(versions.length + 1), createdAt: new Date().toISOString(), hash: h, title: post.title, date: post.dateText, description: post.description, tags: post.tags, cover: post.cover, content: post.content };
  versions.push(v);
  await fs.writeFile(hp, JSON.stringify(versions, null, 2), 'utf8');
}

async function readVersions(slug) {
  const p = path.join(historyDir, `${slug}.json`);
  try { const arr = JSON.parse(await fs.readFile(p, 'utf8')); return Array.isArray(arr) ? arr : []; }
  catch { return []; }
}

async function writeHistoryPages(post) {
  const versions = await readVersions(post.slug);
  if (!versions.length) return;
  const hd = path.join(blogDir, post.slug, 'history');
  await fs.mkdir(hd, { recursive: true });
  await fs.writeFile(path.join(hd, 'index.html'), renderHistoryIndex(post, versions), 'utf8');
  for (const v of versions) {
    const vd = path.join(hd, v.id);
    await fs.mkdir(vd, { recursive: true });
    const sp = new Map([[post.sourcePath, post.slug]]);
    const rendered = await renderArchivedMarkdown(v.content, post.slug, path.dirname(post.sourcePath), sp);
    await fs.writeFile(path.join(vd, 'index.html'), renderVersionPage(post, v, rendered), 'utf8');
  }
  const cd = path.join(blogDir, post.slug, 'compare');
  await fs.mkdir(cd, { recursive: true });
  await fs.writeFile(path.join(cd, 'index.html'), renderComparePage(post, versions), 'utf8');
}

function renderHistoryIndex(post, versions) {
  const list = versions.toReversed().map(v => `<article class="post-card"><p class="post-meta">${escapeHtml(v.createdAt.slice(0, 10))} <span style="color:var(--muted)">· v${escapeHtml(v.id)}</span></p><h2><a href="./${escapeAttribute(v.id)}/">${escapeHtml(v.title)}</a></h2>${v.description ? `<p>${escapeHtml(v.description)}</p>` : ''}</article>`).join('\n');
  return htmlDocument({ content: `<main class="shell">${siteNav('../../../')}<section class="hero-panel"><p class="eyebrow"><a href="../../">${escapeHtml(post.title)}</a> · History</p><h1>Version History</h1><p>${versions.length} snapshot${versions.length === 1 ? '' : 's'} — <a href="../compare/">compare versions</a></p></section><section class="post-list" aria-label="Post versions">${list}</section></main>`, description: `Version history for ${post.title}`, rootPrefix: '../../../', title: `History · ${post.title} · Fun10165`, ogType: 'article' });
}

function renderVersionPage(post, version, renderedHtml) {
  return htmlDocument({ content: `<main class="shell">${siteNav('../../../../')}<article class="article-panel"><header class="post-header"><p class="post-meta">v${escapeHtml(version.id)} · ${escapeHtml(version.createdAt.slice(0, 10))}${renderTags(version.tags || [])}</p><h1>${escapeHtml(version.title)}</h1>${version.description ? `<p class="description">${escapeHtml(version.description)}</p>` : ''}</header><div class="content">${renderedHtml}</div></article><p style="margin-top:1rem;color:var(--muted);font-size:0.85rem;"><a href="../">← Back to history</a> &nbsp;·&nbsp; <a href="../../">Current version</a></p></main>`, description: version.description || version.title, rootPrefix: '../../../../', title: `v${version.id} · ${post.title} · Fun10165`, ogType: 'article' });
}

function renderComparePage(post, versions) {
  const data = JSON.stringify(versions.map(v => ({ id: v.id, createdAt: v.createdAt.slice(0, 10), title: v.title, hash: v.hash, content: v.content })));
  const sd = data.replaceAll('</script>', '<\\/script>');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Compare · ${escapeHtml(post.title)} · Fun10165</title><link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/><link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/><style>:root{--paper:rgba(255,251,244,0.88);--panel:rgba(46,62,79,0.92);--text:#1f2b38;--muted:#5d6a77;--accent:#d4653f;--accent-2:#2f7f78;--line:rgba(31,43,56,0.12);--shadow:0 20px 60px rgba(31,43,56,0.16);--ins:#d4edda;--del-bg:#f8d7da}*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--text);font-family:IBM Plex Sans,sans-serif;line-height:1.7;background-color:#efe5d2;background-image:linear-gradient(rgba(239,229,210,0.82),rgba(239,229,210,0.92)),url('../../../bg-landscape.webp');background-attachment:fixed;background-position:center;background-size:cover}a{color:var(--accent-2);text-decoration-thickness:.08em;text-underline-offset:.18em}a:hover{color:var(--accent)}.shell{width:min(900px,calc(100% - 2rem));margin:0 auto;padding:1rem 0 4rem}.nav{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 0 1.5rem}.brand{display:inline-flex;align-items:center;gap:.8rem;color:inherit;font-size:.88rem;font-weight:700;letter-spacing:.04em;text-decoration:none;text-transform:uppercase}.brand-mark{display:inline-grid;width:2.5rem;height:2.5rem;place-items:center;border-radius:.9rem;color:#fdf7ea;background:var(--panel);box-shadow:var(--shadow)}.nav-links{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.75rem}.nav-links a{padding:.65rem 1rem;border:1px solid var(--line);border-radius:999px;color:var(--muted);background:rgba(255,255,255,.45);text-decoration:none;transition:transform .18s ease,border-color .18s ease,background .18s ease}.nav-links a:hover{transform:translateY(-2px);border-color:rgba(212,101,63,.45);background:rgba(255,255,255,.72)}.panel{border:1px solid rgba(31,43,56,.08);border-radius:2rem;background:var(--paper);box-shadow:var(--shadow);backdrop-filter:blur(18px);padding:clamp(1.4rem,4vw,2rem);margin:.75rem 0}h1,h2{font-family:DM Serif Display,Georgia,serif;line-height:1.12}h1{margin:0 0 .5rem;font-size:clamp(2rem,6vw,3.5rem)}h2{font-size:1.4rem;margin:1.5rem 0 .75rem}select{padding:.5rem .75rem;border-radius:.75rem;border:1px solid var(--line);font:inherit;background:var(--paper)}.diff-line{padding:.15rem .5rem;border-radius:.25rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88rem;white-space:pre-wrap;word-break:break-all}.diff-add{background:var(--ins)}.diff-del{background:var(--del-bg)}.diff-context{color:var(--muted)}@media(max-width:640px){.nav{align-items:flex-start;flex-direction:column}.nav-links{justify-content:flex-start}}@media(orientation:portrait){body{background-image:linear-gradient(rgba(239,229,210,0.82),rgba(239,229,210,0.92)),url('../../../bg-portrait.webp')}}</style></head><body><main class="shell">${siteNav('../../../')}<section class="panel"><h1>Compare Versions · ${escapeHtml(post.title)}</h1><p style="color:var(--muted)"><a href="../history/">← Back to history</a> &nbsp;·&nbsp; <a href="../">Current version</a></p><div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center;margin:1rem 0"><label>From <select id="v1"></select></label><label>To <select id="v2"></select></label><button id="diffBtn" style="padding:.5rem 1rem;border-radius:.75rem;border:1px solid var(--line);font:inherit;cursor:pointer;background:var(--panel);color:#fdf7ea">Compare</button></div><div id="diffOutput"></div></section></main><script>var VERSIONS=${sd};var v1=document.getElementById('v1');var v2=document.getElementById('v2');var btn=document.getElementById('diffBtn');var out=document.getElementById('diffOutput');VERSIONS.forEach(function(v,i){var o1=document.createElement('option');o1.value=i;o1.textContent='v'+v.id+' ('+v.createdAt+')';v1.appendChild(o1);var o2=o1.cloneNode(true);v2.appendChild(o2)});if(VERSIONS.length>=2)v2.selectedIndex=VERSIONS.length-1;function lcs(a,b){var m=a.length,n=b.length;var dp=new Array(m+1);for(var i=0;i<=m;i++){dp[i]=new Array(n+1);for(var j=0;j<=n;j++)dp[i][j]=0}for(var i=1;i<=m;i++)for(var j=1;j<=n;j++)dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]+1:Math.max(dp[i-1][j],dp[i][j-1]);var i=m,j=n,ops=[];while(i>0||j>0){if(i>0&&j>0&&a[i-1]===b[j-1]){ops.unshift({t:'eq',l:a[i-1]});i--;j--}else if(j>0&&(i===0||dp[i][j-1]>=dp[i-1][j])){ops.unshift({t:'add',l:b[j-1]});j--}else{ops.unshift({t:'del',l:a[i-1]});i--}}return ops}function escape(s){return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}btn.onclick=function(){var a=VERSIONS[parseInt(v1.value)];var b=VERSIONS[parseInt(v2.value)];var diff=lcs(a.content.split('\\n'),b.content.split('\\n'));var html='<h2>v'+a.id+' → v'+b.id+'</h2>';diff.forEach(function(op){if(op.t==='eq')html+='<div class="diff-line diff-context"> '+escape(op.l)+'</div>';else if(op.t==='add')html+='<div class="diff-line diff-add">+'+escape(op.l)+'</div>';else html+='<div class="diff-line diff-del">-'+escape(op.l)+'</div>'});out.innerHTML=html}</script></body></html>`;
}

// ── page renderers ──

function renderBlogIndex(posts) {
  const list = posts.map(post => {
    const coverHtml = post.cover ? `<img src="${escapeAttribute(rewriteCoverUrl(post.cover, post.slug, post.sourcePath))}" alt="" class="post-cover" loading="lazy"/>` : '';
    return `<article class="post-card">${coverHtml}<p class="post-meta"><time datetime="${escapeHtml(post.dateText)}">${formatDate(post.dateText)}</time> · ${post.readingTime}${renderTags(post.tags)}</p><h2><a href="./${escapeAttribute(post.slug)}/">${escapeHtml(post.title)}</a></h2>${post.description ? `<p>${escapeHtml(post.description)}</p>` : ''}</article>`;
  }).join('\n');
  return htmlDocument({ content: `<main class="shell">${siteNav('../')}<section class="hero-panel"><p class="eyebrow">Blog</p><h1>Notes from Fun10165</h1><p>Static posts generated from Markdown, with GitHub-flavored Markdown and KaTeX math rendered at build time. <a href="./feed.xml">RSS</a></p></section><section class="post-list" aria-label="Blog posts">${list}</section></main>`, description: 'Notes from Fun10165.', rootPrefix: '../', title: 'Blog · Fun10165', ogType: 'website' });
}

function renderPostPage(post, prev, next, allPosts) {
  const coverHtml = post.cover ? `<img src="${escapeAttribute(rewriteCoverUrl(post.cover, post.slug, post.sourcePath))}" alt="" class="post-cover-hero"/>` : '';
  const seriesPosts = post.series ? allPosts.filter(p => p.series === post.series && p.slug !== post.slug).sort((a, b) => a.dateValue - b.dateValue) : [];
  const seriesHtml = seriesPosts.length ? `<p class="series-note">Part of series <strong>${escapeHtml(post.series)}</strong>: ${seriesPosts.map((p, i) => `<a href="../${escapeAttribute(p.slug)}/">${i + 1}. ${escapeHtml(p.title)}</a>`).join(', ')}</p>` : '';
  const prevHtml = prev ? `<a class="prev-next-link" href="../${escapeAttribute(prev.slug)}/">← ${escapeHtml(prev.title)}</a>` : '';
  const nextHtml = next ? `<a class="prev-next-link" href="../${escapeAttribute(next.slug)}/">${escapeHtml(next.title)} →</a>` : '';
  const tagPageLinks = post.tags.map(t => `<a href="../tags/${escapeHtml(t)}/">#${escapeHtml(t)}</a>`).join(' ');
  return htmlDocument({
    content: `<main class="shell">${siteNav('../../')}<article class="article-panel"><header class="post-header">${coverHtml}<p class="post-meta"><time datetime="${escapeHtml(post.dateText)}">${formatDate(post.dateText)}</time> · ${post.readingTime}${renderTags(post.tags)}</p><h1>${escapeHtml(post.title)}</h1>${post.description ? `<p class="description">${escapeHtml(post.description)}</p>` : ''}</header>${post.toc ? `<aside class="toc-container">${post.toc}</aside>` : ''}<div class="content">${post.html}</div></article><footer class="post-footer"><div class="prev-next">${prevHtml}${nextHtml}</div>${seriesHtml}${tagPageLinks ? `<p class="post-tags">Tags: ${tagPageLinks}</p>` : ''}<p class="post-links"><a href="./history/">View history</a> &nbsp;·&nbsp; <a href="./compare/">Compare versions</a> &nbsp;·&nbsp; <a href="../">All posts</a></p></footer>${renderComments(post.slug)}</main>`,
    description: post.description || post.title,
    ogImage: post.cover ? homepageCoverUrl(post.cover, post.sourcePath) : '',
    ogType: 'article',
    publishedTime: post.dateText,
    rootPrefix: '../../',
    title: `${post.title} · Fun10165`
  });
}

function renderComments(slug) {
  return `<section class="comments" id="comments"><h2>Comments</h2>
<script src="https://giscus.app/client.js"
  data-repo="Fun10165/fun10165.github.io"
  data-repo-id="MDEwOlJlcG9zaXRvcnkyMDQ0MjUyNDU="
  data-category="General"
  data-category-id="DIC_kwDODC9IHc4C_jM_"
  data-mapping="pathname"
  data-strict="0"
  data-reactions-enabled="1"
  data-emit-metadata="0"
  data-input-position="top"
  data-theme="light"
  data-lang="zh-CN"
  crossorigin="anonymous"
  async>
</script>
<noscript>Please enable JavaScript to view comments via <a href="https://github.com/Fun10165/fun10165.github.io/discussions">GitHub Discussions</a>.</noscript>
</section>`;
}

// ── RSS feed ──

function renderRssFeed(posts) {
  const items = posts.map(p => `    <item>
      <title>${escapeXml(p.title)}</title>
      <link>https://fun10165.github.io/blog/${escapeXml(p.slug)}/</link>
      <guid>https://fun10165.github.io/blog/${escapeXml(p.slug)}/</guid>
      <pubDate>${new Date(`${p.dateText}T00:00:00Z`).toUTCString()}</pubDate>
      <description>${escapeXml(p.description)}</description>
      ${p.tags.map(t => `<category>${escapeXml(t)}</category>`).join('\n      ')}
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Fun10165 Blog</title>
  <link>https://fun10165.github.io/blog/</link>
  <description>Notes from Fun10165</description>
  <language>zh-CN</language>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  <atom:link href="https://fun10165.github.io/blog/feed.xml" rel="self" type="application/rss+xml"/>
${items}
</channel>
</rss>`;
}

// ── sitemap ──

function renderSitemap(posts) {
  const items = posts.map(p => `  <url><loc>https://fun10165.github.io/blog/${escapeXml(p.slug)}/</loc><lastmod>${escapeXml(p.dateText)}</lastmod></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://fun10165.github.io/</loc></url>
  <url><loc>https://fun10165.github.io/blog/</loc></url>
${items}
</urlset>`;
}

// ── tag pages ──

async function writeTagPages(posts) {
  const tagMap = new Map();
  for (const p of posts) for (const t of p.tags) {
    if (!tagMap.has(t)) tagMap.set(t, []);
    tagMap.get(t).push(p);
  }
  for (const [tag, tagged] of tagMap) {
    const td = path.join(blogDir, 'tags', tag);
    await fs.mkdir(td, { recursive: true });
    const list = tagged.map(p => `<article class="post-card"><p class="post-meta"><time datetime="${escapeHtml(p.dateText)}">${formatDate(p.dateText)}</time> · ${p.readingTime}${renderTags(p.tags)}</p><h2><a href="../../${escapeAttribute(p.slug)}/">${escapeHtml(p.title)}</a></h2>${p.description ? `<p>${escapeHtml(p.description)}</p>` : ''}</article>`).join('\n');
    await fs.writeFile(path.join(td, 'index.html'), htmlDocument({ content: `<main class="shell">${siteNav('../../')}<section class="hero-panel"><p class="eyebrow">Tag</p><h1>#${escapeHtml(tag)}</h1><p>${tagged.length} post${tagged.length === 1 ? '' : 's'}</p></section><section class="post-list">${list}</section></main>`, description: `Posts tagged #${tag}`, rootPrefix: '../../', title: `#${tag} · Fun10165`, ogType: 'website' }), 'utf8');
  }
}

// ── series pages ──

async function writeSeriesPages(posts) {
  const seriesMap = new Map();
  for (const p of posts) {
    if (!p.series) continue;
    if (!seriesMap.has(p.series)) seriesMap.set(p.series, []);
    seriesMap.get(p.series).push(p);
  }
  for (const [name, sposts] of seriesMap) {
    sposts.sort((a, b) => a.dateValue - b.dateValue);
    const sd = path.join(blogDir, 'series', name);
    await fs.mkdir(sd, { recursive: true });
    const list = sposts.map((p, i) => `<article class="post-card"><p class="post-meta"><span style="color:var(--accent)">${i + 1}.</span> <time datetime="${escapeHtml(p.dateText)}">${formatDate(p.dateText)}</time> · ${p.readingTime}${renderTags(p.tags)}</p><h2><a href="../../${escapeAttribute(p.slug)}/">${escapeHtml(p.title)}</a></h2>${p.description ? `<p>${escapeHtml(p.description)}</p>` : ''}</article>`).join('\n');
    await fs.writeFile(path.join(sd, 'index.html'), htmlDocument({ content: `<main class="shell">${siteNav('../../')}<section class="hero-panel"><p class="eyebrow">Series</p><h1>${escapeHtml(name)}</h1><p>${sposts.length} post${sposts.length === 1 ? '' : 's'}</p></section><section class="post-list">${list}</section></main>`, description: `Series: ${name}`, rootPrefix: '../../', title: `${name} · Fun10165`, ogType: 'website' }), 'utf8');
  }
}

// ── search page ──

async function writeSearchPage(posts) {
  const index = JSON.stringify(posts.map(p => ({ title: p.title, slug: p.slug, description: p.description, date: p.dateText, tags: p.tags })));
  const sd = index.replaceAll('</script>', '<\\/script>');
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Search · Fun10165</title><meta name="description" content="Search Fun10165 blog posts"/><link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/><link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/><style>:root{--paper:rgba(255,251,244,0.88);--panel:rgba(46,62,79,0.92);--text:#1f2b38;--muted:#5d6a77;--accent:#d4653f;--accent-2:#2f7f78;--line:rgba(31,43,56,0.12);--shadow:0 20px 60px rgba(31,43,56,0.16)}*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--text);font-family:IBM Plex Sans,sans-serif;line-height:1.7;background-color:#efe5d2;background-image:linear-gradient(rgba(239,229,210,0.82),rgba(239,229,210,0.92)),url('../bg-landscape.webp');background-attachment:fixed;background-position:center;background-size:cover}a{color:var(--accent-2);text-decoration-thickness:.08em;text-underline-offset:.18em}a:hover{color:var(--accent)}.shell{width:min(900px,calc(100% - 2rem));margin:0 auto;padding:1rem 0 4rem}.nav{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 0 1.5rem}.brand{display:inline-flex;align-items:center;gap:.8rem;color:inherit;font-size:.88rem;font-weight:700;letter-spacing:.04em;text-decoration:none;text-transform:uppercase}.brand-mark{display:inline-grid;width:2.5rem;height:2.5rem;place-items:center;border-radius:.9rem;color:#fdf7ea;background:var(--panel);box-shadow:var(--shadow)}.nav-links{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.75rem}.nav-links a{padding:.65rem 1rem;border:1px solid var(--line);border-radius:999px;color:var(--muted);background:rgba(255,255,255,.45);text-decoration:none;transition:transform .18s ease,border-color .18s ease,background .18s ease}.nav-links a:hover{transform:translateY(-2px);border-color:rgba(212,101,63,.45);background:rgba(255,255,255,.72)}h1{font-family:DM Serif Display,Georgia,serif;font-size:clamp(2rem,6vw,3.5rem);margin:0 0 1rem}.search-input{width:100%;padding:.75rem 1rem;border:1px solid var(--line);border-radius:1rem;font:inherit;font-size:1rem;background:var(--paper);box-shadow:var(--shadow);margin-bottom:1.5rem}.post-card{border:1px solid rgba(31,43,56,.08);border-radius:2rem;background:var(--paper);box-shadow:var(--shadow);backdrop-filter:blur(18px);padding:1.4rem 1.6rem;margin-bottom:1rem}.post-card h2{margin:0 0 .3rem;font-family:DM Serif Display,Georgia,serif}a{text-decoration:none}.post-card h2 a{color:inherit}.post-card p{margin:0;color:var(--muted)}.no-results{text-align:center;color:var(--muted);padding:2rem}@media(max-width:640px){.nav{align-items:flex-start;flex-direction:column}.nav-links{justify-content:flex-start}}@media(orientation:portrait){body{background-image:linear-gradient(rgba(239,229,210,0.82),rgba(239,229,210,0.92)),url('../bg-portrait.webp')}}</style></head><body><main class="shell">${siteNav('../')}<h1>Search</h1><input type="search" class="search-input" placeholder="Search posts..." id="search" autofocus/><div id="results" class="post-card" style="text-align:center;color:var(--muted)">Type to search ${posts.length} posts</div></main><script>var POSTS=${sd};var inp=document.getElementById('search');var out=document.getElementById('results');function esc(s){return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}inp.oninput=function(){var q=inp.value.toLowerCase().trim();if(!q){out.innerHTML='<div class="post-card" style="text-align:center;color:var(--muted)">Type to search '+POSTS.length+' posts</div>';return}var filtered=POSTS.filter(function(p){var txt=(p.title+' '+p.description+' '+p.tags.join(' ')).toLowerCase();return txt.includes(q)});if(!filtered.length){out.innerHTML='<div class="no-results">No posts matching "'+esc(q)+'"</div>';return}out.innerHTML=filtered.map(function(p){return '<div class="post-card"><p style="font-size:.82rem;color:var(--accent)">'+p.date+'</p><h2><a href="./'+esc(p.slug)+'/">'+esc(p.title)+'</a></h2><p>'+esc(p.description)+'</p></div>'}).join('')}</script></main></body></html>`;
  await fs.mkdir(path.join(blogDir, 'search'), { recursive: true });
  await fs.writeFile(path.join(blogDir, 'search', 'index.html'), html, 'utf8');
}

// ── homepage injection ──

function rewriteCoverUrl(cover, slug, sourcePath) {
  if (!cover) return '';
  if (/^https?:\/\//i.test(cover) || cover.startsWith('//')) return cover;
  const tp = path.resolve(path.dirname(sourcePath), decodeUrlPath(cover));
  return relativeUrlPath(path.join(blogDir, slug), tp);
}

async function writeHomepageRecentPosts(posts) {
  const ip = path.join(rootDir, 'index.html');
  const html = await fs.readFile(ip, 'utf8');
  const start = '            // BLOG_RECENT_POSTS_START';
  const end = '            // BLOG_RECENT_POSTS_END';
  if (!html.includes(start) || !html.includes(end)) throw new BuildError('index.html missing BLOG_RECENT_POSTS markers.');
  const payload = posts.map(p => `            ${JSON.stringify({ title: p.title, date: formatDate(p.dateText), description: p.description, slug: p.slug, cover: homepageCoverUrl(p.cover, p.sourcePath), tags: p.tags })}`).join(',\n');
  const re = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  await fs.writeFile(ip, html.replace(re, `${start}\n${payload}\n${end}`), 'utf8');
}

function homepageCoverUrl(cover, sourcePath) {
  if (!cover) return '';
  if (/^https?:\/\//i.test(cover) || cover.startsWith('//')) return cover;
  return `./${relativePath(path.resolve(path.dirname(sourcePath), decodeUrlPath(cover)))}`;
}

// ── html document ──

function htmlDocument({ content, description, ogImage, ogType, publishedTime, rootPrefix, title }) {
  const ogImg = ogImage ? `<meta property="og:image" content="https://fun10165.github.io/${ogImage.replace(/^\.\//, '')}"/>` : '';
  const ogPt = publishedTime ? `<meta property="article:published_time" content="${escapeAttribute(publishedTime)}"/>` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttribute(description)}" />
  <meta property="og:title" content="${escapeAttribute(title)}" />
  <meta property="og:description" content="${escapeAttribute(description)}" />
  <meta property="og:type" content="${escapeAttribute(ogType || 'website')}" />
  ${ogImg}
  ${ogPt}
  <meta name="twitter:card" content="summary" />
  <link rel="alternate" type="application/rss+xml" title="Fun10165 Blog" href="${rootPrefix}blog/feed.xml" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet" />
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
    .nav-links a { padding:0.65rem 1rem; border:1px solid var(--line); border-radius:999px; color:var(--muted); background:rgba(255,255,255,0.45); text-decoration:none; transition:transform 180ms ease,border-color 180ms ease,background 180ms ease; }
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
    /* TOC */
    .toc { margin: 1.5rem 0; padding: 1rem 1.2rem; border: 1px solid var(--line); border-radius: 1rem; background: rgba(255,251,244,0.5); }
    .toc h3 { margin: 0 0 0.6rem; font-size: 1rem; }
    .toc ul { list-style: none; padding: 0; margin: 0; }
    .toc li { margin: 0.3rem 0; }
    .toc-h3 { padding-left: 1.2rem; font-size: 0.9rem; }
    .toc a { color: var(--text); text-decoration: none; }
    .toc a:hover { color: var(--accent); }
    /* prev/next */
    .prev-next { display: flex; justify-content: space-between; gap: 1rem; margin: 2rem 0 1rem; }
    .prev-next-link { padding: 0.75rem 1rem; border: 1px solid var(--line); border-radius: 1rem; background: var(--paper); text-decoration: none; color: var(--text); transition: transform 180ms ease; flex: 1; }
    .prev-next-link:hover { transform: translateY(-2px); }
    .prev-next-link:first-child { text-align: left; }
    .prev-next-link:last-child { text-align: right; }
    .prev-next-link:only-child { text-align: center; }
    .post-footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--line); font-size: 0.88rem; color: var(--muted); }
    .post-tags { font-size: 0.88rem; }
    .post-tags a { margin: 0 0.2rem; }
    .post-links { margin-top: 0.8rem; font-size: 0.85rem; }
    .series-note { padding: 0.75rem 1rem; border-left: 3px solid var(--accent-2); border-radius: 0.75rem; background: rgba(47,127,120,0.08); margin: 1rem 0; }
    .comments { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--line); }
    .footnotes { font-size: 0.88rem; color: var(--muted); border-top: 1px solid var(--line); margin-top: 3rem; padding-top: 1rem; }
    pre[class*="language-"], code[class*="language-"] { font-size: 0.88rem; }
    @media (max-width:640px) { .nav { align-items:flex-start; flex-direction:column; } .nav-links { justify-content:flex-start; } .prev-next { flex-direction: column; } }
    @media (orientation: portrait) { body { background-image: linear-gradient(rgba(239,229,210,0.82),rgba(239,229,210,0.92)),url('${rootPrefix}bg-portrait.webp'); } }
  </style>
</head>
<body>
${content}
</body>
</html>`;
}

// ── helpers ──

function siteNav(rootPrefix) {
  return `<nav class="nav" aria-label="Primary navigation"><a class="brand" href="${rootPrefix}"><span class="brand-mark">F</span><span>Fun10165</span></a><div class="nav-links"><a href="${rootPrefix}">Home</a><a href="${rootPrefix}blog/">Blog</a><a href="${rootPrefix}blog/search/">Search</a></div></nav>`;
}

function renderTags(tags) {
  if (!tags.length) return '';
  const links = tags.map(t => `<a href="../../tags/${escapeHtml(t)}/" style="text-decoration:none;color:var(--muted)">#${escapeHtml(t)}</a>`).join(' ');
  return `<span class="tag-list">${links}</span>`;
}

function formatDate(dateText) {
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC', year: 'numeric' }).format(new Date(`${dateText}T00:00:00Z`));
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function escapeAttribute(value) { return escapeHtml(value).replaceAll('`', '&#96;'); }

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function relativePath(fp) { return path.relative(rootDir, fp).split(path.sep).join('/') || '.'; }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

class BuildError extends Error {
  constructor(message) { super(message); this.name = 'BuildError'; }
}

main().catch((error) => {
  if (error instanceof BuildError) { console.error(`build-blog: ${error.message}`); process.exitCode = 1; return; }
  console.error(error);
  process.exitCode = 1;
});
