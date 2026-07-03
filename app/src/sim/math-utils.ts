/**
 * Pure math utilities — no D3 or React dependencies.
 * Safe to import in Web Workers.
 */

/** Separable 2D Gaussian blur. Smooths Monte Carlo noise in the grid. */
export function gaussianBlur2D(data: number[], w: number, h: number, radius: number): number[] {
  // Build 1D Gaussian kernel
  const sigma = radius / 2;
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v);
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  // Horizontal pass
  const temp = new Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let val = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.max(0, Math.min(w - 1, x + k));
        val += data[y * w + sx] * kernel[k + radius];
      }
      temp[y * w + x] = val;
    }
  }

  // Vertical pass
  const out = new Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let val = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.max(0, Math.min(h - 1, y + k));
        val += temp[sy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = val;
    }
  }

  return out;
}
