function breathBand(gain, a1, a2, b1, b2) {
  let z1 = 0, z2 = 0, w1 = 0, w2 = 0;
  return () => {
    const x = gain * (2 * Math.random() - 1);
    const y = x + z1;
    z1 = 2 * x - a1 * y + z2;
    z2 = x - a2 * y;
    const out = y + w1;
    w1 = -2 * y - b1 * out + w2;
    w2 = y - b2 * out;
    return out;
  };
}

function generatePurr24k(seconds = 6) {
  const rate = 24000;
  const len = Math.round(seconds * rate);
  const data = new Float32Array(len);
  const throatNoise = breathBand(0.031123062, -1.840968141, 0.858616601, -1.968871069, 0.96963571);
  const airNoise = breathBand(0.045636007, -1.796412445, 0.83151183, -1.941966293, 0.945405516);
  const drift = 'ULHHNTVELQZWEPWNBXNTXJIFZOVAEDRMQYRCZBWNUCRXWQGLFYEMHUFFAICVOKFVULWOOZHJRBNEISTXRYFGWGQAONCBBGJGDGZC';
  const tau = 2 * Math.PI;
  let phase = 0;
  let noise = 0;
  for (let i = 0; i < len; i++) {
    const t = i / rate;
    const a = Math.sin((t * tau) / 3);
    const b = Math.sin(tau * (t / 3 + 0.07 * Math.sin((t * tau) / 6)));
    const pos = ((t % 6) + 1) / 0.11;
    const j = Math.floor(pos) % (drift.length - 1);
    const v = drift.charCodeAt(j);
    const wobble = (v - 65 + (drift.charCodeAt(j + 1) - v) * (pos - Math.floor(pos))) * 0.056 - 0.7;
    phase += (tau * (24.1 + 0.725 * a + 0.175 * Math.sin((t * tau) / 1.5) + 0.7 * b + 0.3 * wobble)) / rate;
    const h = Math.sin(phase);
    const pulse = (1 + h) * 0.5;
    const sq = pulse * pulse;
    const cube = sq * pulse;
    noise = 0.6561 * noise + 0.2432 * (2 * Math.random() - 1);
    const bright = 0.28 * h + 0.16 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase);
    const deep =
      0.35 * h +
      0.19 * Math.sin(2 * phase + 0.2) +
      0.064 * Math.sin(3 * phase + 0.4) +
      0.038 * Math.sin(4 * phase + 0.6) +
      0.023 * Math.sin(5 * phase + 0.8);
    const aVoice = (bright * (0.6 + 0.4 * cube) + noise * (0.2 + 0.74 * cube)) * (0.31 + 0.4 * Math.abs(a) + 0.19 * Math.max(0, a));
    const rasp = 0.043 * throatNoise() * (0.38 + 0.62 * sq);
    const air = 0.009 * airNoise() * (0.18 + 0.82 * Math.max(0, -b) ** 2);
    const bVoice = (deep * (0.69 + 0.31 * sq) + rasp + air) * (0.37 + 0.38 * Math.abs(b) + 0.16 * Math.max(0, b));
    const edge = Math.min(1, i / (rate * 0.06), (len - 1 - i) / (rate * 0.06));
    data[i] = 0.5 * (aVoice + bVoice) * edge;
  }
  return data;
}

function lowpass590(samples, rate) {
  const w0 = (2 * Math.PI * 590) / rate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / Math.SQRT2;
  const a0 = 1 + alpha;
  const b0 = ((1 - cosw) / 2) / a0;
  const b1 = (1 - cosw) / a0;
  const b2 = b0;
  const a1 = (-2 * cosw) / a0;
  const a2 = (1 - alpha) / a0;
  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
  return out;
}

function resampleLinear(src, srcRate, dstRate) {
  if (srcRate === dstRate) return src;
  const dstLen = Math.round((src.length * dstRate) / srcRate);
  const out = new Float32Array(dstLen);
  const ratio = (src.length - 1) / Math.max(1, dstLen - 1);
  for (let i = 0; i < dstLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = src[idx];
    const s1 = src[Math.min(src.length - 1, idx + 1)];
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

function encodeWav(samples, rate, gain = 1) {
  const len = samples.length;
  const buffer = new ArrayBuffer(44 + len * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + len * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] * gain));
    view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return buffer;
}

class Purr {
  constructor() {
    this.enabled = false;
    this.hidden = false;
    this.context = null;
    this.source = null;
    this.low = null;
    this.clip = null;
    this.gain = null;
    this.innerAudio = null;
    this.canPlay = false;
    this.wavPath = null;
    this.target = 0;
    this.currentVol = 0;
    this.lastVolUpdateMs = 0;
  }

  _initInnerAudio() {
    if (typeof wx.createInnerAudioContext !== 'function' || typeof wx.getFileSystemManager !== 'function' || !wx.env?.USER_DATA_PATH) {
      throw new Error('InnerAudioContext unavailable');
    }
    if (typeof wx.setInnerAudioOption === 'function') {
      try {
        wx.setInnerAudioOption({ obeyMuteSwitch: false });
      } catch (_) {}
    }
    const fs = wx.getFileSystemManager();
    const filePath = `${wx.env.USER_DATA_PATH}/pet_cat_purr_24k_v2.wav`;
    let exists = false;
    try {
      if (typeof fs.accessSync === 'function') {
        fs.accessSync(filePath);
        exists = true;
      }
    } catch (_) {}
    if (!exists) {
      const filtered24k = lowpass590(generatePurr24k(6), 24000);
      const wav = encodeWav(filtered24k, 24000, 2.0);
      try {
        fs.writeFileSync(filePath, wav, 'binary');
      } catch (_) {
        fs.writeFileSync(filePath, wav);
      }
    }
    this.wavPath = filePath;

    const inner = wx.createInnerAudioContext();
    inner.obeyMuteSwitch = false;
    inner.loop = true;
    inner.volume = 0;
    inner.onCanplay(() => {
      if (this.canPlay) return;
      this.canPlay = true;
      if (this.enabled && !this.hidden) {
        try {
          inner.play();
        } catch (_) {}
      }
    });
    inner.onError((err) => {
      console.warn('InnerAudio error, switching to WebAudio fallback:', err);
      if (this.innerAudio === inner) {
        try {
          inner.destroy();
        } catch (_) {}
        this.innerAudio = null;
        this.canPlay = false;
        if (this.enabled) {
          this._initWebAudio().catch(() => {});
        }
      }
    });
    inner.src = filePath;
    this.innerAudio = inner;
  }

