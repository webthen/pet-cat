const { CAT_LIST } = require('../../utils/directory');
const { getCatAssetBase64 } = require('../../utils/cat-assets');
const { getWindowMetrics, createPhotoReader } = require('../../utils/canvas-compat');
const { OverheadCat } = require('../../utils/overhead-cat');
const { OverheadHand, TailHand, HandChange, FurContact } = require('../../utils/hand-renderer');
const { GLRenderer } = require('../../utils/gl-renderer');
const { getMoonlightCanvas } = require('../../utils/moonlight');
const { Purr } = require('../../utils/purr-audio');
const { getIcons } = require('../../utils/icons');

const THEME_STORAGE_KEY = 'pet-the-cat-theme';
const PROP_STORAGE_KEY = 'pet-the-cat.proportions.shared';
const SIZES = [65, 72, 79, 86, 93, 100, 103, 106, 108, 111, 114];
const WIDTHS = [80, 84, 88, 92, 96, 100, 108, 116, 124, 132, 140];
const HOME = { u: 0.4, v: 0.555 };
const HELD_PRESSURE = 0.9;

const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const follow = (a, b, dt, seconds) => a + (b - a) * -Math.expm1(-dt / seconds);
const smooth = (t) => t * t * (3 - 2 * t);

function closestStep(value, stops) {
  if (!Number.isFinite(value)) return 5;
  return stops.reduce((best, stop, i) => (Math.abs(stop - value) < Math.abs(stops[best] - value) ? i : best), 0);
}

function getPlatform() {
  try {
    if (typeof wx.getDeviceInfo === 'function') return wx.getDeviceInfo().platform || '';
    return wx.getSystemInfoSync().platform || '';
  } catch (_) {
    return '';
  }
}

function getHeaderMetrics() {
  const win = getWindowMetrics();
  let statusBarHeight = Math.max(20, Math.round(win.windowHeight * 0.03));
  let menuTop = statusBarHeight + 4;
  let menuHeight = 32;
  let menuRight = 108;
  try {
    const sys = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
    if (sys && sys.statusBarHeight) {
      statusBarHeight = sys.statusBarHeight;
      menuTop = statusBarHeight + 4;
    }
    if (typeof wx.getMenuButtonBoundingClientRect === 'function') {
      const rect = wx.getMenuButtonBoundingClientRect();
      if (rect && rect.height > 0 && rect.left > 0) {
        menuTop = rect.top || menuTop;
        menuHeight = rect.height || menuHeight;
        menuRight = Math.max(14, Math.round((win.windowWidth || sys.windowWidth || 375) - rect.left + 14));
      }
    }
  } catch (_) {}
  return {
    statusBarPx: statusBarHeight,
    headerTopPx: menuTop,
    headerHeightPx: menuHeight,
    headerRightPx: menuRight,
  };
}

function getSystemTheme() {
  try {
    if (typeof wx.getAppBaseInfo === 'function') {
      const t = wx.getAppBaseInfo().theme;
      if (t === 'dark' || t === 'light') return t;
    }
    const sys = wx.getSystemInfoSync();
    if (sys && (sys.theme === 'dark' || sys.theme === 'light')) return sys.theme;
  } catch (_) {}
  return 'light';
}

