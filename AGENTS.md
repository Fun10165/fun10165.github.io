# Repository Guidelines

## Project Overview

Personal GitHub Pages site (`fun10165.github.io`) built with Astro. It combines a static personal homepage, a Markdown blog, generated post-history and comparison pages, and the preserved 2019 homepage under `/classic/`.

Astro renders the site as static HTML into `dist/`; GitHub Actions deploys that directory to GitHub Pages. User-authored posts and history snapshots remain under `content/`.

## Architecture & Data Flow

```text
content/posts/*.md
  ├─ Astro Content Collection (`src/content.config.ts`)
  ├─ Markdown pipeline (`astro.config.mjs`, `src/lib/markdown.mjs`)
  ├─ static post, tag, series, search, RSS, and sitemap routes
  └─ snapshot script → content/post-history/<slug>.json

src/pages/index.astro
  └─ static personal homepage with one small client-side egg toggle

src/pages/blog/
  ├─ index, search, RSS, and blog sitemap
  ├─ [slug] post, history, archived version, and compare routes
  ├─ tags/[tag]
  └─ series/[series]

public/
  ├─ canonical static assets and preserved `classic/`
  └─ generated `content/posts/` image copies (ignored by Git)

astro build → dist/ → GitHub Pages
```

- Astro uses static output with trailing slashes.
- The homepage and blog share `BaseLayout.astro` and global design tokens.
- Markdown is rendered through unified with GFM, footnotes, math, sanitization, KaTeX, heading IDs, and local URL rewriting.
- Blog content is validated by the `posts` Content Collection schema.
- Interactive JavaScript is limited to search, version comparison, the homepage egg toggle, and Giscus comments.

## Key Directories

| Path | Purpose |
|---|---|
| `src/pages/` | Astro file-based routes |
| `src/layouts/` | Shared document shells and metadata |
| `src/components/` | Reusable post-list and comments UI |
| `src/styles/` | Shared design system and homepage-specific CSS |
| `src/lib/` | Post, history, and Markdown utilities |
| `content/posts/` | User-authored Markdown posts and source images |
| `content/post-history/` | Committed immutable post snapshots |
| `scripts/snapshot-posts.mjs` | Appends or verifies content snapshots |
| `scripts/sync-content-assets.mjs` | Copies post images into Astro's public tree |
| `public/` | Static assets copied directly to the built site |
| `dist/` | Generated deployment output; never commit or edit |

The `banks/` directory contains Mnemopi tooling artifacts and is not part of the site.

## Development Commands

| Task | Command |
|---|---|
| Install dependencies | `npm ci` |
| Local development | `npm run dev` |
| Type/content checks | `npm run check` |
| Production build | `npm run build` |
| Preview production output | `npm run preview` |
| Generate share image for a post | `npm run share -- <slug>` |
| Legacy-compatible build alias | `npm run build:blog` |
| Full blog check and build | `npm run check:blog` |

`npm run build` first appends a history snapshot when a post body has changed, synchronizes post images, and then runs `astro build`. Stage any resulting `content/post-history/*.json` change with the post. `npm run check` is read-only with respect to history and fails when a current snapshot is missing.

`npm run share -- <slug>` rebuilds the site, renders the post's dedicated share view with a headless Chrome screenshot, and writes `share/<slug>.png`. Generated images are gitignored. The share view itself lives at `/blog/<slug>/share/` and is excluded from sitemaps and search indexing.



GitHub Pages deployment is defined in `.github/workflows/deploy.yml`. It runs `npm ci`, builds the site, and deploys `dist/` through the Pages artifact action.

### Git hooks

- `.githooks/pre-commit` runs the Astro checks for staged site inputs.
- `.githooks/post-commit` runs the full Astro check and build after a commit.
- Run either hook directly with `bash .githooks/pre-commit` or `bash .githooks/post-commit`.

## Content Conventions

Add posts as `content/posts/*.md` with frontmatter:

```yaml
---
title: "Required title"
date: "YYYY-MM-DD"
description: "Required summary"
tags:
  - tag
slug: optional-stable-slug
cover: optional-relative-or-absolute-image
series: optional-series-name
---
```

- Keep every public slug stable after publication.
- Relative post images belong beside the Markdown source, commonly under `content/posts/assets/`.
- Markdown-to-Markdown links are rewritten to the target post route when the target exists.
- Raw Markdown HTML is sanitized before rendering.
- LaTeX-style inline and block math is rendered to static KaTeX HTML.
- History files are generated data but are committed because they are part of the public version archive.
- Do not hand-edit generated copies under `public/content/` or anything under `dist/`.

## Code Conventions

### Astro and TypeScript

- Prefer Astro components for static markup and use client JavaScript only for observable interaction.
- Keep shared page chrome and metadata in `BaseLayout.astro`.
- Put reusable data and routing logic in `src/lib/`, not duplicated across page routes.
- Use Content Collection types (`CollectionEntry<'posts'>`) instead of ad hoc post objects.
- Throw explicit build errors for invalid content, duplicate slugs, and malformed history records.
- Preserve the existing URL families and trailing-slash behavior.

### CSS

- Reuse the custom properties in `src/styles/global.css` for color, spacing, type, borders, and shadows.
- Put page-specific styles next to that page or in a clearly named stylesheet.
- Maintain responsive behavior at desktop, tablet, and phone widths.
- Visual changes must preserve every content block and interaction; verify rendered output rather than source alone.

### Markdown and history

- Keep the unified/remark/rehype pipeline centralized in `astro.config.mjs` and `src/lib/markdown.mjs`.
- Use the same Markdown behavior for current and archived posts.
- Snapshot IDs and files are stable public routes; never renumber or rewrite old entries.
- Escape serialized JSON embedded into HTML before assigning it with `set:html`.

## Important Routes

| Route | Purpose |
|---|---|
| `/` | Personal homepage |
| `/blog/` | Blog index |
| `/blog/<slug>/` | Current post |
| `/blog/<slug>/history/` | Version list |
| `/blog/<slug>/history/<id>/` | Archived version |
| `/blog/<slug>/compare/` | Client-side line comparison |
| `/blog/<slug>/share/` | Share-image view, excluded from sitemaps and indexing |
| `/blog/tags/<tag>/` | Tag archive |
| `/blog/series/<series>/` | Series archive |
| `/blog/search/` | Client-side title, description, and tag search |
| `/blog/feed.xml` | RSS feed |
| `/blog/sitemap.xml` | Blog-compatible sitemap |
| `/classic/` | Preserved 2019 homepage |

## Testing and QA

- `npm run check` must report zero Astro diagnostics.
- `npm run check:blog` must build every static route successfully.
- When changing routes or generators, compare the complete route inventory before and after.
- For homepage or visual changes, inspect both desktop and narrow mobile layouts in a real browser.
- Smoke-test anchor navigation, search matching and empty states, the egg toggle, history navigation, version comparison, Giscus loading, local images, GFM fixtures, tables, task lists, footnotes, and KaTeX.
- Verify no horizontal overflow, overlap, truncation, missing content, or broken static assets before deployment.
