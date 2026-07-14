# fake-telegram-server (MINIKUBE ONLY)

Mock Telegram Bot API for the Figure D two-bot E2E gate. Captures `sendMessage`
(which bot token was used + the inline-keyboard `callback_data`) and can replay a
Telegram `callback_query` to the reader webhook.

Endpoints:

- `POST /bot<token>/sendMessage` — Telegram-shaped capture.
- `GET /sends` — captured sends (harness assertions).
- `POST /reset` — clear captures.
- `POST /fire-callback` `{reader_base_url,secret,chat_id,callback_data,from_id}` — POST a callback_query to the reader.

Deployed only in the minikube overlay; the prod default `WORKFLOW_APPROVAL_TELEGRAM_API_ROOT` stays `https://api.telegram.org`.