  async _initWebAudio() {
    if (typeof wx.createWebAudioContext !== 'function') {
      throw new Error('WebAudioContext unavailable');
    }
    const ctx = wx.createWebAudioContext();
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try {
        await Promise.resolve(ctx.resume());
      } catch (_) {}
    }

    const raw24k = generatePurr24k();
    const rate = ctx.sampleRate || 44100;
    const useFilterNode = typeof ctx.createBiquadFilter === 'function';
    const filtered24k = useFilterNode ? raw24k : lowpass590(raw24k, 24000);
    const resampled = resampleLinear(filtered24k, 24000, rate);

    const clip = ctx.createBuffer(1, resampled.length, rate);
    if (typeof clip.copyToChannel === 'function') {
      clip.copyToChannel(resampled, 0);
    } else {
      clip.getChannelData(0).set(resampled);
    }

    const source = ctx.createBufferSource();
    source.buffer = clip;
    source.loop = true;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    if (useFilterNode) {
      const low = ctx.createBiquadFilter();
      low.type = 'lowpass';
      low.frequency.value = 590;
      source.connect(low);
      low.connect(gain);
      this.low = low;
    } else {
      source.connect(gain);
    }
    gain.connect(ctx.destination);
    source.start(0);

    this.context = ctx;
    this.clip = clip;
    this.source = source;
    this.gain = gain;
  }

  prepareWav() {
    if (typeof wx.getFileSystemManager !== 'function' || !wx.env?.USER_DATA_PATH) return;
    const fs = wx.getFileSystemManager();
    const filePath = `${wx.env.USER_DATA_PATH}/pet_cat_purr_24k_v2.wav`;
    try {
      if (typeof fs.accessSync === 'function') {
        fs.accessSync(filePath);
        return;
      }
    } catch (_) {}
    const filtered24k = lowpass590(generatePurr24k(6), 24000);
    const wav = encodeWav(filtered24k, 24000, 2.0);
    try {
      fs.writeFileSync(filePath, wav, 'binary');
    } catch (_) {
      try {
        fs.writeFileSync(filePath, wav);
      } catch (_) {}
    }
  }

  async toggle() {
    if (!this.innerAudio && !this.context) {
      try {
        this._initInnerAudio();
      } catch (_) {
        await this._initWebAudio();
      }
    }

    if (this.context && typeof this.context.resume === 'function') {
      try {
        await Promise.resolve(this.context.resume());
      } catch (_) {}
    }

    this.enabled = !this.enabled;
    if (this.innerAudio) {
      if (this.enabled && !this.hidden) {
        try {
          this.innerAudio.play();
        } catch (_) {}
      } else {
        try {
          this.innerAudio.pause();
        } catch (_) {}
      }
    }
    this.update(0, true);
    return this.enabled;
  }

  setHidden(hidden) {
    this.hidden = hidden;
    if (this.innerAudio) {
      if (hidden || !this.enabled) {
        try {
          this.innerAudio.pause();
        } catch (_) {}
      } else {
        try {
          this.innerAudio.play();
        } catch (_) {}
      }
    }
    this.update(0, true);
  }

  update(value, immediate = false) {
    if (!this.context && !this.innerAudio) return;
    if (this.innerAudio) {
      const target = this.enabled && !this.hidden ? Math.min(1, 0.08 + 0.72 * value) : 0;
      this.target = target;
      const step = immediate ? 1 : 0.18;
      this.currentVol += (target - this.currentVol) * step;
      const clamped = Math.max(0, Math.min(1, this.currentVol));
      const now = Date.now();
      if (immediate || Math.abs(clamped - (this.lastSentVol ?? -1)) > 0.035 || now - this.lastVolUpdateMs >= 65) {
        this.lastVolUpdateMs = now;
        this.lastSentVol = clamped;
        this.innerAudio.volume = clamped;
      }
      return;
    }

    if (this.context && this.gain) {
      const target = this.enabled && !this.hidden ? 0.06 + 0.65 * value : 0;
      if (immediate || Math.abs(target - (this.target ?? -1)) > 0.008) {
        this.target = target;
        const param = this.gain.gain;
        if (typeof param.setTargetAtTime === 'function') {
          try {
            param.setTargetAtTime(target, this.context.currentTime, immediate ? 0.1 : 0.24);
            return;
          } catch (_) {}
        }
        param.value = target;
      }
    }
  }

  destroy() {
    if (this.source && typeof this.source.stop === 'function') {
      try {
        this.source.stop();
      } catch (_) {}
    }
    if (this.context && typeof this.context.close === 'function') {
      try {
        this.context.close();
      } catch (_) {}
    }
    if (this.innerAudio) {
      try {
        this.innerAudio.stop();
        this.innerAudio.destroy();
      } catch (_) {}
    }
    this.context = null;
    this.source = null;
    this.low = null;
    this.clip = null;
    this.gain = null;
    this.innerAudio = null;
    this.wavPath = null;
  }
}

module.exports = { Purr };
