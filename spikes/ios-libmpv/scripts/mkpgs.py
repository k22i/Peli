#!/usr/bin/env python3
"""Writes a tiny PGS (HDMV bitmap subtitle) .sup: one cue every 4 s lasting 2 s.

ffmpeg has no PGS encoder, so the display sets are built by hand: a palette
(transparent, white, black), the text rendered with Pillow and run-length
encoded as PGS wants it. Usage: mkpgs.py out.sup [seconds] [width] [height]
"""
import struct
import sys

from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1]
secs = int(sys.argv[2]) if len(sys.argv) > 2 else 28
W = int(sys.argv[3]) if len(sys.argv) > 3 else 1280
H = int(sys.argv[4]) if len(sys.argv) > 4 else 720


def seg(pts, kind, payload):
    return b"PG" + struct.pack(">II", int(pts * 90000), 0) + bytes([kind]) + struct.pack(">H", len(payload)) + payload


def rle(img):
    px = img.load()
    w, h = img.size
    data = bytearray()
    for y in range(h):
        x = 0
        while x < w:
            c = px[x, y]
            n = 1
            while x + n < w and px[x + n, y] == c and n < 16383:
                n += 1
            if c == 0:
                data += b"\x00" + (bytes([n]) if n < 64 else bytes([0x40 | (n >> 8), n & 0xFF]))
            elif n < 3:
                data += bytes([c]) * n
            else:
                data += b"\x00" + (bytes([0x80 | n, c]) if n < 64 else bytes([0xC0 | (n >> 8), n & 0xFF, c]))
            x += n
        data += b"\x00\x00"
    return bytes(data)


font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 54)


def bitmap(text):
    probe = Image.new("RGBA", (W, 120), (0, 0, 0, 0))
    d = ImageDraw.Draw(probe)
    box = d.textbbox((0, 0), text, font=font, stroke_width=3)
    w, h = box[2] - box[0] + 8, box[3] - box[1] + 8
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((4 - box[0], 4 - box[1]), text, font=font, fill=(255, 255, 255, 255),
                            stroke_width=3, stroke_fill=(0, 0, 0, 255))
    p = Image.new("P", (w, h), 0)
    src, dst = im.load(), p.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = src[x, y]
            dst[x, y] = 0 if a < 100 else (1 if r > 160 else 2)
    return p


sup = bytearray()
for i, t in enumerate(range(1, secs - 2, 4)):
    bmp = bitmap(f"PGS cue {i + 1}: bitmap subtitle at {t} s")
    w, h = bmp.size
    x, y = (W - w) // 2, H - h - 60
    n = i * 2
    pds = bytes([0, 0]) + bytes([0, 16, 128, 128, 0]) + bytes([1, 235, 128, 128, 255]) + bytes([2, 16, 128, 128, 255])
    data = rle(bmp)
    ods = struct.pack(">HBB", 0, 0, 0xC0) + struct.pack(">I", len(data) + 4)[1:] + struct.pack(">HH", w, h) + data
    pcs = struct.pack(">HHBHBBBB", W, H, 0x10, n, 0x80, 0, 0, 1) + struct.pack(">HBBHH", 0, 0, 0, x, y)
    wds = bytes([1, 0]) + struct.pack(">HHHH", x, y, w, h)
    sup += seg(t, 0x16, pcs) + seg(t, 0x17, wds) + seg(t, 0x14, pds) + seg(t, 0x15, ods) + seg(t, 0x80, b"")
    # clear the screen 2 s later
    pcs2 = struct.pack(">HHBHBBBB", W, H, 0x10, n + 1, 0x00, 0, 0, 0)
    sup += seg(t + 2, 0x16, pcs2) + seg(t + 2, 0x80, b"")
open(out, "wb").write(sup)
