# fun10165.github.io

Personal website and Markdown blog built with Astro and deployed as static HTML to GitHub Pages.

## Structure

- `src/`: Astro pages, layouts, components, styles, and build utilities
- `content/posts/`: Markdown post sources and local images
- `content/post-history/`: committed post-version snapshots
- `public/classic/`: preserved original homepage from the early GitHub Pages days

## Development

```sh
npm ci
npm run dev
npm run check
npm run build
```

The production build is written to `dist/` and deployed by `.github/workflows/deploy.yml`.
