# evenfire docs website

Docusaurus 3 site that publishes the repository's [`docs/`](../docs) directory
as a documentation website (docs-only mode — the docs tree stays the single
source of truth and remains browsable on GitHub).

The setup follows the pattern used by comparable agentic platforms:
Hermes Agent (Docusaurus, GitHub Pages, local search, `llms.txt` prebuild) and
OpenClaw (llms.txt + LLM-consumable markdown). Concretely:

- **Content**: sourced from `../docs` (`routeBasePath: '/'`); internal working
  dirs (`docs/agents`, `docs/control-ui`, `docs/desktop-ui-ux`) are excluded.
- **Sidebar**: curated explicitly in [`sidebars.ts`](sidebars.ts)
  (Getting Started → Architecture → CRD Reference → Deployment → Features →
  Testing → Reference).
- **Repo links**: [`src/remark/repoLinks.mjs`](src/remark/repoLinks.mjs)
  rewrites relative links that point outside `docs/` (service READMEs, charts,
  root policy files) — or to deleted files — into absolute GitHub URLs, so the
  same markdown works on GitHub and on the site.
- **Search**: `@easyops-cn/docusaurus-search-local` (client-side, no Algolia).
- **Diagrams**: Mermaid via `@docusaurus/theme-mermaid`.
- **LLM-consumable docs**: `scripts/generate-llms-txt.mjs` (postbuild) emits
  `llms.txt` (index) and `llms-full.txt` (full concatenation) into `build/`.
- **Deploy**: `.github/workflows/docs-site.yml` builds on PRs and deploys to
  GitHub Pages on pushes to `main`.

## Local development

```bash
cd website
npm install
npm start          # dev server at http://localhost:3000/evenfire/
npm run build      # static build into build/ (+ llms.txt / llms-full.txt)
npm run serve      # serve the production build locally
```

## Custom domain

Defaults target GitHub Pages (`https://evenfire-ai.github.io/evenfire/`).
For a custom domain, override at build time:

```bash
DOCS_URL=https://docs.evenfire.ai DOCS_BASE_URL=/ npm run build
```

## Adding a page

1. Add the markdown file under `../docs/<section>/`.
2. Add its doc id to [`sidebars.ts`](sidebars.ts) (ids are the file path
   relative to `docs/`, without `.md`).
3. Links to other docs pages: relative `.md` links. Links to source files or
   repo-root files: also relative — the remark plugin turns them into GitHub
   URLs automatically.
