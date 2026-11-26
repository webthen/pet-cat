const { samplePhotoRgba } = require('./canvas-compat');

const aspect = 935 / 1517;
const photoWidth = 1517;
const stripOrigin = 20;
const halfWidth = 100;
const bandHeight = 50;

const path = [
  [0.749, 0.453], [0.805, 0.470], [0.873, 0.481], [0.921, 0.514], [0.952, 0.576],
  [0.955, 0.646], [0.944, 0.708], [0.918, 0.755], [0.879, 0.786], [0.857, 0.794],
];

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const smooth = (x) => {
  x = clamp(x);
  return x * x * (3 - 2 * x);
};
const smoothRange = (lo, hi, x) => {
  const k = clamp((x - lo) / (hi - lo));
  return k * k * (3 - 2 * k);
};
const approach = (a, b, dt, s) => a + (b - a) * -Math.expm1(-dt / s);
const count = 26;
const angleLimit = Math.PI / 12;
const bell = (x) => Math.exp(-x * x);

function turn(n, goal, rate, dt) {
  const offset = n.angle - goal;
  const speed = n.turnRate + rate * offset;
  const decay = Math.exp(-rate * dt);
  n.angle = goal + (offset + speed * dt) * decay;
  n.turnRate = (n.turnRate - speed * rate * dt) * decay;
}

function skeleton() {
  const arc = [0];
  for (let i = 1; i < path.length; i++) {
    arc.push(arc[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], (path[i][1] - path[i - 1][1]) * aspect));
  }
  const nodes = [];
  let j = 1;
  for (let i = 0; i < count; i++) {
    const at = (arc[arc.length - 1] * i) / (count - 1);
    while (j < path.length - 1 && at > arc[j]) j++;
    const a = path[j - 1];
    const b = path[j];
    const f = (at - arc[j - 1]) / (arc[j] - arc[j - 1]);
    const x = a[0] + (b[0] - a[0]) * f;
    const y = (a[1] + (b[1] - a[1]) * f) * aspect;
    const prev = nodes[i - 1];
    nodes.push({
      x,
      y,
      u: x,
      v: y,
      length: 0,
      arc: prev ? prev.arc + Math.hypot(x - prev.x, y - prev.y) : 0,
      angle: 0,
      rest: 0,
      r: 0.025,
      upperFur: 0.025,
      turnRate: 0,
      widthScale: 1,
      furTravel: 0,
    });
    if (prev) {
      prev.length = Math.hypot(x - prev.x, y - prev.y);
      prev.angle = prev.rest = Math.atan2(y - prev.y, x - prev.x);
    }
  }
  nodes[nodes.length - 1].rest = nodes[nodes.length - 1].angle = nodes[nodes.length - 2].rest;
  return nodes;
}

class CatTail {
  constructor() {
    this.nodes = skeleton();
    this.length = this.nodes[this.nodes.length - 1].arc;
    this.root = this.nodes[0];
    for (const n of this.nodes) {
      const bend = smooth((n.arc / this.length - 0.065) / 0.32);
      n.upperRest = n.rest * (1 - 1.96 * bend);
    }
    this.bendWeight = this.nodes.map((n) => smooth(n.arc / 0.084));
    this.reset();
  }

  reset() {
    this.restsAbove = false;
    this.centers = null;
    this.stroke = null;
    this.amount = 0;
    this.closure = 0;
    this.at = 0.2;
    this.slide = 0;
    this.releaseAge = 4;
    this.releaseAngles = null;
    this.releasePoint = null;
    this.curlDuration = 0;
    this.curlTime = 0;
    for (const n of this.nodes) {
      n.u = n.x;
      n.v = n.y;
      n.angle = n.rest;
      n.turnRate = 0;
      n.widthScale = 1;
      n.furTravel = 0;
    }
  }

