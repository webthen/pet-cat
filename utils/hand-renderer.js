const { createOffscreen, tintBlurIntoCanvas, createBlurredTintCanvas } = require('./canvas-compat');

function sleeveReach(hand, view, left, right) {
  const a = new Float64Array(2);
  const b = new Float64Array(2);
  hand.point(left, 1535, a);
  hand.point(right, 1535, b);
  if (Math.max(a[0], b[0]) < 0 || Math.min(a[0], b[0]) > view.width) return 0;
  let minY = Infinity;
  if (a[0] >= 0 && a[0] <= view.width) minY = a[1];
  if (b[0] >= 0 && b[0] <= view.width) minY = Math.min(minY, b[1]);
  for (const side of [0, view.width]) {
    const t = (side - a[0]) / (b[0] - a[0]);
    if (t >= 0 && t <= 1) minY = Math.min(minY, a[1] + (b[1] - a[1]) * t);
  }
  return Math.max(0, view.height + 3 - minY);
}

class HandLayer {
  draw(ctx, view, paint) {
    ctx.save();
    paint(ctx);
    ctx.restore();
  }
}

const OverheadHand = (() => {
  const pad = [169, 119];
  const wrist = [429, 572];
  const artWidth = 1024;
  const artHeight = 1536;
  const sizeRatio = 0.5166;
  const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  const xs = [0, 62, 101, 146, 193, 247, 317, 381, 453, 538, 638, 785, 916, 1024];
  const ys = [0, 67, 91, 113, 137, 169, 213, 278, 351, 434, 522, 618, 729, 854, 1004, 1191, 1375, 1536];
  const nx = xs.length;
  const ny = ys.length;

  function shadowMasks(photo) {
    const w = 160;
    const h = 240;
    const margin = 8;
    const shape = createOffscreen(w, h);
    const s = shape.getContext('2d');
    s.drawImage(photo, 0, 0, w, h);
    const rawData = s.getImageData(0, 0, w, h).data;

    const fullW = w + 2 * margin;
    const fullH = h + 2 * margin;
    const shapes = [];
    for (const upper of [false, true]) {
      const alphaMask = new Uint8ClampedArray(fullW * fullH);
      for (let y = 0; y < h; y++) {
        const yf = y / h;
        let grad;
        if (upper) {
          grad = yf <= 0.36 ? 1 : yf >= 0.53 ? 0 : 1 - (yf - 0.36) / 0.17;
        } else {
          grad = yf <= 0.36 ? 0 : yf >= 0.53 ? 1 : (yf - 0.36) / 0.17;
        }
        if (grad <= 0) continue;
        const dstRow = (y + margin) * fullW + margin;
        const srcRow = y * w;
        for (let x = 0; x < w; x++) {
          alphaMask[dstRow + x] = Math.round(rawData[(srcRow + x) * 4 + 3] * grad);
        }
      }
      const soft = createBlurredTintCanvas(alphaMask, fullW, fullH, 1.5, 0x39, 0x29, 0x1c);
      const tight = createBlurredTintCanvas(alphaMask, fullW, fullH, 0.45, 0x39, 0x29, 0x1c);
      shapes.push({ soft, tight, upper, margin: (margin * artWidth) / w });
    }
    return shapes;
  }

  const baseDigits = [
    { m: [250, 310], p: [166, 231], tip: [93, 162], splay: -0.225, curl: 0.98 },
    { m: [306, 294], p: [217, 179], tip: [145, 102], splay: -0.064, curl: 0.74 },
    { m: [359, 270], p: [297, 160], tip: [217, 90], splay: 0.071, curl: 1.02 },
    { m: [414, 267], p: [391, 185], tip: [338, 122], splay: 0.232, curl: 1.24 },
    { m: [207, 473], p: [140, 415], tip: [84, 350], splay: -0.24, curl: 0.81 },
  ];

  function poseDigits(tips) {
    return baseDigits.map((f, i) => {
      const tip = tips?.[i] ?? f.tip;
      const dx = tip[0] - f.m[0];
      const dy = tip[1] - f.m[1];
      const length = Math.hypot(dx, dy);
      return { ...f, tip, ax: dx / length, ay: dy / length, prox: Math.hypot(f.p[0] - f.m[0], f.p[1] - f.m[1]) };
    });
  }

  const smallHand = {
    size: 0.87,
    anchor: [305, 323],
    tips: [[90, 157], [144, 97], [217, 84], [340, 120], [83, 350]],
    thumb: [[0, 320], [148, 320], [181, 376], [214, 437], [232, 465], [246, 514], [0, 514]],
    gaps: [
      [0, 50, 123, 284], [77, 66, 163, 292], [90, 75, 176, 293], [100, 83, 185, 293],
      [111, 90, 195, 303], [126, 100, 210, 308], [141, 113, 228, 318], [150, 122, 239, 328],
      [160, 136, 252, 340], [175, 155, 268, 352], [185, 164, 276, 356], [198, 178, 285, 363],
      [211, 196, 294, 372], [235, 214, 309, 381], [259, 231, 328, 394], [278, 245, 356, 406],
      [300, 275, 361, 424], [320, 292, 375, 431],
    ],
  };

  function separateFingers(photo, fingers, gapRows, thumb) {
    const palm = createOffscreen(artWidth, artHeight);
    const p = palm.getContext('2d');
    p.drawImage(photo, 0, 0);
    p.clearRect(0, 0, artWidth, 270);
    p.globalCompositeOperation = 'destination-out';
    const melt = p.createLinearGradient(0, 270, 0, 319);
    melt.addColorStop(0, '#000');
    melt.addColorStop(1, 'rgba(0,0,0,0)');
    p.fillStyle = melt;
    p.fillRect(0, 270, artWidth, 51);
    p.fillStyle = '#000';

    const polygons = fingers.slice(0, 4).map((_, i) => {
      const left = gapRows.map((row) => [i === 0 ? 0 : row[i], row[0]]);
      const right = gapRows.map((row) => [i === 3 ? 535 : row[i + 1], row[0]]);
      return left.concat(right.reverse());
    });
    polygons.push(thumb ?? [[0, 320], [150, 320], [184, 376], [213, 437], [227, 464], [246, 514], [0, 514]]);

    function tracePath(ctx, pts) {
      ctx.beginPath();
      pts.forEach(([x, y], i) => {
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
    }

    p.globalCompositeOperation = 'destination-out';
    tracePath(p, polygons[4].map(([x, y]) => [Math.max(0, x - 2), Math.min(509, y)]));
    p.fill();
    p.globalCompositeOperation = 'source-over';

    const parts = polygons.map((poly, i) => {
      const left = Math.floor(Math.min(...poly.map((v) => v[0])));
      const top = Math.floor(Math.min(...poly.map((v) => v[1])));
      const right = Math.ceil(Math.max(...poly.map((v) => v[0])));
      const bottom = Math.ceil(Math.max(...poly.map((v) => v[1])));
      const img = createOffscreen(right - left, bottom - top);
      const ctx = img.getContext('2d');
      ctx.save();
      ctx.translate(-left, -top);
      tracePath(ctx, poly);
      ctx.clip();
      ctx.drawImage(photo, 0, 0);
      ctx.restore();
      const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
      const grid = [];
      const triangles = [];
      const cols = Math.ceil(img.width / 48);
      const rows = Math.ceil(img.height / 44);
      for (let y = 0; y <= rows; y++) {
        for (let x = 0; x <= cols; x++) {
          grid.push([left + (img.width * x) / cols, top + (img.height * y) / rows]);
        }
      }
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          let opaque = false;
          const x1 = Math.min(img.width - 1, Math.ceil(((x + 1) * img.width) / cols));
          const y1 = Math.min(img.height - 1, Math.ceil(((y + 1) * img.height) / rows));
          for (let iy = Math.floor((y * img.height) / rows); iy <= y1 && !opaque; iy += 2) {
            for (let ix = Math.floor((x * img.width) / cols); ix <= x1; ix += 2) {
              if (pixels[(iy * img.width + ix) * 4 + 3] > 1) {
                opaque = true;
                break;
              }
            }
          }
          if (opaque) {
            const j = y * (cols + 1) + x;
            triangles.push([j, j + 1, j + cols + 1], [j + cols + 1, j + 1, j + cols + 2]);
          }
        }
      }
      const f = fingers[i];
      const tones = [img];
      for (let n = 1; n <= 3; n++) {
        const tint = createOffscreen(img.width, img.height);
        const tc = tint.getContext('2d');
        tc.drawImage(img, 0, 0);
        tc.globalCompositeOperation = 'source-atop';
        const wash = tc.createLinearGradient(f.tip[0] - left, f.tip[1] - top, f.m[0] - left, f.m[1] - top);
        wash.addColorStop(0, 'rgba(77,44,34,' + (0.18 * n) / 3 + ')');
        wash.addColorStop(0.45, 'rgba(91,51,39,' + (0.08 * n) / 3 + ')');
        wash.addColorStop(0.67, 'rgba(255,240,214,' + (0.055 * n) / 3 + ')');
        wash.addColorStop(1, 'rgba(255,240,214,0)');
        tc.fillStyle = wash;
        tc.fillRect(0, 0, img.width, img.height);
        tc.globalCompositeOperation = 'source-over';
        tones.push(tint);
      }
      return { tones, left, top, grid, triangles, out: new Float64Array(2 * grid.length), digit: i };
    });
    return { palm, parts };
  }

  function digitShadow(photo) {
    const ratio = 0.22;
    const margin = 40;
    const w = Math.ceil((photo.width + 2 * margin) * ratio);
    const h = Math.ceil((photo.height + 2 * margin) * ratio);
    const mask = createOffscreen(w, h);
    const c = mask.getContext('2d');
    c.drawImage(photo, margin * ratio, margin * ratio, photo.width * ratio, photo.height * ratio);
    const rgba = c.getImageData(0, 0, w, h).data;
    const alpha = new Uint8ClampedArray(w * h);
    for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
    return {
      soft: createBlurredTintCanvas(alpha, w, h, 1.8, 0x39, 0x29, 0x1c),
      tight: createBlurredTintCanvas(alpha, w, h, 0.45, 0x39, 0x29, 0x1c),
      margin,
      w: w / ratio,
      h: h / ratio,
    };
  }

  class OverheadHandImpl {
    constructor() {
      this.profile = smallHand;
      this.fingers = poseDigits(this.profile.tips);
    }

    load(img) {
      this.photo = img;
      Object.assign(this, separateFingers(img, this.fingers, this.profile.gaps, this.profile.thumb));
      this.shadows = shadowMasks(img);
      this.baseShadows = shadowMasks(this.palm);
      for (const part of this.parts) part.shadow = digitShadow(part.tones[0]);
      const small = createOffscreen(160, 240);
      const ctx = small.getContext('2d');
      ctx.drawImage(img, 0, 0, small.width, small.height);
      const data = ctx.getImageData(0, 0, small.width, small.height).data;
      const scale = small.width / artWidth;
      this.cells = [];
      this.spans = [];
      for (let r = 0; r < ny - 1; r++) {
        for (let c = 0; c < nx - 1; c++) {
          const x0 = Math.max(0, Math.floor(xs[c] * scale) - 1);
          const x1 = Math.min(small.width - 1, Math.ceil(xs[c + 1] * scale) + 1);
          const y0 = Math.max(0, Math.floor(ys[r] * scale) - 1);
          const y1 = Math.min(small.height - 1, Math.ceil(ys[r + 1] * scale) + 1);
          let occupied = false;
          for (let y = y0; y <= y1 && !occupied; y++) {
            for (let x = x0; x <= x1; x++) {
              if (data[4 * (y * small.width + x) + 3] > 2) {
                occupied = true;
                break;
              }
            }
          }
          if (occupied) {
            this.cells.push([r, c]);
            const last = this.spans[this.spans.length - 1];
            if (last && last.row === r && last.end === c) last.end = c + 1;
            else this.spans.push({ row: r, start: c, end: c + 1 });
          }
        }
      }
      this.points = new Float64Array(2 * nx * ny);
      this.q = new Float64Array(2);
      this.dpr = 1;
      this._palmVertBuf = new Float32Array(this.cells.length * 24);
      this._digitVertBuf = new Float32Array(2048 * 4);
      return this;
    }

    configure(view, p) {
      this.dpr = view.dpr || 1;
      this.transition = null;
      this.sleeveDrop = 0;
      this.scale = ((view.handWidth * sizeRatio * this.profile.size) / artWidth) * (1 + 0.034 * clamp(p.altitude ?? 0));
      this.px = p.x;
      this.py = p.y;
      this.loadVal = clamp(p.load ?? p.pressure ?? 0);
      this.altitude = clamp(p.altitude ?? 0);
      this.lift = clamp(p.lift ?? 0);
      this.dx = clamp(p.motionX || 0, -1, 1);
      this.dy = clamp(p.motionY || 0, -1, 1);
      const yaw = 0.013 + clamp(p.angle || 0, -0.48, 0.48) + 0.033 * this.dx;
      this.cs = Math.cos(yaw);
      this.sn = Math.sin(yaw);
      const at = (p.x - (view.x ?? 0)) / (view.w ?? view.width);
      const counter = clamp((at - 0.346) * 0.87 + 0.16 * this.dx, -0.32, 0.46);
      const fore = 0.013 + 0.37 * (yaw - 0.013) + counter + 0.017 * this.lift;
      this.ac = Math.cos(fore);
      this.as = Math.sin(fore);
      const ux = wrist[0] - pad[0];
      const uy = wrist[1] - pad[1];
      this.wx = this.cs * ux - this.sn * uy;
      this.wy = this.sn * ux + this.cs * uy;
      this.tuck = clamp(p.tuck ?? 0, -1, 1);
      const pressure = clamp(p.pressure ?? 0);
      const firm = smooth(0.5, 0.98, pressure);
      this.articulated = !p.rest || pressure > 0.18;
      if (this.articulated) {
        const bearing = smooth(0.04, 0.54, pressure) * (1 - 0.89 * this.altitude);
        const open = bearing * (0.78 + 0.16 * firm - 0.5 * this.tuck) - 0.2 * this.altitude;
        const flex = clamp(0.15 + 0.53 * Math.max(0, this.tuck) - 0.15 * Math.max(0, -this.tuck) + 0.25 * firm + 0.48 * this.altitude, 0, 1);
        this.joints = this.fingers.map((f, i) => {
          const side = (i - 1.5) * 0.025 * this.dx * bearing;
          const angle = f.splay * open + side + 0.046 * (this.dx - 0.49 * this.dy) * bearing;
          return {
            co: Math.cos(angle),
            si: Math.sin(angle),
            flex,
            first: -0.16 * flex * f.curl + 0.023 * open,
            second: -0.6 * flex * f.curl + 0.052 * open,
            wide: 0.029 * bearing,
            slipX: -(19 + 3 * i) * this.dx * bearing,
            slipY: -(15 + 2 * i) * this.dy * bearing,
          };
        });
      }
      if (this.articulated) {
        this.point(this.profile.anchor[0], this.profile.anchor[1], this.q);
        const settling = Math.min(view.h * 0.013, (p.depth ?? 0) * 0.36) * (1 - this.altitude);
        this.px += p.x - this.q[0];
        this.py += p.y - this.q[1] + settling;
        if (p.coat) this.seatOnEdge(p, view);
        else this.seat = null;
      } else {
        this.seat = null;
      }
      this.sleeveDrop = sleeveReach(this, view, 459, 922);
    }

    seatOnEdge(p, view) {
      const W = view.w;
      const reachWidth = view.kitten ? (view.baseW ?? W) : W;
      const padPos = p.pad ?? { u: (p.x - view.x) / W, v: (p.y - view.y) / view.h };
      let { u, v } = padPos;
      let offsetX = 0, offsetY = 0;
      if (view.kitten) {
        const f = this.fingers[1];
        this.digitPoint(f.tip[0], f.tip[1], 1, this.q);
        this.point(this.q[0], this.q[1], this.q);
        const x = p.x + (this.q[0] - p.x) * 0.72;
        const y = p.y + (this.q[1] - p.y) * 0.72;
        u = (x - view.x) / W;
        v = (y - view.y) / view.h;
        offsetX = p.x - x;
        offsetY = p.y - y;
      }
      const edge = p.coat.handEdge(u, v, padPos.u, padPos.v);
      if (!edge) {
        this.seat = null;
        return;
      }
      const { nx: ex, ny: ey } = edge;
      const clearance = Math.max(0, (edge.inside ? edge.distance : -edge.distance) * W + offsetX * ex + offsetY * ey);
      let dx = 0, dy = 0;
      if (clearance < 0.14 * reachWidth) {
        const anchor = this.profile.anchor;
        this.point(anchor[0], anchor[1], this.q);
        const x = this.q[0];
        const y = this.q[1];
        let lead = 0, side = 0, weight = 0;
        for (let i = 0; i < 4; i++) {
          const f = this.fingers[i];
          this.digitPoint(f.tip[0], f.tip[1], i, this.q);
          this.point(this.q[0], this.q[1], this.q);
          const ax = this.q[0] - x;
          const ay = this.q[1] - y;
          const out = -ex * ax - ey * ay;
          const k = Math.exp(out / (W * 0.016));
          lead = Math.max(lead, out);
          side += k * (-ey * ax + ex * ay);
          weight += k;
        }
        if (lead > W * 0.009) {
          const shift = Math.max(0, lead - clearance + this.scale * 4);
          const drift = (side / weight) * smooth(0, 1, shift / lead) * 0.78;
          const neck = p.coat.neckWeight(p.pad?.u ?? (p.x - view.x) / W);
          const bearing = 1 - neck * (1 - smooth(0.009, 0.072, lead / W));
          dx = (bearing * (ex * shift + ey * drift)) / W;
          dy = (bearing * (ey * shift - ex * drift)) / W;
        }
      }
      const last = this.seat?.kitten === view.kitten ? this.seat : null;
      const travel = last ? Math.hypot(p.x - last.px, p.y - last.py) : Infinity;
      const reposition = travel / reachWidth > 0.12;
      let f = reposition ? 1 : -Math.expm1(-p.dt / 0.038);
      if (!reposition && view.kitten) {
        const correction = W * Math.hypot(dx - last.x, dy - last.y);
        const allowance = 0.105 * reachWidth * p.dt + 0.25 * travel;
        if (correction * f > allowance) f = allowance / correction;
      }
      const seatX = (last?.x ?? dx) + (dx - (last?.x ?? dx)) * f;
      const seatY = (last?.y ?? dy) + (dy - (last?.y ?? dy)) * f;
      this.seat = { x: seatX, y: seatY, px: p.x, py: p.y, kitten: view.kitten };
      this.px += seatX * W;
      this.py += seatY * W;
    }

    contacts() {
      const pads = this.fingers.map((f, i) => {
        const x = f.tip[0] + (f.p[0] - f.tip[0]) * 0.24;
        const y = f.tip[1] + (f.p[1] - f.tip[1]) * 0.24;
        if (this.articulated) {
          this.digitPoint(x, y, i, this.q);
          this.point(this.q[0], this.q[1], this.q);
        } else {
          this.point(x, y, this.q);
        }
        return { x: this.q[0], y: this.q[1], weight: [0.14, 0.19, 0.18, 0.1, 0.065][i] };
      });
      this.point(this.profile.anchor[0], this.profile.anchor[1], this.q);
      pads.push({ x: this.q[0], y: this.q[1], weight: 0.325 });
      return pads;
    }

    digitPoint(x, y, id, out) {
      const f = this.fingers[id];
      const j = this.joints[id];
      const dx = x - f.m[0];
      const dy = y - f.m[1];
      const along = f.ax * dx + f.ay * dy;
      const gain = smooth(-8, 67, along);
      const boundary = id === 4 ? 1 - smooth(462, 512, y) : 1 - smooth(274, 319, y);
      const amt = gain * boundary;
      const flex = along * j.first + Math.max(0, along - f.prox) * (j.second - j.first);
      const cross = -f.ay * dx + f.ax * dy;
      const bx = dx + f.ax * flex - f.ay * cross * j.wide;
      const by = dy + f.ay * flex + f.ax * cross * j.wide;
      const friction = amt * clamp(along / (f.prox * 1.8));
      const bend = j.flex * Math.sin(Math.PI * clamp(along / (f.prox * 1.88))) * 7 * f.curl;
      out[0] = x + amt * (j.co * bx - j.si * by - dx + f.ay * bend) + friction * j.slipX;
      out[1] = y + amt * (j.si * bx + j.co * by - dy - f.ax * bend) + friction * j.slipY;
    }

    point(x, y, out, offset = 0) {
      let u = x - pad[0];
      let v = y - pad[1];
      const distal = 1 - smooth(135, 495, y);
      const flex = this.loadVal - 0.16;
      u += flex * distal * 0.042 * (x - pad[0]);
      v += flex * distal * 0.048 * (y - pad[1]);
      const knuckle = smooth(140, 350, y) * (1 - smooth(400, 580, y));
      u += knuckle * (this.dx * 11 - flex * 4.3);
      v += knuckle * (this.dy * 9 - flex * 8.3 + this.lift * 8);
      const hx = this.cs * u - this.sn * v;
      const hy = this.sn * u + this.cs * v;
      const wx = x - wrist[0];
      const wy = y - wrist[1];
      const sx = this.wx + this.ac * wx - this.as * wy;
      const sy = this.wy + this.as * wx + this.ac * wy;
      const blend = smooth(465, 785, y + 0.29 * (x - wrist[0]));
      out[offset] = this.px + this.scale * (hx + (sx - hx) * blend);
      out[offset + 1] = this.py + this.scale * (hy + (sy - hy) * blend);
      if (this.sleeveDrop && y > 680) out[offset + 1] += this.sleeveDrop * smooth(680, 1535, y);
      if (this.transition) this.transition.project(out, offset);
    }

    digitShadows(ctx) {
      const k = this.scale;
      const a = this.altitude;
      for (const part of this.parts) {
        const f = this.fingers[part.digit];
        const root = f.m;
        const tip = f.tip;
        const u = tip[0] - root[0];
        const v = tip[1] - root[1];
        const s = -f.ay * 40;
        const t = f.ax * 40;
        const det = u * t - v * s;
        this.digitPoint(root[0], root[1], part.digit, this.q);
        this.point(this.q[0], this.q[1], this.q);
        const x = this.q[0], y = this.q[1];
        this.digitPoint(tip[0], tip[1], part.digit, this.q);
        this.point(this.q[0], this.q[1], this.q);
        const X = this.q[0] - x, Y = this.q[1] - y;
        this.digitPoint(root[0] + s, root[1] + t, part.digit, this.q);
        this.point(this.q[0], this.q[1], this.q);
        const Z = this.q[0] - x, W = this.q[1] - y;
        const m = (X * t - Z * v) / det;
        const n = (Y * t - W * v) / det;
        const o = (Z * u - X * s) / det;
        const d = (W * u - Y * s) / det;
        const { soft, tight, margin, w, h } = part.shadow;
        const left = part.left - margin;
        const top = part.top - margin;
        const tx = x - m * root[0] - o * root[1];
        const ty = y - n * root[0] - d * root[1];
        ctx.save();
        ctx.globalAlpha = 0.27 - 0.08 * a;
        ctx.transform(m, n, o, d, tx + k * (8 + 22 * a), ty + k * (13 + 32 * a));
        ctx.drawImage(soft, left, top, w, h);
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = (0.31 + 0.18 * this.loadVal) * (1 - a) * (1 - a);
        ctx.transform(m, n, o, d, tx + k * 2.6, ty + k * 4);
        ctx.drawImage(tight, left, top, w, h);
        ctx.restore();
      }
    }

    shade(ctx, visibility) {
      const a = this.altitude;
      const k = this.scale;
      const level = this.loadVal;
      ctx.save();
      if (this.articulated) this.digitShadows(ctx);
      for (const { soft, tight, upper, margin } of this.articulated ? this.baseShadows : this.shadows) {
        const co = upper ? this.cs : this.ac;
        const si = upper ? this.sn : this.as;
        const ax = upper ? pad[0] : wrist[0];
        const ay = upper ? pad[1] : wrist[1];
        const tx = upper ? this.px : this.px + k * this.wx;
        const ty = upper ? this.py : this.py + k * this.wy;
        const w = artWidth + 2 * margin;
        const h = artHeight + 2 * margin;
        const left = -ax - margin;
        const top = -ay - margin;
        const far = upper ? 1 : 1.42;
        ctx.save();
        ctx.translate(tx, ty);
        ctx.transform(k * co, k * si, -k * si, k * co, 0, 0);
        ctx.globalAlpha *= visibility * (upper ? 0.28 : 0.19) * (1 - 0.3 * a);
        ctx.drawImage(soft, left + (9 + 18 * a) * far, top + (13 + 29 * a) * far, w, h);
        ctx.restore();
        ctx.save();
        ctx.translate(tx, ty);
        ctx.transform(k * co, k * si, -k * si, k * co, 0, 0);
        ctx.globalAlpha *= visibility * (upper ? 0.32 + 0.15 * level : 0.09) * (1 - a) * (1 - a);
        ctx.drawImage(tight, left + 2.8, top + 4.1, w, h);
        ctx.restore();
      }
      ctx.restore();
    }

    triangle(ctx, ia, ib, ic, src, texture) {
      const q = this.points;
      const i = ia * 2;
      const j = ib * 2;
      const k = ic * 2;
      const x = xs[ia % nx];
      const y = ys[Math.floor(ia / nx)];
      const u = xs[ib % nx] - x;
      const v = ys[Math.floor(ib / nx)] - y;
      const s = xs[ic % nx] - x;
      const t = ys[Math.floor(ic / nx)] - y;
      const det = u * t - v * s;
      const X = q[j] - q[i];
      const Y = q[j + 1] - q[i + 1];
      const Z = q[k] - q[i];
      const W = q[k + 1] - q[i + 1];
      const m = (X * t - Z * v) / det;
      const n = (Y * t - W * v) / det;
      const b = (Z * u - X * s) / det;
      const d = (W * u - Y * s) / det;
      const cx = (q[i] + q[j] + q[k]) / 3;
      const cy = (q[i + 1] + q[j + 1] + q[k + 1]) / 3;
      ctx.save();
      ctx.beginPath();
      for (const h of [i, j, k]) {
        const ex = q[h] - cx;
        const ey = q[h + 1] - cy;
        const over = 0.68 / Math.max(1, Math.hypot(ex, ey));
        const px = q[h] + ex * over;
        const py = q[h + 1] + ey * over;
        if (h === i) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.clip();
      ctx.transform(m, n, b, d, q[i] - m * x - b * y, q[i + 1] - n * x - d * y);
      ctx.drawImage(texture, ...src, ...src);
      ctx.restore();
    }

    drawDigits(ctx) {
      for (const part of this.parts) {
        const { left, top, grid, triangles, tones, out, digit } = part;
        const img = tones[Math.round(3 * this.joints[digit].flex)];
        for (let i = 0; i < grid.length; i++) {
          this.digitPoint(grid[i][0], grid[i][1], digit, this.q);
          this.point(this.q[0], this.q[1], out, 2 * i);
        }
        for (const [ia, ib, ic] of triangles) {
          const a = ia * 2;
          const b = ib * 2;
          const c = ic * 2;
          const p = grid[ia];
          const u = grid[ib][0] - p[0];
          const v = grid[ib][1] - p[1];
          const h = grid[ic][0] - p[0];
          const s = grid[ic][1] - p[1];
          const det = u * s - v * h;
          const X = out[b] - out[a];
          const Y = out[b + 1] - out[a + 1];
          const Z = out[c] - out[a];
          const W = out[c + 1] - out[a + 1];
          const m = (X * s - Z * v) / det;
          const n = (Y * s - W * v) / det;
          const o = (Z * u - X * h) / det;
          const d = (W * u - Y * h) / det;
          const cx = (out[a] + out[b] + out[c]) / 3;
          const cy = (out[a + 1] + out[b + 1] + out[c + 1]) / 3;
          ctx.save();
          ctx.beginPath();
          for (const i of [a, b, c]) {
            const dx = out[i] - cx;
            const dy = out[i + 1] - cy;
            const add = 0.54 / Math.max(1, Math.hypot(dx, dy));
            if (i === a) ctx.moveTo(out[i] + dx * add, out[i + 1] + dy * add);
            else ctx.lineTo(out[i] + dx * add, out[i + 1] + dy * add);
          }
          ctx.closePath();
          ctx.clip();
          ctx.transform(m, n, o, d, out[a] - m * p[0] - o * p[1], out[a + 1] - n * p[0] - d * p[1]);
          const x0 = Math.min(p[0], grid[ib][0], grid[ic][0]);
          const y0 = Math.min(p[1], grid[ib][1], grid[ic][1]);
          const lx = Math.max(left, Math.floor(x0) - 2);
          const ly = Math.max(top, Math.floor(y0) - 2);
          const w = Math.min(left + img.width - lx, Math.ceil(Math.max(Math.abs(u), Math.abs(h))) + 5);
          const hh = Math.min(top + img.height - ly, Math.ceil(Math.max(Math.abs(v), Math.abs(s))) + 5);
          ctx.drawImage(img, lx - left, ly - top, w, hh, lx, ly, w, hh);
          ctx.restore();
        }
      }
    }

    drawSkin(ctx) {
      for (let r = 0; r < ny; r++) {
        for (let c = 0; c < nx; c++) {
          this.point(xs[c], ys[r], this.points, 2 * (r * nx + c));
        }
      }
      ctx.save();
      if (this.articulated) this.drawDigits(ctx);
      this.drawPalm(ctx, this.articulated ? this.palm : this.photo);
      ctx.restore();
    }

    drawSpan(ctx, row, start, end, texture) {
      const xy = this.points;
      const stride = nx * 2;
      const A = row * stride + 2 * start;
      const B = row * stride + 2 * end;
      const C = A + stride;
      const D = B + stride;
      const x = xs[start];
      const y = ys[row];
      const w = xs[end] - x;
      const h = ys[row + 1] - y;
      const m = (xy[B] - xy[A] + xy[D] - xy[C]) / (2 * w);
      const n = (xy[B + 1] - xy[A + 1] + xy[D + 1] - xy[C + 1]) / (2 * w);
      const b = (xy[C] - xy[A] + xy[D] - xy[B]) / (2 * h);
      const d = (xy[C + 1] - xy[A + 1] + xy[D + 1] - xy[B + 1]) / (2 * h);
      const ax = (xy[A] + xy[B] + xy[C] + xy[D]) * 0.25 - (m * w + b * h) * 0.5;
      const ay = (xy[A + 1] + xy[B + 1] + xy[C + 1] + xy[D + 1]) * 0.25 - (n * w + d * h) * 0.5;
      const tolerance = 0.75 / this.dpr;
      for (let col = start; col <= end; col++) {
        const i = A + (col - start) * 2;
        const dx = xs[col] - x;
        const px = ax + dx * m;
        const py = ay + dx * n;
        if (
          Math.abs(px - xy[i]) > tolerance ||
          Math.abs(py - xy[i + 1]) > tolerance ||
          Math.abs(px + b * h - xy[i + stride]) > tolerance ||
          Math.abs(py + d * h - xy[i + stride + 1]) > tolerance
        ) {
          if (end > start + 1) {
            const mid = (start + end) >> 1;
            this.drawSpan(ctx, row, start, mid, texture);
            this.drawSpan(ctx, row, mid, end, texture);
          } else {
            const left = Math.max(0, xs[start] - 4);
            const top = Math.max(0, ys[row] - 4);
            const right = Math.min(artWidth, xs[start + 1] + 4);
            const bottom = Math.min(artHeight, ys[row + 1] + 4);
            const box = [left, top, right - left, bottom - top];
            const v = row * nx + start;
            this.triangle(ctx, v, v + 1, v + nx, box, texture);
            this.triangle(ctx, v + nx, v + 1, v + nx + 1, box, texture);
          }
          return;
        }
      }
      const pad = 0.65 / (this.scale * this.dpr);
      const left = Math.max(0, x - pad);
      const top = Math.max(0, y - pad);
      const width = Math.min(artWidth, x + w + pad) - left;
      const height = Math.min(artHeight, y + h + pad) - top;
      ctx.save();
      ctx.transform(m, n, b, d, ax - m * x - b * y, ay - n * x - d * y);
      ctx.drawImage(texture, left, top, width, height, left, top, width, height);
      ctx.restore();
    }

    drawPalm(ctx, texture) {
      for (const { row, start, end } of this.spans) {
        if (this.articulated && ys[row + 1] < 318) continue;
        this.drawSpan(ctx, row, start, end, texture);
      }
    }

    draw(ctx) {
      if (!this.photo) return;
      if (!this.transition) this.shade(ctx, 1);
      this.drawSkin(ctx);
    }

    digitShadowsGL(glRenderer) {
      const k = this.scale;
      const a = this.altitude;
      for (const part of this.parts) {
        const f = this.fingers[part.digit];
        const root = f.m;
        const tip = f.tip;
        const u = tip[0] - root[0];
        const v = tip[1] - root[1];
        const s = -f.ay * 40;
        const t = f.ax * 40;
        const det = u * t - v * s;
        this.digitPoint(root[0], root[1], part.digit, this.q);
        this.point(this.q[0], this.q[1], this.q);
        const x = this.q[0], y = this.q[1];
        this.digitPoint(tip[0], tip[1], part.digit, this.q);
        this.point(this.q[0], this.q[1], this.q);
        const X = this.q[0] - x, Y = this.q[1] - y;
        this.digitPoint(root[0] + s, root[1] + t, part.digit, this.q);
        this.point(this.q[0], this.q[1], this.q);
        const Z = this.q[0] - x, W = this.q[1] - y;
        const m = (X * t - Z * v) / det;
        const n = (Y * t - W * v) / det;
        const o = (Z * u - X * s) / det;
        const d = (W * u - Y * s) / det;
        const { soft, tight, margin, w, h } = part.shadow;
        const left = part.left - margin;
        const top = part.top - margin;
        const tx = x - m * root[0] - o * root[1];
        const ty = y - n * root[0] - d * root[1];
        glRenderer.drawTransformedQuad(
          glRenderer.getTexture(soft),
          m, n, o, d, tx + k * (8 + 22 * a), ty + k * (13 + 32 * a),
          left, top, w, h, 0, 0, 1, 1, 0.27 - 0.08 * a
        );
        const aTight = (0.31 + 0.18 * this.loadVal) * (1 - a) * (1 - a);
        if (aTight > 0.002) {
          glRenderer.drawTransformedQuad(
            glRenderer.getTexture(tight),
            m, n, o, d, tx + k * 2.6, ty + k * 4,
            left, top, w, h, 0, 0, 1, 1, aTight
          );
        }
      }
    }

    shadeGL(glRenderer, visibility) {
      if (visibility <= 0.002) return;
      const a = this.altitude;
      const k = this.scale;
      const level = this.loadVal;
      if (this.articulated) this.digitShadowsGL(glRenderer);
      for (const { soft, tight, upper, margin } of this.articulated ? this.baseShadows : this.shadows) {
        const co = upper ? this.cs : this.ac;
        const si = upper ? this.sn : this.as;
        const ax = upper ? pad[0] : wrist[0];
        const ay = upper ? pad[1] : wrist[1];
        const tx = upper ? this.px : this.px + k * this.wx;
        const ty = upper ? this.py : this.py + k * this.wy;
        const w = artWidth + 2 * margin;
        const h = artHeight + 2 * margin;
        const left = -ax - margin;
        const top = -ay - margin;
        const far = upper ? 1 : 1.42;
        const aSoft = visibility * (upper ? 0.28 : 0.19) * (1 - 0.3 * a);
        if (aSoft > 0.002) {
          glRenderer.drawTransformedQuad(
            glRenderer.getTexture(soft),
            k * co, k * si, -k * si, k * co, tx, ty,
            left + (9 + 18 * a) * far, top + (13 + 29 * a) * far, w, h, 0, 0, 1, 1, aSoft
          );
        }
        const aTight = visibility * (upper ? 0.32 + 0.15 * level : 0.09) * (1 - a) * (1 - a);
        if (aTight > 0.002) {
          glRenderer.drawTransformedQuad(
            glRenderer.getTexture(tight),
            k * co, k * si, -k * si, k * co, tx, ty,
            left + 2.8, top + 4.1, w, h, 0, 0, 1, 1, aTight
          );
        }
      }
    }

    drawDigitsGL(glRenderer) {
      const buf = this._digitVertBuf;
      for (const part of this.parts) {
        const { left, top, grid, triangles, tones, out, digit } = part;
        const img = tones[Math.round(3 * this.joints[digit].flex)];
        const tex = glRenderer.getTexture(img);
        const invW = 1 / img.width;
        const invH = 1 / img.height;
        for (let i = 0; i < grid.length; i++) {
          this.digitPoint(grid[i][0], grid[i][1], digit, this.q);
          this.point(this.q[0], this.q[1], out, 2 * i);
        }
        let k = 0;
        for (const [ia, ib, ic] of triangles) {
          const a = ia * 2, b = ib * 2, c = ic * 2;
          buf[k++] = out[a]; buf[k++] = out[a + 1]; buf[k++] = (grid[ia][0] - left) * invW; buf[k++] = (grid[ia][1] - top) * invH;
          buf[k++] = out[b]; buf[k++] = out[b + 1]; buf[k++] = (grid[ib][0] - left) * invW; buf[k++] = (grid[ib][1] - top) * invH;
          buf[k++] = out[c]; buf[k++] = out[c + 1]; buf[k++] = (grid[ic][0] - left) * invW; buf[k++] = (grid[ic][1] - top) * invH;
        }
        if (k > 0) glRenderer.drawTriangles(tex, buf, k >> 2, 1);
      }
    }

    drawPalmGL(glRenderer, texObj) {
      const tex = glRenderer.getTexture(texObj);
      const xy = this.points;
      const buf = this._palmVertBuf;
      const invW = 1 / artWidth;
      const invH = 1 / artHeight;
      let k = 0;
      for (const [r, c] of this.cells) {
        if (this.articulated && ys[r + 1] < 318) continue;
        const v0 = r * nx + c;
        const v1 = v0 + 1;
        const v2 = v0 + nx;
        const v3 = v2 + 1;
        const i0 = v0 * 2, i1 = v1 * 2, i2 = v2 * 2, i3 = v3 * 2;
        const u0 = xs[c] * invW, u1 = xs[c + 1] * invW;
        const t0 = ys[r] * invH, t1 = ys[r + 1] * invH;
        buf[k++] = xy[i0]; buf[k++] = xy[i0 + 1]; buf[k++] = u0; buf[k++] = t0;
        buf[k++] = xy[i1]; buf[k++] = xy[i1 + 1]; buf[k++] = u1; buf[k++] = t0;
        buf[k++] = xy[i2]; buf[k++] = xy[i2 + 1]; buf[k++] = u0; buf[k++] = t1;
        buf[k++] = xy[i2]; buf[k++] = xy[i2 + 1]; buf[k++] = u0; buf[k++] = t1;
        buf[k++] = xy[i1]; buf[k++] = xy[i1 + 1]; buf[k++] = u1; buf[k++] = t0;
        buf[k++] = xy[i3]; buf[k++] = xy[i3 + 1]; buf[k++] = u1; buf[k++] = t1;
      }
      if (k > 0) glRenderer.drawTriangles(tex, buf, k >> 2, 1);
    }

    drawSkinGL(glRenderer) {
      for (let r = 0; r < ny; r++) {
        for (let c = 0; c < nx; c++) {
          this.point(xs[c], ys[r], this.points, 2 * (r * nx + c));
        }
      }
      if (this.articulated) this.drawDigitsGL(glRenderer);
      this.drawPalmGL(glRenderer, this.articulated ? this.palm : this.photo);
    }

    drawGL(glRenderer, visibility = 1) {
      if (!this.photo) return;
      if (!this.transition) this.shadeGL(glRenderer, visibility);
      this.drawSkinGL(glRenderer);
    }
  }

  return OverheadHandImpl;
})();

const TailHand = (() => {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (x) => {
    x = clamp(x, 0, 1);
    return x * x * (3 - 2 * x);
  };
  const layout = {
    cx: 452,
    cy: 204,
    size: 0.87,
    wrist: [544, 623],
    bottom: [423, 828],
    tips: [[336, 120], [421, 98], [519, 110], [606, 134], [253, 188]],
    knuckles: [[357, 257], [458, 239], [551, 241], [640, 267], [238, 278]],
    arm: [[472, 373], [544, 623], [560, 703], [608, 1050], [629, 1460], [296, 392], [428, 718], [676, 679]],
  };
  const xs = [0, 176, 226, 266, 311, 354, 394, 439, 486, 531, 576, 622, 666, 718, 824, 930, 1024];
  const ys = [0, 67, 97, 126, 156, 191, 230, 274, 329, 401, 489, 556, 624, 702, 834, 1040, 1270, 1536];
  const closedScale = 0.83;

  class TailHandImpl {
    constructor() {
      this.layout = layout;
      this.angle = 0;
    }

    load(photo) {
      this.photo = photo;
      const tiny = createOffscreen(128, 192);
      const c = tiny.getContext('2d');
      c.drawImage(photo, 0, 0, 128, 192);
      const pix = c.getImageData(0, 0, 128, 192).data;
      this.grid = [];
      this.cells = [];
      this.spans = [];
      for (const y of ys) for (const x of xs) this.grid.push([x, y]);
      for (let j = 0; j < ys.length - 1; j++) {
        for (let i = 0; i < xs.length - 1; i++) {
          let occupied = false;
          for (let y = Math.max(0, (ys[j] >> 3) - 1); y < Math.min(192, Math.ceil(ys[j + 1] / 8) + 1) && !occupied; y++) {
            for (let x = Math.max(0, (xs[i] >> 3) - 1); x < Math.min(128, Math.ceil(xs[i + 1] / 8) + 1); x++) {
              if (pix[(128 * y + x) * 4 + 3] > 0) {
                occupied = true;
                break;
              }
            }
          }
          if (occupied) {
            this.cells.push([j, i]);
            const last = this.spans[this.spans.length - 1];
            if (last && last.row === j && last.end === i) last.end = i + 1;
            else this.spans.push({ row: j, start: i, end: i + 1 });
          }
        }
      }
      this.xy = new Float64Array(this.grid.length * 2);
      this.q = new Float64Array(2);
      this._vertBuf = new Float32Array(this.cells.length * 24);
      return this;
    }

    configure(view, p, x, y, amount, pressure, slide, dt) {
      const l = this.layout;
      this.x = x;
      this.y = y;
      this.k = (view.handWidth * 0.5166 * l.size * closedScale) / 1024;
      this.transition = null;
      this.sleeveDrop = 0;
      this.dpr = view.dpr || 1;
      const target = 0.24 * p.ty + 0.026 * Math.tanh(slide * 4);
      const f = 1 - Math.exp(-dt / 0.09);
      if (amount < 0.07) this.angle = target;
      else this.angle += (target - this.angle) * f;
      this.c = Math.cos(this.angle);
      this.s = Math.sin(this.angle);
      const fore = 0.53 * this.angle + ease((p.u - 0.79) / 0.2) * 0.12;
      this.ca = Math.cos(fore);
      this.sa = Math.sin(fore);
      const wx = l.wrist[0] - l.cx;
      const wy = l.wrist[1] - l.cy;
      this.wx = this.c * wx - this.s * wy;
      this.wy = this.s * wx + this.c * wy;
      const diameter = (2 * p.feltRadius * view.w) / this.k;
      this.fold = (1 - amount) * -22 + amount * (clamp((125 - diameter) * 0.23, -13, 20) + pressure * 6);
      const along = p.tx * this.c + p.ty * this.s;
      const cross = p.ty * this.c - p.tx * this.s;
      const edge = p.upperFur * view.w;
      const reach = (edge + Math.abs(cross) * 130 * this.k) / Math.max(0.65, along);
      const cover = (78 - this.fold) * this.k;
      const lift = clamp(reach - cover, 0, edge * 0.87) * ease((along - 0.25) / 0.55) * ease(amount);
      this.x += this.s * lift;
      this.y -= this.c * lift;
      this.closing = 4 * amount * (1 - amount);
      this.slide = clamp(slide * 16, -7, 7) * amount;
      this.sleeveDrop = sleeveReach(this, view, ...l.bottom);
    }

    point(x, y, out, i = 0) {
      const l = this.layout;
      const dx = x - l.cx;
      const knuckles = 1 - ease((y - l.cy + 36) / 173);
      const thumb = 1 - ease((x - l.cx + 180) / 87);
      const fold = this.fold - this.closing * 9 * ease((x - 366) / 225);
      const px = dx + knuckles * (thumb * 0.65 * fold - (0.045 * dx * fold) / 20 - this.slide);
      const py = y - l.cy + knuckles * fold * (1 - 0.55 * thumb);
      const hx = this.c * px - this.s * py;
      const hy = this.s * px + this.c * py;
      const sx = x - l.wrist[0];
      const sy = y - l.wrist[1];
      const arm = ease((y + 0.2 * sx - 553) / 240);
      out[i] = this.x + this.k * (hx + (this.wx + (this.ca * sx - this.sa * sy) / closedScale - hx) * arm);
      out[i + 1] = this.y + this.k * (hy + (this.wy + (this.sa * sx + this.ca * sy) / closedScale - hy) * arm);
      if (this.sleeveDrop && y > 680) out[i + 1] += this.sleeveDrop * ease((y - 680) / 855);
      if (this.transition) this.transition.project(out, i);
    }

    triangle(ctx, ia, ib, ic) {
      const [ax, ay] = this.grid[ia];
      const [bx, by] = this.grid[ib];
      const [cx, cy] = this.grid[ic];
      const uvx = bx - ax;
      const uvy = by - ay;
      const px = cx - ax;
      const py = cy - ay;
      const det = uvx * py - uvy * px;
      const o = this.xy;
      const A = ia * 2;
      const B = ib * 2;
      const C = ic * 2;
      const X = o[B] - o[A];
      const Y = o[B + 1] - o[A + 1];
      const Z = o[C] - o[A];
      const V = o[C + 1] - o[A + 1];
      const m = (X * py - Z * uvy) / det;
      const n = (Y * py - V * uvy) / det;
      const b = (Z * uvx - X * px) / det;
      const d = (V * uvx - Y * px) / det;
      const mx = (o[A] + o[B] + o[C]) / 3;
      const my = (o[A + 1] + o[B + 1] + o[C + 1]) / 3;
      ctx.save();
      ctx.beginPath();
      for (const h of [A, B, C]) {
        const vx = o[h] - mx;
        const vy = o[h + 1] - my;
        const g = 0.64 / Math.max(1, Math.hypot(vx, vy));
        if (h === A) ctx.moveTo(o[h] + vx * g, o[h + 1] + vy * g);
        else ctx.lineTo(o[h] + vx * g, o[h + 1] + vy * g);
      }
      ctx.closePath();
      ctx.clip();
      ctx.transform(m, n, b, d, o[A] - m * ax - b * ay, o[A + 1] - n * ax - d * ay);
      const left = Math.max(0, Math.min(ax, bx, cx) - 2);
      const top = Math.max(0, Math.min(ay, by, cy) - 2);
      const w = Math.min(1024, Math.max(ax, bx, cx) + 2) - left;
      const h = Math.min(1536, Math.max(ay, by, cy) + 2) - top;
      ctx.drawImage(this.photo, left, top, w, h, left, top, w, h);
      ctx.restore();
    }

    drawSpan(ctx, row, start, end) {
      const xy = this.xy;
      const stride = xs.length * 2;
      const A = row * stride + 2 * start;
      const B = row * stride + 2 * end;
      const C = A + stride;
      const D = B + stride;
      const x = xs[start];
      const y = ys[row];
      const w = xs[end] - x;
      const h = ys[row + 1] - y;
      const m = (xy[B] - xy[A] + xy[D] - xy[C]) / (2 * w);
      const n = (xy[B + 1] - xy[A + 1] + xy[D + 1] - xy[C + 1]) / (2 * w);
      const b = (xy[C] - xy[A] + xy[D] - xy[B]) / (2 * h);
      const d = (xy[C + 1] - xy[A + 1] + xy[D + 1] - xy[B + 1]) / (2 * h);
      const ax = (xy[A] + xy[B] + xy[C] + xy[D]) * 0.25 - (m * w + b * h) * 0.5;
      const ay = (xy[A + 1] + xy[B + 1] + xy[C + 1] + xy[D + 1]) * 0.25 - (n * w + d * h) * 0.5;
      const tolerance = 0.18 / this.dpr;
      for (let col = start; col <= end; col++) {
        const i = A + (col - start) * 2;
        const dx = xs[col] - x;
        const px = ax + dx * m;
        const py = ay + dx * n;
        if (
          Math.abs(px - xy[i]) > tolerance ||
          Math.abs(py - xy[i + 1]) > tolerance ||
          Math.abs(px + b * h - xy[i + stride]) > tolerance ||
          Math.abs(py + d * h - xy[i + stride + 1]) > tolerance
        ) {
          if (end > start + 1) {
            const mid = (start + end) >> 1;
            this.drawSpan(ctx, row, start, mid);
            this.drawSpan(ctx, row, mid, end);
          } else {
            const v = A / 2;
            this.triangle(ctx, v, v + 1, v + xs.length);
            this.triangle(ctx, v + xs.length, v + 1, v + xs.length + 1);
          }
          return;
        }
      }
      const pad = 0.65 / (this.k * this.dpr);
      const left = Math.max(0, x - pad);
      const top = Math.max(0, y - pad);
      const width = Math.min(1024, x + w + pad) - left;
      const height = Math.min(1536, y + h + pad) - top;
      ctx.save();
      ctx.transform(m, n, b, d, ax - m * x - b * y, ay - n * x - d * y);
      ctx.drawImage(this.photo, left, top, width, height, left, top, width, height);
      ctx.restore();
    }

    drawSkin(ctx) {
      for (let i = 0; i < this.grid.length; i++) this.point(this.grid[i][0], this.grid[i][1], this.xy, 2 * i);
      for (const { row, start, end } of this.spans) this.drawSpan(ctx, row, start, end);
    }

    drawSkinGL(glRenderer) {
      for (let i = 0; i < this.grid.length; i++) this.point(this.grid[i][0], this.grid[i][1], this.xy, 2 * i);
      const tex = glRenderer.getTexture(this.photo);
      const xy = this.xy;
      const buf = this._vertBuf;
      const stride = xs.length;
      const invW = 1 / 1024;
      const invH = 1 / 1536;
      let k = 0;
      for (const [r, c] of this.cells) {
        const v0 = r * stride + c;
        const v1 = v0 + 1;
        const v2 = v0 + stride;
        const v3 = v2 + 1;
        const i0 = v0 * 2, i1 = v1 * 2, i2 = v2 * 2, i3 = v3 * 2;
        const u0 = xs[c] * invW, u1 = xs[c + 1] * invW;
        const t0 = ys[r] * invH, t1 = ys[r + 1] * invH;
        buf[k++] = xy[i0]; buf[k++] = xy[i0 + 1]; buf[k++] = u0; buf[k++] = t0;
        buf[k++] = xy[i1]; buf[k++] = xy[i1 + 1]; buf[k++] = u1; buf[k++] = t0;
        buf[k++] = xy[i2]; buf[k++] = xy[i2 + 1]; buf[k++] = u0; buf[k++] = t1;
        buf[k++] = xy[i2]; buf[k++] = xy[i2 + 1]; buf[k++] = u0; buf[k++] = t1;
        buf[k++] = xy[i1]; buf[k++] = xy[i1 + 1]; buf[k++] = u1; buf[k++] = t0;
        buf[k++] = xy[i3]; buf[k++] = xy[i3 + 1]; buf[k++] = u1; buf[k++] = t1;
      }
      if (k > 0) glRenderer.drawTriangles(tex, buf, k >> 2, 1);
    }
  }

  return TailHandImpl;
})();

const HandChange = (() => {
  const openArm = [[305, 323], [429, 572], [506, 700], [659, 1050], [724, 1460], [207, 473], [410, 766], [609, 666]];
  const anchorCount = 10 + openArm.length;
  const clamp = (x) => Math.max(0, Math.min(1, x));

  function field() {
    return {
      xy: new Float64Array(anchorCount * 2),
      delta: new Float64Array(anchorCount * 2),
      soft: 1,
      project(out, k) {
        const x = out[k];
        const y = out[k + 1];
        let total = 0, dx = 0, dy = 0;
        for (let i = 0; i < this.xy.length; i += 2) {
          const a = x - this.xy[i];
          const b = y - this.xy[i + 1];
          const d = a * a + b * b + this.soft;
          const weight = 1 / (d * d);
          total += weight;
          dx += this.delta[i] * weight;
          dy += this.delta[i + 1] * weight;
        }
        out[k] += dx / total;
        out[k + 1] += dy / total;
      },
    };
  }

  class HandChangeImpl {
    constructor() {
      this.open = field();
      this.cupped = field();
      this.q = new Float64Array(2);
      this.reset();
    }

    reset() {
      this.held = false;
      this.amount = 0;
      this.rate = 0;
      this.move = null;
      this.view = null;
      this.x = 0;
      this.y = 0;
      this.vx = 0;
      this.vy = 0;
    }

    place(hand, grip, held, dt, view) {
      const q = this.q;
      hand.point(...openArm[1], q);
      const openX = q[0];
      const openY = q[1];
      let gripX = openX;
      let gripY = openY;
      if (grip) {
        grip.point(...grip.layout.wrist, q);
        gripX = q[0];
        gripY = q[1];
      }
      let x = held ? gripX : openX;
      let y = held ? gripY : openY;
      const targetAmount = held ? 1 : 0;
      if (this.view !== view) {
        this.view = view;
        this.x = x;
        this.y = y;
        this.vx = this.vy = 0;
        this.move = null;
        this.amount = targetAmount;
        this.rate = 0;
        this.held = held;
      }
      if (held !== this.held) {
        this.move = {
          x: this.x,
          y: this.y,
          vx: this.vx,
          vy: this.vy,
          amount: this.amount,
          rate: this.rate,
          time: 0,
          duration: held ? 0.29 : 0.26,
        };
        this.held = held;
      }
      const m = this.move;
      if (m) {
        const t = clamp((m.time += dt) / m.duration);
        const f = t * t * (3 - 2 * t);
        const carry = m.duration * t * (1 - t) * (1 - t);
        x = m.x + (x - m.x) * f + m.vx * carry;
        y = m.y + (y - m.y) * f + m.vy * carry;
        this.amount = clamp(m.amount + (targetAmount - m.amount) * f + m.rate * carry);
        this.rate = ((targetAmount - m.amount) * 6 * t * (1 - t)) / m.duration + m.rate * (1 - t) * (1 - 3 * t);
        if (t === 1) {
          this.move = null;
          this.amount = targetAmount;
          this.rate = 0;
        }
      }
      const limit = view.handWidth * 1.7;
      this.vx = Math.max(-limit, Math.min(limit, (x - this.x) / dt));
      this.vy = Math.max(-limit, Math.min(limit, (y - this.y) / dt));
      this.x = x;
      this.y = y;
      hand.px += x - openX;
      hand.py += y - openY;
      if (grip) {
        grip.x += x - gripX;
        grip.y += y - gripY;
        if (this.amount > 0 && this.amount < 1) this.fit(hand, grip, this.amount, view.baseW);
        if (this.move) {
          hand.sleeveDrop += sleeveReach(hand, view, 459, 922);
          grip.sleeveDrop += sleeveReach(grip, view, ...grip.layout.bottom);
        }
      }
      const mix = clamp((this.amount - 0.28) / 0.48);
      return mix * mix * (3 - 2 * mix);
    }

    fit(hand, grip, amount, width) {
      const a = this.open;
      const b = this.cupped;
      const q = this.q;
      const { tips, knuckles, arm } = grip.layout;
      a.soft = b.soft = (width * 0.003) ** 2;
      for (let i = 0; i < tips.length; i++) {
        const f = hand.fingers[i];
        if (hand.articulated) hand.digitPoint(f.tip[0], f.tip[1], i, q);
        else q.set(f.tip);
        hand.point(q[0], q[1], a.xy, 2 * i);
        grip.point(...tips[i], b.xy, 2 * i);
        const k = 2 * (i + tips.length);
        const joint = i === 4 ? f.p : f.m;
        if (hand.articulated) hand.digitPoint(...joint, i, q);
        else q.set(joint);
        hand.point(q[0], q[1], a.xy, k);
        grip.point(...knuckles[i], b.xy, k);
      }
      for (let i = 0; i < openArm.length; i++) {
        const k = 2 * (i + tips.length + knuckles.length);
        hand.point(openArm[i][0], openArm[i][1], a.xy, k);
        grip.point(...arm[i], b.xy, k);
      }
      for (let i = 0; i < a.xy.length; i++) {
        const distance = b.xy[i] - a.xy[i];
        a.delta[i] = distance * amount;
        b.delta[i] = distance * (amount - 1);
      }
      hand.transition = a;
      grip.transition = b;
    }
  }

  return HandChangeImpl;
})();

const FurContact = (() => {
  const smooth = (lo, hi, x) => {
    const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
    return t * t * (3 - 2 * t);
  };

  function coatFringe(surface) {
    const { src, sw, sh } = surface;
    const start = Math.floor(sw * 0.19);
    const end = Math.ceil(sw * 0.74);
    const outline = new Float32Array(sw);
    const edge = new Float32Array(sw);
    const r = Math.max(4, Math.round(sw * 0.014));
    for (let x = start - r; x <= end + r; x++) {
      let y = Math.floor(sh * 0.84);
      while (y > sh * 0.47 && src[4 * (y * sw + x) + 3] < 155) y--;
      outline[x] = y;
    }
    let sum = 0;
    for (let x = start - r; x <= start + r; x++) sum += outline[x];
    for (let x = start; x < end; x++) {
      edge[x] = sum / (2 * r + 1);
      sum += outline[x + r + 1] - outline[x - r];
    }
    return { src, sw, edge };
  }

  function furAlpha(photo, x, y) {
    const { src, sw } = photo;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const i = 4 * (iy * sw + ix) + 3;
    const j = i + sw * 4;
    return (src[i] + fx * (src[i + 4] - src[i])) * (1 - fy) + (src[j] + fx * (src[j + 4] - src[j])) * fy;
  }

  function fringeAlpha(photo, u, edge, gap, scale, softness) {
    const base = 1 - smooth(-8, -2, gap / softness);
    const limit = 1 - smooth(3, 12, gap / softness);
    if (base >= 1 || limit <= 0) return 255 * base;
    const hair = furAlpha(photo, u, edge + (gap * scale * 0.9) / softness) / 255;
    const bed = 1 - smooth(-7, 8, gap / softness);
    return 255 * (base + (limit - base) * (0.72 * hair + 0.28 * bed));
  }

  function makeMargin(photo, image, left, top, tipX, tipY, axisX, axisY, digit) {
    const w = 183;
    const h = 176;
    const x0 = Math.floor(tipX - 58);
    const y0 = Math.floor(tipY - 37);
    const sampler = createOffscreen(w, h);
    const sg = sampler.getContext('2d');
    sg.drawImage(image, left - x0, top - y0);
    const skin = sg.getImageData(0, 0, w, h).data;
    const scale = photo.sw / 1517;
    const shapes = [sg.createImageData(w, h), sg.createImageData(w, h)];
    const digitScale = [1, 0.92, 0.99, 0.82, 0.79][digit];
    const submerge = [5, -8, 8, -12, -4][digit];
    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (let y = 1; y < h - 1; y++) {
      let lo = 1;
      let hi = w - 2;
      while (lo < w - 1 && skin[4 * (w * y + lo) + 3] < 120) lo++;
      while (hi > lo && skin[4 * (w * y + hi) + 3] < 120) hi--;
      for (let x = 1; x < w - 1; x++) {
        const dx = x + x0 - tipX;
        const dy = y + y0 - tipY;
        const along = dx * axisX + dy * axisY;
        const across = -dx * axisY + dy * axisX;
        if (along > 51 || along < -37 || Math.abs(across) > 35) continue;
        const depth = submerge + 0.28 * across + 0.01 * across * across;
        const u = photo.sw * (0.23 + 0.072 * digit) + across * scale;
        const ix = Math.floor(u);
        const f = u - ix;
        const baseline = photo.edge[ix] + f * (photo.edge[ix + 1] - photo.edge[ix]);
        const index = 4 * (w * y + x) + 3;
        const skinAlpha = skin[index] / 255;
        if (skinAlpha <= 0) continue;
        for (let level = 0; level < 2; level++) {
          const end = level ? depth : depth * 0.6 - 13;
          const opacity =
            fringeAlpha(photo, u, baseline, along - end, scale, 1.2) *
            (1 - smooth(27, 35, Math.abs(across))) *
            smooth(-37, -29, along) *
            skinAlpha;
          if (opacity < 1) continue;
          shapes[level].data[index] = opacity;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
      if (lo >= hi) continue;
      for (const side of [1, -1]) {
        const root = side > 0 ? lo : hi;
        if (root === 1 || root === w - 2) continue;
        const a = skin[4 * (w * y + root) + 3];
        const prior = skin[4 * (w * y + root - side) + 3];
        const rim = root - (side * (a - 120)) / Math.max(1, a - prior);
        const along = (rim + x0 - tipX) * axisX + (y + y0 - tipY) * axisY;
        const proximal = y + y0 - tipY;
        const upstream = side > 0;
        const sidePad =
          smooth(-27, upstream ? 2 : 14, along) *
          (1 - smooth(48, 112, along)) *
          smooth(upstream ? -25 : -9, upstream ? 9 : 21, proximal);
        if (sidePad < 0.012) continue;
        const strength = digitScale * (upstream ? 1 : 0.3) * sidePad;
        const softness = 0.38 + 0.62 * sidePad;
        const donor = photo.sw * (0.226 + 0.071 * digit + (upstream ? 0 : 0.026));
        const end = Math.min(58, hi - lo + 4);
        for (let step = -5; step <= end; step++) {
          const x = root + side * step;
          const depth = (x - rim) * side;
          if (x <= 0 || x >= w - 1) continue;
          const u = donor + (y - 0.36 * depth) * scale;
          const ix = Math.floor(u);
          const f = u - ix;
          const baseline = photo.edge[ix] + f * (photo.edge[ix + 1] - photo.edge[ix]);
          const index = 4 * (w * y + x) + 3;
          const rimOpacity = smooth(-5, -1, depth) * smooth(0, 0.25, sidePad) * (skin[index] / 255);
          for (let level = 0; level < 2; level++) {
            const reach = (level ? 20 : 9) * strength;
            const opacity = fringeAlpha(photo, u, baseline, depth - reach, scale, softness) * rimOpacity;
            if (opacity <= shapes[level].data[index] || opacity < 1) continue;
            shapes[level].data[index] = Math.min(opacity, 254);
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
      }
    }
    const bw = Math.max(1, maxX - minX + 1);
    const bh = Math.max(1, maxY - minY + 1);
    const beds = shapes.map((shape) => {
      const bed = createOffscreen(bw, bh);
      bed.getContext('2d').putImageData(shape, -minX, -minY, minX, minY, bw, bh);
      return bed;
    });
    return { beds, x0: x0 + minX, y0: y0 + minY, w: bw, h: bh, digit, tipX, tipY, m: new Float64Array(6) };
  }

  function restToScreen(hand, digit, x, y, q) {
    if (hand.articulated) {
      hand.digitPoint(x, y, digit, q);
      x = q[0];
      y = q[1];
    }
    hand.point(x, y, q);
  }

  function fitMargin(part, hand, q) {
    const { tipX: x, tipY: y, m, digit } = part;
    const span = 32;
    restToScreen(hand, digit, x, y, q);
    const ox = q[0];
    const oy = q[1];
    restToScreen(hand, digit, x + span, y, q);
    m[0] = (q[0] - ox) / span;
    m[1] = (q[1] - oy) / span;
    restToScreen(hand, digit, x, y + span, q);
    m[2] = (q[0] - ox) / span;
    m[3] = (q[1] - oy) / span;
    m[4] = ox + (part.x0 - x) * m[0] + (part.y0 - y) * m[2];
    m[5] = oy + (part.x0 - x) * m[1] + (part.y0 - y) * m[3];
  }

  class FurContactImpl {
    constructor() {
      this.q = new Float64Array(2);
      this.coats = new WeakMap();
    }

    draw(ctx, view, layer, cat, hand, input, altitude) {
      if (!cat.longCoat || !input || input.zone === 'tail' || altitude >= 0.94) return;
      const bearing = 1 - altitude;
      const load = smooth(0.02, 0.79, 0.62 * input.pressure + 0.38 * cat.tip.load);
      if (bearing * load < 0.01) return;
      if (!this.buffer) {
        this.buffer = createOffscreen(1, 1);
        this.ink = this.buffer.getContext('2d');
      }
      let parts = this.coats.get(cat.surface.img);
      if (!parts) {
        const fringe = coatFringe(cat.surface);
        parts = hand.fingers.map((f, i) => {
          const part = hand.parts[i];
          return makeMargin(fringe, part.tones[0], part.left, part.top, ...f.tip, -f.ax, -f.ay, i);
        });
        this.coats.set(cat.surface.img, parts);
      }
      const dpr = view.dpr;
      const canvasW = Math.max(1, Math.round(view.width * dpr));
      const canvasH = Math.max(1, Math.round(view.height * dpr));
      let x0 = view.width, y0 = view.height, x1 = 0, y1 = 0;
      for (const part of parts) {
        fitMargin(part, hand, this.q);
        const [a, b, c, d, x, y] = part.m;
        const xx = a * part.w;
        const xy = b * part.w;
        const yx = c * part.h;
        const yy = d * part.h;
        x0 = Math.min(x0, x + Math.min(0, xx) + Math.min(0, yx));
        x1 = Math.max(x1, x + Math.max(0, xx) + Math.max(0, yx));
        y0 = Math.min(y0, y + Math.min(0, xy) + Math.min(0, yy));
        y1 = Math.max(y1, y + Math.max(0, xy) + Math.max(0, yy));
      }
      const px = Math.max(0, Math.floor(x0 * dpr) - 1);
      const py = Math.max(0, Math.floor(y0 * dpr) - 1);
      const w = Math.min(canvasW, Math.ceil(x1 * dpr) + 1) - px;
      const h = Math.min(canvasH, Math.ceil(y1 * dpr) + 1) - py;
      if (w < 1 || h < 1) return;
      const buffer = this.buffer;
      const g = this.ink;
      if (buffer.width < w) buffer.width = Math.ceil(w / 32) * 32;
      if (buffer.height < h) buffer.height = Math.ceil(h / 32) * 32;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'source-over';
      g.clearRect(0, 0, w, h);
      const crown = input.skull ?? 0;
      const deep = smooth(0.16, 0.94, load) * (1 - 0.68 * crown);
      for (const part of parts) {
        const [a, b, c, d, x, y] = part.m;
        g.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, x * dpr - px, y * dpr - py);
        g.globalAlpha = bearing * load * (1 - 0.19 * crown);
        g.drawImage(part.beds[0], 0, 0);
        const loft = 0.96 + 0.04 * Math.sin(((x - view.x) * 86) / view.w + ((y - view.y) * 55) / view.h + part.tipX * 0.14);
        g.globalAlpha = bearing * deep * loft;
        g.drawImage(part.beds[1], 0, 0);
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-in';
      const sx = layer.width / (view.width * dpr);
      const sy = layer.height / (view.height * dpr);
      g.drawImage(layer, px * sx, py * sy, w * sx, h * sy, 0, 0, w, h);
      g.globalCompositeOperation = 'source-over';
      ctx.drawImage(buffer, 0, 0, w, h, px / dpr, py / dpr, w / dpr, h / dpr);
    }

    drawGL(glRenderer, view, cat, hand, input, altitude) {
      if (!cat.longCoat || !input || input.zone === 'tail' || altitude >= 0.94) return;
      const bearing = 1 - altitude;
      const load = smooth(0.02, 0.79, 0.62 * input.pressure + 0.38 * cat.tip.load);
      if (bearing * load < 0.01) return;
      let parts = this.coats.get(cat.surface.img);
      if (!parts) {
        const fringe = coatFringe(cat.surface);
        parts = hand.fingers.map((f, i) => {
          const part = hand.parts[i];
          return makeMargin(fringe, part.tones[0], part.left, part.top, ...f.tip, -f.ax, -f.ay, i);
        });
        this.coats.set(cat.surface.img, parts);
      }
      const gpu = cat.ensureGPU(glRenderer);
      const bodyTex = gpu.bodyTex;
      const bodyRect = cat.surface.bodyRect;
      const invW = 1 / view.w;
      const invH = 1 / view.h;
      const crown = input.skull ?? 0;
      const deep = smooth(0.16, 0.94, load) * (1 - 0.68 * crown);
      const verts = (this._glVerts ??= new Float32Array(36));
      for (const part of parts) {
        fitMargin(part, hand, this.q);
        const [a, b, c, d, x, y] = part.m;
        const px0 = x, py0 = y;
        const px1 = x + a * part.w, py1 = y + b * part.w;
        const px2 = x + c * part.h, py2 = y + d * part.h;
        const px3 = px1 + c * part.h, py3 = py1 + d * part.h;
        const u0 = (px0 - view.x) * invW, v0 = (py0 - view.y) * invH;
        const u1 = (px1 - view.x) * invW, v1 = (py1 - view.y) * invH;
        const u2 = (px2 - view.x) * invW, v2 = (py2 - view.y) * invH;
        const u3 = (px3 - view.x) * invW, v3 = (py3 - view.y) * invH;
        verts[0] = px0; verts[1] = py0; verts[2] = 0; verts[3] = 0; verts[4] = u0; verts[5] = v0;
        verts[6] = px1; verts[7] = py1; verts[8] = 1; verts[9] = 0; verts[10] = u1; verts[11] = v1;
        verts[12] = px2; verts[13] = py2; verts[14] = 0; verts[15] = 1; verts[16] = u2; verts[17] = v2;
        verts[18] = px2; verts[19] = py2; verts[20] = 0; verts[21] = 1; verts[22] = u2; verts[23] = v2;
        verts[24] = px1; verts[25] = py1; verts[26] = 1; verts[27] = 0; verts[28] = u1; verts[29] = v1;
        verts[30] = px3; verts[31] = py3; verts[32] = 1; verts[33] = 1; verts[34] = u3; verts[35] = v3;
        const alpha0 = bearing * load * (1 - 0.19 * crown) * 0.45;
        const shade = 1;
        glRenderer.drawFurContactQuad(glRenderer.getTexture(part.beds[0]), bodyTex, bodyRect, alpha0, shade, verts);
        const loft = 0.96 + 0.04 * Math.sin(((x - view.x) * 86) / view.w + ((y - view.y) * 55) / view.h + part.tipX * 0.14);
        const alpha1 = bearing * deep * loft * 0.40;
        glRenderer.drawFurContactQuad(glRenderer.getTexture(part.beds[1]), bodyTex, bodyRect, alpha1, shade, verts);
      }
    }
  }

  return FurContactImpl;
})();

module.exports = {
  sleeveReach,
  HandLayer,
  OverheadHand,
  TailHand,
  HandChange,
  FurContact,
};
