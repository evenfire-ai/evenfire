function fakeProviderScript(): string {
  return `
const http = require('http')
const requests = []
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
function readBody(req) {
  return new Promise(resolve => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => resolve(data))
  })
}
http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true })
  if (req.method === 'POST' && req.url === '/reset') {
    requests.splice(0, requests.length)
    return send(res, 200, { ok: true })
  }
  if (req.method === 'GET' && req.url === '/requests') return send(res, 200, { requests })
  if (req.method !== 'POST') return send(res, 404, { ok: false })
  const raw = await readBody(req)
  let body = {}
  try { body = raw ? JSON.parse(raw) : {} } catch { body = { raw } }
  requests.push({ method: req.method, path: req.url, headers: req.headers, body })
  if (req.url.endsWith('/conversations.open')) return send(res, 200, { ok: true, channel: { id: 'D-figure-d' } })
  if (req.url.endsWith('/chat.postMessage')) return send(res, 200, { ok: true, ts: String(Date.now() / 1000) })
  if (req.url.includes('/sendMessage')) return send(res, 200, { ok: true, result: { message_id: requests.length } })
  return send(res, 200, { ok: true })
}).listen(8099, '0.0.0.0')
`
}

export function figureDProviderResourcesYaml(app: string, namespace: string): string {
  return `
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${app}
  namespace: ${namespace}
data:
  server.js: |
${fakeProviderScript()
  .trim()
  .split('\n')
  .map(line => `    ${line}`)
  .join('\n')}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${app}
  namespace: ${namespace}
  labels:
    app: ${app}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${app}
  template:
    metadata:
      labels:
        app: ${app}
    spec:
      containers:
      - name: ${app}
        image: node:24-alpine
        command: ["node", "/app/server.js"]
        ports:
        - containerPort: 8099
        volumeMounts:
        - name: script
          mountPath: /app
      volumes:
      - name: script
        configMap:
          name: ${app}
---
apiVersion: v1
kind: Service
metadata:
  name: ${app}
  namespace: ${namespace}
spec:
  selector:
    app: ${app}
  ports:
  - name: http-egress
    port: 443
    targetPort: 8099
  - name: http-local
    port: 8099
    targetPort: 8099
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${app}-control-api-access
  namespace: ${namespace}
spec:
  podSelector:
    matchLabels:
      app: ${app}
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: control-api
      namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: control-plane
    ports:
    - protocol: TCP
      port: 8099
  policyTypes:
  - Ingress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: control-api-to-${app}
  namespace: control-plane
spec:
  podSelector:
    matchLabels:
      app: control-api
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ${namespace}
      podSelector:
        matchLabels:
          app: ${app}
    ports:
    - protocol: TCP
      port: 8099
  policyTypes:
  - Egress
`
}