  setPhoto(image, maxRadius = 0.041) {
    this.image = image;
    const fullW = image.fullW || image.width;
    const fullH = image.fullH || image.height;
    const w = 171;
    const h = 50;
    const data = samplePhotoRgba(image, w, h);
    const scaleX = w / fullW;
    const scaleY = fullH / h;
    const midY = Math.round(100 / scaleY);
    for (const n of this.nodes) {
      const x = Math.min(w - 1, Math.max(0, Math.round((20 + photoWidth * n.arc) * scaleX)));
      let top = midY;
      let bottom = midY;
      while (top > 0 && data[(top * w + x) * 4 + 3] > 85) top--;
      while (bottom < h - 1 && data[(bottom * w + x) * 4 + 3] > 85) bottom++;
      n.r = clamp(((bottom - top) * scaleY) / (2 * photoWidth), 0.008, maxRadius);
      while (top > 0 && data[(top * w + x) * 4 + 3] > 48) top--;
      n.upperFur = (100 - top * scaleY) / photoWidth;
    }
    return { data, width: w, height: h, fullW, fullH };
  }

  segment(s) {
    const distance = clamp(s) * this.length;
    let i = 0;
    while (i < count - 2 && this.nodes[i + 1].arc < distance) i++;
    return { i, f: clamp((distance - this.nodes[i].arc) / this.nodes[i].length) };
  }

  point(s, seated = false) {
    const { i, f } = this.segment(s);
    const a = this.nodes[i];
    const b = this.nodes[i + 1];
    const line = seated && this.centers ? this.centers : this.nodes;
    const p = line[i];
    const q = line[i + 1];
    const prev = line[Math.max(0, i - 1)];
    const next = line[Math.min(count - 1, i + 2)];
    const ax = q.u - prev.u;
    const ay = q.v - prev.v;
    const bx = next.u - p.u;
    const by = next.v - p.v;
    const wa = (1 - f) / (Math.hypot(ax, ay) || 1);
    const wb = f / (Math.hypot(bx, by) || 1);
    const dx = ax * wa + bx * wb;
    const dy = ay * wa + by * wb;
    const len = Math.hypot(dx, dy) || 1;
    return {
      u: p.u + (q.u - p.u) * f,
      v: (p.v + (q.v - p.v) * f) / aspect,
      tx: dx / len,
      ty: dy / len,
      at: clamp(s),
      ru: a.x + (b.x - a.x) * f,
      rv: (a.y + (b.y - a.y) * f) / aspect,
      radius: a.r + (b.r - a.r) * f,
      upperFur: (1 - f) * a.upperFur * a.widthScale + f * b.upperFur * b.widthScale,
      feltRadius: (1 - f) * a.r * a.widthScale + f * b.r * b.widthScale,
    };
  }

  gripPoint() {
    if (!this.stroke && this.releasePoint) return this.releasePoint;
    const p = this.point(this.at, true);
    if (this.at >= 0.999 && this.stroke) {
      const t = this.stroke;
      const extra = clamp((t.u - p.u) * p.tx + (t.v - p.v * aspect) * p.ty, 0, 0.024);
      p.u += p.tx * extra;
      p.v += (p.ty * extra) / aspect;
    }
    return p;
  }

  closest(u, v, from = 0, to = 1) {
    const center = this.centers ?? this.nodes;
    const start = from * this.length;
    const end = to * this.length;
    let at = 0;
    let distance = Infinity;
    for (let i = 0; i < count - 1; i++) {
      const { arc, length } = this.nodes[i];
      if (arc > end) break;
      if (arc + length < start) continue;
      const a = center[i];
      const b = center[i + 1];
      const dx = b.u - a.u;
      const dy = b.v - a.v;
      const px = u - a.u;
      const py = v * aspect - a.v;
      const f = clamp((px * dx + py * dy) / Math.max(1e-12, dx * dx + dy * dy), Math.max(0, (start - arc) / length), Math.min(1, (end - arc) / length));
      const d = Math.hypot(px - f * dx, py - f * dy);
      if (d < distance) {
        distance = d;
        at = (arc + length * f) / this.length;
      }
    }
    const p = this.point(at, true);
    p.distance = distance;
    p.normal = (u - p.u) * -p.ty + (v - p.v) * aspect * p.tx;
    return p;
  }

  grab(p, hit, fromBody = false) {
    this.releasePoint = null;
    this.releaseAngles = null;
    this.curlDuration = 0;
    const at = hit.at;
    const grip = this.point(at, true);
    const y = grip.v * aspect;
    const dy = (p.v - grip.v) * aspect;
    this.stroke = {
      x: p.u,
      y: p.v * aspect,
      dx: p.u - grip.u,
      dy,
      keepY: fromBody ? dy - clamp(dy, -grip.radius, grip.radius) : 0,
      startX: grip.u,
      startY: y,
      startAt: at,
      farthest: grip.u,
      farthestAt: at,
      angles: this.nodes.map((n) => n.angle),
      u: grip.u,
      v: y,
      handU: grip.u,
      handY: y,
      yaw: 0,
      unwind: 0,
      wantedAt: at,
      pressure: 0.6,
      pastTip: false,
    };
    this.at = at;
    this.slide = 0;
  }

