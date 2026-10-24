"""Convert a Radiance .hdr equirect into the compressed half-float OpenEXR the demo loads.

    pip install OpenEXR numpy
    py tools/hdri_to_exr.py assets_src/hdri/<name>.hdr public/assets/hdri/<name>.exr

DWAB (lossy, built for HDR) turns the 20.7 MB 4k sky into about 3 MB; the visible sky changes by about 2 %.
The sun is brighter than half floats allow (65504), so the radiance is stored scaled by 1/HDRI_SCALE;
src/scene/world.js multiplies it back before cutting the sun out.
"""
import sys
import numpy as np
import OpenEXR

HDRI_SCALE = 2.0   # keep in sync with src/scene/world.js


def read_hdr(path):
    b = open(path, "rb").read()
    i = 0
    while True:
        j = b.index(b"\n", i)
        line, i = b[i:j], j + 1
        if line[:2] in (b"-Y", b"+Y"):
            break
    _, H, _, W = line.split()
    H, W = int(H), int(W)
    rgbe = np.zeros((H, W, 4), np.uint8)
    for y in range(H):   # new-style RLE scanlines (every Poly Haven .hdr)
        assert b[i] == 2 and b[i + 1] == 2, "only RLE-encoded .hdr files are supported"
        i += 4
        for c in range(4):
            row, x = rgbe[y, :, c], 0
            while x < W:
                n = b[i]
                i += 1
                if n > 128:
                    n -= 128
                    row[x:x + n] = b[i]
                    i += 1
                else:
                    row[x:x + n] = np.frombuffer(b, np.uint8, n, i)
                    i += n
                x += n
    e = rgbe[..., 3].astype(np.int32)
    f = np.where(e > 0, np.ldexp(1.0, e - 136), 0).astype(np.float32)
    return rgbe[..., :3].astype(np.float32) * f[..., None]


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    img = read_hdr(src) / HDRI_SCALE
    assert img.max() < 65504, "radiance too large for half floats: raise HDRI_SCALE"
    header = {"compression": OpenEXR.DWAB_COMPRESSION, "type": OpenEXR.scanlineimage}
    OpenEXR.File(header, {"RGB": img.astype(np.float16)}).write(dst)
