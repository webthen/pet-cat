const { ASSET_DIRECTORY } = require('./directory');

function createOffscreen(width = 1, height = 1) {
  const w = Math.max(1, Math.round(width || 1));
  const h = Math.max(1, Math.round(height || 1));
  return wx.createOffscreenCanvas({ type: '2d', width: w, height: h });
}

function getWindowMetrics() {
  if (typeof wx.getWindowInfo === 'function') {
    return wx.getWindowInfo();
  }
  return wx.getSystemInfoSync();
}

const kernelCache = new Map();
function gaussianKernel(sigma) {
  const key = Math.max(1, Math.round(sigma * 20));
  let entry = kernelCache.get(key);
  if (entry) return entry;
  const s = key / 20;
  const radius = Math.max(1, Math.ceil(s * 2.5));
  const weights = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * s * s));
    weights[i + radius] = w;
    sum += w;
  }
  for (let i = 0; i < weights.length; i++) weights[i] /= sum;
  entry = { radius, weights };
  kernelCache.set(key, entry);
  return entry;
}

let blurTemp = new Float32Array(0);
let blurOut = new Float32Array(0);

function ensureBlurBuffers(size) {
  if (blurTemp.length < size) {
    blurTemp = new Float32Array(size);
    blurOut = new Float32Array(size);
  }
}

/**
 * Separable Gaussian blur on a single-channel alpha array (0..255).
 * Uses zero-padding outside bounds to match Canvas 2D filter: blur().
 */
function blurAlphaValues(srcAlpha, width, height, sigma) {
  const len = width * height;
  if (sigma <= 0.05) {
    return new Uint8ClampedArray(srcAlpha);
  }
  const { radius, weights } = gaussianKernel(sigma);
  ensureBlurBuffers(len);
  const tmp = blurTemp;
  const out = blurOut;

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      const start = Math.max(-radius, -x);
      const end = Math.min(radius, width - 1 - x);
      for (let k = start; k <= end; k++) {
        acc += srcAlpha[row + x + k] * weights[k + radius];
      }
      tmp[row + x] = acc;
    }
  }

  // Vertical pass
  const res = new Uint8ClampedArray(len);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const start = Math.max(-radius, -y);
    const end = Math.min(radius, height - 1 - y);
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = start; k <= end; k++) {
        acc += tmp[(y + k) * width + x] * weights[k + radius];
      }
      out[row + x] = acc;
      res[row + x] = Math.round(acc);
    }
  }
  return res;
}

/**
 * Downsamples sourceCanvas into (w, h), blurs alpha by sigma, and returns Uint8ClampedArray(w*h).
 */
function alphaBlurFromCanvas(sourceCanvas, w, h, sigma) {
  const cn = createOffscreen(w, h);
  const g = cn.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.drawImage(sourceCanvas, 0, 0, w, h);
  const rgba = g.getImageData(0, 0, w, h).data;
  const alpha = new Uint8ClampedArray(w * h);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = rgba[i * 4 + 3];
  }
  return blurAlphaValues(alpha, w, h, sigma);
}

/**
 * Draws srcCanvas into dstCanvas (already sized), blurs its alpha, and tints with (r, g, b).
 * Avoids Canvas 2D ctx.filter and source-in compatibility quirks across mobile clients.
 */
function tintBlurIntoCanvas(srcCanvas, dstCanvas, dstCtx, sigma, r, g, b) {
  const w = dstCanvas.width;
  const h = dstCanvas.height;
  dstCtx.setTransform(1, 0, 0, 1, 0, 0);
  dstCtx.clearRect(0, 0, w, h);
  dstCtx.drawImage(srcCanvas, 0, 0, w, h);
  const imgData = dstCtx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const len = w * h;
  const alpha = new Uint8ClampedArray(len);
  for (let i = 0; i < len; i++) alpha[i] = data[i * 4 + 3];
  const blurred = blurAlphaValues(alpha, w, h, sigma);
  for (let i = 0, p = 0; i < len; i++, p += 4) {
    const a = blurred[i];
    if (a === 0) {
      data[p] = 0;
      data[p + 1] = 0;
      data[p + 2] = 0;
      data[p + 3] = 0;
    } else {
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = a;
    }
  }
  dstCtx.putImageData(imgData, 0, 0);
}

/**
 * Blurs a single-channel alpha mask and outputs an OffscreenCanvas tinted with (r, g, b).
 */
function createBlurredTintCanvas(alphaMask, width, height, sigma, r, g, b) {
  const blurred = blurAlphaValues(alphaMask, width, height, sigma);
  const cn = createOffscreen(width, height);
  const ctx = cn.getContext('2d');
  const imgData = ctx.createImageData(width, height);
  const data = imgData.data;
  for (let i = 0, p = 0; i < blurred.length; i++, p += 4) {
    const a = blurred[i];
    if (a > 0) {
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = a;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  cn._rgbaData = data;
  return cn;
}

function downsampleAlpha(srcAlpha, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
    const sRow = sy * sw;
    const dRow = y * dw;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
      out[dRow + x] = srcAlpha[sRow + sx];
    }
  }
  return out;
}

