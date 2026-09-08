"""PII that exists only as pixels.

A scanned ID card, a photographed cheque, a screenshotted receipt: pages where the
identifier is in the image and nowhere in the DOM. These are the cases the vision layer
exists for, and the corpus has to contain them or L3 can never be shown to be worth its
forty megabytes.

Rendered with Pillow at generation time and embedded as a data URI, so a corpus page
stays a single self-contained file and the harness runs with no network at all.

The fonts are whatever the machine has. That is deliberate: a corpus that only renders
on a machine with a particular font file is a corpus that stops being reproducible the
first time someone clones the repository, and the exact glyph shapes do not matter to
what is being measured. What matters is that the text is legible, is not in the DOM, and
sits at a rectangle the label file records.
"""

from __future__ import annotations

import base64
import io

from PIL import Image, ImageDraw, ImageFont

# Tried in order. The last entry is Pillow's built-in bitmap font, which always exists.
FONT_CANDIDATES = [
    "C:/Windows/Fonts/segoeui.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]
MONO_CANDIDATES = [
    "C:/Windows/Fonts/consola.ttf",
    "C:/Windows/Fonts/cour.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/System/Library/Fonts/Menlo.ttc",
]


def _font(size: int, mono: bool = False):
    for path in MONO_CANDIDATES if mono else FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _uri(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def id_card(name: str, number: str, dob: str, address: str, *,
            width: int = 460, height: int = 280, title: str = "GOVERNMENT OF INDIA",
            subtitle: str = "Unique Identification Authority",
            tint: tuple[int, int, int] = (252, 249, 240)) -> str:
    """A card whose every readable field is pixels. Nothing here reaches the DOM."""
    img = Image.new("RGB", (width, height), tint)
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, width - 1, height - 1], outline=(190, 175, 140), width=2)
    d.rectangle([0, 0, width - 1, 44], fill=(226, 213, 178))
    d.text((14, 8), title, font=_font(15), fill=(70, 45, 20))
    d.text((14, 26), subtitle, font=_font(11), fill=(110, 85, 55))

    # A photograph, as a grey block with a suggestion of a head. It is scored as a face
    # region, not as text, and it is here so a blur policy has something to blur.
    d.rectangle([width - 118, 58, width - 20, 186], fill=(206, 206, 206), outline=(150, 150, 150))
    d.ellipse([width - 96, 78, width - 42, 132], fill=(170, 170, 170))
    d.ellipse([width - 106, 138, width - 32, 200], fill=(170, 170, 170))

    y = 62
    d.text((16, y), "Name", font=_font(10), fill=(120, 110, 95))
    d.text((16, y + 13), name, font=_font(17), fill=(25, 20, 15))
    y += 46
    d.text((16, y), "Date of Birth", font=_font(10), fill=(120, 110, 95))
    d.text((16, y + 13), dob, font=_font(14), fill=(25, 20, 15))
    y += 42
    d.text((16, y), "Address", font=_font(10), fill=(120, 110, 95))
    for i, line in enumerate(_wrap(address, 34)):
        d.text((16, y + 13 + i * 15), line, font=_font(12), fill=(45, 40, 32))

    d.rectangle([0, height - 46, width - 1, height - 1], fill=(226, 213, 178))
    d.text((16, height - 38), number, font=_font(24, mono=True), fill=(30, 25, 18))
    return _uri(img)


def cheque(name: str, account: str, ifsc: str, amount: str, *,
           width: int = 620, height: int = 240) -> str:
    """A cheque leaf. The account number and IFSC are pixels; the DOM has neither."""
    img = Image.new("RGB", (width, height), (236, 242, 236))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, width - 1, height - 1], outline=(160, 180, 160), width=2)
    for i in range(0, height, 8):
        d.line([(0, i), (width, i)], fill=(228, 236, 228))

    d.text((18, 16), "STATE CO-OPERATIVE BANK", font=_font(15), fill=(20, 60, 40))
    d.text((18, 36), "Jayanagar Branch", font=_font(11), fill=(90, 110, 95))
    d.text((18, 74), "Pay", font=_font(11), fill=(90, 110, 95))
    d.text((60, 70), name, font=_font(17), fill=(25, 30, 25))
    d.text((18, 112), "Rupees", font=_font(11), fill=(90, 110, 95))
    d.text((78, 108), amount, font=_font(15), fill=(25, 30, 25))

    d.text((18, height - 62), "A/C", font=_font(10), fill=(90, 110, 95))
    d.text((48, height - 66), account, font=_font(18, mono=True), fill=(25, 30, 25))
    d.text((width - 210, height - 62), "IFSC", font=_font(10), fill=(90, 110, 95))
    d.text((width - 172, height - 66), ifsc, font=_font(16, mono=True), fill=(25, 30, 25))
    return _uri(img)


def receipt(lines: list[tuple[str, str]], *, header: str = "TAX INVOICE",
            width: int = 340, height: int = 300) -> str:
    """A photographed receipt: label/value pairs, small type, faint paper."""
    img = Image.new("RGB", (width, height), (250, 250, 247))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, width - 1, height - 1], outline=(215, 215, 210))
    d.text((14, 12), header, font=_font(13), fill=(40, 40, 40))
    d.line([(14, 32), (width - 14, 32)], fill=(200, 200, 195))

    y = 42
    for label, value in lines:
        d.text((14, y), label, font=_font(10), fill=(130, 130, 125))
        d.text((14, y + 12), value, font=_font(13, mono=True), fill=(35, 35, 35))
        y += 34
    return _uri(img)


def signature(name: str, *, width: int = 240, height: int = 90) -> str:
    """A signature block. A face-or-signature region for the blur path to act on."""
    img = Image.new("RGB", (width, height), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.line([(10, height - 22), (width - 10, height - 22)], fill=(180, 180, 180))
    d.text((14, height - 18), "Signature of applicant", font=_font(9), fill=(150, 150, 150))
    # A scrawl, deterministic given the name, so the corpus rebuilds identically.
    seed = sum(ord(c) for c in name)
    x, y = 18, 46
    for i in range(26):
        nx = x + 8
        ny = 30 + ((seed * (i + 3)) % 34)
        d.line([(x, y), (nx, ny)], fill=(30, 40, 90), width=2)
        x, y = nx, ny
    return _uri(img)


def _wrap(text: str, width: int) -> list[str]:
    words, lines, current = text.split(), [], ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) > width and current:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines[:4]
