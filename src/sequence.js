// Scripted camera for the demo / recordings: above -> half-submerged -> underwater -> surfacing -> above.
// Positions and look targets are interpolated with centripetal Catmull-Rom + smoothstep timing, so the
// camera never jerks.
import * as THREE from "three/webgpu";

// [time s, position, look-at]
export const DEMO = [
  [0, [-1.6, 1.3, 9.0], [2.2, 0.5, 23]],
  [4, [-1.2, 0.8, 10.8], [2.4, 0.4, 23]],
  [7, [-1.0, 0.05, 12.2], [2.5, 0.1, 23]],
  [13, [-0.8, 0.0, 13.4], [2.5, -0.1, 23]],
  [16, [-0.6, -0.9, 14.2], [2.5, -1.4, 23]],
  [19.5, [0.2, -1.5, 15.5], [5.0, -1.2, 22]],
  [23, [0.6, -1.4, 16.8], [6.0, 3.0, 26]],
  [26, [0.4, -0.5, 17.4], [2.6, 0.0, 23]],
  [28.5, [0.3, 0.03, 17.8], [2.6, 0.1, 23]],
  [32, [0.2, 0.5, 18.0], [2.6, 0.45, 23]],
  [37, [0.0, 0.75, 18.2], [2.6, 0.55, 23]],
];

export class Sequence {
  constructor(keys = DEMO) {
    this.keys = keys;
    this.duration = keys[keys.length - 1][0];
    this.pos = new THREE.CatmullRomCurve3(keys.map(k => new THREE.Vector3(...k[1])), false, "centripetal");
    this.look = new THREE.CatmullRomCurve3(keys.map(k => new THREE.Vector3(...k[2])), false, "centripetal");
  }

  // map time -> curve parameter so each key is reached at its time (eased between keys)
  param(t) {
    const k = this.keys;
    if (t <= 0) return 0;
    if (t >= this.duration) return 1;
    let i = 0;
    while (i < k.length - 2 && t > k[i + 1][0]) i++;
    const a = k[i][0], b = k[i + 1][0];
    let f = (t - a) / (b - a);
    f = f * f * (3 - 2 * f) * 0.5 + f * 0.5;   // half eased: keeps motion continuous through keys
    return (i + f) / (k.length - 1);
  }

  apply(camera, t) {
    const u = this.param(t);
    camera.position.copy(this.pos.getPoint(u));
    camera.lookAt(this.look.getPoint(u));
  }
}
