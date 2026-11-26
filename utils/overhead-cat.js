const { createBlurredTintCanvas, downsampleAlpha } = require('./canvas-compat');
const { CoatSurface } = require('./coat-surface');
const { CoatOutline } = require('./coat-outline');
const { CatTail, TailPhoto, TailSocket } = require('./cat-tail');

const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const smooth = (a, b, x) => {
  const f = clamp((x - a) / (b - a));
  return f * f * (3 - 2 * f);
};
const follow = (x, target, dt, tau) => x + (target - x) * -Math.expm1(-dt / tau);
const bell = (x, y) => Math.exp(-x * x - y * y);
const skullAt = (u) => 1 - smooth(0.238, 0.353, u);
const skinTravel = (skull) => 1 - 0.34 * skull;
const spine = 0.48;

function widthWeight(u) {
  const cheeks = 0.15 * smooth(0.11, 0.18, u);
  const neck = 0.4 * smooth(0.212, 0.3, u);
  const shoulders = 0.45 * smooth(0.27, 0.44, u);
  return (cheeks + neck + shoulders) * (1 - smooth(0.56, 0.744, u));
}

const metric = 935 / 1517;
const nx = 60;
const ny = 38;
const longCoats = new Set(['ragdoll', 'siberian', 'norwegian']);

function guardHairFlow(surface, vertices) {
  const { src, sw: w, sh: h } = surface;
  const flow = new Float32Array(vertices.length * 2);
  const step = Math.max(2, Math.round(w * 0.006));
  for (let i = 0; i < vertices.length; i++) {
    const { x: u, y: v, pile } = vertices[i];
    if (!pile) continue;
    const x = Math.round(u * (w - 1));
    const y = Math.round(v * (h - 1));
    if (src[4 * (y * w + x) + 3] < 64) continue;
    let xx = 0, xy = 0, yy = 0;
    for (let j = -2; j <= 2; j++) {
      for (let k = -2; k <= 2; k++) {
        const px = x + k * step;
        const py = y + j * step;
        if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) continue;
        const n = 4 * (py * w + px);
        if (src[n + 3] < 230) continue;
        const dx = src[n + 5] - src[n - 3];
        const dy = src[n + 4 * w + 1] - src[n - 4 * w + 1];
        const weight = 6 - Math.abs(j) - Math.abs(k);
        xx += dx * dx * weight;
        xy += dx * dy * weight;
        yy += dy * dy * weight;
      }
    }
    const side = clamp((v - 0.48) * 2.8, -1, 1);
    const angle = 0.5 * Math.atan2(2 * xy, xx - yy) + Math.PI / 2;
    let tx = Math.cos(angle);
    let ty = Math.sin(angle);
    if (tx + side * ty < 0) {
      tx = -tx;
      ty = -ty;
    }
    const coherence = (0.74 * Math.hypot(xx - yy, 2 * xy)) / (xx + yy + 90);
    tx = 1 + (tx - 1) * coherence;
    ty = side + (ty - side) * coherence;
    const len = Math.hypot(tx, ty);
    tx /= len;
    ty /= len;
    const sweep = Math.sin(11 * u + 28 * v + 1.4 * Math.sin(9 * u - 6 * v));
    const back = -0.011 + 0.0025 * sweep;
    const cross = 0.0045 * sweep;
    flow[2 * i] = back * tx - cross * ty;
    flow[2 * i + 1] = (back * ty + cross * tx) / metric;
  }
  return flow;
}

function spring(s, name, vname, target, dt, hz, damp) {
  const n = Math.max(1, Math.ceil(160 * dt));
  const h = dt / n;
  const w = 2 * Math.PI * hz;
  for (let i = 0; i < n; i++) {
    s[vname] += (w * w * (target - s[name]) - 2 * w * damp * s[vname]) * h;
    s[name] += h * s[vname];
  }
}

function neutral() {
  return {
    x: 0.35, y: 0.47, load: 0, loadV: 0, bulk: 0, bulkV: 0, lift: 0, liftV: 0,
    head: 0, shearX: 0, shearY: 0, shearVX: 0, shearVY: 0, shoulderX: 0, shoulderY: 0,
    axisX: 0.54, axisY: 0.84, length: 0.044, width: 0.06, dirX: 1, dirY: 0,
    glide: 0, pads: [], held: 0, tail: 0, active: false,
  };
}

function swishBeats(count) {
  const beats = [];
  let end = 0;
  for (let i = 0; i < count; i++) {
    const length = (i === 0 ? 1.08 : 0.85) + 0.3 * Math.random();
    const peak = (i === 0 ? 0.9 : i === 1 ? 0.76 : 0.52) + 0.1 * Math.random();
    beats.push({ start: end, length, attack: 0.4 + 0.14 * Math.random(), peak });
    end += length;
  }
  return beats;
}

