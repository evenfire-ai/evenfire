export const MONGO_MCP_SERVER_NAME = 'mongodb-mcp-stack-mongodb-mcp-server'
export const ARTIFACT_NAME = 'mongo-mcp-seed-result.json'
export const DATABASE_NAME = 'clerum'
export const COLLECTION_NAME = 'agent_chat_mongo_mcp'

export function buildMongoMcpManifest(params: {
  name: string
  namespace: string
  marker: string
  recordRef: string
}): Record<string, unknown> {
  const { name, namespace, marker, recordRef } = params

  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name, namespace },
    spec: {
      description: `E2E Agent Chat MongoDB MCP workflow recipe ${marker}`,
      triggers: {
        onDemand: {
          requiresApproval: false,
          allowedActors: ['user', 'autonomous'],
        },
      },
      mcpServers: [
        {
          id: MONGO_MCP_SERVER_NAME,
          endpoint: `http://${MONGO_MCP_SERVER_NAME}.mcp-server.svc.cluster.local:3000/mcp`,
        },
      ],
      output: {
        destination: 'pvc',
        name,
        format: 'json',
        storageSize: '64Mi',
      },
      steps: [
        {
          id: 'seed-mongo-for-mcp',
          timeoutSeconds: 180,
          run: {
            type: 'snippet',
            language: 'typescript',
            code: [
              `const serverId = "${MONGO_MCP_SERVER_NAME}"`,
              'await sdk.mcp.callTool(serverId, "delete-many", {',
              `  database: "${DATABASE_NAME}",`,
              `  collection: "${COLLECTION_NAME}",`,
              `  filter: { $or: [{ marker: "${marker}" }, { recordRef: "${recordRef}" }] }`,
              '})',
              'const inserted = await sdk.mcp.callTool(serverId, "insert-many", {',
              `  database: "${DATABASE_NAME}",`,
              `  collection: "${COLLECTION_NAME}",`,
              '  documents: [{',
              '    scenario: "agent-chat-mongo-mcp",',
              `    marker: "${marker}",`,
              `    recordRef: "${recordRef}",`,
              `    recipeName: "${name}",`,
              '    source: "workflow-recipe",',
              '    status: "ready-for-mcp-read"',
              '  }]',
              '})',
              'const rows = await sdk.mcp.callTool(serverId, "find", {',
              `  database: "${DATABASE_NAME}",`,
              `  collection: "${COLLECTION_NAME}",`,
              `  filter: { marker: "${marker}" },`,
              '  limit: 1',
              '})',
              `const artifact = await sdk.artifacts.writeJson("${ARTIFACT_NAME}", {`,
              '  scenario: "agent-chat-mongo-mcp",',
              `  marker: "${marker}",`,
              `  recordRef: "${recordRef}",`,
              `  database: "${DATABASE_NAME}",`,
              `  collection: "${COLLECTION_NAME}",`,
              `  mcpServer: "${MONGO_MCP_SERVER_NAME}",`,
              '  insertedCount: 1,',
              '  inserted,',
              '  rows',
              '})',
              `return { scenario: "agent-chat-mongo-mcp", marker: "${marker}", recordRef: "${recordRef}", mcpServer: "${MONGO_MCP_SERVER_NAME}", insertedCount: 1, inserted, rows, artifact }`,
            ].join('\n'),
            capabilities: {
              mcp: {
                servers: [MONGO_MCP_SERVER_NAME],
                allowedTools: {
                  include: [
                    `${MONGO_MCP_SERVER_NAME}__delete-many`,
                    `${MONGO_MCP_SERVER_NAME}__insert-many`,
                    `${MONGO_MCP_SERVER_NAME}__find`,
                  ],
                },
              },
              artifacts: { maxCount: 1 },
            },
          },
        },
      ],
    },
  }
}
