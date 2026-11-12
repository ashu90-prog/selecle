"""Turn the bordered banner from Resources/Image/Logoorbanner.png into
assets/banner.json (base64 RGB pixels) for the terminal renderer.

Run from the repo root:  python scripts/build-banner.py [preview.png]
"""
import base64
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'Resources' / 'Image' / 'Logoorbanner.png'
OUT = ROOT / 'assets' / 'banner.json'

BASE_WIDTH = 240        # widest the banner will ever be drawn, in pixels/columns
BANNER_TOP = 0.465      # the bordered banner starts below this fraction of the height
LABEL_BOX = (0.445, 0.44, 0.55, 0.497)  # the "Banner" caption above the frame
DARK = 24               # rows/columns darker than this everywhere are trimmed


def main():
    img = Image.open(SOURCE).convert('RGB')
    w, h = img.size

    # Hide the caption, then keep only the lower (bordered) half.
    draw = ImageDraw.Draw(img)
    l, t, r, b = LABEL_BOX
    draw.rectangle([l * w, t * h, r * w, b * h], fill=(0, 0, 0))
    img = img.crop((0, int(BANNER_TOP * h), w, h))

    # Trim the black margin around the frame.
    mask = img.convert('L').point(lambda v: 255 if v > DARK else 0)
    img = img.crop(mask.getbbox())

    height = round(img.height * BASE_WIDTH / img.width)
    small = img.resize((BASE_WIDTH, height), Image.Resampling.BOX)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({
        'width': BASE_WIDTH,
        'height': height,
        'rgb': base64.b64encode(small.tobytes()).decode('ascii'),
    }))
    print(f'wrote {OUT} ({BASE_WIDTH}x{height}) from crop {img.size}')
    if len(sys.argv) > 1:
        img.save(sys.argv[1])


if __name__ == '__main__':
    main()
