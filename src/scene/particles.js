// Marine snow: small suspended particles in a box that wraps around the camera. Opaque (alpha-hashed) so they
// write depth and the post pass fogs them like everything else; only drawn below the water surface.
import * as THREE from "three/webgpu";
import {
  Fn, float, vec2, vec3, vec4, uniform, instanceIndex, positionGeometry, cameraViewMatrix, hash, mod, fract,
  sin, cos, length, smoothstep, varying, max, exp, mix, Discard, If, uv, PI,
} from "three/tsl";

const COUNT = 9000;
const BOX = 14;

export function makeParticles(O) {
  const U = O.U;
  const camPos = uniform(new THREE.Vector3());
  const time = uniform(0);
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshBasicNodeMaterial({ alphaHash: true });
  const id = float(instanceIndex);
  const seed = vec3(hash(id), hash(id.add(1733)), hash(id.add(9127)));
  const drift = vec3(sin(time.mul(0.11).add(seed.x.mul(40))).mul(0.06), time.mul(-0.012).add(sin(time.mul(0.3).add(seed.z.mul(30))).mul(0.02)), cos(time.mul(0.09).add(seed.y.mul(40))).mul(0.06));
  const base = seed.mul(BOX).add(drift);
  const rel = mod(base.sub(camPos), BOX).sub(BOX / 2);
  const center = camPos.add(rel);
  const size = hash(id.add(77)).pow(3).mul(0.006).add(0.0015);
  // camera-facing quad
  const right = uniform(new THREE.Vector3(1, 0, 0));
  const up = uniform(new THREE.Vector3(0, 1, 0));
  mat.positionNode = center.add(right.mul(positionGeometry.x.mul(size))).add(up.mul(positionGeometry.y.mul(size)));
  const waterH = O.displacement(center.xz).y.add(U.seaLevel);
  const depth = varying(waterH.sub(center.y), "vSnowDepth");
  const camDist = varying(length(rel), "vSnowDist");
  mat.colorNode = Fn(() => {
    If(depth.lessThan(0.02), () => { Discard(); });
    const r = length(uv().sub(0.5)).mul(2);
    const d = max(depth, 0);
    // forward-scattering flecks: brighter when lit by the sun shafts, faint ambient otherwise
    const lit = U.sunColor.mul(O.sunTransmittance(d)).mul(0.012).add(U.ambient.mul(O.ambientTransmittance(d)).mul(0.5));
    return lit.mul(mix(1.0, 0.3, hash(id.add(5))));
  })();
  mat.opacityNode = Fn(() => {
    const r = length(uv().sub(0.5)).mul(2);
    const fade = smoothstep(BOX / 2, BOX / 2 - 2, camDist).mul(smoothstep(0.15, 0.5, camDist));
    return smoothstep(1, 0.2, r).mul(fade).mul(0.85);
  })();
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  return {
    mesh,
    update(camera, t) {
      camPos.value.copy(camera.position); time.value = t;
      right.value.setFromMatrixColumn(camera.matrixWorld, 0);
      up.value.setFromMatrixColumn(camera.matrixWorld, 1);
    },
  };
}