  drag(p, pressure = 0.6) {
    const s = this.stroke;
    if (!s) return;
    const travel = Math.hypot(p.u - s.x, p.v * aspect - s.y);
    const offset = 1 - smooth(travel / 0.042);
    const u = p.u - offset * s.dx;
    const v = p.v * aspect - s.keepY - offset * (s.dy - s.keepY);
    const dx = u - this.root.x;
    const dy = v - this.root.y;
    const yaw = (s.yaw = clamp(Math.atan2(dy, Math.max(0.001, dx)), -angleLimit, angleLimit));
    s.u = u;
    s.v = v;
    s.pressure = pressure;
    if (u < s.farthest && s.farthest > s.startX + 0.0001) {
      const along = (u - s.farthest) / Math.cos(yaw);
      s.wantedAt = clamp(s.farthestAt + along / this.length);
      s.pastTip = false;
      return;
    }
    const pull = u - s.startX;
    const at = s.startAt;
    const active = smooth(pull / (0.048 + 0.074 * (1 - at)));
    const start = this.segment(at);
    const nodes = this.nodes;
    const openedX = (mix) => {
      let x = this.root.x;
      for (let i = 0; i <= start.i; i++) {
        const yawAt = s.angles[i] + (yaw - s.angles[i]) * this.bendWeight[i] * mix;
        x += Math.cos(yawAt) * nodes[i].length * (i === start.i ? start.f : 1);
      }
      return x;
    };
    const extended = openedX(1);
    const tipX = extended + (1 - at) * this.length * Math.cos(yaw);
    s.pastTip = u > tipX + 0.028;
    if (pull < 0) {
      s.wantedAt = clamp(at + pull / this.length);
      s.unwind = 0;
    } else {
      s.unwind = active;
      if (u < extended - 0.0001 && u < openedX(active) - 0.0001) {
        let low = 0;
        let high = active;
        for (let i = 0; i < 11; i++) {
          const mid = (low + high) * 0.5;
          if (openedX(mid) < u) low = mid;
          else high = mid;
        }
        s.unwind = (low + high) * 0.5;
      }
      const feed = Math.max(0, u - openedX(s.unwind)) / (this.length * Math.cos(yaw));
      s.wantedAt = clamp(Math.max(s.farthestAt, at + feed));
    }
    if (s.pastTip) {
      s.wantedAt = 1;
      s.unwind = 1;
    }
    if (u >= s.farthest) {
      s.farthest = Math.min(u, tipX);
      s.farthestAt = s.wantedAt;
    }
  }

  release() {
    if (!this.stroke) return;
    this.releasePoint = this.gripPoint();
    this.releaseAngles = this.nodes.map((n) => n.angle);
    this.releaseAge = 0;
    this.stroke = null;
    this.curlDelay = Math.random() < 0.1 ? 0 : 1.05 + Math.random() * 0.55;
  }

  readyToCurl(dt) {
    return this.releaseAngles && !this.curlDuration && this.releaseAge + dt >= this.curlDelay;
  }

  beginCurl(duration, restsAbove) {
    this.restsAbove = restsAbove;
    this.curlDuration = duration;
    this.curlTime = 0;
  }

