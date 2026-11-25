/**
 * MixMaker · Audio effects
 * Shared defaults and DSP helpers used by the live and offline audio graph.
 */
export const createDefaultEffects = () => ({
  eq: [0, 0, 0], hp: 20, lp: 20000, rev: 0, delay: 0,
  dlt: 0.3, dist: 0, comp: false, radio: false, bypass: false
});

export const shapeEnvelope = (x, type, clamp) =>
  type === 'lin' ? x : type === 'exp' ? x * x : Math.sin(clamp(x, 0, 1) * Math.PI / 2);

export function createDistortionCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = amount * 60;
  for (let i = 0; i < n; i++) {
    const x = i * 2 / n - 1;
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}
