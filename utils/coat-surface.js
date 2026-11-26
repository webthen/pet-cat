const { samplePhotoRgba } = require('./canvas-compat');

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const napFactor = new Float64Array(512);
for (let i = 0; i < 256; i++) {
  const fibre = i / 127.5 - 1;
  napFactor[i] = -6.885 + 3.06 + 8.16 * fibre;
  napFactor[256 + i] = -6.885 - 3.06 - 8.16 * fibre - 3.825 * Math.max(fibre, 0);
}

const surfaceTile = 12;

function alphaCoverage(pixels, width, height) {
  const cols = Math.ceil(width / surfaceTile);
  const rows = Math.ceil(height / surfaceTile);
  const stride = cols + 1;
  const visible = new Uint32Array(stride * (rows + 1));
  const translucent = new Uint32Array(visible.length);
  for (let row = 0; row < rows; row++) {
    let visibleCount = 0;
    let translucentCount = 0;
    for (let col = 0; col < cols; col++) {
      const left = col * surfaceTile;
      const right = Math.min(left + surfaceTile, width);
      const top = row * surfaceTile;
      const bottom = Math.min(top + surfaceTile, height);
      let min = 255;
      let max = 0;
      for (let y = top; y < bottom && (min === 255 || max <= 1); y++) {
        for (let n = 4 * (y * width + left) + 3, end = 4 * (y * width + right); n < end; n += 4) {
          min = Math.min(min, pixels[n]);
          max = Math.max(max, pixels[n]);
        }
      }
      const i = (row + 1) * stride + col + 1;
      if (max > 1) visibleCount++;
      if (min < 255) translucentCount++;
      visible[i] = visible[i - stride] + visibleCount;
      translucent[i] = translucent[i - stride] + translucentCount;
    }
  }
  return { visible, translucent, stride, cols, rows };
}

function coverageAt(map, left, top, right, bottom) {
  const { visible, translucent, stride, cols, rows } = map;
  const x = clamp(Math.floor((left - 2) / surfaceTile), 0, cols);
  const X = clamp(Math.ceil((right + 2) / surfaceTile), 0, cols);
  const y = clamp(Math.floor((top - 2) / surfaceTile), 0, rows) * stride;
  const Y = clamp(Math.ceil((bottom + 2) / surfaceTile), 0, rows) * stride;
  if (visible[Y + X] - visible[y + X] - visible[Y + x] + visible[y + x] === 0) return 0;
  return translucent[Y + X] - translucent[y + X] - translucent[Y + x] + translucent[y + x] === 0 ? 255 : 1;
}

function sampleChannel(src, top, bottom, fx, fy) {
  const a = src[top] + (src[top + 4] - src[top]) * fx;
  const b = src[bottom] + (src[bottom + 4] - src[bottom]) * fx;
  return a + (b - a) * fy;
}

function surfaceGrid(cols, rows) {
  const uv = new Float32Array((cols + 1) * (rows + 1) * 2);
  const idx = new Uint16Array(cols * rows * 6);
  let k = 0;
  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x <= cols; x++) {
      const n = y * (cols + 1) + x;
      uv[n * 2] = x / cols;
      uv[n * 2 + 1] = y / rows;
      if (y < rows && x < cols) {
        idx.set([n, n + 1, n + cols + 1, n + 1, n + cols + 2, n + cols + 1], k);
        k += 6;
      }
    }
  }
  return { uv, idx };
}