  moveGrip(dt) {
    const s = this.stroke;
    const prevAt = this.at;
    this.at = approach(prevAt, s.wantedAt, dt, 0.029 + 0.017 * (1 - this.amount));
    const along = ((this.at - prevAt) * this.length) / dt;
    this.slide = approach(this.slide, clamp(along, -0.85, 0.95), dt, 0.057);
    const x = approach(s.handU, s.u, dt, 0.061);
    const y = approach(s.handY, s.v, dt, 0.061);
    const vx = clamp((x - s.handU) / dt, -1.5, 1.5);
    const vy = clamp((y - s.handY) / dt, -1.5, 1.5);
    s.handU = x;
    s.handY = y;
    const side = 0.24 * Math.tanh((y - s.startY) / 0.042) - 0.048 * this.amount;
    const slip = Math.tanh(this.slide * 4.4);
    const grip = this.segment(this.at);
    let gripY = this.root.y;
    let mobility = 0;
    for (let i = 0; i < count; i++) {
      const n = this.nodes[i];
      const k = n.arc / this.length;
      const offset = (k - this.at) * this.length;
      const before = bell((offset + 0.037) / 0.061);
      const after = bell((offset - 0.05) / 0.071);
      const free = smooth(offset / 0.155);
      const cross = vy * Math.cos(n.angle) - vx * Math.sin(n.angle);
      const give = this.bendWeight[i] * this.amount * (side * (before - 0.78 * after) - 0.31 * free * Math.tanh(2.7 * cross));
      const ahead = smooth((k - s.farthestAt) / 0.44);
      const weight = s.unwind * (1 - 0.94 * ahead) * this.bendWeight[i];
      const curled = s.angles[i] + give;
      const drawn = clamp(s.yaw + give, -angleLimit, angleLimit);
      n.goal = curled + (drawn - curled) * weight;
      const tx = Math.max(0, Math.cos(n.goal));
      n.compliance = (1 - weight) * this.bendWeight[i] * tx * tx * (1 - smooth(offset / 0.105));
      if (i <= grip.i) {
        const span = n.length * (i === grip.i ? grip.f : 1);
        gripY += span * Math.sin(n.goal);
        mobility += span * tx * n.compliance;
      }
      const pad = bell((offset + 0.007 * slip) / 0.044);
      const edge = bell((Math.abs(offset) - 0.065) / 0.025);
      const width = 1 + this.amount * (0.065 * edge - (0.14 + 0.1 * s.pressure) * pad);
      n.widthScale = approach(n.widthScale, width, dt, width < n.widthScale ? 0.043 : 0.13);
      n.furTravel = approach(n.furTravel, 0.0048 * slip * this.amount * (pad + 0.45 * edge), dt, 0.065);
    }
    const tilt = 0.36 * Math.tanh((y - gripY) / (0.36 * (0.035 + mobility)));
    for (const n of this.nodes) {
      const offset = n.arc - this.at * this.length;
      const rate = 67 - 47 * smooth((offset + 0.008) / 0.2) - 17 * smooth((-offset - 0.067) / 0.16);
      turn(n, n.goal + tilt * n.compliance, rate, dt);
    }
  }

  slipped() {
    return this.stroke?.pastTip && this.at > 0.994 && this.nodes[this.nodes.length - 1].u - this.root.x > 0.91 * this.length;
  }

  update(dt, wave) {
    const s = this.stroke;
    const root = this.root;
    this.closure = approach(this.closure, s ? 1 : 0, dt, s ? 0.047 : 0.055);
    this.amount = approach(this.amount, this.closure, dt, s ? 0.061 : 0.073);
    this.releaseAge += dt;
    if (this.curlDuration) this.curlTime += dt;
    if (s) this.moveGrip(dt);
    else {
      this.slide = approach(this.slide, 0, dt, 0.14);
      for (let i = 0; i < count; i++) {
        const n = this.nodes[i];
        const k = n.arc / this.length;
        const target = this.restsAbove ? n.upperRest : n.rest;
        let base = target;
        if (this.releaseAngles) {
          const start = this.releaseAngles[i];
          const progress = this.curlDuration ? smooth((this.curlTime / this.curlDuration - 0.22 * (1 - k)) / 0.78) : 0;
          base = start + (target - start) * progress;
        }
        n.angle = this.releaseAngles && !this.curlDuration ? base : wave(k, base, n.rest);
        n.turnRate = 0;
        n.widthScale = approach(n.widthScale, 1, dt, 0.106);
        n.furTravel = approach(n.furTravel, 0, dt, 0.11);
      }
    }
    if (this.curlDuration && this.curlTime >= this.curlDuration) {
      this.releaseAngles = null;
      this.curlDuration = 0;
    }
    let x = root.x;
    let y = root.y;
    for (let i = 0; i < count; i++) {
      const n = this.nodes[i];
      n.u = x;
      n.v = y;
      if (i === count - 1) {
        n.angle = this.nodes[i - 1].angle;
        break;
      }
      x += Math.cos(n.angle) * n.length;
      y += Math.sin(n.angle) * n.length;
    }
  }
}

