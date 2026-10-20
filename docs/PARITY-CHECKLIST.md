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

The existing emoji picker now uses the measured 560 x 498 floating panel at x=374, y=125 for the 1280 x 713 fixture, with a 12-column grid and actual name-based filtering. Its 147 licensed Noto glyphs are a subset, not the reference's complete artwork or catalog. Unsupported categories/GIF/stickers remain explicitly unavailable. Tests verify bounds, filtering, all glyphs loading and insertion into the real composer. Message-info now has a tenth inspected, sanitized direct-message comparison: 64px header, 20px-inset 86px wallpaper preview and 72px Read/Delivered rows with actual receipt times. Group info retains individual members and timestamps. Recording and voice preview use floating rounded surfaces and retain actual recording/playback tests, but their equivalent reference states have not been inspected: starting the live microphone was outside the read-only scope. Media viewer, complete settings/menu states and current dark-reference parity remain pending.

Chats preferences now uses the measured sidebar header and section/row layout for actual theme and saved-message actions. An eleventh comparison shows the missing reference controls plainly: custom chat themes, media upload quality and auto-download preferences are unavailable, and this app has no corresponding toggle set. Theme changes remain persistent and tested. Existing images still open the protected resource in a new tab rather than an in-app viewer; pending-image uploads still show a filename strip. Those are UI implementation gaps, not finished CSS parity.


The existing media flow now has an in-app protected image/video viewer with loaded-history navigation, zoom, download, keyboard controls and close, plus large pending-image/video previews. These surfaces were inspected with synthetic desktop/mobile media, not an equivalent live-reference media state. Chats now includes functional persisted Enter-is-send, browser spelling and typed-emoticon toggles, still-photo quality selection and Photos/Audio/Videos auto-loading choices. Standard caps large still photos at 1600px; HD preserves originals. Videos/animated files are unchanged and documents remain manual. These implementation semantics are intentionally explicit rather than a claim of identical WhatsApp media processing. The tenth browser suite checks actual behavior. Earlier notes about filename-only previews/new-tab images and missing preference toggles describe the superseded checkpoint.

The viewer now follows a live-measured 60px toolbar and 100px thumbnail filmstrip. Zoom controls, go-to-message, reply, star, forward, authenticated download, message-menu access and thumbnail navigation use actual behavior. Individual-message pinning is explicitly unavailable. Media from the gallery also opens in-app. Manually loaded media stays loaded during unrelated rerenders for the session. The twelfth comparison is privacy-masked, with differing synthetic aspect ratio/count; current dark reference, upload-preview reference and exhaustive viewer hover/focus/video states remain unverified.