function lockTexture(data, luma, strand, w, h) {
  const map = new Uint8Array(w * h * 4);
  const weight = new Uint16Array(w * h);
  const underfur = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    map[i * 4] = strand[i];
    map[i * 4 + 1] = map[i * 4 + 2] = map[i * 4 + 3] = 128;
  }
  let seed = 873713;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const scale = w / 970;
  const step = 12 * scale;
  for (let row = step; row < h - step; row += step * 0.63) {
    for (let col = step; col < w - step; col += step) {
      const x = Math.round(col + (random() - 0.5) * step);
      const y = Math.round(row + (random() - 0.5) * step * 0.7);
      if (data[4 * (y * w + x) + 3] < 160) continue;
      const side = clamp((y / h - 0.48) * 3.5, -1, 1);
      const angle = Math.atan2(side, 0.83);
      const gx = Math.cos(angle);
      const gy = Math.sin(angle);
      let xx = 0, xy = 0, yy = 0;
      for (let j = -6; j <= 6; j += 3) {
        for (let i = -6; i <= 6; i += 3) {
          const n = (y + j) * w + x + i;
          if (data[4 * n + 3] < 240) continue;
          const dx = luma[n + 1] - luma[n - 1];
          const dy = luma[n + w] - luma[n - w];
          xx += dx * dx;
          xy += dx * dy;
          yy += dy * dy;
        }
      }
      const grain = 0.5 * Math.atan2(2 * xy, xx - yy) + Math.PI / 2;
      const coherence = Math.min(0.85, Math.hypot(xx - yy, 2 * xy) / (xx + yy + 75));
      let tx = Math.cos(grain);
      let ty = Math.sin(grain);
      if (tx * gx + ty * gy < 0) {
        tx = -tx;
        ty = -ty;
      }
      tx = gx * (1 - coherence) + tx * coherence;
      ty = gy * (1 - coherence) + ty * coherence;
      const norm = Math.hypot(tx, ty);
      tx /= norm;
      ty /= norm;
      const deep = random() < 0.17;
      const length = (12 + 15 * random() + (deep ? 15 : 0)) * scale;
      const width = (2.1 + 4.2 * random() + (deep ? 3 : 0)) * scale;
      const lean = (random() - 0.5) * 1.4;
      const travel = 0.52 + 0.44 * random();
      const endX = x + length * tx;
      const endY = y + length * ty;
      const pad = Math.ceil(2 * width + 1);
      const top = Math.max(0, Math.floor(Math.min(y, endY)) - pad);
      const bottom = Math.min(h - 1, Math.ceil(Math.max(y, endY)) + pad);
      const left = Math.max(0, Math.floor(Math.min(x, endX)) - pad);
      const right = Math.min(w - 1, Math.ceil(Math.max(x, endX)) + pad);
      for (let py = top; py <= bottom; py++) {
        for (let px = left; px <= right; px++) {
          const dx = px - x;
          const dy = py - y;
          const t = (dx * tx + dy * ty) / length;
          if (t <= 0 || t >= 1) continue;
          const bow = t * (1 - t) * 4;
          const cross = (-dx * ty + dy * tx) / width - lean * bow;
          const envelope = clamp(1 - Math.abs(cross) / (0.45 + 0.69 * bow), 0, 1);
          const lift = t * (2 - t) * Math.min(1, (1 - t) * 5) * envelope * envelope * (3 - 2 * envelope);
          const n = py * w + px;
          const coverage = Math.round(255 * lift * lift);
          if (deep && envelope > 0) {
            const fold = t - 0.46 - 0.15 * cross * cross;
            const along = Math.max(0, 1 - (fold * fold) / 0.082);
            const edge = cross + (lean < 0 ? -0.26 : 0.26);
            const across = Math.max(0, 1 - (edge * edge) / 0.63);
            const shade = along * along * across * across;
            if (shade) underfur[n] = Math.max(underfur[n], Math.round(109 * shade * envelope));
          }
          if (!coverage) continue;
          weight[n] += coverage;
          const mix = coverage / weight[n];
          const k = 4 * n;
          const forward = lift * travel;
          const splay = forward * (lean * 1.36 + cross * 0.25);
          const ux = 128 + 124 * clamp(forward * tx - splay * ty, -1, 1);
          const uy = 128 + 124 * clamp(forward * ty + splay * tx, -1, 1);
          map[k + 1] = Math.round(map[k + 1] + (ux - map[k + 1]) * mix);
          map[k + 2] = Math.round(map[k + 2] + (uy - map[k + 2]) * mix);
          const ridge = 128 + 90 * lift * (0.22 - 1.42 * cross);
          map[k + 3] = Math.round(map[k + 3] + (ridge - map[k + 3]) * mix);
        }
      }
    }
  }
  for (let n = 0; n < underfur.length; n++) {
    if (underfur[n]) map[4 * n + 3] = Math.max(0, map[4 * n + 3] - underfur[n]);
  }
  return map;
}

