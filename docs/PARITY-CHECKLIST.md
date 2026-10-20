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

## Current visual-pass status

The existing-screen parity pass is active; new feature work is paused. Measured and rendered at 1280 x 713: rail 65px; sidebar 511px; chat header 704 x 64px at x=576; composer 680 x 52px at (588,649), 26px radius. These are component measurements, not a claim that all screens are identical.

Inspected comparisons: full chat/list shell with private reference fields masked; same-size composer crops; public-only incoming context menu surfaces; sidebar settings surface with personal reference name/avatar masked. The build now follows the current light reference, not an older dark Web screenshot. Settings still has different available rows, custom filter pills differ from the user's personal folders, menu action coverage differs, independent-app security notices are intentionally accurate, and empty-state artwork is not matched. Calls/Meta AI/Channels/Communities navigation is visibly present but unavailable, with honest notices. Keep that distinction when presenting screenshots.

The New chat drawer now occupies the measured x=65, width=511, full-height sidebar. Contact info and Search messages occupy x=576, width=704 at the reference viewport. Full-history results are automatically fetched from the authenticated server as the user types; selecting a loaded result returns to its highlighted message. A ninth browser suite checks these rendered bounds, contact selection, search results and unavailable Calls semantics. Contact icons, phone lookup, self-chat and business-account-specific sections remain different. Date-based search is explicitly unavailable rather than pretending to work. These three surfaces have inspected, sanitized comparisons, not an exhaustive visual-equivalence verdict.

Profile editing and existing Account/Privacy/Chats/shortcut/help subpages now use the sidebar drawer instead of centered popups at the measured desktop viewport. Profile values remain actual editable fields with explicit save; local accounts use usernames, not phone login. The profile comparison retains this difference. Dark-theme regression checks fixed light wallpaper/timestamps/filter/notification overrides; local desktop/mobile screenshots were inspected, but the current live reference remained in light mode and its settings were never changed. Dark screenshots are usability checks, not verified dark-reference matches. The ninth browser suite also checks profile save, theme persistence after refresh and real message send at 390px.
