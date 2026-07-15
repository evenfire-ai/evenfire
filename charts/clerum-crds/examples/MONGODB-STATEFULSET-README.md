# MongoDB MCP Server - StatefulSet Deployment

This directory contains the WorkflowRecipe-based deployment for MongoDB MCP server with persistent storage.

## Problem

The `McpServer` CRD does not support `volumeClaimTemplates`, which are required for StatefulSet deployment. MongoDB requires persistent storage for data durability.

## Solution

Use `WorkflowRecipe` CRD instead of `McpServer` CRD. WorkflowRecipe already supports:
- StatefulSet with `volumeClaimTemplates`
- PVC creation and management
- Data retention across pod restarts

## Quick Start

```bash
# 1. Create Context CRD (if not exists)
kubectl apply -f charts/clerum-crds/examples/context1.yaml

# 2. Create MongoDB credentials secret
kubectl create secret generic mcp-mongodb-credentials \
  --from-literal=connection-string='mongodb://localhost:27017/e2e_test?directConnection=true' \
  -n mcp-server

# 3. Apply WorkflowRecipe
kubectl apply -f charts/clerum-crds/examples/mongodb-mcp-statefulset-recipe.yaml

# 4. Verify StatefulSet created
kubectl get statefulset -n mcp-server

# 5. Verify PVC created
kubectl get pvc -n mcp-server

# 6. Verify pod is running
kubectl get pods -n mcp-server -l clerum.io/workload=mongodb-mcp
```

## Resources Created

| Resource | Name | Purpose |
|----------|------|---------|
| StatefulSet | `mongodb-mcp` | MongoDB MCP server with stable identity |
| PVC | `data-mongodb-mcp-0` | Persistent storage (10Gi) |
| Service | `mongodb-mcp-headless` | Headless service for stable DNS |
| Service | `mongodb-mcp` | ClusterIP service for MCP transport |

## Pod DNS

StatefulSet pods have stable DNS names:

```
mongodb-mcp-0.mongodb-mcp.mcp-server.svc.cluster.local:3000
```

## Data Persistence

The PVC persists across:
- Pod restarts
- Node failures (if storage class supports it)
- WorkflowRecipe deletion (manual cleanup required)

To clean up PVCs:

```bash
kubectl delete pvc -l clerum.io/workload=mongodb-mcp -n mcp-server
```

## Testing

Run E2E tests:

```bash
cd workflow-recipes
npm run test:e2e mongodb-statefulset-recipe
```

Tests validate:
- StatefulSet creation
- PVC creation without ownerReferences
- Pod readiness and health check
- MCP tools/list and tools/call
- Data persistence across pod restarts
- PVC retention after WorkflowRecipe deletion

## Configuration

### Storage

Edit `volumeClaimTemplates` in the WorkflowRecipe:

```yaml
volumeClaimTemplates:
  - name: data
    storageClass: do-block-storage  # Change for your provider
    accessMode: ReadWriteOnce
    size: 10Gi                      # Adjust size as needed
```

### Replicas

For multi-replica MongoDB deployments:

```yaml
workloads:
  - id: mongodb-mcp
    replicas: 3  # Creates mongodb-mcp-0, mongodb-mcp-1, mongodb-mcp-2
```

### Read-Only Mode

Enable read-only mode:

```yaml
env:
  - name: MDB_MCP_READ_ONLY
    value: true
```

## Migration from McpServer CRD

If you previously deployed MongoDB using `McpServer` CRD:

1. Delete old deployment:
   ```bash
   kubectl delete mcpserver mongodb-server -n mcp-server
   ```

2. Apply new WorkflowRecipe:
   ```bash
   kubectl apply -f charts/clerum-crds/examples/mongodb-mcp-statefulset-recipe.yaml
   ```

3. Update any client code to use the new endpoint:
   ```
   mongodb-mcp-0.mongodb-mcp.mcp-server.svc.cluster.local:3000
   ```

## Troubleshooting

### PVC in Pending state

Check storage class:
```bash
kubectl get storageclass
```

Edit WorkflowRecipe to use available storage class.

### Pod not starting

Check pod events:
```bash
kubectl describe pod -l clerum.io/workload=mongodb-mcp -n mcp-server
```

Check logs:
```bash
kubectl logs -l clerum.io/workload=mongodb-mcp -n mcp-server
```

### MCP connection refused

Verify service:
```bash
kubectl get svc mongodb-mcp -n mcp-server
```

Port-forward locally:
```bash
kubectl port-forward -n mcp-server statefulset/mongodb-mcp 3000:3000
curl http://localhost:3000/mcp/tools/list
```

## Future Enhancements

- [ ] Extend `McpServer` CRD to support `volumeClaimTemplates`
- [ ] Update HCC/Context Mapper to create StatefulSets when PVCs are specified
- [ ] Migrate MongoDB deployment back to `McpServer` CRD for consistency

## See Also

- [MongoDB StatefulSet Gap Analysis](../../../docs/archive/workflow-recipes/validation/MONGODB-STATEFULSET-GAP.md)
- [WorkflowRecipe CRD Reference](../../../docs/crds/workflowrecipe.md)
- [E2E Testing Guide](../../../mcp-servers/README.md#testing)
