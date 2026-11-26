const { blurAlphaValues, downsampleAlpha } = require('./canvas-compat');

const aspect = 935 / 1517;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

class CoatOutline {
  constructor(surface) {
    const w = 180;
    const h = Math.round((w * surface.sh) / surface.sw);
    const alpha = surface.alpha320
      ? downsampleAlpha(surface.alpha320, surface.sw, surface.sh, w, h)
      : (() => {
          const out = new Uint8ClampedArray(w * h);
          const s = surface.src;
          for (let y = 0; y < h; y++) {
            const sy = Math.min(surface.sh - 1, Math.floor(((y + 0.5) * surface.sh) / h));
            for (let x = 0; x < w; x++) {
              const sx = Math.min(surface.sw - 1, Math.floor(((x + 0.5) * surface.sw) / w));
              out[y * w + x] = s[4 * (sy * surface.sw + sx) + 3];
            }
          }
          return out;
        })();
    const edge = blurAlphaValues(alpha, w, h, 0.75);
    const wide = blurAlphaValues(alpha, w, h, 2.0);
    const A = (data, x, y) => data[y * w + x];

    this.maskWidth = w;
    this.maskHeight = h;
    this.padMask = wide;

    this.neckColumns = [];
    for (let x = Math.ceil(0.13 * w); x < 0.42 * w; x++) {
      let top = 0;
      let bottom = h - 1;
      while (top < bottom && A(edge, x, top) < 128) top++;
      while (bottom > top && A(edge, x, bottom) < 128) bottom--;
      if (bottom > top) {
        this.neckColumns.push({ u: (x + 0.5) / w, top: (top + 0.5) / h, bottom: (bottom + 0.5) / h });
      }
    }

    this.lines = [];
    const point = (x, y) => {
      const i = clamp(Math.round(x), 2, w - 3);
      const j = clamp(Math.round(y), 2, h - 3);
      const nx = A(wide, i + 2, j) - A(wide, i - 2, j);
      const ny = A(wide, i, j + 2) - A(wide, i, j - 2);
      const L = Math.hypot(nx, ny) || 1;
      return { x: (x + 0.5) / w, y: ((y + 0.5) / h) * aspect, nx: nx / L, ny: ny / L };
    };

    for (let y = 1; y < h - 2; y++) {
      for (let x = 1; x < w - 2; x++) {
        const a = A(edge, x, y);
        const b = A(edge, x + 1, y);
        const c = A(edge, x + 1, y + 1);
        const d = A(edge, x, y + 1);
        if (Math.min(a, b, c, d) >= 128 || Math.max(a, b, c, d) < 128) continue;
        const hits = [];
        if ((a >= 128) !== (b >= 128)) hits.push(point(x + (128 - a) / (b - a), y));
        if ((b >= 128) !== (c >= 128)) hits.push(point(x + 1, y + (128 - b) / (c - b)));
        if ((d >= 128) !== (c >= 128)) hits.push(point(x + (128 - d) / (c - d), y + 1));
        if ((a >= 128) !== (d >= 128)) hits.push(point(x, y + (128 - a) / (d - a)));
        for (let i = 0; i + 1 < hits.length; i += 2) {
          const p = hits[i];
          const q = hits[i + 1];
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const length = Math.hypot(dx, dy);
          if (length > 1e-8) this.lines.push({ p, q, dx, dy, length, den: length * length });
        }
      }
    }
  }

  padCoverage(u, v) {
    const w = this.maskWidth;
    const h = this.maskHeight;
    const x = u * w - 0.5;
    const y = v * h - 0.5;
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return 0;
    const col = Math.floor(x);
    const row = Math.floor(y);
    const i = row * w + col;
    const fx = x - col;
    const fy = y - row;
    const a = this.padMask;
    const top = a[i] + (a[i + 1] - a[i]) * fx;
    const bottom = a[i + w] + (a[i + w + 1] - a[i + w]) * fx;
    return (top + (bottom - top) * fy) / 255;
  }

  fitNeck(cat) {
    if (!this.neckColumns.length) return;
    let top = Infinity;
    let innerTop = -Infinity;
    let bottom = -Infinity;
    let innerBottom = Infinity;
    for (const p of this.neckColumns) {
      const a = cat.restY(p.u, p.top);
      const b = cat.restY(p.u, p.bottom);
      top = Math.min(top, a);
      innerTop = Math.max(innerTop, a);
      bottom = Math.max(bottom, b);
      innerBottom = Math.min(innerBottom, b);
    }
    this.topNeck = { side: 1, limit: top, seat: top + 0.6 * (innerTop - top) };
    this.bottomNeck = { side: -1, limit: bottom, seat: bottom + 0.45 * (innerBottom - bottom) };
  }

  near(cat, u, v) {
    const mat = cat.unmap(u, v);
    const U = mat.u;
    const V = mat.v * aspect;
    let best = Infinity;
    let closest = null;
    for (const line of this.lines) {
      const { p, dx, dy, den } = line;
      const t = clamp(((U - p.x) * dx + (V - p.y) * dy) / den);
      const ex = p.x + t * dx - U;
      const ey = p.y + t * dy - V;
      const d = ex * ex + ey * ey;
      if (d < best) {
        best = d;
        closest = line;
      }
    }
    if (!closest) return null;
    let sum = 0, x = 0, y = 0, nx = 0, ny = 0;
    const sigma = 0.014;
    const limit = sigma * sigma * 8;
    for (const l of this.lines) {
      const p = l.p;
      if (Math.abs(p.x - closest.p.x) > 0.065 || Math.abs(p.y - closest.p.y) > 0.065) continue;
      const k = clamp(((U - p.x) * l.dx + (V - p.y) * l.dy) / l.den);
      const ex = p.x + k * l.dx;
      const ey = p.y + k * l.dy;
      const delta = (ex - U) ** 2 + (ey - V) ** 2 - best;
      if (delta > limit) continue;
      const weight = Math.exp(-delta / (2 * sigma * sigma)) * l.length;
      sum += weight;
      x += ex * weight;
      y += ey * weight;
      nx += (p.nx + (l.q.nx - p.nx) * k) * weight;
      ny += (p.ny + (l.q.ny - p.ny) * k) * weight;
    }
    x /= sum;
    y /= sum * aspect;
    const restY = cat.thickness === 1 ? y : cat.restY(x, y);
    if (cat.thickness !== 1) {
      const slope = ((cat.restY(x + 0.001, y) - cat.restY(x - 0.001, y)) * aspect) / 0.002;
      ny /= cat.widthScale(x);
      nx -= slope * ny;
    }
    const norm = Math.hypot(nx, ny) || 1;
    const X = cat.hasMesh ? cat.surface.sample(cat.xy, x, y, 0) : x;
    const Y = cat.hasMesh ? cat.surface.sample(cat.xy, x, y, 1) : restY;
    return {
      u: X,
      v: Y,
      nx: nx / norm,
      ny: ny / norm,
      distance: Math.hypot(u - X, (v - Y) * aspect),
      restDistance: Math.hypot(u - x, (v - restY) * aspect),
      inside: !!mat.zone,
      zone: x < 0.282 ? 'head' : 'back',
    };
  }
}

module.exports = { CoatOutline };
