# README showcase images

Drop the finished, branded screenshots into this folder:

```text
docs/assets/readme/
```

Use the following filenames. The headline belongs inside your branded image;
the root README already contains the section heading and explanatory copy.

| Filename | Headline inside the image | What to show |
| --- | --- | --- |
| `01-desktop-conversation.png` | Put your agents to work | A marketing agent conversation with a useful, readable result and visible tool activity. |
| `02-human-approvals.png` | Review before it runs | A pending tool action with its request and the Approve / Deny controls clearly visible. |
| `03-agent-configuration.png` | Equip agents for the job | The Control UI configuration for one agent, showing its instructions, model or assigned connectors. |
| `04-marketplace.png` | Connect the tools you use | A populated Marketplace with recognizable connector and plugin entries. |
| `05-evendrive.png` | Give your team shared context | Organized files and, if available, a document preview in EvenDrive. |
| `06-cost-and-usage.png` | Make agent spending visible | A readable Cost & Usage view with meaningful sample usage. Show currency only when model prices are configured. |

## Export guidance

- Prefer a consistent 16:9 canvas, ideally 1920 × 1080, with the same frame,
  screenshot scale and headline position across the set.
- Keep the headline short and separate from the product interface. Preserve
  enough UI context to identify the feature, with readable controls at GitHub's
  normal README width.
- Use clean demonstration data. Remove private emails, credentials and private
  URLs, including any visible in browser chrome or tool details.
- Show the actual interface and its actual result. If a conversation is prepared
  with sample data, include that context in the final caption.
- PNG is the expected format. If your export is WebP or JPEG, keep its real
  extension; the README reference can be updated to match. Do not rename the
  extension without converting the file.
- Existing screenshots elsewhere under `docs/assets/` are used by other docs;
  keep this showcase's finished exports in this folder.

## Current draft and replacement

The root README currently uses `mockup-1.png` in all six showcase positions.
This is the shared layout preview requested for this branch. It shows the same
Desktop conversation and approval request throughout; feature-specific images
will replace it as they are prepared.

Once a final image is present, replace that section's `<img src>` in the root
README from `docs/assets/readme/mockup-1.png` to its numbered filename above.
The adjacent HTML comment records the intended filename. Update the alt text to
describe the actual image. Keep the shared mockup while any section still uses it.

The hero conversation and approval screenshots are the first two priorities.
The showcase is ready for publication once every shared mockup is replaced and
the images, captions and surrounding claims have been reviewed together.