function samplePhotoRgba(spec, targetW, targetH) {
  const cn = createOffscreen(targetW, targetH);
  const g = cn.getContext('2d');
  g.clearRect(0, 0, targetW, targetH);
  if (spec && (spec.canvas || typeof spec.getContext === 'function')) {
    const src = spec.canvas || spec;
    g.drawImage(src, 0, 0, targetW, targetH);
  } else if (spec && spec.img) {
    g.drawImage(
      spec.img,
      (spec.x * targetW) / spec.fullW,
      (spec.y * targetH) / spec.fullH,
      (spec.w * targetW) / spec.fullW,
      (spec.h * targetH) / spec.fullH
    );
  } else if (spec) {
    g.drawImage(spec, 0, 0, targetW, targetH);
  }
  return g.getImageData(0, 0, targetW, targetH).data;
}

function silverTabby(photo, tail) {
  const fullW = photo.fullW || photo.width;
  const fullH = photo.fullH || photo.height;
  const w = tail ? fullW : Math.min(fullW, 760);
  const h = tail ? fullH : Math.round((w * fullH) / fullW);
  const canvas = createOffscreen(w, h);
  const ctx = canvas.getContext('2d');
  if (photo.img) {
    ctx.drawImage(
      photo.img,
      (photo.x * w) / photo.fullW,
      (photo.y * h) / photo.fullH,
      (photo.w * w) / photo.fullW,
      (photo.h * h) / photo.fullH
    );
  } else {
    ctx.drawImage(photo.canvas || photo, 0, 0, w, h);
  }
  const frame = ctx.getImageData(0, 0, w, h);
  const pixels = frame.data;
  const source = [0, 32, 52, 66, 80, 94, 108, 127, 150, 180, 220, 255];
  const silver = [8, 18, 31, 49, 77, 112, 145, 174, 200, 223, 238, 248];
  const tones = new Uint8ClampedArray(768);
  for (let v = 0, j = 1; v < 256; v++) {
    while (v > source[j]) j++;
    const l = silver[j - 1] + ((v - source[j - 1]) / (source[j] - source[j - 1])) * (silver[j] - silver[j - 1]);
    tones[3 * v] = l + 0.6 - (2.3 * l) / 255;
    tones[3 * v + 1] = l + 1;
    tones[3 * v + 2] = l + 0.9 - (0.3 * l) / 255;
  }
  const earA = new Float32Array(w);
  const earB = new Float32Array(w);
  if (!tail) {
    for (let i = 0; i < w; i++) {
      const x = ((i + 0.5) * 1517) / w - 0.5;
      earA[i] = Math.exp(-(((x - 214) / 48) ** 2));
      earB[i] = Math.exp(-(((x - 192) / 51) ** 2));
    }
  }
  for (let j = 0, i = 0; j < h; j++) {
    const y = ((j + 0.5) * 935) / h - 0.5;
    const a = tail ? 0 : Math.exp(-(((y - 309) / 46) ** 2));
    const b = tail ? 0 : Math.exp(-(((y - 580) / 26) ** 2));
    for (let k = 0; k < w; k++, i += 4) {
      if (!pixels[i + 3]) continue;
      const t = 3 * ((54 * pixels[i] + 183 * pixels[i + 1] + 19 * pixels[i + 2] + 128) >> 8);
      const ear = Math.max(earA[k] * a, earB[k] * b);
      pixels[i] = tones[t] + 18 * ear;
      pixels[i + 1] = tones[t + 1] - 12 * ear;
      pixels[i + 2] = tones[t + 2] - 10 * ear;
    }
  }
  ctx.putImageData(frame, 0, 0);
  canvas._rgbaData = pixels;
  return {
    canvas,
    rgbaData: pixels,
    rect: [0, 0, 1, 1],
    x: 0,
    y: 0,
    w,
    h,
    fullW: w,
    fullH: h,
    width: w,
    height: h,
  };
}

function loadImageDirect(loaderCanvas, src, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const img = loaderCanvas.createImage();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Image load timeout: ' + src));
    }, timeoutMs);
    img.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err || new Error('Failed to load image: ' + src));
    };
    img.src = src;
  });
}

function getImageInfoAsync(src) {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined' || typeof wx.getImageInfo !== 'function') {
      reject(new Error('getImageInfo unavailable'));
      return;
    }
    wx.getImageInfo({
      src,
      success: (res) => (res && res.path ? resolve(res.path) : reject(new Error('Empty getImageInfo path'))),
      fail: (err) => reject(err || new Error('getImageInfo failed: ' + src)),
    });
  });
}

