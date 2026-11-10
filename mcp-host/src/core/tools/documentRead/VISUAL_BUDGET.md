# Visual read budget: decision table

`readVisual` in `index.ts` gives each `mode: "visual"` call only what the
request still has left. Every row below is an independent upper bound; the
call's effective limit is the **minimum** of all of them, computed before the
reader child is spawned. Nothing here is a per-call constant: `usage` is
`requestImageUsage(messages, toolResults)`, the images already in the request
(earlier messages plus the results of the same tool batch).

Notation: `usage.images`, `usage.bytes` (decoded bytes), `usage.maxSide`;
`P` is the provider profile (`VisualDeliveryLimits`, from
`visualInput/deliveryLimits.ts`); `L` is `DocumentReadLimits`.

| #   | Limit source                                                                                                                 | Bound on this call                                                                                                                                                                                                                                  | Who wins                                                      | When it is exhausted                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Provider image count `P.maxImages`                                                                                           | `imageSlots = P.maxImages - usage.images`                                                                                                                                                                                                           | min with rows 2 and 3                                         | `imageSlots < 1`: no child is spawned; `read_budget_exhausted` with the image message and `resumeCursor`                                                                                                                                                                |
| 2   | Many-image dimension rule `P.maxDimensionAboveImageCount` (Claude: more than 20 images means every image is at most 2000 px) | slots capped at `threshold.count - usage.images` when a request image is larger than `threshold.maxDimension`; render side always capped at `threshold.maxDimension`                                                                                | min with row 1                                                | same as row 1                                                                                                                                                                                                                                                           |
| 3   | Tool page cap                                                                                                                | `pageCap = min(L.maxVisualPagesPerCall, P.maxImages)`, then `min(pageCap, imageSlots)` pages                                                                                                                                                        | smallest of the three counts                                  | stopped by free slots (not by `pageCap`): continuation limit `image_budget`; otherwise `max_pages`                                                                                                                                                                      |
| 4   | Per-image bytes                                                                                                              | `min(L.maxImageBytes, P.maxImageBytes, floor(P.maxImageEncodedBytes * 3/4))`, and each page also gets `floor(call bytes / pages)`                                                                                                                   | min                                                           | the child re-renders a page at lower scale (`MAX_RENDER_ATTEMPTS`); still too big: `image_bytes`; if the call total was cut below `callImageBytes` by rows 6-8 this is reported as the image message (a pause), otherwise as `document_limits_exceeded` / `image_bytes` |
| 5   | Pixels                                                                                                                       | `min(L.maxRenderPixelsPerCall, P.maxPixels)` shared by the pages of the call; dimension `min(L.maxRenderDimension, P.maxDimension, threshold)`                                                                                                      | min                                                           | `pixels` failure                                                                                                                                                                                                                                                        |
| 6   | Provider aggregate image bytes `P.maxTotalImageBytes` (Codex 16 MiB; Claude publishes none)                                  | `P.maxTotalImageBytes - usage.bytes`, and `callImageBytes = min(maxImageBytes * L.maxVisualPagesPerCall, P.maxTotalImageBytes)`                                                                                                                     | min                                                           | `maxTotalImageBytes < 1`: pause as in row 1                                                                                                                                                                                                                             |
| 7   | Provider serialized request bytes `P.maxVisualRequestBytes` (Claude 32 MB, Codex 24 MiB visual body)                         | `floor((P.maxVisualRequestBytes - ceil(usage.bytes * 4/3) - VISUAL_REQUEST_TEXT_RESERVE_BYTES) * 3/4)`. Images already in the request travel as base64 (4/3); the text that shares the request is not measured, so a fixed reserve stands in for it | min; this is the row that binds on Claude, which has no row 6 | same as row 6                                                                                                                                                                                                                                                           |
| 8   | Turn image memory `VisualInputBudget`                                                                                        | `floor(remainingResidentBytes * 3/8)` (publication charges 2 bytes per base64 character, 8/3 per decoded byte); re-checked on the real attachments before publishing                                                                                | min                                                           | pause as in row 1; the post-render check also returns the pause, never an error                                                                                                                                                                                         |

Order of evaluation: rows 1-3 give the page count; rows 4-8 give
`maxTotalImageBytes`; if either is below 1 the call returns the pause
immediately. Otherwise the child renders with those two numbers, and the Tool
re-verifies the returned images against every row except 1-3 before they are
published.

## What decides when two sources disagree

- A count limit (rows 1-3) never trades against a byte limit (rows 4-8): both must hold.
- On Codex the aggregate byte cap (row 6) normally binds (16 MiB is about
  22.4 MB of base64, below the 25.1 MB request body).
- On Claude there is no aggregate image cap, so row 7 is the only aggregate bound.
  Without it, a 24-page scan followed by cursor reached 44.7 MB of base64 against
  a 32 MB request limit (review round 2, R1-H2).
- Row 8 binds on small Hosts, independent of the provider.

## Residual risks (not closed by this table)

- The text reserve (row 7) is an estimate: 4 MB covers a ~1M-token context at
  four UTF-8 bytes per token plus the measured 2.1 MB case. A request carrying
  more text than that (very long history, many large `document_read` text
  results kept in the conversation) can still exceed the provider's serialized
  bound. The last-mile backstop is `assertVisualRequestFits` in
  `llm/claude.ts` and `llm/openai.ts`, which runs when GFS images are present or
  the caller sets `verifyImageInput`; it turns the overflow into a typed
  `limit_exceeded` turn failure instead of a provider 413.

## Tests that pin this table

`__tests__/documentReadVisualBudget.test.ts`:

- `U6`: a request already holding 22.5 MB of images pauses without spawning a child.
- `R2-L3/H2`: the largest request admission allows passes the real
  `assertVisualRequestFits` with the Claude profile; the same call without the
  request-byte datum fails it.
- `R1-H2`: following the cursor of a long scan, with 3 MB of earlier text and
  every page at its byte bound, keeps the cumulative request under the Claude
  bound at every step and ends on the pause.