function shortCoatTexture(data, luma, strand, w, h) {
  const map = new Uint8Array(4 * w * h);
  const radius = Math.max(1, Math.round(w * 0.003));
  const border = 2 * radius + 2;
  for (let y = 0; y < h; y++) {
    const side = clamp((y / h - 0.48) * 3.5, -1, 1);
    const length = Math.hypot(0.83, side);
    const tx = 0.83 / length;
    const ty = side / length;
    const along = Math.round(radius * tx) + w * Math.round(radius * ty);
    const cross = Math.round(-radius * ty) + w * Math.round(radius * tx);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const k = 4 * i;
      map[k] = strand[i];
      map[k + 1] = map[k + 2] = map[k + 3] = 128;
      if (x < border || x >= w - border || y < border || y >= h - border || data[k + 3] < 240) continue;
      if (
        data[(i + along) * 4 + 3] < 240 ||
        data[(i - along) * 4 + 3] < 240 ||
        data[(i + cross) * 4 + 3] < 240 ||
        data[(i - cross) * 4 + 3] < 240
      ) continue;
      const core = (2 * luma[i] + luma[i - along] + luma[i + along]) * 0.25;
      const left = (2 * luma[i - cross] + luma[i - cross - along] + luma[i - cross + along]) * 0.25;
      const right = (2 * luma[i + cross] + luma[i + cross - along] + luma[i + cross + along]) * 0.25;
      const range = 8 + 0.06 * core;
      const crest = clamp((core - 0.5 * (left + right)) / range, -1, 1);
      const slope = clamp((left - right) / (2 * range), -1, 1);
      const travel = 21 + 11 * crest;
      const splay = 8 * slope;
      map[k + 1] = Math.round(128 + travel * tx - splay * ty);
      map[k + 2] = Math.round(128 + travel * ty + splay * tx);
      const shade = 38 * crest + 12 * slope - 14;
      map[k + 3] = Math.round(128 + shade * (1 - 0.75 * clamp((core - 110) / 95, 0, 1)));
    }
  }
  return map;
}

class CoatSurface {
  constructor(canvas, cols, rows) {
    this.canvas = canvas;
    this.cols = cols;
    this.rows = rows;
    this.inverseIterations = 3;
    Object.assign(this, surfaceGrid(cols, rows));
    this.meshVerts = new Float32Array((cols + 1) * (rows + 1) * 7);
    this.sw = 320;
    this.sh = Math.round((320 * 935) / 1517);
  }

  setImage(photoSpec, rasterWidth, longCoat, shortCoat = false) {
    this.img = photoSpec;
    this.bodyRect = photoSpec.rect || [0, 0, 1, 1];
    this.stillFrame = null;
    const w = this.sw;
    const h = this.sh;
    const data = (this.src = samplePhotoRgba(photoSpec, w, h));
    const len = w * h;
    const alpha = (this.alpha320 = new Uint8ClampedArray(len));
    const strand = (this.strand = new Uint8Array(len));
    const luma = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      const byte = i * 4;
      alpha[i] = data[byte + 3];
      luma[i] = (2 * data[byte] + 5 * data[byte + 1] + data[byte + 2]) * 0.125;
    }
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const a = luma[i - w - 1];
        const b = luma[i + w + 1];
        const c = luma[i];
        strand[i] = 128 + 127 * clamp((2.1 * (c - 0.5 * (a + b)) + 0.65 * (b - a)) / (13 + 0.095 * c), -1, 1);
      }
    }
    if (shortCoat) this.locks = shortCoatTexture(data, luma, strand, w, h);
    else this.locks = longCoat ? lockTexture(data, luma, strand, w, h) : null;
    this.hasLocks = Boolean(this.locks);
    if (this.locks) {
      this.furMap = this.locks instanceof Uint8Array ? this.locks : new Uint8Array(this.locks);
    } else {
      const fur = new Uint8Array(4 * len);
      for (let i = 0, p = 0; i < len; i++, p += 4) {
        fur[p] = strand[i];
        fur[p + 1] = 128;
        fur[p + 2] = 128;
        fur[p + 3] = 128;
      }
      this.furMap = fur;
    }
    this.bodyTex = null;
    this.furTex = null;
  }

  buildMesh(view, xy, light, lift, hasRaised = true) {
    const { x = 0, y = 0, w = view.width, h = view.height } = view;
    const verts = this.meshVerts;
    const uv = this.uv;
    const count = lift.length;
    for (let i = 0; i < count; i++) {
      const j = i * 2;
      const o = i * 7;
      verts[o] = x + xy[j] * w;
      verts[o + 1] = y + xy[j + 1] * h;
      verts[o + 2] = uv[j];
      verts[o + 3] = uv[j + 1];
      verts[o + 4] = light[j];
      verts[o + 5] = light[j + 1];
      verts[o + 6] = hasRaised ? lift[i] : 0;
    }
    return verts;
  }

  sample(data, u, v, k, stride = 2) {
    const gx = clamp(u * this.cols, 0, this.cols - 0.00001);
    const gy = clamp(v * this.rows, 0, this.rows - 0.00001);
    const x = gx | 0;
    const y = gy | 0;
    const fx = gx - x;
    const fy = gy - y;
    const a = stride * (y * (this.cols + 1) + x) + k;
    const b = a + stride * (this.cols + 1);
    const t = data[a] + (data[a + stride] - data[a]) * fx;
    const bot = data[b] + (data[b + stride] - data[b]) * fx;
    return t + (bot - t) * fy;
  }
}

module.exports = { CoatSurface };