function hasInk(pixels, left, top, right, bottom) {
  const x0 = Math.max(0, Math.floor(left) - 3);
  const x1 = Math.min(pixels.width, Math.ceil(right) + 3);
  const y0 = Math.max(0, top - 3);
  const y1 = Math.min(pixels.height, bottom + 3);
  for (let y = y0; y < y1; y++) {
    let alpha = (y * pixels.width + x0) * 4 + 3;
    for (let x = x0; x < x1; x++, alpha += 4) {
      if (pixels.data[alpha]) return true;
    }
  }
  return false;
}

function texture(pixels) {
  const { width, height, data } = pixels;
  const stride = width + 2;
  const texels = new Uint8ClampedArray(4 * stride * (height + 2));
  for (let y = 0; y < height + 2; y++) {
    const row = width * Math.max(0, Math.min(height - 1, y - 1));
    for (let x = 0; x < stride; x++) {
      const s = 4 * (row + Math.max(0, Math.min(width - 1, x - 1)));
      const d = 4 * (y * stride + x);
      const a = data[s + 3];
      texels[d] = (data[s] * a) / 255;
      texels[d + 1] = (data[s + 1] * a) / 255;
      texels[d + 2] = (data[s + 2] * a) / 255;
      texels[d + 3] = a;
    }
  }
  return { texels, stride, height };
}

function rasterTriangle(dst, tex, a, b, c, dpr) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const ex = c.x - a.x;
  const ey = c.y - a.y;
  const det = dx * ey - ex * dy;
  if (Math.abs(det) < 0.00001) return;
  const u = b.s - a.s;
  const v = b.t - a.t;
  const p = c.s - a.s;
  const q = c.t - a.t;
  const ux = (u * ey - p * dy) / det;
  const uy = (p * dx - u * ex) / det;
  const vx = (v * ey - q * dy) / det;
  const vy = (q * dx - v * ex) / det;
  const ab = Math.hypot(dx, dy);
  const ac = Math.hypot(ex, ey);
  const bc = Math.hypot(c.x - b.x, c.y - b.y);
  const per = ab + ac + bc;
  const radius = Math.abs(det) / per;
  const cx = (a.x * bc + b.x * ac + c.x * ab) / per;
  const cy = (a.y * bc + b.y * ac + c.y * ab) / per;
  const pad = Math.min(1.5 * radius, 0.72 * dpr);
  const expand = 1 + (pad + 0.65) / radius;
  const edgeFor = (x, y) => ({ x: cx + (x - cx) * expand, y: cy + (y - cy) * expand });
  let lo = edgeFor(a.x, a.y);
  let mid = edgeFor(b.x, b.y);
  let hi = edgeFor(c.x, c.y);
  const top = Math.max(0, Math.ceil(Math.min(lo.y, mid.y, hi.y) - 0.5));
  const bottom = Math.min(dst.height, Math.ceil(Math.max(lo.y, mid.y, hi.y) - 0.5));
  const flip = Math.sign(det);
  const ax = (-dy / ab) * flip;
  const ay = (dx / ab) * flip;
  const bx = (-(c.y - b.y) / bc) * flip;
  const by = ((c.x - b.x) / bc) * flip;
  const kx = (ey / ac) * flip;
  const ky = (-ex / ac) * flip;
  const leftS = Math.max(0, Math.floor(Math.min(a.s, b.s, c.s)) - 2) + 0.5;
  const rightS = Math.min(tex.stride - 2, Math.ceil(Math.max(a.s, b.s, c.s)) + 2) + 0.5;
  const topT = Math.max(0, Math.floor(Math.min(a.t, b.t, c.t)) - 2) + 0.5;
  const bottomT = Math.min(tex.height, Math.ceil(Math.max(a.t, b.t, c.t)) + 2) + 0.5;
  if (lo.y > mid.y) [lo, mid] = [mid, lo];
  if (mid.y > hi.y) [mid, hi] = [hi, mid];
  if (lo.y > mid.y) [lo, mid] = [mid, lo];
  const long = (hi.x - lo.x) / (hi.y - lo.y);
  const first = mid.y === lo.y ? 0 : (mid.x - lo.x) / (mid.y - lo.y);
  const last = hi.y === mid.y ? 0 : (hi.x - mid.x) / (hi.y - mid.y);
  const { stride, texels } = tex;
  const srcStride = 4 * stride;
  const out = dst.data;
  for (let y = top; y < bottom; y++) {
    const cyRow = y + 0.5;
    const x1 = lo.x + (cyRow - lo.y) * long;
    const x2 = cyRow < mid.y ? lo.x + (cyRow - lo.y) * first : mid.x + (cyRow - mid.y) * last;
    const left = Math.max(0, Math.ceil(Math.min(x1, x2) - 0.5));
    const right = Math.min(dst.width, Math.ceil(Math.max(x1, x2) - 0.5));
    let sx = a.s + 0.5 + (left + 0.5 - a.x) * ux + (cyRow - a.y) * uy;
    let sy = a.t + 0.5 + (left + 0.5 - a.x) * vx + (cyRow - a.y) * vy;
    let f0 = (left + 0.5 - a.x) * ax + (cyRow - a.y) * ay + pad + 0.5;
    let f1 = (left + 0.5 - b.x) * bx + (cyRow - b.y) * by + pad + 0.5;
    let f2 = (left + 0.5 - c.x) * kx + (cyRow - c.y) * ky + pad + 0.5;
    for (let x = left, d = 4 * (y * dst.width + left); x < right; x++, d += 4, sx += ux, sy += vx, f0 += ax, f1 += bx, f2 += kx) {
      if (sx < leftS || sx >= rightS || sy < topT || sy >= bottomT) continue;
      const cover = Math.min(1, f0, f1, f2);
      if (cover <= 0) continue;
      const ix = sx | 0;
      const iy = sy | 0;
      const s = 4 * (iy * stride + ix);
      const h = s + srcStride;
      const fx = sx - ix;
      const fy = sy - iy;
      const tl = (1 - fx) * (1 - fy);
      const tr = fx * (1 - fy);
      const bl = (1 - fx) * fy;
      const br = fx * fy;
      const alpha = cover * (texels[s + 3] * tl + texels[s + 7] * tr + texels[h + 3] * bl + texels[h + 7] * br);
      if (alpha < 0.5) continue;
      const r = texels[s] * tl + texels[s + 4] * tr + texels[h] * bl + texels[h + 4] * br;
      const g = texels[s + 1] * tl + texels[s + 5] * tr + texels[h + 1] * bl + texels[h + 5] * br;
      const bCol = texels[s + 2] * tl + texels[s + 6] * tr + texels[h + 2] * bl + texels[h + 6] * br;
      if (alpha >= 254.5) {
        out[d] = r;
        out[d + 1] = g;
        out[d + 2] = bCol;
        out[d + 3] = 255;
        continue;
      }
      const under = out[d + 3] * (1 - alpha / 255);
      const combined = alpha + under;
      out[d] = (255 * r * cover + under * out[d]) / combined;
      out[d + 1] = (255 * g * cover + under * out[d + 1]) / combined;
      out[d + 2] = (255 * bCol * cover + under * out[d + 2]) / combined;
      out[d + 3] = combined;
    }
  }
}

