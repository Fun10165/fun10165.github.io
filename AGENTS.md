# Repository Guidelines

## Project Overview

Personal GitHub Pages site (`fun10165.github.io`) — a Vue 3 CDN homepage plus a generated static Markdown blog. The homepage is still a single-page portfolio/archive entry point; blog HTML is generated from Markdown and committed under `blog/` for GitHub Pages.

## Architecture & Data Flow

```
index.html (Vue 3 SPA, CDN-loaded)
  |
  +-- Vue 3 Options API app (createApp)
  |     data: timeline, projects, now, blog, yearsOnline, revealEgg
  |     methods: toggleEgg()
  |     mount: #app
  |
  +-- Inline <style> (CSS custom properties, single responsive grid layout)
  |
  +-- Links to ./blog/ (generated static blog index)
  |
  +-- Links to classic/index.html (preserved original, plain HTML)

content/posts/*.md (frontmatter + Markdown)
  |
  +-- build:blog -> blog/index.html and blog/<slug>/index.html
```

- **No router** — anchor-based homepage scrolling (`#story`, `#now`, `#projects`, `#legacy`) plus a plain `./blog/` Blog link
- **No API calls, no state management** beyond Vue `data()`
- **All content is hardcoded** in the Vue `data()` object (Chinese text)
- **No components** — single inline template string in `createApp({ template: … })`

## Key Directories

| Path | Purpose |
|---|---|
| `index.html` | Main page: Vue 3 app with inline CSS and JS |
| `avatar.webp` | 1920×1920 avatar image (WebP, 294KB) |
| `hit-logo.svg` | HIT Shenzhen logo SVG (blue, 122KB) |
| `classic/index.html` | Preserved original 2019 homepage (plain HTML, no JS) |
| `content/posts/*.md` | Markdown blog source posts with frontmatter |
| `blog/` | Generated static blog output served by GitHub Pages |

The `banks/` directory contains Mnemopi tooling artifacts and is **not part of the site content**.

## Development Commands

| Task | Command |
|---|---|
| Local preview | `python3 -m http.server 8000` or any static file server from repo root |
| Build blog | `npm run build:blog` |
| Check blog output | `npm run check:blog` |
| Build static generated assets | `npm run build` |
| Deploy | Run the blog build, commit generated `blog/`, then push to `main`; GitHub Pages serves the root |

### Pre-commit hook

A pre-commit hook in `.githooks/pre-commit` validates HTML structure, JS syntax, and Vue template integrity
on every commit. Configured via `git config core.hooksPath .githooks`. It blocks commits that fail any check.

Run manually: `bash .githooks/pre-commit`

### Post-commit hook

A post-commit hook in `.githooks/post-commit` runs full HTML/JS/Vue validation on all files and `check:blog`
after each commit. It is non-blocking and skips JS syntax checks on generated compare pages.

Run manually: `bash .githooks/post-commit`

The homepage has no bundler. Vue 3 is loaded from CDN at runtime:

```html
<script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
```

The blog build is a Node-based static generation workflow only: source Markdown stays in `content/posts/`, generated HTML stays in `blog/`.

## Code Conventions & Common Patterns

### Vue pattern
- **Options API** with `data()`, `methods`, `template` (no Composition API, no `<script setup>`)
- Single `createApp({…}).mount("#app")` call
- Template uses `v-for`, `v-if`, `:key`, `@click`, `{{ }}` interpolation directly in a template string
- `yearsOnline` computed once in `data()` via `new Date().getFullYear() - 2019` (not reactive to time)
- Blog homepage card data lives in the same `data()` object; keep homepage additions in the Options API style

### CSS pattern
- CSS custom properties in `:root` for theming (`--bg`, `--accent`, `--panel`, etc.)
- Single breakpoint system: `@media (max-width: 820px)` and `@media (max-width: 640px)`
- Staggered reveal animations via `.reveal` + `.delay-1` through `.delay-3` classes
- Fonts loaded from Google Fonts: DM Serif Display (headings), IBM Plex Sans (body)
- Layout: CSS Grid (`hero`, `sections`) with `min(1120px, calc(...))` centering shell

### HTML pattern
- Static `<div id="app">` mount point
- All content in Chinese (lang="zh-CN")
- Semantic HTML: `<header>`, `<nav>`, `<main>`, `<section>`, `<article>`, `<aside>`, `<footer>`


### Blog workflow
- Add posts as `content/posts/*.md` with frontmatter: `title`, `date`, `description`, `tags`, and optional `slug`.
- Optional frontmatter field `cover` (relative or absolute image URL) adds a hero image to post pages and a thumbnail on the blog index.
- Run `npm run build:blog` to regenerate `blog/index.html` and each `blog/<slug>/index.html` page.
- Run `npm run check:blog` before committing generated blog output when touching posts or the generator.
- Every build appends a content snapshot to `content/post-history/<slug>.json` when the content hash changes (skipped in `--check` mode).
- Generated pages: `blog/<slug>/history/index.html` (version list), `blog/<slug>/history/<version-id>/index.html` (archived version), `blog/<slug>/compare/index.html` (client-side line diff between any two versions).
- Markdown conversion should use a unified/remark/rehype pipeline, not regex conversion: `remark-gfm`, `remark-math`, `rehype-sanitize`, `rehype-katex`, `rehype-slug`, and `rehype-stringify`.
- Math rendering choice: LaTeX-style inline/block formulae are rendered to static KaTeX HTML; include KaTeX CSS in generated pages.
- Preserve link and image paths/extensions from Markdown where safe, and sanitize raw Markdown HTML before KaTeX/stringify.
## Important Files

| File | Role |
|---|---|
| `index.html` | Homepage source — contains all homepage HTML, CSS, and JS |
| `content/posts/*.md` | Blog source posts |
| `blog/index.html` | Generated blog listing page |
| `blog/<slug>/index.html` | Generated standalone blog post pages |
| `avatar.webp` | 1920×1920 avatar, displayed prominently in hero |
| `hit-logo.svg` | Inline SVG logo for HIT Shenzhen, placed above school name in hero |
| `classic/index.html` | Historical archive, never modified by design |
| `README.md` | Minimal project description |

## Runtime/Tooling Preferences

- **Static output** — homepage and generated blog HTML are served directly by GitHub Pages
- **Homepage runtime** — Vue loaded from CDN; edit `index.html` directly for homepage changes
- **Blog build** — use the npm scripts for Markdown-to-HTML generation, then commit the generated `blog/` output
- **No TypeScript on the homepage** — plain JavaScript (ES6+)
- **No CSS preprocessor** — vanilla CSS with custom properties

## Testing & QA

- **No test framework** — manual visual verification in browser
- Test changes by opening `index.html` directly or via a local static server
- Verify: desktop layout (>820px), tablet/mobile layout at the 820px and 640px breakpoints
- Verify: anchor links scroll, Blog nav and Blog card resolve to `./blog/`, egg toggle works, classic link resolves