Page({
  data: {
    cats: CAT_LIST,
    selected: 'kuro',
    selectedIndex: 1,
    currentCatName: '黑猫',
    moonlit: false,
    soundOn: false,
    landscape: false,
    softRotated: false,
    closeUp: false,
    ready: false,
    loadFailed: false,
    proportionsOpen: false,
    showHint: false,
    sizeIndex: 5,
    widthIndex: 5,
    statusBarPx: 24,
    headerTopPx: 28,
    headerHeightPx: 32,
    headerRightPx: 108,
    icons: getIcons(false),
  },

  onLoad() {
    let storedTheme = null;
    try {
      const t = wx.getStorageSync(THEME_STORAGE_KEY);
      if (t === 'dark' || t === 'light') storedTheme = t;
    } catch (_) {}
    const theme = storedTheme || getSystemTheme();
    const moonlit = theme === 'dark';

    let sizeIndex = 5;
    let widthIndex = 5;
    try {
      const saved = wx.getStorageSync(PROP_STORAGE_KEY);
      if (saved && typeof saved === 'object') {
        sizeIndex = closestStep(saved.size, SIZES);
        widthIndex = closestStep(saved.width, WIDTHS);
      }
    } catch (_) {}

    this._catScale = SIZES[sizeIndex] / 100;
    this._thickness = WIDTHS[widthIndex] / 100;
    this._isTouchPlatform = ['ios', 'android'].includes(getPlatform());
    const header = getHeaderMetrics();

    this.setData({
      moonlit,
      sizeIndex,
      widthIndex,
      ...header,
      icons: getIcons(moonlit),
    });
    this._applyNavTheme(moonlit);

    if (typeof wx.onThemeChange === 'function') {
      this._onSystemThemeChange = (res) => {
        if (!res || (res.theme !== 'dark' && res.theme !== 'light')) return;
        this._setTheme(res.theme === 'dark', false);
      };
      wx.onThemeChange(this._onSystemThemeChange);
    }
  },

  onReady() {
    this._initEngine();
  },

  onShow() {
    if (this._purr) this._purr.setHidden(false);
    this._hidden = false;
    this._lastMs = 0;
    if (this._canvas && !this._rafId) {
      this._scheduleFrame();
    }
  },

  onHide() {
    this._hidden = true;
    this._endTouch();
    this._lastMs = 0;
    if (this._purr) this._purr.setHidden(true);
    this._cancelFrame();
  },

  onUnload() {
    this._destroyed = true;
    this._cancelFrame();
    if (this._onSystemThemeChange && typeof wx.offThemeChange === 'function') {
      wx.offThemeChange(this._onSystemThemeChange);
    }
    if (this._purr) this._purr.destroy();
    if (this._catCache && this._glRenderer) {
      for (const entry of this._catCache.values()) {
        if (entry && entry.gpu) {
          this._glRenderer.deleteTexture(entry.gpu.bodyTex);
          this._glRenderer.deleteTexture(entry.gpu.tailTex);
          this._glRenderer.deleteTexture(entry.gpu.furTex);
          this._glRenderer.deleteTexture(entry.gpu.shadowTex);
        }
      }
      this._catCache.clear();
    }
    if (this._glRenderer) {
      this._glRenderer.destroy();
      this._glRenderer = null;
    }
  },

  onResize() {
    this._updateRotationFlag();
    this.setData(getHeaderMetrics());
    setTimeout(() => this._measureAndLayout(), 60);
  },

  onShareAppMessage() {
    return {
      title: `快来一起撸${this.data.currentCatName}～`,
      path: '/pages/index/index',
    };
  },

  onShareTimeline() {
    return {
      title: '撸猫模拟器 - 治愈系互动撸猫',
    };
  },

  _applyNavTheme(moonlit) {
    const bg = moonlit ? '#101722' : '#fbf5ec';
    const front = moonlit ? '#ffffff' : '#000000';
    wx.setNavigationBarColor({
      frontColor: front,
      backgroundColor: bg,
      animation: { duration: 180, timingFunc: 'easeInOut' },
    });
    if (typeof wx.setBackgroundColor === 'function') {
      wx.setBackgroundColor({
        backgroundColor: bg,
        backgroundColorTop: bg,
        backgroundColorBottom: bg,
      });
    }
    if (typeof wx.setBackgroundTextStyle === 'function') {
      wx.setBackgroundTextStyle({ textStyle: moonlit ? 'light' : 'dark' });
    }
  },

  _setTheme(moonlit, persist = true) {
    this.setData({
      moonlit,
      icons: getIcons(moonlit),
    });
    this._applyNavTheme(moonlit);
    if (persist) {
      try {
        wx.setStorageSync(THEME_STORAGE_KEY, moonlit ? 'dark' : 'light');
      } catch (_) {}
    }
    if (this._ready) this._paint(0.001);
  },

  _initEngine() {
    wx.createSelectorQuery()
      .in(this)
      .select('#scene')
      .fields({ node: true, size: true, rect: true })
      .exec((res) => {
        const info = res && res[0];
        if (!info || !info.node) {
          this.setData({ loadFailed: true });
          return;
        }
        this._canvas = info.node;
        try {
          this._glRenderer = new GLRenderer(this._canvas);
        } catch (err) {
          console.error('WebGL init failed:', err);
          this.setData({ loadFailed: true });
          return;
        }
        this._stageRect = {
          left: info.left || 0,
          top: info.top || 0,
          right: (info.left || 0) + (info.width || 0),
          bottom: (info.top || 0) + (info.height || 0),
          width: info.width || 0,
          height: info.height || 0,
        };

        this._cat = new OverheadCat();
        this._cat.setThickness(this._thickness);
        this._catCache = new Map();
        this._handChange = new HandChange();
        this._furContact = new FurContact();
        this._purr = new Purr();
        this._photoReader = createPhotoReader(this._canvas, (name) => ({ base64: getCatAssetBase64(name) }));

        this._requestId = 0;
        this._ready = false;
        this._room = null;
        this._hand = null;
        this._tailHand = null;
        this._tailHandPromise = null;
        this._selectedKey = this.data.selected;
        this._loadedKey = null;

        this._resetPointerState();
        this._updateRotationFlag();
        this._computeLayout(this._stageRect);
        this._loadAll();
        this._scheduleFrame();
      });
  },

  _resetPointerState() {
    this._handChange?.reset();
    this._passedTip = false;
    this._tailAnchor = false;
    this._returningToBody = false;
    this._area = 'back';
    this._edgePointer = null;
    this._edgeMoved = false;
    this._operator = null;
    this._previousInput = null;
    this._lastMoveMs = 0;
    this._activeTouchId = null;
    this._pendingTouch = null;
    this._down = true;
    this._over = true;
    this._mode = 'rest';
    this._age = 0;
    this._origin = { ...HOME };
    this._startHeight = 0;
    this._retreat = 0;
    this._pad = { ...HOME };
    this._target = { ...HOME };
    this._tuck = 0;
    this._lastTouch = null;
    this._force = null;
    this._pressure = HELD_PRESSURE;
    this._altitude = 0;
    this._vx = 0;
    this._vy = 0;
  },

  _updateRotationFlag() {
    const win = getWindowMetrics();
    const isPortrait = win.windowWidth < win.windowHeight;
    const softRotated = Boolean(this.data.landscape && isPortrait);
    if (softRotated !== this.data.softRotated) {
      this.setData({ softRotated });
    }
    return softRotated;
  },

  _measureAndLayout() {
    if (!this._canvas) return;
    wx.createSelectorQuery()
      .in(this)
      .select('#stage')
      .boundingClientRect((rect) => {
        if (!rect || rect.width < 1 || rect.height < 1) return;
        this._stageRect = rect;
        this._computeLayout(rect);
      })
      .exec();
  },

  _computeLayout(rect) {
    if (!rect || rect.width < 1 || rect.height < 1) return;
    const win = getWindowMetrics();
    const softRotated = this.data.softRotated;
    const r = softRotated ? { width: rect.height, height: rect.width } : { width: rect.width, height: rect.height };
    const pixelRatio = win.pixelRatio || 1;
    const dpr = Math.min(pixelRatio, 2.2, 2000 / Math.max(r.width, r.height));
    const isLandscapeView = this.data.landscape || win.windowWidth > win.windowHeight;
    const closeUp = Boolean(this.data.closeUp && !isLandscapeView);
    const topCrop = isLandscapeView ? 0.1 : 0;
    const framedHeight = r.height / (1 - topCrop);
    let zoom = Math.max(r.width / 1517, framedHeight / 935);
    let roomW = 1517 * zoom;
    let roomH = 935 * zoom;
    let roomX = (r.width - roomW) / 2;
    let roomY = (framedHeight - roomH) / 2 - (framedHeight - r.height);
    if (!isLandscapeView) {
      if (closeUp) {
        zoom = Math.max(r.width / (1517 * 0.68), framedHeight / 935);
        roomW = 1517 * zoom;
        roomH = 935 * zoom;
        roomX = Math.min(0, Math.max(r.width - roomW, r.width * 0.5 - roomW * 0.38));
        roomY = Math.min(0, Math.max(r.height - roomH, (r.height - roomH) * 0.52));
      } else {
        const overflowX = r.width - roomW;
        roomX = overflowX < 0 ? overflowX * 0.32 : overflowX * 0.5;
      }
    }
    const baseW = roomW * 0.831;
    const baseH = roomH * 0.831;
    const w = baseW * this._catScale;
    const h = baseH * this._catScale;
    const x = roomX + roomW * 0.006 + (baseW - w) * 0.46;
    const y = roomY + (roomH - baseH) * 0.49 + (baseH - h) * 0.51;
    const kittenAmount = clamp((0.86 - this._catScale) / (0.86 - 0.65));
    const upperNeckExtra = (kittenAmount * clamp(baseW * 0.062, 24, 44)) / w;
    const touchLift = this._isTouchPlatform && isLandscapeView ? Math.min(28, Math.round(framedHeight * 0.08)) : 0;

    this._view = {
      width: r.width,
      height: r.height,
      dpr,
      x,
      y,
      w,
      h,
      roomX,
      roomY,
      roomW,
      roomH,
      baseW,
      kitten: this._catScale <= 0.79,
      upperNeckExtra,
      handWidth: baseW * 0.895,
      touchLift,
      reduced: false,
    };

    const mainW = Math.max(1, Math.round(rect.width * dpr));
    const mainH = Math.max(1, Math.round(rect.height * dpr));
    if (this._canvas.width !== mainW || this._canvas.height !== mainH) {
      this._canvas.width = mainW;
      this._canvas.height = mainH;
    }

    if (this._ready) {
      this._reprojectPointer();
      this._paint(0.001);
    }
  },

  _loadTailHand() {
    if (this._tailHand || this._tailHandPromise) return this._tailHandPromise;
    this._tailHandPromise = this._photoReader
      .readPhoto('grip-slim')
      .then((grip) => {
        if (!this._destroyed && grip) {
          this._tailHand = new TailHand().load(grip);
          if (this._glRenderer) this._glRenderer.getTexture(this._tailHand.photo);
        }
        return this._tailHand;
      })
      .catch((err) => {
        this._tailHandPromise = null;
        console.warn('Tail hand load skipped:', err);
        return null;
      });
    return this._tailHandPromise;
  },

  async _loadAll() {
    this.setData({ loadFailed: false });
    try {
      const initialKey = this._selectedKey;
      const [[background, open]] = await Promise.all([
        Promise.all(['room', 'hand-slim'].map((n) => this._photoReader.readPhoto(n))),
        this._chooseCat(initialKey),
      ]);
      if (this._destroyed) return;
      this._room = background;
      this._hand = new OverheadHand().load(open);
      if (this._glRenderer) {
        this._glRenderer.getTexture(this._room);
        for (const part of this._hand.parts) {
          for (const tone of part.tones) this._glRenderer.getTexture(tone);
        }
      }

      let lastTried = initialKey;
      while (this._loadedKey !== this._selectedKey && lastTried !== this._selectedKey) {
        lastTried = this._selectedKey;
        await this._chooseCat(lastTried);
        if (this._destroyed) return;
      }

      if (this._loadedKey !== this._selectedKey) throw new Error('Cat mismatch');
      this._ready = true;
      this.setData({ ready: true });
      this._paint(0.001);
      this._measureAndLayout();
      this._showInitialHint();
      setTimeout(() => {
        if (!this._destroyed) this._loadTailHand();
      }, 40);
      setTimeout(() => {
        if (!this._destroyed) this._preloadAllCats();
      }, 200);
    } catch (err) {
      console.error('Init failed:', err);
      this.setData({ loadFailed: true });
    }
  },

  _evictOldCats(maxSize = 13) {
    while (this._catCache && this._catCache.size > maxSize) {
      const oldestKey = this._catCache.keys().next().value;
      const entry = this._catCache.get(oldestKey);
      this._catCache.delete(oldestKey);
      if (entry && entry.gpu && this._glRenderer) {
        this._glRenderer.deleteTexture(entry.gpu.bodyTex);
        this._glRenderer.deleteTexture(entry.gpu.tailTex);
        this._glRenderer.deleteTexture(entry.gpu.furTex);
        this._glRenderer.deleteTexture(entry.gpu.shadowTex);
      }
    }
  },

  async _preloadAllCats() {
    const gen = (this._preloadGen = (this._preloadGen || 0) + 1);
    const ids = CAT_LIST.map((c) => c.id);
    const tempCat = new OverheadCat();
    tempCat.setThickness(this._thickness);
    for (const id of ids) {
      if (this._destroyed || gen !== this._preloadGen) return;
      if (this._catCache && this._catCache.has(id)) continue;
      // Pause preloading while user is actively stroking so frame rate never stutters
      while (this._down && !this._destroyed && gen === this._preloadGen) {
        await new Promise((r) => setTimeout(r, 120));
      }
      if (this._destroyed || gen !== this._preloadGen) return;
      await new Promise((r) => setTimeout(r, 50));
      if (this._destroyed || gen !== this._preloadGen) return;
      try {
        const [photo, tailPhoto] = await Promise.all([
          this._photoReader.readPhoto(id),
          this._photoReader.readPhoto(id + '-tail'),
        ]);
        if (this._destroyed || gen !== this._preloadGen) return;
        if (this._catCache && this._catCache.has(id)) continue;
        tempCat.setCat(photo, tailPhoto, id, 320);
        if (this._glRenderer) tempCat.ensureGPU(this._glRenderer);
        if (this._catCache) {
          this._catCache.set(id, tempCat.exportPrepared(id));
          this._evictOldCats(13);
        }
      } catch (err) {
        console.warn('Preload skipped for', id, err);
      }
    }
    if (!this._destroyed && gen === this._preloadGen && this._purr) {
      setTimeout(() => {
        if (!this._destroyed && this._purr) this._purr.prepareWav();
      }, 100);
    }
  },

  _showInitialHint() {
    const HINT_KEY = 'pet-the-cat-hint-shown';
    try {
      if (wx.getStorageSync(HINT_KEY)) return;
    } catch (_) {}
    this.setData({ showHint: true });
    setTimeout(() => {
      this.setData({ showHint: false });
      try { wx.setStorageSync(HINT_KEY, 1); } catch (_) {}
    }, 4400);
  },

  async _chooseCat(id) {
    this._selectedKey = id;
    const idx = CAT_LIST.findIndex((c) => c.id === id);
    const catMeta = idx >= 0 ? CAT_LIST[idx] : CAT_LIST[0];
    this.setData({
      selected: id,
      selectedIndex: idx >= 0 ? idx + 1 : 1,
      currentCatName: catMeta.name,
      loadFailed: false,
    });
    const ticket = ++this._requestId;
    const cached = this._catCache && this._catCache.get(id);
    if (cached) {
      this._catCache.delete(id);
      this._catCache.set(id, cached);
      this._cat.applyPrepared(cached);
      this._loadedKey = id;
      this._resetPointerState();
      if (this._ready) this._paint(0.001);
      return;
    }
    try {
      const [photo, tailPhoto] = await Promise.all([
        this._photoReader.readPhoto(id),
        this._photoReader.readPhoto(id + '-tail'),
      ]);
      if (ticket !== this._requestId || this._destroyed) return;
      this._cat.setCat(photo, tailPhoto, id, 320);
      if (this._glRenderer) this._cat.ensureGPU(this._glRenderer);
      if (this._catCache) {
        this._catCache.set(id, this._cat.exportPrepared(id));
        this._evictOldCats(13);
      }
      this._loadedKey = id;
      this._resetPointerState();
      if (this._ready) this._paint(0.001);
    } catch (err) {
      console.error('Choose cat failed:', err);
      if (ticket === this._requestId) {
        this.setData({ loadFailed: true });
      }
    }
  },

  onChooseCat(e) {
    const id = e.currentTarget.dataset.cat;
    if (!id || id === this._selectedKey) return;
    if (this._isTouchPlatform) this._hapticTouch();
    if (this._ready) this._chooseCat(id);
    else {
      const idx = CAT_LIST.findIndex((c) => c.id === id);
      const catMeta = idx >= 0 ? CAT_LIST[idx] : CAT_LIST[0];
      this._selectedKey = id;
      this.setData({ selected: id, selectedIndex: idx >= 0 ? idx + 1 : 1, currentCatName: catMeta.name });
    }
  },

  onRetry() {
    if (this._ready) this._chooseCat(this._selectedKey);
    else this._loadAll();
  },

  onToggleTheme() {
    this._setTheme(!this.data.moonlit, true);
  },

  onToggleProportions() {
    const next = !this.data.proportionsOpen;
    this.setData({ proportionsOpen: next });
    if (!next) this._persistProportions();
  },

  onCloseProportions() {
    if (!this.data.proportionsOpen) return;
    this.setData({ proportionsOpen: false });
    this._persistProportions();
  },

  onPanelTap() {},

  onSizeChanging(e) {
    this._applyProportionIndices(e.detail.value, this.data.widthIndex, false);
  },

  onSizeChange(e) {
    this._applyProportionIndices(e.detail.value, this.data.widthIndex, true);
  },

  onWidthChanging(e) {
    this._applyProportionIndices(this.data.sizeIndex, e.detail.value, false);
  },

  onWidthChange(e) {
    this._applyProportionIndices(this.data.sizeIndex, e.detail.value, true);
  },

  _applyProportionIndices(sizeIdx, widthIdx, persist) {
    const size = SIZES[sizeIdx] ?? 100;
    const width = WIDTHS[widthIdx] ?? 100;
    this._catScale = size / 100;
    this._thickness = width / 100;
    if (this._cat) this._cat.setThickness(this._thickness);
    this.setData({ sizeIndex: sizeIdx, widthIndex: widthIdx });
    if (this._stageRect) this._computeLayout(this._stageRect);
    if (persist) this._persistProportions();
  },

  _persistProportions() {
    try {
      wx.setStorageSync(PROP_STORAGE_KEY, {
        size: SIZES[this.data.sizeIndex],
        width: WIDTHS[this.data.widthIndex],
      });
    } catch (_) {}
  },

  async onToggleSound() {
    if (!this._purr || this._togglingSound) return;
    this._togglingSound = true;
    try {
      const on = await this._purr.toggle();
      this.setData({ soundOn: on });
      wx.showToast({
        title: on ? '已开启呼噜声' : '已关闭呼噜声',
        icon: 'none',
        duration: 1200,
      });
    } catch (err) {
      console.warn('Purr toggle failed:', err);
      wx.showToast({ title: '声音初始化失败', icon: 'none' });
    } finally {
      this._togglingSound = false;
    }
  },

  onToggleCloseUp() {
    if (this.data.landscape) return;
    const closeUp = !this.data.closeUp;
    if (this._isTouchPlatform) this._hapticTouch();
    this.setData({ closeUp, proportionsOpen: false });
    this._measureAndLayout();
    setTimeout(() => this._measureAndLayout(), 220);
  },

  onToggleLandscape() {
    const landscape = !this.data.landscape;
    this.setData({ landscape, proportionsOpen: false });
    this._updateRotationFlag();
    setTimeout(() => this._measureAndLayout(), 40);
    setTimeout(() => this._measureAndLayout(), 160);
  },

  // --- Touch & Gesture Routing ---
  _pointFromTouch(touch) {
    const r = this._stageRect;
    const v = this._view;
    const rotated = this.data.softRotated;
    let x;
    let y;
    if (!rotated && typeof touch.x === 'number' && typeof touch.y === 'number') {
      x = touch.x;
      y = touch.y;
    } else {
      const tx = touch.clientX !== undefined ? touch.clientX : r.left + (touch.x || 0);
      const ty = touch.clientY !== undefined ? touch.clientY : r.top + (touch.y || 0);
      x = rotated ? ty - r.top : tx - r.left;
      y = rotated ? r.right - tx : ty - r.top;
    }
    return { u: (x - v.x) / v.w, v: (y - v.y - v.touchLift) / v.h };
  },

  _setOver(value) {
    if (value && !this._over && this._down) {
      this._hapticTouch();
    }
    this._over = value;
  },

  _hapticTouch() {
    if (!this._isTouchPlatform) return;
    try {
      wx.vibrateShort({ type: 'light' });
    } catch (_) {}
  },

  _hapticStroke() {
    if (!this._isTouchPlatform || !this._down) return;
    const speed = Math.hypot(this._vx || 0, this._vy || 0);
    if (speed < 0.16) return;
    const now = Date.now();
    if (now - (this._lastHapticMs || 0) < 260) return;
    this._lastHapticMs = now;
    try {
      wx.vibrateShort({ type: 'light' });
    } catch (_) {}
  },

  _track(p) {
    const previous = this._mode;
    if (previous !== 'stroke') {
      if (previous !== 'linger') {
        this._pad = { ...p };
        this._previousInput = this._operator;
        this._vx = 0;
        this._vy = 0;
        this._tuck = 0;
      } else {
        this._previousInput = this._operator;
      }
      if (previous !== 'rest' && previous !== 'linger') {
        this._altitude = this._isTouchPlatform ? 0.28 : 0.77;
        this._pressure = this._isTouchPlatform ? 0.42 : 0;
      }
    }
    this._target = p;
    this._mode = 'stroke';
    this._hapticStroke();
  },

  _withdraw() {
    if (this._mode === 'away' || this._mode === 'withdraw') return;
    this._mode = 'withdraw';
    this._age = 0;
    this._origin = { ...this._pad };
    this._startHeight = this._altitude;
    this._retreat = (this._view.height - this._view.y) / this._view.h + 0.36;
  },

  _reachBody(p, holding) {
    const w = this._view.w;
    const stickyTouch = this._isTouchPlatform && this._down && holding;
    const touchBoost = stickyTouch ? 1.85 : this._isTouchPlatform ? 1.25 : 1;
    const margin = (holding ? clamp(w * 0.087, 34, 72) : clamp(w * 0.055, 24, 48)) * touchBoost;
    const upper = (holding ? clamp(w * 0.17, 58, 149) : clamp(w * 0.125, 43, 112)) * (stickyTouch ? 1.15 : 1);
    return this._cat.reach(p, margin / w, upper / w, true, this._view.upperNeckExtra);
  },

  _tailPickup(p, fromBody) {
    const tail = this._cat.tail;
    const w = this._view.w;
    const touchBoost = this._isTouchPlatform ? 1.45 : 1;
    const margin = (fromBody ? clamp(w * 0.087, 34, 72) : clamp(w * 0.05, 21, 44)) / w;
    if (fromBody && p.u <= tail.point(0.54, true).u + 0.018) {
      const near = tail.closest(p.u, p.v, this._cat.tailBase.at, 0.54);
      const above = clamp(((near.v - p.v) * (935 / 1517)) / Math.max(0.001, near.distance));
      const upper = Math.min(0.17, clamp(w * 0.17, 58, 149) / w);
      const lower = Math.min(0.103, margin * 1.2);
      if (near.distance <= near.radius + lower + (upper - lower) * smooth(above)) return near;
    }
    const near = tail.closest(p.u, p.v);
    const directReach = (fromBody ? Math.min(0.087, margin) : Math.min(0.05, margin * 0.7)) * touchBoost;
    if (near.at <= 0.075 || near.distance > near.radius + directReach) return null;
    if (!this._cat.unmap(p.u, p.v).zone) return near;
    if (near.at < 0.27 && near.distance < near.radius + 0.002 && this._cat.outline.near(this._cat, p.u, p.v).distance < 0.018) {
      return near;
    }
    return null;
  },

  _route(p) {
    const fromBody = this._over && this._mode === 'stroke' && this._area !== 'tail';
    this._edgePointer = null;
    this._edgeMoved = true;
    this._operator = { u: p.u, v: p.v };
    const tail = this._cat.tail;
    const baseX = this._cat.tailBaseX();
    const leftOfBase = p.u < baseX;
    if (leftOfBase && (tail.stroke || this._tailAnchor || this._passedTip)) {
      if (tail.stroke) this._previousInput = this._operator;
      tail.release();
      this._returningToBody = true;
      this._passedTip = false;
    }
    if (this._passedTip) {
      const hit = tail.closest(p.u, p.v);
      if (!this._cat.unmap(p.u, p.v).zone && !(tail.releaseAge > 0.18 && hit.at > 0.08 && hit.distance < hit.radius)) {
        this._setOver(false);
        if (this._mode !== 'tail-open') this._withdraw();
        return;
      }
      this._passedTip = false;
    }
    if (!tail.stroke && p.u >= baseX + (this._returningToBody ? 0.014 : 0)) {
      if (!this._tailHand) {
        this._loadTailHand();
      } else {
        const near = this._tailPickup(p, fromBody);
        if (near) {
          tail.grab(p, near, fromBody);
          this._tailAnchor = true;
          this._returningToBody = false;
          if (fromBody) this._previousInput = tail.gripPoint();
        }
      }
    }
    if (tail.stroke) {
      tail.drag(p, this._force ?? 0.6);
      this._area = 'tail';
      this._setOver(true);
      this._track(tail.gripPoint());
      return;
    }
    const contact = this._reachBody(p, this._over);
    if (!contact) {
      this._setOver(false);
      this._withdraw();
      return;
    }
    this._area = contact.zone;
    this._edgePointer = contact.snapped ? p : null;
    this._setOver(true);
    this._track(contact);
  },

  _reprojectPointer() {
    if (!this._lastTouch || (!this._down && !this._over)) return;
    this._route(this._pointFromTouch(this._lastTouch));
    if (this._mode === 'stroke') this._pad = { ...this._target };
  },

  _handleTouch(touch) {
    this._down = true;
    this._lastTouch = {
      clientX: touch.clientX,
      clientY: touch.clientY,
      x: touch.x,
      y: touch.y,
    };
    const f = touch.force;
    const sensed = typeof f === 'number' && f > 0 && Math.abs(f - 0.5) > 0.018;
    this._force = sensed ? clamp(f) : null;
    this._route(this._pointFromTouch(this._lastTouch));
  },

  _endTouch() {
    if (this._cat) this._cat.tail.release();
    this._passedTip = false;
    this._activeTouchId = null;
    this._pendingTouch = null;
    this._down = false;
    this._lastTouch = null;
    this._edgePointer = null;
    this._setOver(false);
    if (this._view && this._mode === 'stroke') {
      this._mode = 'linger';
      this._age = 0;
    } else if (this._view) {
      this._withdraw();
    }
  },

  onTouchStart(e) {
    if (!this._ready) return;
    if (this.data.proportionsOpen) this.onCloseProportions();
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    if (this._activeTouchId === null) {
      this._activeTouchId = touch.identifier;
      this._pendingTouch = null;
      this._tapStartMs = Date.now();
      this._tapX = touch.clientX ?? touch.x ?? 0;
      this._tapY = touch.clientY ?? touch.y ?? 0;
      this._tapMoved = false;
      this._handleTouch(touch);
    }
  },

  onTouchMove(e) {
    if (!this._ready || this._activeTouchId === null) return;
    const touches = e.touches || [];
    const match = touches.find((t) => t.identifier === this._activeTouchId) || touches[0];
    if (match) {
      if (!this._tapMoved) {
        const mx = match.clientX ?? match.x ?? 0;
        const my = match.clientY ?? match.y ?? 0;
        if (Math.hypot(mx - (this._tapX || 0), my - (this._tapY || 0)) > 12) {
          this._tapMoved = true;
        }
      }
      this._pendingTouch = {
        clientX: match.clientX,
        clientY: match.clientY,
        x: match.x,
        y: match.y,
        force: match.force,
      };
    }
  },

  onTouchEnd(e) {
    if (!this._ready) return;
    const touches = e.touches || [];
    if (!touches.some((t) => t.identifier === this._activeTouchId)) {
      const now = Date.now();
      const quickTap = !this._tapMoved && now - (this._tapStartMs || 0) < 210 && (!this._cat || !this._cat.tail.stroke);
      this._endTouch();
      if (quickTap && !this.data.landscape) {
        const tapDist = Math.hypot((this._tapX || 0) - (this._lastTapX || 0), (this._tapY || 0) - (this._lastTapY || 0));
        if (this._lastTapEndMs && now - this._lastTapEndMs < 280 && tapDist < 28) {
          this._lastTapEndMs = 0;
          this.onToggleCloseUp();
        } else {
          this._lastTapEndMs = now;
          this._lastTapX = this._tapX;
          this._lastTapY = this._tapY;
        }
      } else {
        this._lastTapEndMs = 0;
      }
    }
  },

  onTouchCancel() {
    if (!this._ready) return;
    this._endTouch();
  },

  // --- Simulation & Rendering Loop ---
  _move(dt) {
    this._age += dt;
    if (this._edgePointer && !this._edgeMoved && this._over && this._mode === 'stroke') {
      const contact = this._reachBody(this._edgePointer, true);
      if (contact) {
        this._target = contact;
        this._area = contact.zone;
        if (!contact.snapped) this._edgePointer = null;
      } else {
        this._edgePointer = null;
        this._setOver(false);
        this._withdraw();
      }
    }
    this._edgeMoved = false;

    if (this._cat.tail.slipped()) {
      this._passedTip = true;
      this._cat.tail.release();
      this._setOver(false);
      this._pad = { ...this._cat.tail.releasePoint };
      this._target = { ...this._pad };
      this._mode = 'tail-open';
      this._age = 0;
    }

    const constrained = this._cat.tail.stroke ? this._cat.tail.gripPoint() : null;
    const inputPoint = constrained ?? this._operator;
    let desired = 0;
    let height = 0;
    if (this._mode === 'rest') {
      desired = HELD_PRESSURE;
    } else if (this._mode === 'stroke') {
      if (constrained) {
        this._pad = constrained;
      } else {
        this._pad.u = follow(this._pad.u, this._target.u, dt, 0.01);
        this._pad.v = follow(this._pad.v, this._target.v, dt, 0.01);
      }
      desired = this._force === null ? HELD_PRESSURE : 0.86 + 0.13 * this._force;
    } else if (this._mode === 'linger') {
      desired = 0.12;
      height = 0.2;
      if (this._age > 0.16) this._withdraw();
    } else if (this._mode === 'tail-open') {
      height = 0.46;
      if (this._age > 0.155) this._withdraw();
    } else if (this._mode === 'withdraw') {
      const t = clamp(this._age / 0.34);
      const f = smooth(t);
      this._pad.u = this._origin.u + 0.026 * f;
      this._pad.v = this._origin.v + (this._retreat - this._origin.v) * f;
      height = this._startHeight + (1 - this._startHeight) * f;
      if (t === 1) this._mode = 'away';
    } else {
      height = 1;
    }

    this._pressure = follow(this._pressure, desired, dt, desired > this._pressure ? 0.018 : 0.045);
    this._altitude = follow(this._altitude, height, dt, height > this._altitude ? 0.06 : 0.024);
    const tracking = this._mode === 'stroke';
    const nowMs = this._lastMs || Date.now();
    const hasSample = tracking && this._previousInput && inputPoint;
    const du = hasSample ? inputPoint.u - this._previousInput.u : 0;
    const dv = hasSample ? inputPoint.v - this._previousInput.v : 0;
    const movedDelta = Math.abs(du) > 1e-5 || Math.abs(dv) > 1e-5;
    if (!tracking) {
      this._previousInput = null;
      this._lastMoveMs = 0;
      this._vx = follow(this._vx, 0, dt, 0.04);
      this._vy = follow(this._vy, 0, dt, 0.04);
    } else if (movedDelta) {
      const moveDt = this._lastMoveMs ? clamp((nowMs - this._lastMoveMs) / 1000, 0.008, 0.06) : dt;
      const dx = clamp(du / moveDt, -1.5, 1.5);
      const dy = clamp(dv / moveDt, -1.6, 1.6);
      this._previousInput = inputPoint;
      this._lastMoveMs = nowMs;
      this._vx = follow(this._vx, dx, dt, 0.028);
      this._vy = follow(this._vy, dy, dt, 0.028);
    } else {
      if (!this._previousInput && inputPoint) {
        this._previousInput = inputPoint;
        this._lastMoveMs = nowMs;
      }
      const idleSec = this._lastMoveMs ? (nowMs - this._lastMoveMs) / 1000 : 1;
      if (idleSec > 0.036) {
        this._vx = follow(this._vx, 0, dt, 0.035);
        this._vy = follow(this._vy, 0, dt, 0.035);
      } else {
        this._vx = follow(this._vx, 0, dt, 0.14);
        this._vy = follow(this._vy, 0, dt, 0.14);
      }
    }
    const pull = Math.tanh(8.3 * (this._vx * 0.63 + this._vy * 0.616 * 0.86));
    this._tuck = follow(this._tuck, this._mode === 'stroke' ? pull : 0, dt, 0.042);
  },

  _poseHands(dt) {
    const tail = this._cat.tail;
    const held = !!tail.stroke;
    let grip = null;
    if (this._tailHand && (held || this._handChange.held || this._handChange.move)) {
      const t = tail.gripPoint();
      grip = this._tailHand;
      grip.configure(
        this._view,
        t,
        this._view.x + t.u * this._view.w,
        this._view.y + t.v * this._view.w,
        tail.amount,
        this._pressure,
        tail.slide,
        dt
      );
    }
    return this._handChange.place(this._hand, grip, held, dt, this._view);
  },

  _tailContact(t, load) {
    return {
      u: t.ru,
      v: t.rv,
      zone: 'tail',
      pressure: load * 0.74,
      dx: this._vx,
      dy: this._vy,
      axisX: t.tx,
      axisY: t.ty,
      length: 0.029,
      width: t.radius * 0.76,
      pads: [],
    };
  },

  _paint(dt) {
    const view = this._view;
    const glRenderer = this._glRenderer;
    if (!view || !glRenderer || !this._room || !this._hand) return;
    const { width: w, height: h } = view;
    const softRotated = this.data.softRotated;

    const rest = this._mode === 'rest';
    const visible = this._mode !== 'away';
    const touching = rest || this._mode === 'stroke';
    const x = view.x + view.w * this._pad.u;
    const y = view.y + view.h * this._pad.v;
    const edgeYaw = 0.45 * smooth(clamp((x / w - 0.75) / 0.19));
    const motionX = Math.tanh(4.6 * this._vx);
    const motionY = Math.tanh(3.9 * this._vy);
    const tail = this._cat.tail;
    const onBody = touching && this._area !== 'tail' && !tail.stroke;
    const pose = {
      x,
      y,
      pad: this._pad,
      coat: onBody ? this._cat : null,
      dt,
      pressure: this._pressure,
      load: this._cat.state.load,
      lift: this._cat.state.lift,
      depth: onBody ? this._cat.tip.depth : 0,
      altitude: this._altitude,
      rest,
      tuck: this._tuck,
      angle: edgeYaw + 0.17 * motionX - 0.058 * motionY,
      motionX,
      motionY,
    };

    let input = null;
    let blend = 0;
    if (visible) {
      this._hand.configure(view, pose);
      if (tail.stroke) {
        input = this._tailContact(tail.point(tail.at), this._pressure);
      } else {
        let pads = null;
        if (onBody) {
          pads = this._hand.contacts();
          if (view.upperNeckExtra) {
            const drop = this._cat.upperPadDrop(view, this._pad, pads);
            if (drop > 0) {
              this._hand.py += drop;
              for (const finger of pads) finger.y += drop;
            }
          }
        }
        const opening = this._handChange.held || !!this._handChange.move;
        blend = this._poseHands(dt);
        if (pads) {
          input = this._cat.contact(
            view,
            opening ? this._hand.contacts() : pads,
            this._pressure * (1 - this._altitude),
            this._vx,
            this._vy,
            this._pad.u
          );
        }
        if (!input && onBody && opening && this._returningToBody && tail.releasePoint && this._tailHand) {
          const q = this._tailHand.q;
          this._tailHand.point(this._tailHand.layout.cx, this._tailHand.layout.cy, q);
          const tuft = tail.closest((q[0] - view.x) / view.w, (q[1] - view.y) / view.h);
          const support = 1 - smooth(clamp(((tuft.distance - tuft.feltRadius) * view.w) / (0.035 * view.handWidth)));
          if (support > 0) input = this._tailContact(tuft, this._pressure * support);
        }
      }
    } else if (this._handChange.view) {
      this._handChange.reset();
    }

    this._cat.draw(view, input, dt);
    if (visible && tail.stroke) blend = this._poseHands(dt);
    if (tail.amount < 0.002 && !tail.stroke) {
      this._tailAnchor = false;
      this._returningToBody = false;
    }

    glRenderer.beginFrame(w, h, softRotated);
    glRenderer.drawQuad(glRenderer.getTexture(this._room), view.roomX, view.roomY, view.roomW, view.roomH, 1);
    this._cat.renderGL(glRenderer, view);

    if (visible) {
      if (blend <= 0) {
        if (this._hand.transition || this._hand.sleeveDrop > 1) {
          this._hand.shadeGL(glRenderer, 1);
          this._hand.drawSkinGL(glRenderer);
        } else {
          this._hand.drawGL(glRenderer, 1);
        }
      } else if (blend >= 1) {
        if (this._tailHand) this._tailHand.drawSkinGL(glRenderer);
      } else {
        glRenderer.beginOffscreen(0);
        if (this._hand.transition || this._hand.sleeveDrop > 1) {
          this._hand.shadeGL(glRenderer, 1);
          this._hand.drawSkinGL(glRenderer);
        } else {
          this._hand.drawGL(glRenderer, 1);
        }
        glRenderer.beginOffscreen(1);
        if (this._tailHand) this._tailHand.drawSkinGL(glRenderer);
        glRenderer.endOffscreenAndCompositeMix(blend);
      }
    }

    if (onBody && input && input.zone !== 'tail' && blend === 0 && this._cat.longCoat) {
      this._furContact.drawGL(glRenderer, view, this._cat, this._hand, input, this._altitude);
    }
    if (this.data.moonlit) {
      glRenderer.drawMoonlight(glRenderer.getTexture(getMoonlightCanvas()), view);
    }
    if (this._purr) this._purr.update(input?.pressure ?? 0);
  },

  _cancelFrame() {
    if (!this._rafId) return;
    if (this._rafType === 'raf' && this._canvas && typeof this._canvas.cancelAnimationFrame === 'function') {
      this._canvas.cancelAnimationFrame(this._rafId);
    } else if (this._rafType === 'timer') {
      clearTimeout(this._rafId);
    }
    this._rafId = null;
    this._rafType = null;
  },

  _scheduleFrame() {
    if (this._destroyed || this._hidden || !this._canvas) return;
    if (typeof this._canvas.requestAnimationFrame === 'function') {
      this._rafType = 'raf';
      this._rafId = this._canvas.requestAnimationFrame((ms) => {
        this._rafId = null;
        this._onFrame(ms);
      });
    } else {
      this._rafType = 'timer';
      this._rafId = setTimeout(() => {
        this._rafId = null;
        this._onFrame(Date.now());
      }, 16);
    }
  },

  _onFrame(ms) {
    if (this._destroyed || this._hidden) return;
    this._scheduleFrame();
    if (!this._ready || !this._view) {
      this._lastMs = 0;
      return;
    }
    if (this._pendingTouch) {
      const pending = this._pendingTouch;
      this._pendingTouch = null;
      this._handleTouch(pending);
    }
    const now = typeof ms === 'number' && ms > 0 ? ms : Date.now();
    const elapsed = this._lastMs ? now - this._lastMs : 16.6;
    if (this._lastMs && elapsed < 32 && (this._mode === 'rest' || this._mode === 'away') && !this._cat.tailMoving(elapsed / 1000)) {
      return;
    }
    const dt = this._lastMs ? clamp(elapsed / 1000, 0.001, 0.075) : 1 / 60;
    this._lastMs = now;
    this._move(dt);
    this._paint(dt);
  },
});
