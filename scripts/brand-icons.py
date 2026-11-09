"""SquareYield icons (docs/features/024-squareyield/spec.md): the PNGs of the mark drawn in
apps/app/src/web/components/brand.tsx (same 32-unit geometry), for the app icon, favicon, Android icons,
splash and the home-screen / web-manifest icons.

    uv run --no-project --with pillow python scripts/brand-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1] / "apps" / "app"
IMAGES = ROOT / "assets" / "images"
PUBLIC = ROOT / "public" / "brand"

INK = (29, 28, 26, 255)  # --ink-1 (light)
GREEN = (47, 122, 79, 255)  # --pos (light)
PAPER = (244, 242, 236, 255)  # --bg (light)
WHITE = (255, 255, 255, 255)
STROKE = 2.6
SUPERSAMPLE = 4


def mark(size: int, scale: float, ink=INK, arrow=GREEN, background=None) -> Image.Image:
    """The mark centred on a size × size canvas; `scale` = share of the canvas the 32-unit box takes."""
    big = size * SUPERSAMPLE
    image = Image.new("RGBA", (big, big), background or (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    unit = big * scale / 32
    offset = big * (1 - scale) / 2

    def at(x: float, y: float) -> tuple[float, float]:
        return offset + x * unit, offset + y * unit

    width = round(STROKE * unit)
    half = STROKE / 2
    # open square: top edge, left edge, bottom edge, right edge (square ends, like the SVG's butt caps + miter)
    for (x0, y0), (x1, y1) in [((17, 6.5), (5.5 - half, 6.5)), ((5.5, 6.5 - half), (5.5, 26.5 + half)),
                               ((5.5 - half, 26.5), (25.5 + half, 26.5)), ((25.5, 26.5 + half), (25.5, 15))]:
        draw.line([at(x0, y0), at(x1, y1)], fill=ink, width=width)
    draw.rectangle([at(10.7, 15.7), at(13.3, 18.3)], fill=ink)
    draw.line([at(15.5, 16.5), at(27, 5)], fill=arrow, width=width)
    draw.line([at(19.5, 5), at(27 + half, 5)], fill=arrow, width=width)
    draw.line([at(27, 5 - half), at(27, 12.5)], fill=arrow, width=width)
    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    mark(1024, 0.72, background=PAPER).save(IMAGES / "icon.png")
    mark(48, 0.96).save(IMAGES / "favicon.png")
    mark(400, 0.9).save(IMAGES / "splash-icon.png")
    # Android adaptive icon: the system crops to a circle / squircle, keep the mark in the central safe zone
    mark(1024, 0.5).save(IMAGES / "android-icon-foreground.png")
    Image.new("RGBA", (1024, 1024), PAPER).save(IMAGES / "android-icon-background.png")
    mark(1024, 0.5, ink=WHITE, arrow=WHITE).save(IMAGES / "android-icon-monochrome.png")
    # web: home-screen icon (iOS) and web manifest icons, on paper so they read on any wallpaper
    for size in (180, 192, 512):
        mark(size, 0.72, background=PAPER).save(PUBLIC / f"icon-{size}.png")
    print("icons written to", IMAGES, "and", PUBLIC)


if __name__ == "__main__":
    main()
