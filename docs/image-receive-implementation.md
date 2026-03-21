# Telegram Image Receive Implementation

> 2026-03-21

## Scope

Implemented the receive half of image support:

`Telegram -> ccgram -> Claude Code`

Out of scope for this change:

- `Claude Code -> Telegram` image sending
- non-photo attachments such as `document`, `video`, `animation`
- image persistence beyond temporary local storage

## Behavior

When a Telegram photo message arrives:

1. The bot picks the largest available `photo` variant from the Telegram update.
2. It calls `getFile` on the Telegram Bot API.
3. It downloads the file to `/tmp/ccgram-images/`.
4. It builds an injected prompt for Claude Code:
   - with caption: `{caption}\n\n画像: {localPath}`
   - without caption: `この画像を確認してください。\n\n画像: {localPath}`
5. It routes that prompt using the existing reply-to or default-workspace logic.

This keeps the implementation aligned with ccgram's existing text injection flow. No special image encoding is added on the ccgram side; Claude receives a local filesystem path it can inspect.

## Changed Files

- `src/types/telegram.ts`
  - added `PhotoSize`
  - added `caption?: string`
  - added `photo?: PhotoSize[]`
- `workspace-telegram-bot.ts`
  - added Telegram photo download helper
  - added `/tmp/ccgram-images/` temp storage
  - added largest-photo selection
  - reused existing workspace routing for photo prompts

## Verification

- `npm run build` passed
- manual runtime verification passed:
  - updated deployed bot under `~/.ccgram/dist/`
  - restarted the running Telegram bot process
  - confirmed a Telegram image was received and visible from Claude Code

## Known Limitations

- The temp directory is not auto-pruned yet.
- If no reply target and no default workspace are set, the photo cannot be routed and the bot falls back to the existing help message.
- Only Telegram `photo` messages are handled in this change. Files sent as `document` still need separate support.
