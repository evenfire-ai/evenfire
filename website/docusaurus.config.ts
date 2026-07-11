import path from 'node:path'

import type * as Preset from '@docusaurus/preset-classic'
import type { Config } from '@docusaurus/types'
import { themes as prismThemes } from 'prism-react-renderer'

import repoLinks from './src/remark/repoLinks.mjs'

// The docs site sources its content directly from the repository's `docs/`
// directory (single source of truth — the same files render on GitHub).
const DOCS_DIR = path.resolve(__dirname, '../docs')
const REPO_DIR = path.resolve(__dirname, '..')

const config: Config = {
  title: 'evenfire',
  tagline:
    'Self-hostable, Kubernetes-native platform for LLM agents — multi-channel, first-class MCP, declarative workflows',
  favicon: 'img/logo.svg',

  // Defaults target GitHub Pages (https://evenfire-ai.github.io/evenfire/).
  // Override via env when moving to a custom domain, e.g.
  //   DOCS_URL=https://docs.evenfire.ai DOCS_BASE_URL=/ npm run build
  url: process.env.DOCS_URL ?? 'https://evenfire-ai.github.io',
  baseUrl: process.env.DOCS_BASE_URL ?? '/evenfire/',
  trailingSlash: false,

  organizationName: 'evenfire-ai',
  projectName: 'evenfire',

  // Legacy docs contain some links to files that no longer exist (archived
  // material); the repoLinks remark plugin rewrites everything it can to
  // GitHub URLs, the rest only warns instead of failing the build.
  onBrokenLinks: 'warn',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
    // .md files are parsed as CommonMark (the docs contain `{{...}}` template
    // syntax and `<placeholders>` that are not valid MDX); .mdx files as MDX.
    format: 'detect',
    mermaid: true,
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  themes: [
    '@docusaurus/theme-mermaid',
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        docsRouteBasePath: '/',
        indexBlog: false,
        highlightSearchTermsOnTargetPage: false,
      },
    ],
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          path: '../docs',
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/evenfire-ai/evenfire/edit/main/docs/',
          // Internal working docs are not part of the public site.
          exclude: [
            '**/_*.{js,jsx,ts,tsx,md,mdx}',
            '**/_*/**',
            '**/*.test.{js,jsx,ts,tsx}',
            '**/__tests__/**',
            'agents/**',
            'control-ui/**',
            'desktop-ui-ux/**',
          ],
          // Must run before Docusaurus's own link resolver so out-of-tree
          // links are already GitHub URLs when it sees them.
          beforeDefaultRemarkPlugins: [[repoLinks, { docsDir: DOCS_DIR, repoDir: REPO_DIR }]],
          showLastUpdateTime: false,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    docs: {
      sidebar: {
        hideable: true,
        autoCollapseCategories: true,
      },
    },
    navbar: {
      title: 'evenfire',
      logo: {
        alt: 'evenfire logo',
        src: 'img/logo.svg',
      },
      items: [
        { to: '/getting-started/quickstart', label: 'Quickstart', position: 'left' },
        { to: '/architecture/overview', label: 'Architecture', position: 'left' },
        { to: '/crds', label: 'CRD Reference', position: 'left' },
        {
          href: 'https://github.com/evenfire-ai/evenfire',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Quickstart', to: '/getting-started/quickstart' },
            { label: 'Architecture', to: '/architecture/overview' },
            { label: 'CRD Reference', to: '/crds' },
            { label: 'E2E Testing', to: '/testing/e2e-guide' },
          ],
        },
        {
          title: 'Project',
          items: [
            { label: 'GitHub', href: 'https://github.com/evenfire-ai/evenfire' },
            {
              label: 'Contributing',
              href: 'https://github.com/evenfire-ai/evenfire/blob/main/CONTRIBUTING.md',
            },
            {
              label: 'Security',
              href: 'https://github.com/evenfire-ai/evenfire/blob/main/SECURITY.md',
            },
            {
              label: 'License',
              href: 'https://github.com/evenfire-ai/evenfire/blob/main/LICENSE',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} evenfire. Apache-2.0 with additional use grant.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'yaml', 'docker'],
    },
  } satisfies Preset.ThemeConfig,
}

export default config
