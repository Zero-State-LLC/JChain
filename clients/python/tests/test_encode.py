"""The thumbnail rule, the WebP header reader, and agent-side encoding."""

from __future__ import annotations

import io
import itertools
from pathlib import Path

import pytest

import jchain
from jchain import fits_thumbnail, read_webp, thumb_required, thumbnail_size

PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[3] / "test" / "fixtures"


# ---------------------------------------------------------------- thumb rule


def test_thumb_required_only_over_320() -> None:
    assert not thumb_required(320, 320)
    assert not thumb_required(1, 320)
    assert thumb_required(321, 10)
    assert thumb_required(10, 321)


@pytest.mark.parametrize("width, height", [(640, 320), (1280, 640), (321, 321), (8192, 1), (1, 8192), (4000, 3000), (1001, 333)])
def test_thumbnail_size_fits_and_keeps_shape(width: int, height: int) -> None:
    tw, th = thumbnail_size(width, height)
    assert max(tw, th) == 320
    assert fits_thumbnail((width, height), (tw, th))


def test_thumbnail_size_agrees_with_the_rule_across_shapes() -> None:
    for width, height in itertools.product(range(300, 2000, 37), range(1, 2000, 41)):
        assert fits_thumbnail((width, height), thumbnail_size(width, height)), (width, height)


def test_small_image_is_its_own_thumbnail() -> None:
    assert thumbnail_size(200, 100) == (200, 100)
    assert fits_thumbnail((200, 100), (200, 100))
    assert not fits_thumbnail((200, 100), (100, 50))


def test_one_pixel_tolerance_is_the_edge() -> None:
    # 1000x333 scales to 320x106.56: 106 and 107 are within one pixel, 105 and 108 are not.
    assert fits_thumbnail((1000, 333), (320, 107))
    assert fits_thumbnail((1000, 333), (320, 106))
    assert not fits_thumbnail((1000, 333), (320, 105))
    assert not fits_thumbnail((1000, 333), (320, 108))
    assert not fits_thumbnail((1000, 333), (321, 107)), "over the 320 box"
    assert not fits_thumbnail((640, 320), (320, 320)), "square thumb for a 2:1 image"


# --------------------------------------------------------------- header reader


@pytest.mark.parametrize(
    "name, size",
    [("valid.webp", (1, 1)), ("large.webp", (640, 320)), ("large-thumb.webp", (320, 160)), ("alpha.webp", (4, 4)), ("metadata.webp", (2, 2))],
)
def test_reader_matches_service_fixtures(name: str, size: tuple) -> None:
    path = FIXTURES / name
    if not path.exists():
        pytest.skip("repo fixtures not present")
    info = read_webp(path.read_bytes())
    assert (info.width, info.height) == size


def test_reader_flags_metadata_and_rejects_bad_files() -> None:
    path = FIXTURES / "metadata.webp"
    if path.exists():
        assert read_webp(path.read_bytes()).has_metadata
    good = _png_to_webp(Image.new("RGB", (10, 10)))
    with pytest.raises(jchain.WebPError) as caught:
        read_webp(good + b"trailing")
    assert caught.value.reason == "invalid_image"
    with pytest.raises(jchain.WebPError) as caught:
        read_webp(b"\xff\xd8\xff" + b"\x00" * 40)
    assert caught.value.reason == "unsupported_type"


def test_reader_rejects_animated_webp() -> None:
    frames = [Image.new("RGB", (20, 20), c) for c in [(255, 0, 0), (0, 0, 255)]]
    buffer = io.BytesIO()
    frames[0].save(buffer, "WEBP", save_all=True, append_images=frames[1:], duration=100)
    with pytest.raises(jchain.WebPError) as caught:
        read_webp(buffer.getvalue())
    assert caught.value.reason == "animated"


# ------------------------------------------------------------------- encoding


def _png_to_webp(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "WEBP")
    return buffer.getvalue()


def _png(image: Image.Image, **params: object) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "PNG", **params)
    return buffer.getvalue()


def _assert_clean_static_webp(data: bytes) -> jchain.WebPInfo:
    info = read_webp(data)
    assert not info.has_metadata
    assert not {"EXIF", "XMP ", "ICCP", "ANIM", "ANMF"} & set(info.chunks)
    assert b"ANIM" not in data
    return info


