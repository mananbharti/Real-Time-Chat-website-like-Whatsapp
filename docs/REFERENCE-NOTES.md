# Reference inspection

Reference measurements were taken from the official `https://web.whatsapp.com/` site on 16 October 2026 under a view-only visual-reference pass. No messages were sent and no account settings were changed. Private reference screenshots or chat content are **not** included in this repository.

The live interface differs from older WhatsApp Web designs: it uses a Roboto Variable/Roboto/Helvetica font stack, a rounded floating composer, pill-shaped search/filter controls, rounded selected conversation rows and a newer navigation rail. The light-theme incoming/outgoing surfaces observed were white and `#D9FDD3`; the wallpaper base was `#F5F1EB`, the rail surface was `#F7F5F3`, and the main text token was `#0A0A0A`.

Those measured typography and surface details informed the next styling pass. The included Roboto font is distributed under its own license in `public/fonts/Roboto-LICENSE.txt`.

This is a partial, read-only visual reference pass, **not** an assertion that all WhatsApp screens, dark-theme states, animations or micro-interactions have been exhaustively measured and matched. Features such as calls and end-to-end encryption remain outside this implementation. Further parity work should use a screen/state checklist and real-device testing rather than an unqualified "pixel-perfect" claim.

## Measured light-theme pass, October 16

At a 1280 x 713 viewport, the official linked reference used a 65px rail and 511px chat-list column; chat view began at x=576. Its header was 64px high, search surface 40px, filter pills 32px, list rows had a 76px pitch with a 72px selected surface, and list avatars were 48px. The floating composer was 52px high, inset 12px with a 26px radius. Chat text measured 14px/20px and the input 15px/22.05px. These measurements now drive the desktop layout rather than the earlier older-design assumptions.

The current build uses the public default doodle wallpaper mask from the observed static asset URL `https://static.whatsapp.net/rsrc.php/yx/r/voSdkk88H7C.svg`, with its measured 540 x 960px tile, `#EAE0D3` fill and 0.6 opacity over `#F5F1EB`. This is a third-party reference asset, not project-original artwork. Navigation/menu icons were transcribed from the inspected reference; they carry no account data. Do not present these assets or the wordmark as evidence of affiliation. An independent production release should review branding and asset rights.

Settings are being reworked from a centered modal to the reference sidebar layout. Unsupported capabilities are identified rather than backed by fake success responses. Calls, Channels, Communities and Meta AI rail controls are visual reference surfaces with clear unavailable notices, not implemented services.

Pixel parity is still NOT complete. Sanitized side-by-side images use opaque masks on private reference fields and synthetic local conversations; different message data makes them layout comparisons, not a valid whole-image similarity score. Remaining checks include equivalent message states, every menu and settings subpage, theme/responsive variants, focus/hover transitions and real-device behavior.

The emoji panel's category vectors were also transcribed from the inspected public interface. Emoji artwork comes from the separately licensed Noto distribution, not WhatsApp. The panel comparison is a layout comparison, and does not establish an identical emoji catalog or glyph appearance.

The read-only media viewer pass measured the 60px toolbar, 40px control boxes at 48px pitch, 100px bottom filmstrip and navigation positions. Public toolbar vectors were transcribed into the local viewer; no reference image, thumbnail, contact identity or message content was copied into the repository. This carries the same third-party-artwork review caveat as the other reference icons. The twelfth comparison masks all reference media and identity fields. The local synthetic media has a different aspect ratio and item count, so that comparison proves neither equal image layout for all ratios nor complete viewer behavior parity.

## Complete Unicode 17 emoji catalog

The picker now uses emojibase-data 17.0.0 English names, keywords, ordering, category and skin-variant metadata (MIT): https://registry.npmjs.org/emojibase-data/-/emojibase-data-17.0.0.tgz. It includes 3,953 entries, with a local SVG for every entry. "Complete" is scoped to this pinned Unicode 17 catalog, not an assertion that every future Unicode release or WhatsApp-specific emoji is included.

The SVG sources are Noto Emoji v2.051 at commit `8998f5dd683424a73e2314a8c1f1e359c19e8742` from https://github.com/googlefonts/noto-emoji. The `svg/LICENSE` notice governs the image artwork under Apache 2.0; the repository's top-level font license is separate. Region flags come from that checkout's `third_party/region-flags/waved-svg`, with its public-domain/exemption notice retained. Full Apache license, Noto notice, flags notice and emojibase license are under `public/emoji/`. The previous svgmoji 3.2.0 subset was replaced; its notice remains for provenance.

Rebuild with `python3 scripts/build-emoji.py /path/to/emojibase-data/package /path/to/noto-emoji`, then optionally run `npx --yes svgo@4.0.0 -f public/emoji -q` to optimize the SVG XML. A prefix trie makes in-message emoji conversion independent of scanning thousands of entries per character. The picker initially renders 180 entries and appends further batches of 180 on request, with local lazy-loaded artwork and an explicit Load more control. All categories, tone choices and keyword results are reachable. Search spans tones; browsing uses the chosen tone. GIF/sticker selection remains unavailable. Noto and WhatsApp artwork are different.
