# 04 Attachments

## Goal

Validate local file upload path, artifact message part rendering, and attachment retrieval.

## Steps

1. Sign in as owner and open channel `frontend-v1` (or default channel).
2. Attach one local text file through `Attach file`.
3. Send message text: `Attachment smoke test`.
4. Verify message renders with attachment link.
5. Click attachment link and verify file opens/downloads.
6. Repeat once with an image file (if available) to validate mime rendering path.

## Expected results

- Upload succeeds without error banner.
- Pending attachment list appears before send, then clears after send.
- Attachment link appears on message card.
- Download/open route works and does not return unauthorized.

## UI quality checks

- Composer controls stay aligned when attachment state changes.
- Attachment links are visually distinct from message body text.
