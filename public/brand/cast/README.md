# Homepage cast

The homepage mascot is a rotating cast of Wojaks (Danny, 2026-10-24). This folder holds the cast art and the manifest the Worker reads. The art is supplied by Danny, a commissioned artist, or a CC0 or licensed source. No agent draws, traces, redraws, recolors, or edits cast art.

## How the rotation works

- `cast.json` is an array of entries, one per cast member:

  ```json
  {
    "file": "<slug>.svg or <slug>-hero.webp",
    "name": "...",
    "alt": "...",
    "source": "https://...",
    "author": "...",
    "license": "...",
    "width": 1600,
    "height": 1280
  }
  ```

- `file`, `name`, `alt`, `source` (an https URL), `author`, and `license` are required. `width` and `height` are the file's intrinsic size and default to 1600 and 1280.
- The Worker bundles `cast.json` when it is built, so a change ships with the next deploy.
- The homepage shows one entry per UTC hour: the hour count since 1970 modulo the number of entries. With one entry, that entry shows every hour. No JavaScript runs.
- The file is shown as-is in a framed tile, with no filter or recoloring, and with a credit line under it built from `name`, `author`, `license`, and `source`.
- With an empty array, the homepage shows the text-first hero: the mark, j-chain.net, and the tagline.
- An entry with a missing field, a source that is not https, or a file name that is not lowercase letters, digits, and hyphens ending in `.webp` or `.svg`, is skipped.

## Current cast

| File | Source | Author | License |
|---|---|---|---|
| `wojak-classic.svg` | [Wikimedia Commons: Wojak (meme) simplified & vectorized](https://commons.wikimedia.org/wiki/File:Wojak_(meme)_simplified_%26_vectorized.svg) | Global Donald (Wikimedia Commons), "Own work", 2 October 2026 | CC0 1.0 Universal Public Domain Dedication |
| `wojak-doomer.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Doomer | CC0 1.0 Universal Public Domain Dedication |
| `wojak-yes-chad.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Yes Chad | CC0 1.0 Universal Public Domain Dedication |
| `wojak-soyjak.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Soyjak | CC0 1.0 Universal Public Domain Dedication |
| `wojak-bloomer.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Bloomer | CC0 1.0 Universal Public Domain Dedication |
| `wojak-coomer.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Coomer | CC0 1.0 Universal Public Domain Dedication |
| `wojak-zoomer.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Zoomer | CC0 1.0 Universal Public Domain Dedication |
| `wojak-brainlet.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Brainlet | CC0 1.0 Universal Public Domain Dedication |
| `wojak-galaxy-brain.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Galaxy Brain | CC0 1.0 Universal Public Domain Dedication |
| `wojak-feels.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Feels | CC0 1.0 Universal Public Domain Dedication |
| `wojak-smug.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Smug | CC0 1.0 Universal Public Domain Dedication |
| `wojak-gigachad.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Gigachad | CC0 1.0 Universal Public Domain Dedication |
| `wojak-boomer.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Boomer | CC0 1.0 Universal Public Domain Dedication |
| `wojak-wagie.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Wagie | CC0 1.0 Universal Public Domain Dedication |
| `wojak-schizo.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Schizo | CC0 1.0 Universal Public Domain Dedication |
| `wojak-neet.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), NEET | CC0 1.0 Universal Public Domain Dedication |
| `wojak-becky.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Becky | CC0 1.0 Universal Public Domain Dedication |
| `wojak-doomer-girl.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Doomer Girl | CC0 1.0 Universal Public Domain Dedication |
| `wojak-rage.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Rage | CC0 1.0 Universal Public Domain Dedication |
| `wojak-based.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Based | CC0 1.0 Universal Public Domain Dedication |
| `wojak-comfy.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Comfy | CC0 1.0 Universal Public Domain Dedication |
| `wojak-terminal.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Terminal | CC0 1.0 Universal Public Domain Dedication |
| `wojak-scientist.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Scientist | CC0 1.0 Universal Public Domain Dedication |
| `wojak-bored.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Bored | CC0 1.0 Universal Public Domain Dedication |
| `wojak-chad.webp` | [github.com/Zero-State-LLC/JChain](https://github.com/Zero-State-LLC/JChain) | Zero State LLC (original for j-chain.net), Chad | CC0 1.0 Universal Public Domain Dedication |

The 24 `wojak-<archetype>.webp` files (v2, 2026-10-24) are 512 x 512 WebP squares, metadata-free, on the brand void background. They rotate with the classic Wojak, one entry per UTC hour.

`wojak-classic.svg` is byte-identical to the Commons original (sha256 `a213db0407bc6ba2f01cca6e50a3511b3de5b26f9efcf6da2186ab0a7d64d634`), and a test asserts that hash, so do not edit it. Commons also tags it "fan art"; that tag is informational, not a license. The file has its own white background.

## Adding a cast member

1. Supply one image. Either:
   - an SVG, used as-is for the hero; or
   - WebP crops named by one slug in lowercase letters, digits, and hyphens: `<slug>-hero.webp` at 1600 x 1280 (5:4) for the homepage hero, under 400 KB, and `<slug>-avatar.webp`, a 512 x 512 square crop of the face, for later use as an avatar.
2. Strip metadata (EXIF, XMP) from WebP files. Do not edit an SVG you did not make; keep it byte-identical to its source.
3. Add one entry to `cast.json` with the provenance fields filled in. `alt` is the homepage alt text: describe the picture in one sentence.
4. Never reuse a file name for new art. Files under `/brand/` are cached for a year; give changed art a new slug.

## Rules for the art

- Every cast member must be CC0, licensed to Zero State LLC for commercial use, or original commissioned art. Keep the license or the commission agreement with Danny. Wojak's original creator is unknown and has not been known to enforce, but that is not a license.
- The Wojaks on pngimg.com are CC BY-NC 4.0: non-commercial only, so never usable here.
- No Pepe the Frog, and no other known third-party character.
- Exclude these variants:
  - Chudjak, which is based on a photo of a mass shooter.
  - The political NPC variant.
  - The Tradwife variant.
- The board's Prohibited Content rules apply to the cast like any other image.
