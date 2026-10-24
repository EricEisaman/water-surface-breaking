# Third-party assets and code

## Assets

Everything in `public/assets/` comes from [Poly Haven](https://polyhaven.com) under **CC0** ([license](https://polyhaven.com/license)). Thank you, Poly Haven and its artists.

The files here are processed versions. `npm run fetch` downloads the originals into `assets_src/` (not in git), and `npm run assets` (`tools/build_assets.mjs`) rebuilds `public/assets/` from them: rocks get simplified LODs and a coarse shadow mesh with meshoptimizer and meshopt compression, textures are re-encoded as WebP, and the HDRI is converted to a DWAB-compressed half-float OpenEXR (`tools/hdri_to_exr.py`).

| Asset | Type | Used as | Source |
|---|---|---|---|
| Kloofendal 48d Partly Cloudy (Pure Sky), 4k | HDRI | sky and sun | https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky |
| Coast Sand 01, 2k | texture | sand | https://polyhaven.com/a/coast_sand_01 |
| Coast Sand Rocks 02, 2k | texture | seabed | https://polyhaven.com/a/coast_sand_rocks_02 |
| Coast Rocks 01, 2k | model | rocks | https://polyhaven.com/a/coast_rocks_01 |
| Coast Rocks 02, 2k | model | rocks | https://polyhaven.com/a/coast_rocks_02 |
| Coast Rocks 05, 2k | model | boulder | https://polyhaven.com/a/coast_rocks_05 |
| Sand Rocks Small 01, 2k | model | small rocks | https://polyhaven.com/a/sand_rocks_small_01 |
| Coastal Cliff 02, 2k | model | cliffs | https://polyhaven.com/a/coastal_cliff_02 |
| Lambis Shell, 1k | model | shell | https://polyhaven.com/a/lambis_shell |

## Code

- [three.js](https://threejs.org) (MIT), installed from npm. The AgX tone-mapping constants in `src/post/post.js` follow three.js's implementation.
- Build tools from npm: [Vite](https://vite.dev) (MIT), [glTF Transform](https://gltf-transform.dev) (MIT), [meshoptimizer](https://github.com/zeux/meshoptimizer) (MIT), [sharp](https://sharp.pixelplumbing.com) (Apache-2.0). The HDRI converter uses [OpenEXR](https://openexr.com) (BSD-3-Clause) and NumPy (BSD-3-Clause) from pip.

No code or assets from EasyWaterscape are used; it was only a visual reference.

## Brand

The KanaWorks_AI name, logo and the Kana character in `docs/brand/` and in the banners in `docs/assets/` are © 東京AI映像合同会社 and are not covered by the MIT license. See [docs/brand/README.md](docs/brand/README.md).
