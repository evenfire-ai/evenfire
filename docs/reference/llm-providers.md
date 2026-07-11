---
title: LLM Providers
description: Supported LLM providers (OpenAI, Claude, ZAI, Bailian) and how to configure them via the Host CRD.
---

# LLM Providers

The **mcp-host** service supports the following LLM providers, configured via
the [Host CRD](../crds/host.md) `spec.model.provider` field:

| Provider                             | `provider` value | Default Model       | API                     |
| ------------------------------------ | ---------------- | ------------------- | ----------------------- |
| OpenAI                               | `openai`         | `gpt-5.4-mini`      | OpenAI Chat Completions |
| Anthropic Claude                     | `claude`         | `claude-sonnet-4-6` | Anthropic Messages      |
| ZAI (z.ai)                           | `zai`            | `glm-5.1`           | OpenAI-compatible       |
| Alibaba Cloud Model Studio (Bailian) | `bailian`        | `qwen3-coder-plus`  | OpenAI-compatible       |

## Configuration via the Host CRD

```yaml
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: chatllm
spec:
  host: chatLLM
  contextRef: context1
  secretRef: chatllm-api-keys
  model:
    provider: bailian
    name: qwen3-coder-plus
```

API keys are provided through the Secret referenced by `spec.secretRef` — see
the [Host CRD reference](../crds/host.md) for the full spec.

## Bailian (Alibaba Cloud Model Studio)

Bailian provides access to multiple models through Alibaba Cloud's Coding
Plan, including Qwen, MiniMax, GLM, and Kimi models.

Available models: `qwen3-coder-plus`, `qwen3.5-plus`, `qwen3-coder-next`,
`qwen3-max-2026-01-23`, `MiniMax-M2.5`, `glm-5.1`, `glm-5`, `glm-4.7`,
`kimi-k2.5`

Get your Coding Plan API key at:
[modelstudio.console.alibabacloud.com](https://modelstudio.console.alibabacloud.com/)

## Dev mode

Run `mcp-host` locally against any provider without a cluster:

```bash
CLERUM_DEV_MODE=true BAILIAN_API_KEY=sk-... CLERUM_MODEL_PROVIDER=bailian npm run dev
```

| Variable                | Purpose                                  |
| ----------------------- | ---------------------------------------- |
| `CLERUM_MODEL_PROVIDER` | `zai`, `openai`, `claude`, or `bailian`  |
| `OPENAI_API_KEY`        | OpenAI key                               |
| `CLAUDE_API_KEY`        | Anthropic key                            |
| `ZAI_API_KEY`           | ZAI key                                  |
| `BAILIAN_API_KEY`       | Bailian key                              |
