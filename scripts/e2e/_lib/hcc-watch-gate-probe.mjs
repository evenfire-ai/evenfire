// Appended to np08-runtime-access.mjs and executed only inside the owned Host.
const expectedStatus = Number(process.env.HCC_PR_A_EXPECT_STATUS)
const observed = await requestWithRuntimeAccess({
  mountedAccessValue: process.env.MCP_HOST_RUNTIME_ACCESS_TOKEN,
  timeoutMs: 5000,
  request: async value => {
    const response = await fetch(
      `${contextMapperBaseUrl(process.env)}/api/v2/hosts/self/mcpservers`,
      {
        headers: { authorization: `Bearer ${value}` },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      }
    )
    const body = await response.json()
    if (
      response.status === 200 &&
      (!Array.isArray(body.servers) ||
        !body.servers.some(server => server.name === process.env.HCC_PR_A_CONTROL) ||
        body.servers.some(server => server.name === process.env.HCC_PR_A_AFFECTED) !==
          (process.env.HCC_PR_A_AFFECTED_VISIBLE !== 'false'))
    ) {
      throw new Error('fixture_inventory_missing')
    }
    if (response.status === 503 && body.error !== 'authorization_unavailable')
      throw new Error('unexpected_503_class')
    return { status: response.status }
  },
})
if (observed.result.status !== expectedStatus) throw new Error('protected_gate_status_mismatch')
console.log(`PR_A_PROTECTED_API_STATUS=${expectedStatus} AT=${Date.now()}`)