function drawTriangle(g, photo, a, b, c) {
  const u = b.s - a.s;
  const v = b.t - a.t;
  const p = c.s - a.s;
  const q = c.t - a.t;
  const D = u * q - v * p;
  const X = b.x - a.x;
  const Y = b.y - a.y;
  const Z = c.x - a.x;
  const W = c.y - a.y;
  const m = (X * q - Z * v) / D;
  const n = (Y * q - W * v) / D;
  const h = (Z * u - X * p) / D;
  const k = (W * u - Y * p) / D;
  const ab = Math.hypot(X, Y);
  const ac = Math.hypot(Z, W);
  const bc = Math.hypot(X - Z, Y - W);
  const perimeter = ab + ac + bc;
  if (perimeter < 0.0001) return;
  const cx = (a.x * bc + b.x * ac + c.x * ab) / perimeter;
  const cy = (a.y * bc + b.y * ac + c.y * ab) / perimeter;
  const expand = Math.min(1.5, (0.72 * perimeter) / Math.max(0.01, Math.abs(X * W - Y * Z)));
  g.save();
  g.beginPath();
  for (const pt of [a, b, c]) {
    const dx = (pt.x - cx) * expand;
    const dy = (pt.y - cy) * expand;
    if (pt === a) g.moveTo(pt.x + dx, pt.y + dy);
    else g.lineTo(pt.x + dx, pt.y + dy);
  }
  g.closePath();
  g.clip();
  g.transform(m, n, h, k, a.x - m * a.s - h * a.t, a.y - n * a.s - k * a.t);
  const l = Math.max(0, Math.floor(Math.min(a.s, b.s, c.s)) - 2);
  const t = Math.max(0, Math.min(a.t, b.t, c.t) - 2);
  const w = Math.min(photo.width, Math.ceil(Math.max(a.s, b.s, c.s)) + 2) - l;
  const height = Math.min(photo.height, Math.max(a.t, b.t, c.t) + 2) - t;
  g.drawImage(photo, l, t, w, height, l, t, w, height);
  g.restore();
}

