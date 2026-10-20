# Interface parity checklist

This is a tracking document, not a claim that every WhatsApp feature is implemented.

## Implemented and covered by automated checks

- Signup/login, persistent sessions, direct/group messages and authorization.
- Delivery/read acknowledgements, unread counts and receipt details.
- Replies, forwarding, stars and deletion rules.
- Persistent message edits/reactions and group-owner member management.
- Images, recorded voice-note playback and protected attachments.
- Pin/mute/archive, mobile navigation and server restart recovery.
- Per-chat draft recovery, links, full-history search and keyboard shortcuts.
- Text status expiry, profile editing/pictures and shared-media access.

## Implemented, requiring more reference/device checks

- Long-press and swipe gesture thresholds on real iOS/Android devices.
- Every context-menu edge position, focus transition and keyboard-navigation state.
- Recording waveform and microphone-permission failure paths on Safari/Firefox.
- Scroll-to-latest count when media changes message height.
- Dark/light typography, bubble widths/tails, grouping, hover controls and transitions against the current reference.
- Notification permission behavior and cross-tab interaction.

## Not implemented

- Calls, end-to-end encryption, phone/SMS login and account recovery.
- Photo/video stories, status view receipts and story progress controls.
- Stickers, polls and location sharing.
- Multiple-admin roles, group invitation links and richer group permissions.
- Blocking/reporting, disappearing messages, scheduled messages or multi-device draft sync.
- Downloaded webpage metadata/thumbnails for rich link previews.
- Exhaustive authenticated WhatsApp screen/state parity.

Use synthetic data in documentation. Keep personal reference screens, chat text and account information out of this repository.