function swishAt(beats, time) {
  for (const beat of beats) {
    if (time < beat.start) return 0;
    const f = (time - beat.start) / beat.length;
    if (f < 1) return beat.peak * (f < beat.attack ? smooth(0, beat.attack, f) : 1 - smooth(beat.attack, 1, f));
  }
  return 0;
}

class OverheadCat {
  constructor() {
    this.surface = new CoatSurface(null, nx, ny);
    this.tail = new CatTail();
    this.tailPhoto = new TailPhoto();
    this.state = neutral();
    this.time = 0;
    this.thickness = 1;
    this.vertices = [];
    this.xy = new Float32Array(2 * (nx + 1) * (ny + 1));
    this.light = new Float32Array(this.xy.length);
    this.trail = new Float32Array(this.xy.length / 2);
    this.combX = new Float32Array(this.trail.length);
    this.combY = new Float32Array(this.trail.length);
    this.out = new Float64Array(4);
    this.tip = { u: 0.35, v: 0.47, load: 0, lift: 0, depth: 0 };
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        this.vertices.push(this.weights(i / nx, j / ny));
      }
    }
    this.raised = new Float32Array(this.vertices.length);
    this.socket = new TailSocket(this.tail, this.vertices);
    this.reset();
  }

  reset() {
    this.state = neutral();
    this.time = 0;
    this.tip.depth = 0;
    this.hasMesh = false;
    this.trail.fill(0);
    this.combX.fill(0);
    this.combY.fill(0);
    this.raised.fill(0);
    this.tail.reset();
    this.gesture = { age: 0, duration: 0, delay: 0, turn: 0, second: 0, beats: null, count: 0 };
    this.tick(1 / 60, null);
    this.tailPose(1 / 60);
  }

  setCat(body, tailPhoto, key, rasterWidth) {
    const long = (this.longCoat = longCoats.has(key));
    const guards = key === 'norwegian';
    this.surface.setImage(body, rasterWidth, long && !guards, !long);
    this.reset();
    this.combTravel = long ? 0.57 : 0.46;
    this.combRelax = long ? 0.59 : 0.43;
    const { src, sw, sh } = this.surface;
    for (const v of this.vertices) {
      const x = Math.min(sw - 1, Math.floor(v.x * sw));
      const y = Math.min(sh - 1, Math.floor(v.y * sh));
      const bodyPile = 1 - smooth(0.735, 0.812, v.x);
      v.pile = long ? smooth(0.15, 0.29, v.x) * bodyPile : (0.17 + 0.83 * smooth(0.17, 0.34, v.x)) * bodyPile * (1 - Math.max(v.ear1, v.ear2));
      const green = src[4 * (y * sw + x) + 1];
      v.pale = long ? smooth(130, 205, green) : key === 'siam' ? smooth(56, 172, green) : Number(key === 'shiro');
    }
    this.guardFlow = guards ? guardHairFlow(this.surface, this.vertices) : null;
    this.guardBase = guards ? new Float32Array(this.xy.length) : null;
    this.outline = new CoatOutline(this.surface);
    this.outline.fitNeck(this);
    const swShadow = 180;
    const shShadow = Math.round((swShadow * this.surface.sh) / this.surface.sw);
    const shAlpha = downsampleAlpha(this.surface.alpha320, this.surface.sw, this.surface.sh, swShadow, shShadow);
    this.bodyShadow = createBlurredTintCanvas(shAlpha, swShadow, shShadow, 1.4, 0x38, 0x23, 0x16);
    this._gpu = null;

    const tailPixels = this.tail.setPhoto(tailPhoto, long ? 0.064 : 0.041);
    this.tailPhoto.setSections(tailPixels, this.tail.nodes);
    let lo = 0, hi = 0.5;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const p = this.tail.point(mid);
      if (this.restZone(p.u, p.v)) lo = mid;
      else hi = mid;
    }
    this.tailBase = this.tail.point((lo + hi) / 2);
  }

  exportPrepared(key) {
    const pile = new Float32Array(this.vertices.length);
    const pale = new Float32Array(this.vertices.length);
    for (let i = 0; i < this.vertices.length; i++) {
      pile[i] = this.vertices[i].pile;
      pale[i] = this.vertices[i].pale;
    }
    const tailMetrics = this.tail.nodes.map((n) => ({ r: n.r, upperFur: n.upperFur }));
    return {
      key,
      longCoat: this.longCoat,
      combTravel: this.combTravel,
      combRelax: this.combRelax,
      pile,
      pale,
      guardFlow: this.guardFlow,
      guardBase: this.guardBase,
      outline: this.outline,
      bodyShadow: this.bodyShadow,
      tailBase: this.tailBase,
      tailImage: this.tail.image,
      tailMetrics,
      tailVisible: this.tailPhoto.visible,
      surfaceData: {
        img: this.surface.img,
        bodyRect: this.surface.bodyRect,
        src: this.surface.src,
        alpha320: this.surface.alpha320,
        strand: this.surface.strand,
        locks: this.surface.locks,
        hasLocks: this.surface.hasLocks,
        furMap: this.surface.furMap,
      },
      gpu: this._gpu,
    };
  }

  applyPrepared(cache) {
    this.longCoat = cache.longCoat;
    this.combTravel = cache.combTravel;
    this.combRelax = cache.combRelax;
    for (let i = 0; i < this.vertices.length; i++) {
      this.vertices[i].pile = cache.pile[i];
      this.vertices[i].pale = cache.pale[i];
    }
    this.guardFlow = cache.guardFlow;
    this.guardBase = cache.guardBase;
    this.outline = cache.outline;
    this.outline.fitNeck(this);
    this.bodyShadow = cache.bodyShadow;
    this.tailBase = cache.tailBase;
    this.tail.image = cache.tailImage;
    for (let i = 0; i < this.tail.nodes.length; i++) {
      this.tail.nodes[i].r = cache.tailMetrics[i].r;
      this.tail.nodes[i].upperFur = cache.tailMetrics[i].upperFur;
    }
    this.tailPhoto.visible = cache.tailVisible;
    Object.assign(this.surface, cache.surfaceData);
    this._gpu = cache.gpu || null;
    this.reset();
  }

  ensureGPU(glRenderer) {
    if (this._gpu) return this._gpu;
    const s = this.surface;
    const bodyObj = s.img;
    const tailObj = this.tail.image;
    const bodyTex = bodyObj._rgbaData
      ? glRenderer.createTextureFromRGBA(bodyObj._rgbaData, bodyObj.width, bodyObj.height, true)
      : bodyObj.canvas
        ? glRenderer.createTextureFromCanvas(bodyObj.canvas, true)
        : glRenderer.createTextureFromImage(bodyObj.img || bodyObj);
    const tailTex = tailObj._rgbaData
      ? glRenderer.createTextureFromRGBA(tailObj._rgbaData, tailObj.width, tailObj.height, true)
      : tailObj.canvas
        ? glRenderer.createTextureFromCanvas(tailObj.canvas, true)
        : glRenderer.createTextureFromImage(tailObj.img || tailObj);
    const furTex = glRenderer.createTextureFromRawRGBA(s.furMap, s.sw, s.sh);
    const shadowTex = glRenderer.createTextureFromCanvas(this.bodyShadow, true);
    this._gpu = { bodyTex, tailTex, furTex, shadowTex };
    return this._gpu;
  }

  tailBaseX() {
    const p = this.tailBase;
    return this.hasMesh ? this.surface.sample(this.xy, p.u, p.v, 0) : p.u;
  }

  setThickness(ratio) {
    if (!Number.isFinite(ratio)) return;
    const next = clamp(ratio, 0.8, 1.4);
    const delta = next - this.thickness;
    if (!delta) return;
    this.thickness = next;
    this.outline?.fitNeck(this);
    this.surface.inverseIterations = next > 1.22 ? 7 : 3;
    if (this.hasMesh) {
      for (let i = 0; i < this.vertices.length; i++) {
        this.xy[2 * i + 1] += delta * this.vertices[i].spread;
      }
    }
  }

  widthScale(u) {
    return 1 + (this.thickness - 1) * widthWeight(u);
  }

  neckWeight(u) {
    return smooth(0.115, 0.165, u) * (1 - smooth(0.373, 0.455, u));
  }

  restY(u, v) {
    return v + (v - spine) * (this.thickness - 1) * widthWeight(u);
  }

  weights(x, y) {
    const head = (1 - smooth(0.21, 0.365, x)) * (1 - smooth(0.15, 0.24, Math.abs(y - 0.49)));
    const chest = bell((x - 0.365) / 0.167, (y - 0.48) / 0.31);
    const ear1 = bell((x - 0.132) / 0.046, (y - 0.331) / 0.078);
    const ear2 = bell((x - 0.123) / 0.051, (y - 0.608) / 0.056);
    return { x, y, head, chest, ear1, ear2, spread: (y - spine) * widthWeight(x), travel: skinTravel(skullAt(x)) };
  }

  alpha(u, v) {
    if (u < 0 || u >= 1 || v < 0 || v >= 1 || !this.surface.src) return 0;
    const { sw, sh, src } = this.surface;
    return src[4 * ((u * sw) | 0) + 4 * ((v * sh) | 0) * sw + 3];
  }

  restZone(u, v) {
    if (this.alpha(u, v) < 48) return null;
    return u < 0.282 ? 'head' : 'back';
  }

  unmap(u, v) {
    const scale = this.thickness === 1 ? 1 : this.widthScale(u);
    let x = u;
    let y = scale === 1 ? v : spine + (v - spine) / scale;
    if (!this.hasMesh || u < 0 || v < 0 || u > 1 || v > 1) return { u: x, v: y, zone: this.restZone(x, y) };
    for (let i = 0; i < 5; i++) {
      const dx = u - this.surface.sample(this.xy, x, y, 0);
      const dy = v - this.surface.sample(this.xy, x, y, 1);
      x += clamp(dx, -0.045, 0.045);
      y += clamp(dy / scale, -0.07, 0.07);
      if (Math.abs(dx) + Math.abs(dy) < 0.00015) break;
    }
    return { u: x, v: y, zone: this.restZone(x, y) };
  }

  reach(p, margin, upperMargin = margin, bodyOnly = false, upperNeckExtra) {
    if (!this.outline) return null;
    const body = this.unmap(p.u, p.v);
    const neck = this.neckWeight(p.u);
    if (body.zone && (!neck || Math.abs(body.v - spine) < 0.07)) return { u: p.u, v: p.v, zone: body.zone };
    const guide = neck ? this.neckContact(p, margin, upperMargin, upperNeckExtra) : null;
    if (guide && neck === 1) {
      return guide.gap > 0 ? null : { u: p.u, v: guide.v, zone: body.zone ?? (body.u < 0.282 ? 'head' : 'back'), snapped: guide.snapped };
    }
    if (body.zone) return { u: p.u, v: guide ? p.v + neck * (guide.v - p.v) : p.v, zone: body.zone, snapped: guide?.snapped };
    const tail = bodyOnly ? null : this.tail.closest(p.u, p.v);
    const outside = tail ? tail.distance - tail.radius : Infinity;
    if (tail && outside <= 0 && tail.at > 0.08) return { u: p.u, v: p.v, zone: 'tail' };
    const rim = this.outline.near(this, p.u, p.v);
    if (tail && tail.at > 0.08 && outside <= margin && (!rim || outside < rim.distance)) {
      const f = (tail.radius * 0.82) / Math.max(0.0001, tail.distance);
      return { u: tail.u + (p.u - tail.u) * f, v: tail.v + (p.v - tail.v) * f, zone: 'tail', snapped: true };
    }
    if (!rim) return null;
    const above = ((rim.v - p.v) * metric) / Math.max(0.0001, rim.distance);
    const upper = smooth(0.12, 0.78, above) * smooth(0.02, 0.68, rim.ny);
    let gap = Math.min(rim.distance, rim.restDistance) - (margin + (upperMargin - margin) * upper);
    let u = rim.u + rim.nx * 0.0025;
    let v = rim.v + (rim.ny * 0.0025) / metric;
    if (guide) {
      gap += (guide.gap - gap) * neck;
      u += (p.u - u) * neck;
      v += (guide.v - v) * neck;
    }
    return gap > 0 ? null : { u, v, zone: rim.zone, snapped: true };
  }

  neckContact(p, margin, upperMargin, upperNeckExtra = 0) {
    const upper = p.v < spine;
    const edge = upper ? this.outline.topNeck : this.outline.bottomNeck;
    if (!edge) return null;
    const { side, limit, seat } = edge;
    const extra = upper ? upperNeckExtra : 0;
    const reach = (upper ? upperMargin : margin) + 0.55 * margin + extra;
    const outside = (seat - p.v) * side * metric;
    const d = 0.0025 + outside;
    const band = 0.008;
    const push = d <= -band ? 0 : d >= band ? d : ((d + band) ** 2) / (4 * band);
    const glide = extra ? Math.min(extra * 0.16, 0.007, (seat - limit) * metric) * smooth(0, 0.045 + extra, outside) : 0;
    return { v: p.v + (side * (push - glide)) / metric, gap: (limit - p.v) * side * metric - reach, snapped: push > 0 };
  }

  handEdge(u, v, padU, padV) {
    const edge = padV < spine ? this.outline.topNeck : this.outline.bottomNeck;
    const neck = this.neckWeight(padU);
    const blend = edge && neck * (1 - smooth(0.025, 0.067, (padV - edge.seat) * edge.side * metric));
    if (!blend) return this.outline.near(this, u, v);
    let distance = (v - edge.seat) * edge.side * metric;
    let angle = 0;
    if (blend < 1) {
      const rim = this.outline.near(this, u, v);
      if (rim) {
        angle = (1 - blend) * Math.atan2(rim.nx, rim.ny * edge.side);
        distance += (1 - blend) * ((rim.inside ? rim.distance : -rim.distance) - distance);
      }
    }
    return { nx: Math.sin(angle), ny: edge.side * Math.cos(angle), distance: Math.abs(distance), inside: distance >= 0 };
  }

  upperPadDrop(view, pad, pads) {
    const top = this.outline.topNeck;
    if (!top) return 0;
    const neck = this.neckWeight(pad.u) * (1 - smooth(0, 0.045, (pad.v - top.seat) * metric));
    if (!neck) return 0;
    const { sw, sh, src } = this.surface;
    const stride = 4 * sw;
    const inset = Math.max(1, view.w * 0.003);
    let drop = view.w * 0.035;
    for (let i = 0; i < 4; i++) {
      const finger = pads[i];
      const hit = this.unmap((finger.x - view.x) / view.w, (finger.y - inset - view.y) / view.h);
      if (hit.u < 0 || hit.u >= 1) continue;
      const pxPerRow = (view.h * this.widthScale(hit.u)) / sh;
      const y = hit.v * sh;
      const first = Math.floor(y);
      const inside = Math.ceil(inset / pxPerRow);
      const end = Math.min(sh - 1 - inside, Math.ceil(y + drop / pxPerRow));
      const column = 4 * Math.floor(hit.u * sw) + 3;
      for (let row = Math.max(0, first); row <= end; row++) {
        const pixel = row * stride + column;
        if (src[pixel] < 112 || src[pixel + inside * stride] < 112) continue;
        if (row === first) return 0;
        drop = Math.min(drop, (row + 0.5 - y) * pxPerRow);
        break;
      }
    }
    return drop * neck;
  }

  map(u, v) {
    this.move(this.weights(u, v), 0, this.out);
    return [this.out[0], this.out[1]];
  }

  contact(view, pads, pressure, dx, dy, strokeU = (pads[5].x - view.x) / view.w) {
    const soft = view.kitten ? 1 : this.neckWeight(strokeU);
    const points = pads.map((p) => {
      const hit = this.unmap((p.x - view.x) / view.w, (p.y - view.y) / view.h);
      const center = Number(!!hit.zone);
      const coverage = soft ? center + soft * (this.outline.padCoverage(hit.u, hit.v) - center) : center;
      return { ...hit, weight: p.weight, coverage };
    });
    let total = 0, u = 0, v = 0, skull = 0;
    for (const p of points) {
      if (!p.coverage) continue;
      const load = p.weight * p.coverage;
      total += load;
      u += load * p.u;
      v += load * p.v;
      skull += load * skullAt(p.u);
    }
    if (total < 0.04) return null;
    const palm = points[5];
    const middle = points[1];
    const ring = points[2];
    const ax = palm.u - (middle.u + ring.u) * 0.5;
    const ay = (palm.v - (middle.v + ring.v) * 0.5) * metric;
    const dist = Math.max(0.01, Math.hypot(ax, ay));
    const span = Math.hypot(points[3].u - points[0].u, (points[3].v - points[0].v) * metric);
    const onFur = points.filter((p) => p.coverage > 0.001);
    const zone = palm.zone ?? (soft ? (u / total < 0.282 ? 'head' : 'back') : onFur[0].zone);
    return {
      u: u / total,
      v: v / total,
      skull: skull / total,
      pressure: pressure * Math.sqrt(total),
      dx,
      dy,
      pads: onFur,
      zone,
      axisX: ax / dist,
      axisY: ay / dist,
      length: clamp(dist * 0.51, 0.03, 0.066),
      width: clamp(span * 0.43, 0.035, 0.079),
    };
  }

  tick(dt, input, quiet) {
    const s = this.state;
    const p = input ? clamp(input.pressure || 0) : 0;
    const active = p > 0.025;
    const zone = active ? input.zone : null;
    const skull = active && zone !== 'tail' ? (input.skull ?? skullAt(input.u)) : 0;
    const compliance = 1 - 0.34 * skull;
    const dragTransfer = zone === 'tail' ? 0.16 : compliance;
    let pullX = 0, pullY = 0;
    if (active) {
      s.held += dt;
      s.x = input.u;
      s.y = input.v;
      s.axisX = input.axisX;
      s.axisY = input.axisY;
      s.length = input.length;
      s.width = input.width;
      s.pads = input.pads;
      const vx = clamp(input.dx, -0.9, 0.9);
      const vy = clamp(input.dy * metric, -0.9, 0.9);
      const speed = Math.hypot(vx, vy);
      const moving = Math.tanh(6.6 * speed);
      if (speed > 0.006) {
        s.dirX = vx / speed;
        s.dirY = vy / speed;
      }
      s.glide = follow(s.glide, moving, dt, 0.032);
      pullX = 0.048 * moving * s.dirX * p * dragTransfer;
      pullY = (0.048 * moving * s.dirY * p * dragTransfer) / metric;
      s.tail = follow(s.tail, zone === 'tail' ? p : 0, dt, 0.09);
    } else {
      s.held = 0;
      s.glide = follow(s.glide, 0, dt, 0.13);
      s.tail = follow(s.tail, 0, dt, 0.19);
    }
    spring(s, 'shearX', 'shearVX', pullX, dt, 7.2, 0.78);
    spring(s, 'shearY', 'shearVY', pullY, dt, 7.2, 0.78);
    const shoulder = zone === 'tail' ? 0 : 1;
    s.shoulderX = follow(s.shoulderX, pullX * 0.42 * shoulder, dt, 0.15);
    s.shoulderY = follow(s.shoulderY, pullY * 0.38 * shoulder, dt, 0.17);
    s.active = active;
    s.head = follow(s.head, p * skull, dt, active ? 0.095 : 0.36);
    const catLoad = zone === 'tail' ? 0.38 : compliance;
    spring(s, 'load', 'loadV', catLoad * (0.77 * Math.pow(p, 0.75) + 0.23 * smooth(0.56, 1, p)), dt, 6.8, 0.8);
    spring(s, 'bulk', 'bulkV', catLoad * p, dt, 3.8, 0.86);
    spring(s, 'lift', 'liftV', active ? catLoad * smooth(0.14, 0.62, s.held) * Math.sqrt(p) : 0, dt, 3.4, 0.85);
    this.time += dt * (quiet ? 0.45 : 1);
    const t = this.time;
    s.breath = Math.sin(t * 1.66 - 0.22) + 0.115 * Math.sin(t * 3.32 - 0.51);
    const flick = Math.max(0, Math.sin(t * 1.018 - 0.71)) ** 36;
    s.earTurn1 = 0.2 * flick + 0.18 * s.head * bell((s.x - 0.132) / 0.067, (s.y - 0.33) / 0.11);
    s.earTurn2 = -0.15 * Math.max(0, Math.sin(t * 0.94 - 1.11)) ** 38 - 0.15 * s.head * bell((s.x - 0.123) / 0.07, (s.y - 0.61) / 0.1);
    s.headAngle = 0.044 * s.head * clamp((s.y - 0.486) / 0.104, -1, 1) + s.shoulderY * 0.67 + 0.004 * s.breath;
    s.headC = Math.cos(s.headAngle) - 1;
    s.headS = Math.sin(s.headAngle);
    const grainY = clamp((s.y - 0.47) * 2.1, -0.46, 0.46);
    const withGrain = s.dirX + s.dirY * grainY;
    s.nap = s.glide * clamp(withGrain + 0.67 * s.dirY * (1 - Math.abs(s.dirX)), -1, 1);
  }

  tailMoving(dt) {
    const t = this.tail;
    const g = this.gesture;
    if (t.releaseAngles) return t.curlDuration > 0 || t.readyToCurl(dt);
    return g.age < g.duration + g.delay;
  }

  tailPose(dt, quiet = false) {
    const tail = this.tail;
    const g = this.gesture;
    if (tail.readyToCurl(dt)) {
      const immediate = tail.curlDelay === 0;
      g.count++;
      g.age = 0;
      g.beats = null;
      if (immediate) {
        const beatCount = Math.random() < 0.24 ? 3 : 2;
        g.beats = swishBeats(beatCount);
        const last = g.beats[g.beats.length - 1];
        g.duration = last.start + last.length;
        g.delay = 0.12 + 0.07 * Math.random();
      } else {
        const seed = Math.random();
        const sign = Math.random() < 0.32 ? -0.43 : 1;
        g.duration = 1.44 + 0.88 * seed;
        g.delay = 0.33;
        g.turn = sign * (0.19 + 0.1 * seed + 0.17 * this.state.load);
        g.second = -sign * (0.036 + 0.048 * seed);
      }
      tail.beginCurl(immediate ? 1.3 : g.duration, immediate ? tail.restsAbove : Math.random() < 0.5);
    }
    if (g.age < g.duration + g.delay) g.age += dt * (quiet && !g.beats ? 0.45 : 1);
    tail.update(dt, (k, base, rest) => {
      const age = g.age - k * g.delay;
      if (age <= 0 || age >= g.duration) return base;
      if (g.beats) {
        const lift = swishAt(g.beats, age) * smooth(0.025, 0.34, k);
        const opposite = (tail.restsAbove ? 1 : -1) * (0.24 + (0.61 + 0.15 * k) * rest);
        return base + (opposite - base) * lift;
      }
      const f = clamp(age / g.duration);
      const wave = Math.sin(f * Math.PI) ** 2;
      const turn = (g.turn + g.second * Math.sin(f * 2 * Math.PI) + 0.1 * this.state.tail) * wave;
      return base + (tail.restsAbove ? -turn : turn) * smooth(0.015, 0.945, k);
    });
  }

  move(v, trail, out) {
    const s = this.state;
    const rx = v.x - 0.269;
    const ry = (v.y - 0.484) * metric;
    let dx = v.head * (rx * s.headC - ry * s.headS - 0.0015 * s.head);
    let dy = v.head * ((rx * s.headS + ry * s.headC) / metric - 0.0014 * s.head);
    dx += (v.ear1 * (0.406 - v.y) * s.earTurn1 + v.ear2 * (0.552 - v.y) * s.earTurn2) * metric;
    dy += (v.ear1 * (v.x - 0.171) * s.earTurn1 + v.ear2 * (v.x - 0.161) * s.earTurn2) / metric;
    dy += (v.y - 0.48) * v.chest * s.breath * 0.023;
    dx += (v.x - 0.44) * v.chest * s.breath * 0.007;
    const tissue = v.chest;
    dx += v.travel * tissue * s.shoulderX * (0.42 + 0.58 * v.head);
    dy += v.travel * tissue * s.shoulderY * (0.47 + 0.53 * v.head);
    let shade = 0.018 * v.chest * s.breath;
    let nap = trail;
    if ((s.load > 0.001 || s.lift > 0.001) && Math.abs(v.x - s.x) < 0.3 && Math.abs(v.y - s.y) < 0.47) {
      const x = v.x - s.x;
      const y = (v.y - s.y) * metric;
      const along = x * s.axisX + y * s.axisY;
      const across = -x * s.axisY + y * s.axisX;
      const a = along / (s.length + 0.045);
      const b = across / (s.width + 0.018);
      const patch = bell(a, b);
      const broad = bell(along / 0.162, across / 0.136);
      const front = x * s.dirX + y * s.dirY;
      const side = -x * s.dirY + y * s.dirX;
      const bank = s.glide * bell((front - 0.068) / 0.04, side / (s.width + 0.02));
      let fingers = 0;
      if (Math.abs(x) < 0.13 && Math.abs(y) < 0.12) {
        for (const p of s.pads) {
          const fx = v.x - p.u;
          const fy = (v.y - p.v) * metric;
          const r = p.weight > 0.3 ? 0.049 : 0.023;
          if (Math.abs(fx) > r * 2 || Math.abs(fy) > r * 2) continue;
          fingers = Math.max(fingers, p.coverage * bell(fx / r, fy / r));
        }
      }
      const compression = 0.65 * patch + 0.35 * fingers;
      const grip = 0.8 * patch + 0.24 * fingers + 0.47 * bank;
      const shoulder = broad * (1 - compression);
      const pressX = grip * s.shearX + compression * s.load * (-0.003 - 0.15 * x) + 0.003 * broad * s.lift + shoulder * s.bulk * 0.11 * x;
      const pressY =
        grip * s.shearY +
        compression * s.load * (0.042 - (0.21 * y) / metric) +
        broad * (0.009 * s.bulk - 0.014 * s.lift) +
        (shoulder * s.bulk * 0.1 * y) / metric;
      dx += v.travel * pressX;
      dy += v.travel * pressY;
      const lightSide = clamp((-0.8 * x - 0.6 * y) / 0.078, -1.1, 1.1);
      shade += s.load * (patch * (-0.15 - 0.29 * lightSide) - 0.072 * fingers + shoulder * 0.105 * lightSide + bank * (0.23 + 0.16 * lightSide));
      nap += patch * s.nap * 0.34 + 0.15 * bank;
    }
    if (v.pale) {
      const limit = shade > 0 ? 0.26 / (1 + 4 * shade) : 0.47;
      shade *= 1 + v.pale * (limit - 1);
      nap *= 1 - 0.7 * v.pale;
    }
    out[0] = v.x + dx;
    out[1] = v.y + (this.thickness - 1) * v.spread + dy;
    out[2] = shade;
    out[3] = nap;
  }

  draw(view, input, dt = 1 / 60) {
    if (!this.surface.img) return this.tip;
    dt = clamp(Number.isFinite(dt) ? dt : 1 / 60, 0.0001, 0.075);
    this.tick(dt, input, view.reduced);
    this.tailPose(dt, view.reduced);
    const s = this.state;
    const fade = Math.exp(-dt / 0.84);
    const relax = Math.exp(-dt / this.combRelax);
    const o = this.out;
    const deposit = -Math.expm1(-dt * (13 + 15 * s.glide));
    const settling = Math.exp(-dt / (this.longCoat ? 1.95 : 0.92));
    const bodyStroke = input && input.zone !== 'tail';
    const grainY = clamp((s.y - 0.48) * 3.5, -1, 1);
    const grainLen = Math.hypot(0.83, grainY);
    const alongGrain = (0.83 * s.dirX + grainY * s.dirY) / grainLen;
    const crossGrain = (0.83 * s.dirY - grainY * s.dirX) / grainLen;
    const acrossWeight = this.longCoat ? 0.47 : 0.18;
    const upset = s.load * s.glide * clamp(-1.36 * alongGrain + acrossWeight * Math.abs(crossGrain), 0, 1);
    const grooming = -Math.expm1(-dt * (20 + 18 * Math.max(0, alongGrain)) * s.glide);
    let hasRaised = this.longCoat;
    for (let i = 0; i < this.vertices.length; i++) {
      const v = this.vertices[i];
      const x = v.x - s.x;
      const y = (v.y - s.y) * metric;
      let raised = this.raised[i] * settling;
      let nap = this.trail[i] * fade;
      let cx = this.combX[i] * relax;
      let cy = this.combY[i] * relax;
      if (s.active && s.glide > 0.035 && Math.abs(x) < 0.2 && Math.abs(y) < 0.18) {
        const a = (x * s.axisX + y * s.axisY) / (s.length + 0.02);
        const b = (-x * s.axisY + y * s.axisX) / (s.width + 0.014);
        const mark = bell(a, b);
        const set = deposit * mark;
        if (!this.longCoat && bodyStroke) {
          raised += (upset * v.pile - raised) * mark * grooming;
        } else if (v.pile && bodyStroke) {
          let fingers = 0;
          for (const pad of s.pads) {
            if (pad.weight > 0.3) continue;
            const px = (v.x - pad.u) / 0.026;
            const py = ((v.y - pad.v) * metric) / 0.026;
            if (Math.abs(px) < 2 && Math.abs(py) < 2) fingers = Math.max(fingers, pad.coverage * bell(px, py));
          }
          const contact = Math.max(0.48 * mark, fingers);
          raised += (upset * v.pile - raised) * contact * grooming;
        }
        nap += (s.nap * s.load * 1.65 - nap) * set;
        cx += (s.shearX * this.combTravel - cx) * set;
        cy += (s.shearY * this.combTravel - cy) * set;
      }
      this.raised[i] = raised;
      if (raised > 0.001) hasRaised = true;
      this.trail[i] = nap;
      this.combX[i] = cx;
      this.combY[i] = cy;
      this.move(v, nap, o);
      const j = i * 2;
      this.xy[j] = o[0] + v.travel * cx;
      this.xy[j + 1] = o[1] + v.travel * cy;
      this.light[j] = o[2];
      this.light[j + 1] = o[3];
    }
    if (this.guardFlow) {
      this.guardBase.set(this.xy);
      for (let i = 0; i < this.raised.length; i++) {
        const amount = this.raised[i];
        if (amount < 0.001) continue;
        const j = 2 * i;
        const v = this.vertices[i];
        const x = v.x + amount * this.guardFlow[j];
        const y = v.y + amount * this.guardFlow[j + 1];
        this.xy[j] = this.surface.sample(this.guardBase, x, y, 0);
        this.xy[j + 1] = this.surface.sample(this.guardBase, x, y, 1);
      }
    }
    this.socket.update(this.surface, this.xy, this.light);
    this.hasMesh = true;
    this.lastHasRaised = hasRaised;
    this.move(this.weights(input?.u ?? s.x, input?.v ?? s.y), 0, o);
    const tip = this.tip;
    tip.u = o[0];
    tip.v = o[1];
    tip.load = clamp(s.load);
    tip.lift = clamp(s.lift);
    tip.depth = skinTravel(skullAt(s.x)) * Math.max(0, 0.042 * s.load + 0.009 * s.bulk - 0.014 * s.lift) * (view.h ?? view.height);
    return tip;
  }

  renderGL(glRenderer, view) {
    if (!this.surface.img) return;
    if (!glRenderer.catIdxCount) glRenderer.setCatIndices(this.surface.idx);
    const gpu = this.ensureGPU(glRenderer);
    if (gpu.shadowTex) {
      const sy = 1 + (this.thickness - 1) * 0.55;
      const sx = view.x + view.w * 0.0018;
      const syOffset = view.y + 0.48 * view.h * (1 - sy) + view.h * 0.007;
      glRenderer.drawQuad(gpu.shadowTex, sx, syOffset, view.w, view.h * sy, 0.29);
    }
    this.tailPhoto.renderGL(glRenderer, view, this.tail, this.socket, gpu.tailTex);
    const verts = this.surface.buildMesh(view, this.xy, this.light, this.raised, this.lastHasRaised);
    glRenderer.drawCatBody(
      gpu.bodyTex,
      gpu.furTex,
      this.surface.bodyRect,
      0.03,
      0.03 * (1517 / 935),
      this.surface.hasLocks,
      verts
    );
  }
}

module.exports = { OverheadCat };
