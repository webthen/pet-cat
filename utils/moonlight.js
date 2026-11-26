const { createOffscreen } = require('./canvas-compat');

function makeLightField() {
  const lamp = createOffscreen(320, 197);
  const g = lamp.getContext('2d');
  const pixels = g.createImageData(lamp.width, lamp.height);
  const rgba = pixels.data;
  const soft = (v, a, b) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  for (let row = 0; row < lamp.height; row++) {
    const y = row / (lamp.height - 1);
    const penumbra = 0.034 + 0.082 * y;
    for (let col = 0; col < lamp.width; col++) {
      const x = col / (lamp.width - 1);
      const across = x - 0.66 * y;
      const pane = (left, right) => soft(across, left - penumbra, left + penumbra) * (1 - soft(across, right - penumbra, right + penumbra));
      const windowLight = Math.exp(-3.7 * x * x - 5.5 * y * y);
      const beams = (0.78 * pane(-0.24, -0.076) + pane(-0.026, 0.22)) * Math.exp(-1.32 * y);
      const light = Math.min(1, 0.36 * windowLight + 0.83 * beams);
      const spill = 0.04 + 0.07 * (1 - y) * (1 - 0.65 * x);
      const i = (row * lamp.width + col) * 4;
      rgba[i] = 255 * (0.195 + 0.44 * light + spill);
      rgba[i + 1] = 255 * (0.276 + 0.49 * light + spill);
      rgba[i + 2] = 255 * (0.405 + 0.49 * light + spill);
      rgba[i + 3] = 255;
    }
  }
  g.putImageData(pixels, 0, 0);
  return lamp;
}

let field = null;

function getMoonlightCanvas() {
  field ??= makeLightField();
  field._rgbaData ??= field.getContext('2d').getImageData(0, 0, field.width, field.height).data;
  return field;
}

function drawMoonlight(ctx, view) {
  const light = getMoonlightCanvas();
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  if (ctx.globalCompositeOperation === 'multiply') {
    ctx.drawImage(light, view.roomX, view.roomY, view.roomW, view.roomH);
    ctx.globalCompositeOperation = 'screen';
    if (ctx.globalCompositeOperation === 'screen') {
      ctx.fillStyle = '#060a13';
      ctx.fillRect(0, 0, view.width, view.height);
    }
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(13, 24, 46, 0.52)';
    ctx.fillRect(0, 0, view.width, view.height);
  }
  ctx.restore();
}

module.exports = { drawMoonlight, getMoonlightCanvas };
