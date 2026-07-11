import fs from 'node:fs'
import path from 'node:path'

import { visit } from 'unist-util-visit'

const GITHUB_BLOB = 'https://github.com/evenfire-ai/evenfire/blob/main/'
const GITHUB_TREE = 'https://github.com/evenfire-ai/evenfire/tree/main/'

// Matches absolute URLs (scheme:, //), site-absolute paths (/) and pure
// anchors (#) — none of these need rewriting.
const NON_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i

function splitAnchor(url) {
  const hashIndex = url.indexOf('#')
  if (hashIndex === -1) return [url, '']
  return [url.slice(0, hashIndex), url.slice(hashIndex)]
}

/**
 * Remark plugin: rewrites relative Markdown links that point outside the
 * docs tree (source files, service READMEs, charts, root policy docs) — or
 * to files that no longer exist — into absolute GitHub URLs. This lets the
 * docs in `docs/` stay browsable on GitHub while also building cleanly as
 * a website.
 */
export default function repoLinks({ docsDir, repoDir }) {
  const docsRoot = path.resolve(docsDir)
  const repoRoot = path.resolve(repoDir)

  return (tree, file) => {
    const filePath = file.path
    if (!filePath) return

    visit(tree, ['link', 'definition'], node => {
      const url = node.url
      if (!url || NON_RELATIVE.test(url)) return

      const [target, anchor] = splitAnchor(url)
      if (!target) return

      let resolved
      try {
        resolved = path.resolve(path.dirname(filePath), decodeURI(target))
      } catch {
        return
      }

      const insideDocs = !path.relative(docsRoot, resolved).startsWith('..')
      const exists = fs.existsSync(resolved)
      // Links to existing pages inside the docs tree are left for Docusaurus.
      if (insideDocs && exists) return

      const repoRel = path.relative(repoRoot, resolved)
      if (repoRel.startsWith('..')) return

      const isDir = exists && fs.statSync(resolved).isDirectory()
      const ghPath = repoRel.split(path.sep).map(encodeURIComponent).join('/')
      node.url = (isDir ? GITHUB_TREE : GITHUB_BLOB) + ghPath + anchor
    })
  }
}
