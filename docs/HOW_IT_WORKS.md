# How Minamo works

Minamo renders a sunny tropical bay above, below and exactly at the water surface. three.js (`WebGPURenderer`, TSL node materials) draws the scene, the PBR rocks and the water surface. The ocean simulation, caustics, the underwater medium, the lens and the whole post-processing chain are hand-written WGSL compute and render passes on the **same `GPUDevice`**; the two sides exchange textures through three.js `ExternalTexture`.

## One frame

`frame()` in `src/main.js`:

1. **Ocean** (`src/ocean/ocean.js`, WGSL compute): spectrum → inverse FFT in shared memory (rows, then columns) → displacement / derivatives / Jacobian foam → mips → caustics.
2. **Near-plane test** (`post.prepare`, the `nearS` pass): for every pixel, how far the point on the camera's near plane is above the water surface → an r32float texture. This one texture decides, everywhere, which pixels are under water.
3. **Opaque scene** (three.js) into an HDR target (rgba16f + depth).
4. **Water surface**: copy colour + linear depth into `post.backdrop` → draw the back faces of the water mesh → copy again → draw the front faces. Drawing back then front keeps the glassy look of wave crests seen through other crests.
5. **Post** (`src/post/post.js`, WGSL): half-resolution light shafts → underwater compositing → blur pyramid → lens water film simulation → lens layer (meniscus, film, drops) → bloom → auto exposure → AgX tone mapping → the visible canvas.

The three.js canvas is never shown; the final image is drawn into `#c`.

## Ocean

- Tessendorf FFT ocean with a JONSWAP spectrum, directional spreading and a separate swell, in **3 cascades** (250 m / 37 m / 7.3 m tiles, 256² each, rgba16f).
- Textures per cascade: `disp` = (Dx, Dy, Dz, ∂Dx/∂z), `deriv` = (∂Dy/∂x, ∂Dy/∂z, ∂Dx/∂x, ∂Dz/∂z), `foam` = (foam, Jacobian, slope variance for LEAN-style roughness).
- The GPU displacement is read back asynchronously so the CPU can ask for the height under a point (`heightAt()`). That is only used for logic: the floating camera and spawning lens drops.

## The waterline has to match the waves exactly

The camera's near plane is only about 7 cm wide. Any error in where the water surface is gets magnified to the whole screen at the waterline, so **the water mesh and the per-pixel waterline test use the same function**: the same textures, bilinear for the two coarse cascades, a **4-tap cubic B-spline** for the 7.3 m cascade (bilinear 2.85 cm texels turn into visible kinks on the waterline), and 6 damped fixed-point iterations to invert the horizontal displacement. It lives in two places, the TSL `oceanNodes.displacement` and the WGSL `bsplineDisp` / `heightAt` / `nearS` in `post.js`; change one and you must change the other.

The water material, the underwater compositing, the lens film and the lens layer all read the same near-plane texture, so their waterlines agree by construction. The water material picks its above / below branch from that texture rather than from `frontFacing`, because folded wave crests flip their faces.

## Water surface (`src/ocean/waterMaterial.js`)

- **From above:** exact Fresnel, PMREM sky, a GGX sun highlight, screen-space refraction with a bounded normal offset, the same in-water scattering as the post pass, subsurface glow in wave crests, and foam.
- **From below:** Snell's window (refracted sky × n²) and, outside it, total internal reflection that shows the water's own scattered light.

## Underwater medium

Absorption and scattering are per RGB channel. The defaults are a clear tropical sea (Jerlov IA–IB):

| | R | G | B |
|---|---|---|---|
| absorption σa (1/m) | 0.42 | 0.065 | 0.025 |
| scattering σs (1/m) | 0.020 | 0.030 | 0.045 |

Light going *down* is attenuated with the diffuse coefficient `Kd ≈ σa + 0.3 σs`; light along the *view ray* with `σt = σa + σs`. Single scattering along a view segment has a closed form because both exponents are linear in the distance:

```
L_in  = σs · p(cos θ) · E_sun' · exp(−Kd' · depth0) · (1 − exp(−k d)) / k,   k = σt − Kd' · v.y,  Kd' = Kd / cos θ_refr
L_amb = σs / σt · A(depth) · (1 − exp(−σt d))                                  (sky light, with a multiple-scattering boost)
L     = L_scene · exp(−σt d) + L_in · caustics/shafts + L_amb
```

