import type { SidebarsConfig } from '@docusaurus/plugin-content-docs'

// Explicit sidebar: only curated docs appear on the site, in a deliberate
// order (quickstart → concepts → reference), mirroring the IA used by
// agentic-platform docs sites (Hermes Agent, OpenClaw).
const sidebars: SidebarsConfig = {
  docs: [
    'README',
    {
      type: 'category',
      label: 'Getting Started',
      collapsed: false,
      items: ['getting-started/quickstart', 'getting-started/installation'],
    },
    {
      type: 'category',
      label: 'Architecture',
      items: [
        'architecture/overview',
        'architecture/platform-topology',
        'architecture/non-mcp-services',
        'architecture/workflow-recipe-naming',
      ],
    },
    {
      type: 'category',
      label: 'CRD Reference',
      link: { type: 'doc', id: 'crds/README' },
      items: [
        'crds/host',
        'crds/context',
        'crds/mcpserver',
        'crds/communicationchannel',
        'crds/workflowrecipe',
      ],
    },
    {
      type: 'category',
      label: 'Deployment',
      items: [
        'deploy/minikube',
        'deploy/workflow-recipes-guide',
        'deploy/workflow-output-pvc-upgrade',
      ],
    },
    {
      type: 'category',
      label: 'Features',
      link: { type: 'doc', id: 'features/workflow-recipes' },
      items: [
        'features/context-filesystem',
        'features/custom-coordinator-images',
        'features/custom-coordinator-snippet-runtime',
        'features/custom-coordinator-snippet-workflow',
        'features/control-ui-workflow-recipes-and-registry-guide',
        'features/oauth-sandbox-ui-bridge',
        'features/admin-desktop-workspace-provisioning',
        'features/ai-recipe-builder-app-architecture',
      ],
    },
    {
      type: 'category',
      label: 'Testing',
      items: [
        'testing/e2e-guide',
        'testing/custom-coordinator-e2e-gates',
        'testing/desktop-observation-smoke-test',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      items: ['reference/services', 'reference/llm-providers'],
    },
  ],
}

export default sidebars