function drawSections(view, tail, socket, visible, draw) {
  const nodes = tail.nodes;
  const photo = tail.image;
  if (!photo) return;
  let previous = null;
  for (let j = -1; j <= nodes.length; j++) {
    const i = Math.max(0, Math.min(nodes.length - 1, j));
    const n = nodes[i];
    const a = nodes[Math.max(0, i - 1)];
    const b = nodes[Math.min(nodes.length - 1, i + 1)];
    const dx = b.u - a.u;
    const dy = b.v - a.v;
    const length = Math.hypot(dx, dy) || 1;
    const tx = dx / length;
    const ty = dy / length;
    const S = stripOrigin + n.arc * photoWidth;
    const s = j < 0 ? 0 : j === nodes.length ? photo.width : S;
    const ext = (s - S) / photoWidth;
    const x = n.u + ext * tx;
    const y = n.v + ext * ty;
    const row = [];
    for (let t = 0; t <= photo.height; t += bandHeight) {
      const across = (t - halfWidth) / photoWidth;
      const d = across * n.widthScale;
      const nap = n.furTravel * Math.min(1, Math.abs(across) / n.r);
      const px = x - d * ty + nap * tx;
      const py = y + d * tx + nap * ty;
      const [u, v] = n.arc < 0.095 ? socket.seat(i, across, ext, px, py) : [px, py];
      row.push({ s, t, x: view.x + u * view.w, y: view.y + v * view.w });
    }
    if (previous) {
      for (let k = 0; k < row.length - 1; k++) {
        if (!visible[j][k]) continue;
        draw(previous[k], row[k], previous[k + 1]);
        draw(previous[k + 1], row[k], row[k + 1]);
      }
    }
    previous = row;
  }
}

class TailPhoto {
  constructor() {
    this.vertBuf = new Float32Array(2048 * 4);
    this.visible = [];
  }

  setSections(pixels, nodes) {
    const { width, height, fullW, fullH } = pixels;
    const edges = [0, ...nodes.map((n) => stripOrigin + n.arc * photoWidth), fullW];
    const sx = width / fullW;
    const sy = height / fullH;
    this.visible = [];
    for (let i = 1; i < edges.length; i++) {
      const bands = [];
      for (let top = 0; top < fullH; top += bandHeight) {
        bands.push(hasInk(pixels, edges[i - 1] * sx, top * sy, edges[i] * sx, (top + bandHeight) * sy));
      }
      this.visible.push(bands);
    }
  }

  renderGL(glRenderer, view, tail, socket, tailTex) {
    const photo = tail.image;
    if (!photo || !tailTex) return;
    const invW = 1 / (photo.fullW || photo.width);
    const invH = 1 / (photo.fullH || photo.height);
    const buf = this.vertBuf;
    let count = 0;
    drawSections(view, tail, socket, this.visible, (a, b, c) => {
      if (count + 12 > buf.length) return;
      buf[count++] = a.x; buf[count++] = a.y; buf[count++] = a.s * invW; buf[count++] = a.t * invH;
      buf[count++] = b.x; buf[count++] = b.y; buf[count++] = b.s * invW; buf[count++] = b.t * invH;
      buf[count++] = c.x; buf[count++] = c.y; buf[count++] = c.s * invW; buf[count++] = c.t * invH;
    });
    if (count > 0) {
      glRenderer.drawTriangles(tailTex, buf, count >> 2, 1, photo.rect || null, 1);
    }
  }
}

