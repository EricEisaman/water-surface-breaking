"""Download the CC0 Poly Haven source assets used by the demo into assets_src/ (not in git).
Then `npm run assets` (tools/build_assets.mjs) builds the web versions in public/assets/ (LODs, meshopt, WebP).

    npm run fetch                       # skip files that already exist
    npm run fetch -- --force

All assets are CC0 (https://polyhaven.com/license). Sources are listed in LICENSES.md.
"""
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets_src")
FORCE = "--force" in sys.argv
UA = {"User-Agent": "Mozilla/5.0 (water-surface-breaking asset fetch)"}   # Poly Haven returns 403 without a UA

HDRIS = [("kloofendal_48d_partly_cloudy_puresky", "4k")]
TEXTURES = [("coast_sand_01", "2k"), ("coast_sand_rocks_02", "2k")]
MODELS = [("coast_rocks_01", "2k"), ("coast_rocks_02", "2k"), ("coast_rocks_05", "2k"),
          ("sand_rocks_small_01", "2k"), ("coastal_cliff_02", "2k"), ("lambis_shell", "1k")]


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r:
        return json.load(r)


def download(url, dst):
    if os.path.exists(dst) and not FORCE:
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    print("  ", os.path.relpath(dst, ROOT))
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r, open(dst + ".part", "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    os.replace(dst + ".part", dst)


def main():
    for name, res in HDRIS:
        print("hdri", name)
        files = get_json(f"https://api.polyhaven.com/files/{name}")
        download(files["hdri"][res]["hdr"]["url"], os.path.join(OUT, "hdri", f"{name}_{res}.hdr"))
    for name, res in TEXTURES:
        print("texture", name)
        files = get_json(f"https://api.polyhaven.com/files/{name}")
        for key, tag in (("Diffuse", "diff"), ("nor_gl", "nor_gl"), ("arm", "arm")):
            if key in files:
                fmt = "jpg" if "jpg" in files[key][res] else "png"
                download(files[key][res][fmt]["url"], os.path.join(OUT, "textures", name, f"{name}_{tag}_{res}.{fmt}"))
    for name, res in MODELS:
        print("model", name)
        files = get_json(f"https://api.polyhaven.com/files/{name}")
        g = files["gltf"][res]["gltf"]
        base = os.path.join(OUT, "models", name)
        download(g["url"], os.path.join(base, os.path.basename(g["url"])))
        for rel, inc in g["include"].items():
            download(inc["url"], os.path.join(base, rel))


if __name__ == "__main__":
    main()
