# Grok subscription validation

Evidence lanes for `grok-subscription` image input (issue #784). One lane does
not stand in for another.

## Purpose

`cli-chat-proxy.grok.com/v1/responses`, the endpoint `grok-llm-proxy` calls,
is **unmeasured for images**. The limits and the wire shape in
[the transport contract](../architecture/grok-subscription-transport-contract.md#visual-requests-issue-784)
come from the xAI API documentation for `api.x.ai/v1` (docs.x.ai, read
2026-09-23): 20 MiB per image, JPEG and PNG, any text/image order, and
`{ "type": "input_image", "image_url": "data:<mime>;base64,<data>", "detail": "high" }`
next to `input_text` parts. The contract, proxy, control-api, Host and Desktop
suites prove what Evenfire sends and refuses. None of them proves that the
subscription endpoint accepts that body or that the model sees the pixels.

The live probe below is the only check that does. Run it when a Grok
subscription is available. Until it has run, report the endpoint as
unmeasured for images.

## Preconditions

- Separate authorization for the run: it calls the real upstream and spends
  subscription quota.
- A branch-owned local profile, bootstrapped by the canonical Minikube entry
  points, with the images built from the commit under test. Do not touch
  another branch's profile or port-forwards.
- `GROK_LLM_PROXY_EXECUTION_ENABLED` on, a connected Grok grant, and a Host
  whose Grok projection mints `llm:grok:execute` (HCC then injects
  `MCP_HOST_GROK_SUBSCRIPTION_ENABLED`). There is no image-specific flag.
- A catalog model that the xAI documentation lists with image input
  (grok-4.5, grok-4.6 or grok-4.7). Record the canonical model id the runtime
  returns, not an alias.
- Never read `~/.grok/auth.json`, and never read the `api_key` fields of
  `~/.grok/models_cache.json`. The probe runs through the real
  Host → control-api → `grok-llm-proxy` path and needs neither.

## Steps

Send every request through the Host, from the Desktop composer or as a tool
screenshot, never by calling the upstream directly. Use a fresh 64-bit
hexadecimal challenge per image, rendered only into the pixels. The generators
in `desktop-app/test/e2e-playwright/codexImageChallenge.ts`
(`challengeImage`, `paddedChallengeImage`, `challengeImageAt`) produce such
images; the filename and the prompt must not carry the answer.

1. PNG challenge. One small PNG. Ask the model for the hexadecimal code in
   the image.
2. JPEG challenge. The same with a JPEG.
3. Order. One user message of text, image, text, where the answer depends on
   the order (for example: "the code in the image, then the word after it").
4. Limits. Each case in a new conversation. The image budget (20 images,
   20 MiB decoded) covers every image in the request's history, so a case run
   after another in the same conversation carries the earlier images and can
   be refused on the total instead of on its own image:
   - one image padded close to the ingress cap of 16 MiB decoded from the
     composer, and one tool screenshot close to 20 MiB decoded, the contract's
     per-image limit, which only tool screenshots can reach;
   - 20 small images in one request, each with its own challenge;
   - one PNG whose long side is 9000 px. The contract sets no pixel limit, so
     this case measures whether the upstream does.

## Expected

- Steps 1 to 3: the answer contains the challenge (hexadecimal case ignored),
  the turn ends without an error, no tool step substitutes OCR or file loading
  for direct image input, and no fallback badge appears.
- Step 4: every case is accepted by Evenfire, since each is inside the
  contract. Whatever the upstream answers is the measurement. An upstream
  refusal is a limit mismatch between the xAI documentation and the
  subscription endpoint. Report it, and change the contract only in a new
  pull request that cites the recorded status.
- A local refusal in any step (`attachment_too_large`, `invalid_request`,
  `image_source_invalid`, HTTP 413) is a defect in Evenfire, not an upstream
  measurement.

## Recording

For each step record:

- the commit, the profile, the model id and the date;
- the image format, the decoded size in bytes, the dimensions and the image
  count;
- the upstream HTTP status and, on failure, the bounded `upstreamHint` from
  the proxy's `grok_upstream_http` log line and the error code from its
  `grok_proxy_attempt_finished` line;
- whether the answer contained the challenge.

Never record tickets, tokens, grant credentials or image bytes. Put the
results in the pull request or issue that closes the measurement, and update
the "unmeasured" statement in the transport contract only with that evidence.