The phase function is strongly forward: `0.85 · HG(0.9) + 0.15 · HG(0.2)`.

Every opaque material gets the same underwater lighting (`underwaterize` in `src/scene/world.js`): the sun arrives through the shadow node as Fresnel transmission × `exp(−Kd' · depth)` × caustics, the sky as `exp(−Kd · depth)` on the albedo, and rocks get a wet, darker band just above the current waterline. Depth is measured to the current wave height, not to the mean sea level.

## Caustics (`src/ocean/caustics.js`)

The area-ratio method from Evan Wallace's WebGL Water: a source grid with 2 vertices per texel is refracted through the surface and rasterised onto a plane; brighter where triangles shrink. It is drawn three times with three indices of refraction for chromatic dispersion, into a 1024² window that follows the camera (20 m), and its mips serve as defocus blur with depth. The 7.3 m cascade only contributes 30 % (sampled at mip 1.5); at full strength the seabed fills with sparkle noise at 3 m.

## Light shafts

The sun term of the underwater scattering is multiplied by the average of the caustic pattern ray-marched along the view ray. The march runs at half resolution (shaft factor + segment length) and is upsampled with a depth- and medium-aware bilateral filter; texels from the other medium are ignored.

## Lens

- **Waterline:** the sign of the near-plane test gives the exact line, a gradient of the half-resolution field gives the screen-space distance to it, and the meniscus band is shaded from that distance.
- **Draining water film:** a half-resolution semi-Lagrangian simulation of the film running down the lens after the camera leaves the water.
- **Beads:** small procedural droplets left on a wet lens.
- **Drops** (`src/post/lensDrops.js`): CPU-simulated larger drops that slide, leave trails, merge and evaporate, and vanish when the lens goes under water again.

## Camera

The demo path (`src/sequence.js`) stores the camera height *relative to the local water surface*. Near the surface the camera floats with the waves with some lag, like a handheld waterproof housing, so the waterline keeps sweeping across the lens. A camera at a fixed height would rarely straddle the waterline in half-metre waves.

## Rocks and level of detail

Every rock `.glb` contains `lod0..n` plus a coarse `shadow` mesh, with the absolute simplification error of each level in the scene extras (`lodError`). Each placement becomes a `THREE.LOD` that switches where that error projects to 0.75 px at the current internal resolution and field of view. Only the coarse mesh casts shadows (on its own layer). `tools/build_assets.mjs` builds all of this with meshoptimizer.

## HDR safety

The scene target is half float, so materials clamp their output (an unclamped sun highlight overflows to Inf and the bloom pyramid smears it into white polygons), and the post entry also removes NaN / Inf.

## References

- Tessendorf, *Simulating Ocean Water*, SIGGRAPH 2001 course notes.
- Horvath, *Empirical Directional Wave Spectra for Computer Graphics*, DigiPen 2015.
- Bruneton, Neyret, Holzschuch, *Real-time Realistic Ocean Lighting using Seamless Transitions from Geometry to BRDF*, Eurographics 2010.
- Hillaire, *Physically Based and Unified Volumetric Rendering in Frostbite*, SIGGRAPH 2015.
- Solonenko & Mobley, *Inherent optical properties of Jerlov water types*, Applied Optics 54(17), 2015.
- Akkaynak et al., *What Is the Space of Attenuation Coefficients in Underwater Computer Vision?*, CVPR 2017.
- Monzón et al., *Multiple Scattering Approximation for Real-time Underwater Spectral Rendering*, STAG 2022.
- Pope & Fry, *Absorption spectrum (380–700 nm) of pure water*, Applied Optics 1997.
- Evan Wallace, [WebGL Water](https://madebyevan.com/webgl-water/) and *Rendering Realtime Caustics in WebGL*.
- [gasgiant/FFT-Ocean](https://github.com/gasgiant/FFT-Ocean), [Crest](https://github.com/wave-harmonic/crest) (ideas only).
- The visual target was William Faucher's EasyWaterscape for Unreal Engine. Minamo uses none of its code or assets.