def test_large_image_gets_display_and_fitting_thumbnail() -> None:
    encoded = jchain.encode_for_jchain(_png(Image.new("RGB", (1600, 900), (20, 200, 90))))
    assert (encoded.width, encoded.height) == (1600, 900)
    assert encoded.thumb is not None
    display = _assert_clean_static_webp(encoded.display)
    thumb = _assert_clean_static_webp(encoded.thumb)
    assert (display.width, display.height) == (1600, 900)
    assert (thumb.width, thumb.height) == (encoded.thumb_width, encoded.thumb_height) == (320, 180)
    assert fits_thumbnail((1600, 900), (thumb.width, thumb.height))


def test_small_image_has_no_thumbnail() -> None:
    encoded = jchain.encode_for_jchain(_png(Image.new("RGB", (320, 200))))
    assert encoded.thumb is None and encoded.thumb_width is None
    _assert_clean_static_webp(encoded.display)


def test_metadata_is_never_written(tmp_path: Path) -> None:
    source = Image.new("RGB", (400, 300), (5, 5, 5))
    exif = Image.Exif()
    exif[0x010F] = "SecretCam"  # Make
    exif[0x0131] = "private-software"  # Software
    icc = b"\x00" * 128
    path = tmp_path / "with-meta.jpg"
    source.save(path, "JPEG", exif=exif.tobytes(), icc_profile=icc)
    assert Image.open(path).info.get("icc_profile")
    encoded = jchain.encode_for_jchain(path)
    for data in (encoded.display, encoded.thumb):
        assert data is not None
        _assert_clean_static_webp(data)
        assert b"SecretCam" not in data and b"private-software" not in data
        reopened = Image.open(io.BytesIO(data))
        assert not reopened.info.get("exif") and not reopened.info.get("icc_profile") and not reopened.info.get("xmp")


def test_exif_orientation_is_applied_to_pixels(tmp_path: Path) -> None:
    source = Image.new("RGB", (200, 100), (255, 0, 0))
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 degrees clockwise to display
    path = tmp_path / "rotated.jpg"
    source.save(path, "JPEG", exif=exif.tobytes())
    encoded = jchain.encode_for_jchain(str(path))
    assert (encoded.width, encoded.height) == (100, 200)


def test_animated_input_takes_the_first_frame() -> None:
    frames = [Image.new("RGB", (60, 40), c) for c in [(255, 0, 0), (0, 0, 255), (0, 255, 0)]]
    buffer = io.BytesIO()
    frames[0].save(buffer, "GIF", save_all=True, append_images=frames[1:], duration=50, loop=0)
    encoded = jchain.encode_for_jchain(io.BytesIO(buffer.getvalue()))
    _assert_clean_static_webp(encoded.display)
    red, green, blue = Image.open(io.BytesIO(encoded.display)).convert("RGB").getpixel((30, 20))
    assert red > 200 and blue < 60 and green < 60


def test_alpha_is_kept() -> None:
    encoded = jchain.encode_for_jchain(_png(Image.new("RGBA", (50, 50), (0, 0, 0, 0))))
    assert "ALPH" in read_webp(encoded.display).chunks or "VP8L" in read_webp(encoded.display).chunks
    assert Image.open(io.BytesIO(encoded.display)).mode == "RGBA"


def test_palette_and_greyscale_inputs() -> None:
    for mode in ("P", "L", "LA", "1", "CMYK"):
        encoded = jchain.encode_for_jchain(_png(Image.new(mode, (30, 30))) if mode != "CMYK" else _jpeg_cmyk())
        _assert_clean_static_webp(encoded.display)


def _jpeg_cmyk() -> bytes:
    buffer = io.BytesIO()
    Image.new("CMYK", (30, 30)).save(buffer, "JPEG")
    return buffer.getvalue()


def test_scales_down_to_policy_limits() -> None:
    encoded = jchain.encode_for_jchain(_png(Image.new("RGB", (1000, 500))), max_edge_px=600)
    assert (encoded.width, encoded.height) == (600, 300)
    encoded = jchain.encode_for_jchain(_png(Image.new("RGB", (2000, 2000))), max_megapixels=1)
    assert encoded.width * encoded.height <= 1_000_000


def test_too_large_after_quality_steps_raises() -> None:
    noisy = Image.effect_noise((256, 256), 100).convert("RGB")
    with pytest.raises(jchain.EncodeError):
        jchain.encode_for_jchain(_png(noisy), max_bytes=200)


def test_lossless_request() -> None:
    encoded = jchain.encode_for_jchain(_png(Image.new("RGB", (40, 40), (1, 2, 3))), lossless=True)
    assert read_webp(encoded.display).chunks == ("VP8L",)
