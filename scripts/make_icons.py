from PIL import Image, ImageDraw

SIZES = [16, 32, 48, 128]

def make(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = max(2, size // 6)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=(37, 99, 235, 255))
    pad = size // 4
    bar_h = max(1, size // 10)
    gap = bar_h
    widths = [size - 2 * pad, size - 2 * pad, int((size - 2 * pad) * 0.6)]
    y = pad
    for w in widths:
        d.rounded_rectangle([pad, y, pad + w, y + bar_h - 1], radius=bar_h // 2, fill=(255, 255, 255, 255))
        y += bar_h + gap
    img.save(f"icons/{size}.png")

for s in SIZES:
    make(s)
print("icons generated")