function frame(nodes, i, rest, out = {}) {
  const a = nodes[Math.max(0, i - 1)];
  const b = nodes[Math.min(nodes.length - 1, i + 1)];
  const x = rest ? b.x - a.x : b.u - a.u;
  const y = rest ? b.y - a.y : b.v - a.v;
  const inv = 1 / (Math.hypot(x, y) || 1);
  out.x = -y * inv;
  out.y = x * inv;
  return out;
}

function influence(arc, d) {
  const along = smoothRange(0.013, 0.092, arc);
  const edge = smoothRange(0.042, 0.103, Math.abs(d));
  return along * (1 - (1 - along) * edge);
}

class TailSocket {
  constructor(tail, vertices) {
    this.tail = tail;
    const nodes = tail.nodes;
    this.rest = nodes.map((_, i) => frame(nodes, i, true));
    this.normals = nodes.map(() => ({ x: 0, y: 0 }));
    this.raw = new Float32Array(vertices.length * 2);
    this.centers = nodes.map((n) => ({ u: n.u, v: n.v }));
    this.wedge = [];
    for (let j = 0; j < vertices.length; j++) {
      const { x, y } = vertices[j];
      const Y = y * aspect;
      if (x < 0.746 || x > 0.836 || y < 0.275 || y > 0.68) continue;
      let i = 0, f = 0, d = 0, best = Infinity;
      for (let k = 0; k < 8; k++) {
        const a = nodes[k];
        const b = nodes[k + 1];
        const tx = (b.x - a.x) / a.length;
        const ty = (b.y - a.y) / a.length;
        const t = clamp(((x - a.x) * tx + (Y - a.y) * ty) / a.length);
        const rx = x - a.x - (b.x - a.x) * t;
        const ry = Y - a.y - (b.y - a.y) * t;
        const l = rx * rx + ry * ry;
        if (l < best) {
          best = l;
          i = k;
          f = t;
          d = -rx * ty + ry * tx;
        }
      }
      const a = nodes[i];
      const arc = a.arc + f * a.length;
      if (a.arc === 0 && f === 0) continue;
      const w = influence(arc, d);
      if (w < 0.00001) continue;
      this.wedge.push({ j: 2 * j, i, f, d, w, x, y: Y });
    }
  }

  update(surface, xy, light) {
    this.surface = surface;
    this.raw.set(xy);
    this.bound = xy;
    const nodes = this.tail.nodes;
    const R = this.rest;
    const N = this.normals;
    this.tail.centers = this.centers;
    for (let i = 0; i < 9; i++) frame(nodes, i, false, N[i]);
    for (const p of this.wedge) {
      const { j, i, f, d, w } = p;
      const g = 1 - f;
      const a = nodes[i];
      const b = nodes[i + 1];
      const dx = (a.u - a.x) * g + (b.u - b.x) * f + d * ((N[i].x - R[i].x) * g + (N[i + 1].x - R[i + 1].x) * f);
      const dy = (a.v - a.y) * g + (b.v - b.y) * f + d * ((N[i].y - R[i].y) * g + (N[i + 1].y - R[i + 1].y) * f);
      xy[j] += w * (p.x + dx - xy[j]);
      xy[j + 1] += w * ((p.y + dy) / aspect - xy[j + 1]);
      light[j] *= 1 - w;
      light[j + 1] *= 1 - w;
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const p = this.centers[i];
      if (n.arc < 0.095) {
        [p.u, p.v] = this.seat(i, 0, 0, n.u, n.v);
      } else {
        p.u = n.u;
        p.v = n.v;
      }
    }
  }

  seat(i, d, ext, x, y) {
    const a = this.tail.nodes[i];
    const normal = this.rest[i];
    const arc = a.arc + ext;
    const w = influence(arc, d);
    if (w >= 1) return [x, y];
    const u = a.x + ext * normal.y + d * normal.x;
    const v = (a.y - ext * normal.x + d * normal.y) / aspect;
    const bx = this.surface.sample(this.raw, u, v, 0);
    const by = this.surface.sample(this.raw, u, v, 1) * aspect;
    const tx = bx + (x - bx) * w;
    const ty = by + (y - by) * w;
    const away = smoothRange(0.06, 0.088, arc);
    if (away >= 1) return [tx, ty];
    const mx = this.surface.sample(this.bound, u, v, 0);
    const my = this.surface.sample(this.bound, u, v, 1) * aspect;
    return [mx + (tx - mx) * away, my + (ty - my) * away];
  }
}

module.exports = { CatTail, TailPhoto, TailSocket };
