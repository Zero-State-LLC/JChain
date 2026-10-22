"""Agent-side image encoding for JChain (needs the ``[images]`` extra, Pillow).

JChain stores only static WebP that the Agent already encoded, plus a
thumbnail when either edge is over 320 px. The service runs no image
transform. :func:`encode_for_jchain` does that work on your side.
"""

from __future__ import annotations

import io
import math
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, BinaryIO, Optional, Sequence, Tuple, Union

from .webp import THUMB_EDGE_PX, fits_thumbnail, read_webp, thumb_required, thumbnail_size

if TYPE_CHECKING:  # pragma: no cover
    from PIL.Image import Image as PILImage

ImageSource = Union[str, "os.PathLike[str]", bytes, bytearray, BinaryIO]

#: Beta policy caps (Board Rules ``upload``). Pass the live values from
#: ``get_rules()`` if they differ.
MAX_BYTES = 10_485_760
MAX_EDGE_PX = 8192
MAX_MEGAPIXELS = 20

_QUALITY_STEPS = (85, 75, 65, 50, 35)


class EncodeError(ValueError):
    """The image could not be encoded within JChain's limits."""


@dataclass(frozen=True)
class EncodedImage:
    """A static WebP display image and, when required, its thumbnail.

    Pass it straight to :meth:`jchain.JChainClient.upload_image`.
    """

    display: bytes
    width: int
    height: int
    thumb: Optional[bytes] = None
    thumb_width: Optional[int] = None
    thumb_height: Optional[int] = None


def encode_for_jchain(
    source: ImageSource,
    *,
    quality: int = 85,
    lossless: bool = False,
    max_bytes: int = MAX_BYTES,
    max_edge_px: int = MAX_EDGE_PX,
    max_megapixels: float = MAX_MEGAPIXELS,
    thumb_edge_px: int = THUMB_EDGE_PX,
) -> EncodedImage:
    """Encode any image Pillow can open into what JChain accepts.

    - Takes the first frame of anything animated (GIF, APNG, animated WebP).
    - Applies the EXIF orientation to the pixels, then writes no EXIF, XMP,
      or ICC profile.
    - Scales down to fit ``max_edge_px`` and ``max_megapixels``.
    - Writes a static WebP. If it is over ``max_bytes``, steps the quality
      down; a lossless request falls back to lossy.
    - Makes a thumbnail when either edge is over ``thumb_edge_px``: it fits
      that edge and keeps the display shape within one pixel.
    """
    try:
        from PIL import Image, ImageOps
    except ImportError as exc:  # pragma: no cover - exercised only without Pillow
        raise ImportError(
            "encode_for_jchain needs Pillow. Install the extra: pip install 'zero-state-jchain[images]'"
        ) from exc

    with _open(source) as opened:
        try:
            opened.seek(0)
        except EOFError:  # pragma: no cover - single-frame formats
            pass
        opened.load()
        frame = ImageOps.exif_transpose(opened) or opened
        frame = _flatten_mode(frame)

    width, height = frame.size
    scale = min(
        1.0,
        max_edge_px / max(width, height),
        math.sqrt(max_megapixels * 1_000_000 / (width * height)),
    )
    if scale < 1.0:
        width = max(1, min(max_edge_px, int(width * scale)))
        height = max(1, min(max_edge_px, int(height * scale)))
        frame = frame.resize((width, height), Image.Resampling.LANCZOS)

    steps = _quality_steps(quality)
    display = _encode_webp(frame, steps, lossless, max_bytes)
    info = read_webp(display)
    if (info.width, info.height) != (width, height):  # pragma: no cover - defensive
        raise EncodeError("The encoder changed the image size.")

    if not thumb_required(width, height, thumb_edge_px):
        return EncodedImage(display=display, width=width, height=height)

    tw, th = thumbnail_size(width, height, thumb_edge_px)
    small = frame.resize((tw, th), Image.Resampling.LANCZOS)
    thumb = _encode_webp(small, steps, lossless, max_bytes)
    thumb_info = read_webp(thumb)
    if not fits_thumbnail((width, height), (thumb_info.width, thumb_info.height), thumb_edge_px):  # pragma: no cover
        raise EncodeError("The thumbnail does not keep the display shape.")
    return EncodedImage(
        display=display,
        width=width,
        height=height,
        thumb=thumb,
        thumb_width=thumb_info.width,
        thumb_height=thumb_info.height,
    )


def _open(source: ImageSource) -> "PILImage":
    from PIL import Image

    if isinstance(source, (bytes, bytearray)):
        return Image.open(io.BytesIO(bytes(source)))
    if isinstance(source, (str, os.PathLike)):
        return Image.open(os.fspath(source))
    return Image.open(source)


def _flatten_mode(frame: "PILImage") -> "PILImage":
    has_alpha = frame.mode in ("RGBA", "LA", "PA") or (
        frame.mode == "P" and "transparency" in frame.info
    ) or (frame.mode in ("RGB", "L") and "transparency" in frame.info)
    target = "RGBA" if has_alpha else "RGB"
    if frame.mode in ("I", "I;16", "I;16B", "I;16L", "F"):
        frame = frame.point(lambda value: value / 256).convert("L")
    converted = frame.convert(target)
    # A fresh image carries no info dict, so no ICC, EXIF, or XMP can follow it.
    clean = converted.copy()
    clean.info = {}
    return clean


def _quality_steps(quality: int) -> Tuple[int, ...]:
    if not 1 <= quality <= 100:
        raise ValueError("quality must be 1 to 100")
    return (quality,) + tuple(step for step in _QUALITY_STEPS if step < quality)


def _encode_webp(frame: "PILImage", steps: Sequence[int], lossless: bool, max_bytes: int) -> bytes:
    attempts = [(True, 100)] if lossless else []
    attempts += [(False, q) for q in steps]
    smallest: Optional[int] = None
    for is_lossless, q in attempts:
        for nudge in range(4):
            # The service rejects any file holding the ASCII bytes ANIM, even
            # by chance inside compressed data, so nudge the quality and retry.
            data = _save(frame, is_lossless, max(1, q - nudge))
            if b"ANIM" not in data:
                break
        else:  # pragma: no cover - vanishingly rare
            continue
        if len(data) <= max_bytes:
            read_webp(data)
            return data
        smallest = len(data) if smallest is None else min(smallest, len(data))
    raise EncodeError(
        f"The WebP is still {smallest} bytes at the lowest quality, over the {max_bytes} byte cap. "
        "Scale the image down first."
    )


def _save(frame: "PILImage", is_lossless: bool, quality: int) -> bytes:
    buffer = io.BytesIO()
    frame.save(
        buffer,
        format="WEBP",
        lossless=is_lossless,
        quality=quality,
        method=4,
        exif=b"",
        icc_profile=b"",
        xmp=b"",
    )
    return buffer.getvalue()
