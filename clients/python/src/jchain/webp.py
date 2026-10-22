"""Pure-Python WebP header reader and the JChain thumbnail rule.

This mirrors what the JChain asset consumer checks, so a client can fail
early instead of spending an upload. It reads the RIFF container and the
bitstream header only. It never decodes pixels and needs no Pillow.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import List, Optional, Tuple

#: Board Rules ``upload.thumb_edge_px``. A display image whose longer side is
#: over this needs a thumbnail.
THUMB_EDGE_PX = 320

_METADATA = frozenset({b"ICCP", b"EXIF", b"XMP "})
_BITSTREAMS = frozenset({b"VP8 ", b"VP8L"})
_VP8X_ANIMATION = 0x02


class WebPError(ValueError):
    """The bytes are not a static WebP that JChain would accept."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        #: Matches the service's ``reason_code`` where one applies:
        #: ``unsupported_type``, ``animated``, or ``invalid_image``.
        self.reason = reason


@dataclass(frozen=True)
class WebPInfo:
    """Dimensions and chunk layout read from a WebP header."""

    width: int
    height: int
    chunks: Tuple[str, ...]

    @property
    def has_metadata(self) -> bool:
        return any(name.encode("ascii") in _METADATA for name in self.chunks)


@dataclass(frozen=True)
class _Chunk:
    fourcc: bytes
    payload: int
    size: int


def is_webp(data: bytes) -> bool:
    """True when the bytes start with ``RIFF`` and carry ``WEBP`` at offset 8."""
    return len(data) >= 12 and data[0:4] == b"RIFF" and data[8:12] == b"WEBP"


def read_webp(data: bytes) -> WebPInfo:
    """Read width and height from a static WebP, the way the service does.

    Raises :class:`WebPError` for anything the service would reject from
    headers alone: not WebP, animated, an unknown chunk, trailing bytes, or a
    canvas that disagrees with the bitstream. Metadata chunks (``ICCP``,
    ``EXIF``, ``XMP``) are allowed here because the service drops them, but
    :func:`jchain.encode_for_jchain` never writes them.
    """
    if not is_webp(data):
        raise WebPError("unsupported_type", "Not a WebP file. JChain accepts static WebP only.")
    # The service scans the whole file for the ASCII fourcc ANIM.
    if b"ANIM" in data:
        raise WebPError("animated", "The file contains ANIM, so JChain treats it as animated.")
    if len(data) < 20:
        raise WebPError("invalid_image", "The WebP is truncated.")
    riff_size = struct.unpack_from("<I", data, 4)[0]
    if riff_size + 8 != len(data):
        raise WebPError("invalid_image", "The RIFF size does not match the file length.")

    chunks: List[_Chunk] = []
    offset = 12
    while offset < len(data):
        if offset + 8 > len(data):
            raise WebPError("invalid_image", "A chunk header is truncated.")
        size = struct.unpack_from("<I", data, offset + 4)[0]
        end = offset + 8 + size + (size & 1)
        if end > len(data):
            raise WebPError("invalid_image", "A chunk runs past the end of the file.")
        chunks.append(_Chunk(bytes(data[offset:offset + 4]), offset + 8, size))
        offset = end
    names = tuple(chunk.fourcc.decode("latin-1") for chunk in chunks)
    if any(chunk.fourcc in (b"ANIM", b"ANMF") for chunk in chunks):
        raise WebPError("animated", "Animated WebP is not accepted.")

    kept = [chunk for chunk in chunks if chunk.fourcc not in _METADATA]
    if not kept:
        raise WebPError("invalid_image", "The WebP has no image chunk.")
    first = kept[0]
    if first.fourcc in _BITSTREAMS:
        if len(kept) != 1:
            raise WebPError("invalid_image", "The WebP has chunks JChain does not accept.")
        width, height = _bitstream_size(data, first)
        return WebPInfo(width, height, names)

    if first.fourcc != b"VP8X" or first.size != 10:
        raise WebPError("invalid_image", "The WebP has chunks JChain does not accept.")
    flags = data[first.payload]
    if flags & _VP8X_ANIMATION:
        raise WebPError("animated", "The VP8X animation flag is set.")
    canvas_w = _u24(data, first.payload + 4) + 1
    canvas_h = _u24(data, first.payload + 7) + 1
    rest = kept[1:]
    alpha: Optional[_Chunk] = None
    if rest and rest[0].fourcc == b"ALPH":
        alpha = rest.pop(0)
    if len(rest) != 1 or rest[0].fourcc not in _BITSTREAMS:
        raise WebPError("invalid_image", "The WebP has chunks JChain does not accept.")
    image = rest[0]
    if alpha is not None and image.fourcc != b"VP8 ":
        raise WebPError("invalid_image", "ALPH must precede a lossy VP8 bitstream.")
    width, height = _bitstream_size(data, image)
    if (width, height) != (canvas_w, canvas_h):
        raise WebPError("invalid_image", "The canvas size disagrees with the bitstream.")
    return WebPInfo(width, height, names)


def thumb_required(width: int, height: int, edge: int = THUMB_EDGE_PX) -> bool:
    """True when either edge is over ``edge``, so a thumbnail must be declared."""
    return max(width, height) > edge


def thumbnail_size(width: int, height: int, edge: int = THUMB_EDGE_PX) -> Tuple[int, int]:
    """The thumbnail dimensions JChain expects: fit ``edge``, keep the shape.

    A display image that already fits is its own thumbnail and is returned
    unchanged.
    """
    if width < 1 or height < 1:
        raise ValueError("width and height must be positive")
    scale = min(1.0, edge / max(width, height))
    return max(1, int(width * scale + 0.5)), max(1, int(height * scale + 0.5))


def fits_thumbnail(
    display: Tuple[int, int],
    thumb: Tuple[int, int],
    edge: int = THUMB_EDGE_PX,
) -> bool:
    """The service's rule: the thumbnail's longer side is at most ``edge`` and
    each side is within one pixel of the display image scaled to fit ``edge``.
    """
    dw, dh = display
    tw, th = thumb
    if max(tw, th) > edge:
        return False
    scale = min(1.0, edge / max(dw, dh))
    return abs(tw - dw * scale) <= 1 and abs(th - dh * scale) <= 1


def _bitstream_size(data: bytes, chunk: _Chunk) -> Tuple[int, int]:
    at = chunk.payload
    if chunk.fourcc == b"VP8 ":
        if chunk.size < 10 or data[at] & 0x01:
            raise WebPError("invalid_image", "The VP8 header is not a key frame.")
        if data[at + 3:at + 6] != b"\x9d\x01\x2a":
            raise WebPError("invalid_image", "The VP8 start code is missing.")
        width = struct.unpack_from("<H", data, at + 6)[0] & 0x3FFF
        height = struct.unpack_from("<H", data, at + 8)[0] & 0x3FFF
        if width < 1 or height < 1:
            raise WebPError("invalid_image", "The VP8 size is zero.")
        return width, height
    if chunk.size < 5 or data[at] != 0x2F:
        raise WebPError("invalid_image", "The VP8L signature is missing.")
    bits = struct.unpack_from("<I", data, at + 1)[0]
    if bits >> 29:
        raise WebPError("invalid_image", "The VP8L version is not 0.")
    return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1


def _u24(data: bytes, at: int) -> int:
    return int(data[at]) | (int(data[at + 1]) << 8) | (int(data[at + 2]) << 16)
