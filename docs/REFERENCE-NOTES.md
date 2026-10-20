# Reference inspection

The user authorized read-only WhatsApp Web reference inspection on 16 October 2026. Pairing completed on the official `https://web.whatsapp.com/` site. No messages were sent and no account settings were changed. Private reference screenshots or chat content are **not** included in this repository.

The live interface differs from older WhatsApp Web designs: it uses a Roboto Variable/Roboto/Helvetica font stack, a rounded floating composer, pill-shaped search/filter controls, rounded selected conversation rows and a newer navigation rail. The light-theme incoming/outgoing surfaces observed were white and `#D9FDD3`; the wallpaper base was `#F5F1EB`, the rail surface was `#F7F5F3`, and the main text token was `#0A0A0A`.

Those measured typography and surface details informed the next styling pass. The included Roboto font is distributed under its own license in `public/fonts/Roboto-LICENSE.txt`.

This is a partial, read-only visual reference pass, **not** an assertion that all WhatsApp screens, dark-theme states, animations or micro-interactions have been exhaustively measured and matched. Features such as calls and end-to-end encryption remain outside this implementation. Further parity work should use a screen/state checklist and real-device testing rather than an unqualified "pixel-perfect" claim.