function readPackageFileBase64(src) {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined' || typeof wx.getFileSystemManager !== 'function') {
      reject(new Error('FileSystemManager unavailable'));
      return;
    }
    const fs = wx.getFileSystemManager();
    const tryPath = (filePath, nextPath) => {
      fs.readFile({
        filePath,
        encoding: 'base64',
        success: (res) => (res && res.data ? resolve(res.data) : reject(new Error('Empty base64'))),
        fail: (err) => {
          if (nextPath) tryPath(nextPath, null);
          else reject(err || new Error('readFile failed: ' + filePath));
        },
      });
    };
    const trimmed = src.replace(/^\/+/, '');
    tryPath(src, trimmed !== src ? trimmed : null);
  });
}

function ensureCachedWebpFile(name, base64) {
  return new Promise((resolve, reject) => {
    if (
      typeof wx === 'undefined' ||
      typeof wx.getFileSystemManager !== 'function' ||
      !wx.env?.USER_DATA_PATH
    ) {
      reject(new Error('Temp file cache unavailable'));
      return;
    }
    const filePath = `${wx.env.USER_DATA_PATH}/pet_cat_v1_${name}.webp`;
    const fs = wx.getFileSystemManager();
    fs.access({
      path: filePath,
      success: () => resolve(filePath),
      fail: () => {
        try {
          fs.writeFile({
            filePath,
            data: base64,
            encoding: 'base64',
            success: () => resolve(filePath),
            fail: (err) => reject(err || new Error('writeFile failed')),
          });
        } catch (err) {
          reject(err);
        }
      },
    });
  });
}

async function loadImageFromBase64(loaderCanvas, name, base64) {
  try {
    const cachedPath = await ensureCachedWebpFile(name, base64);
    return await loadImageDirect(loaderCanvas, cachedPath, 2500);
  } catch (_) {
    return loadImageDirect(loaderCanvas, `data:image/webp;base64,${base64}`);
  }
}

async function loadImage(loaderCanvas, srcOrSpec, name = 'asset') {
  if (srcOrSpec && typeof srcOrSpec === 'object' && srcOrSpec.base64) {
    return loadImageFromBase64(loaderCanvas, name, srcOrSpec.base64);
  }
  const src = String(srcOrSpec);
  if (src.startsWith('data:')) {
    return loadImageDirect(loaderCanvas, src);
  }
  const normalized = src.startsWith('/') ? src : '/' + src.replace(/^(\.\.\/)+/, '');
  const noSlash = normalized.replace(/^\/+/, '');
  const candidates = [src];
  if (normalized !== src) candidates.push(normalized);
  if (noSlash !== src && noSlash !== normalized) candidates.push(noSlash);

  let lastErr = null;
  for (const cand of candidates) {
    try {
      return await loadImageDirect(loaderCanvas, cand);
    } catch (e) {
      lastErr = e;
    }
  }

  for (const cand of [normalized, noSlash]) {
    try {
      const tempPath = await getImageInfoAsync(cand);
      return await loadImageDirect(loaderCanvas, tempPath);
    } catch (e) {
      lastErr = e;
    }
  }

  try {
    const b64 = await readPackageFileBase64(normalized);
    const ext = normalized.endsWith('.png') ? 'png' : 'webp';
    return await loadImageDirect(loaderCanvas, `data:image/${ext};base64,${b64}`);
  } catch (e) {
    lastErr = e;
  }

  throw lastErr || new Error('Failed to load image: ' + src);
}

function createPhotoReader(loaderCanvas, resolvePath) {
  const originals = new Map();

  async function decodePhoto(name) {
    const entry = ASSET_DIRECTORY[name];
    if (!entry) throw new Error('Unknown photo asset ' + name);
    const [x, y, w, h, W, H] = entry;
    const img = await loadImage(loaderCanvas, resolvePath(name), name);
    if (name === 'room') return img;
    if (name === 'hand-slim' || name === 'grip-slim') {
      const c = createOffscreen(W, H);
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';
      g.drawImage(img, x, y, w, h);
      return c;
    }
    return {
      img,
      rect: [x / W, y / H, w / W, h / H],
      x,
      y,
      w,
      h,
      fullW: W,
      fullH: H,
      width: W,
      height: H,
    };
  }

  function original(name) {
    if (!originals.has(name)) {
      originals.set(
        name,
        decodePhoto(name).catch((e) => {
          originals.delete(name);
          throw e;
        })
      );
    }
    return originals.get(name);
  }

  async function readPhoto(name) {
    if (ASSET_DIRECTORY[name]) return original(name);
    if (name === 'saba' || name === 'saba-tail') {
      const tail = name.endsWith('-tail');
      return silverTabby(await original(tail ? 'mugi-tail' : 'mugi'), tail);
    }
    throw new Error('Unknown coat ' + name);
  }

  return { readPhoto };
}

module.exports = {
  createOffscreen,
  getWindowMetrics,
  blurAlphaValues,
  alphaBlurFromCanvas,
  tintBlurIntoCanvas,
  createBlurredTintCanvas,
  downsampleAlpha,
  samplePhotoRgba,
  silverTabby,
  loadImage,
  createPhotoReader,
};
