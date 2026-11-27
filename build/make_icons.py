"""Build the app icon from the hand-drawn source image.

The source is a 1024 px JPEG with white corners.  Windows expects a
transparent rounded-square icon, so apply a rounded mask and export both a
large PNG (for the page favicon) and a multi-resolution ICO (for the window,
shortcuts and installer).
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "app-icon-source.jpg"
PNG_OUT = ROOT / "static" / "app-icon.png"
ICO_OUT = ROOT / "static" / "app.ico"

SIZE = 1024
RADIUS = 272
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def rounded_mask(size: int, radius: int, scale: int = 4) -> Image.Image:
    """Return an anti-aliased rounded-square mask."""
    big = Image.new("L", (size * scale, size * scale), 0)
    draw = ImageDraw.Draw(big)
    draw.rounded_rectangle(
        (0, 0, size * scale - 1, size * scale - 1),
        radius=radius * scale,
        fill=255,
    )
    return big.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    if not SOURCE.is_file():
        raise SystemExit(f"missing icon source: {SOURCE}")

    source = Image.open(SOURCE).convert("RGB")
    if source.size != (SIZE, SIZE):
        source = source.resize((SIZE, SIZE), Image.Resampling.LANCZOS)

    icon = source.convert("RGBA")
    # The JPEG carries a faint white anti-aliased rim.  Cover it with a thin
    # dark edge inside the rounded shape before applying the alpha mask.
    edge = ImageDraw.Draw(icon)
    edge.rounded_rectangle(
        (0, 0, SIZE - 1, SIZE - 1),
        radius=RADIUS,
        outline=(7, 38, 39, 255),
        width=6,
    )
    icon.putalpha(rounded_mask(SIZE, RADIUS))

    PNG_OUT.parent.mkdir(parents=True, exist_ok=True)
    icon.resize((512, 512), Image.Resampling.LANCZOS).save(
        PNG_OUT, "PNG", optimize=True
    )
    icon.save(ICO_OUT, "ICO", sizes=ICO_SIZES)

    print(f"wrote {PNG_OUT}")
    print(f"wrote {ICO_OUT}")


if __name__ == "__main__":
    main()
