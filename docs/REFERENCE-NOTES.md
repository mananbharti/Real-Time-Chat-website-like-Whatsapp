# Reference inspection

The user authorized read-only WhatsApp Web reference inspection on 16 October 2026. Pairing completed on the official `https://web.whatsapp.com/` site. No messages were sent and no account settings were changed. Private reference screenshots or chat content are **not** included in this repository.

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
