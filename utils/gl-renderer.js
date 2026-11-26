function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('Shader compile failed: ' + log);
  }
  return shader;
}

function createProgram(gl, vsSource, fsSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error('Program link failed: ' + log);
  }
  return prog;
}

const VS_PROJ_HELPER = `
vec2 projectPos(vec2 p, vec2 viewSize, float rot) {
  if (rot > 0.5) {
    return vec2(1.0 - (p.y / viewSize.y) * 2.0, 1.0 - (p.x / viewSize.x) * 2.0);
  }
  return vec2((p.x / viewSize.x) * 2.0 - 1.0, 1.0 - (p.y / viewSize.y) * 2.0);
}
`;

const VS_SPRITE = `
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform vec2 u_viewSize;
uniform float u_rotate;
varying vec2 v_uv;
${VS_PROJ_HELPER}
void main() {
  gl_Position = vec4(projectPos(a_pos, u_viewSize, u_rotate), 0.0, 1.0);
  v_uv = a_uv;
}
`;

const FS_SPRITE = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec4 u_uvRect;
uniform float u_clipRect;
uniform vec4 u_color;
uniform float u_alpha;
varying vec2 v_uv;
void main() {
  vec2 uv = (v_uv - u_uvRect.xy) / u_uvRect.zw;
  if (u_clipRect > 0.5 && (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)) discard;
  vec4 tex = texture2D(u_tex, clamp(uv, 0.0, 1.0));
  gl_FragColor = tex * u_color * u_alpha;
}
`;

const VS_CAT = `
attribute vec2 a_pos;
attribute vec2 a_uv;
attribute vec3 a_data;
uniform vec2 u_viewSize;
uniform float u_rotate;
varying vec2 v_uv;
varying vec3 v_data;
${VS_PROJ_HELPER}
void main() {
  gl_Position = vec4(projectPos(a_pos, u_viewSize, u_rotate), 0.0, 1.0);
  v_uv = a_uv;
  v_data = a_data;
}
`;

const FS_CAT = `
precision mediump float;
uniform sampler2D u_body;
uniform sampler2D u_fur;
uniform vec4 u_bodyRect;
uniform vec2 u_furScale;
uniform float u_hasLocks;
varying vec2 v_uv;
varying vec3 v_data;
void main() {
  vec4 fur = texture2D(u_fur, v_uv);
  vec2 sampleUv = v_uv;
  float raised = v_data.z;
  float ridge = 0.0;
  if (u_hasLocks > 0.5 && raised > 0.001) {
    sampleUv += (fur.gb - 0.5) * (raised * u_furScale);
    ridge = (fur.a - 0.5) * 0.4 * raised;
  }
  vec2 bodyUv = (sampleUv - u_bodyRect.xy) / u_bodyRect.zw;
  if (bodyUv.x < 0.0 || bodyUv.x > 1.0 || bodyUv.y < 0.0 || bodyUv.y > 1.0) discard;
  vec4 tex = texture2D(u_body, bodyUv);
  if (tex.a < 0.004) discard;
  vec3 col = tex.rgb / tex.a;
  float lit = v_data.x;
  float nap = v_data.y;
  float fibre = fur.r * 2.0 - 1.0;
  float nf = nap < 0.0
    ? (-6.885 - 3.06 - 8.16 * fibre - 3.825 * max(fibre, 0.0))
    : (-6.885 + 3.06 + 8.16 * fibre);
  float gain = 1.0 + 0.92 * lit + ridge;
  float add = (18.62 * lit + nap * nf) / 255.0;
  col = clamp(col * gain + add, 0.0, 1.0);
  gl_FragColor = vec4(col * tex.a, tex.a);
}
`;

const VS_FUR_CONTACT = `
attribute vec2 a_pos;
attribute vec2 a_bedUv;
attribute vec2 a_bodyUv;
uniform vec2 u_viewSize;
uniform float u_rotate;
varying vec2 v_bedUv;
varying vec2 v_bodyUv;
${VS_PROJ_HELPER}
void main() {
  gl_Position = vec4(projectPos(a_pos, u_viewSize, u_rotate), 0.0, 1.0);
  v_bedUv = a_bedUv;
  v_bodyUv = a_bodyUv;
}
`;

const FS_FUR_CONTACT = `
precision mediump float;
uniform sampler2D u_bed;
uniform sampler2D u_body;
uniform vec4 u_bodyRect;
uniform float u_alpha;
uniform float u_shade;
varying vec2 v_bedUv;
varying vec2 v_bodyUv;
void main() {
  vec4 bed = texture2D(u_bed, v_bedUv);
  float mask = bed.a * u_alpha;
  if (mask < 0.004) discard;
  vec2 bodyUv = (v_bodyUv - u_bodyRect.xy) / u_bodyRect.zw;
  if (bodyUv.x < 0.0 || bodyUv.x > 1.0 || bodyUv.y < 0.0 || bodyUv.y > 1.0) discard;
  vec4 fur = texture2D(u_body, bodyUv);
  gl_FragColor = vec4(fur.rgb * u_shade, fur.a) * mask;
}
`;

const VS_FULLSCREEN = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_uv = a_pos * 0.5 + 0.5;
}
`;

const FS_MIX = `
precision mediump float;
uniform sampler2D u_texA;
uniform sampler2D u_texB;
uniform float u_blend;
varying vec2 v_uv;
void main() {
  vec4 a = texture2D(u_texA, v_uv);
  vec4 b = texture2D(u_texB, v_uv);
  gl_FragColor = mix(a, b, u_blend);
}
`;

class GLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: true,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL context unavailable');
    this.gl = gl;

    this.spriteProg = createProgram(gl, VS_SPRITE, FS_SPRITE);
    this.spriteLocs = {
      a_pos: gl.getAttribLocation(this.spriteProg, 'a_pos'),
      a_uv: gl.getAttribLocation(this.spriteProg, 'a_uv'),
      u_viewSize: gl.getUniformLocation(this.spriteProg, 'u_viewSize'),
      u_rotate: gl.getUniformLocation(this.spriteProg, 'u_rotate'),
      u_tex: gl.getUniformLocation(this.spriteProg, 'u_tex'),
      u_uvRect: gl.getUniformLocation(this.spriteProg, 'u_uvRect'),
      u_clipRect: gl.getUniformLocation(this.spriteProg, 'u_clipRect'),
      u_color: gl.getUniformLocation(this.spriteProg, 'u_color'),
      u_alpha: gl.getUniformLocation(this.spriteProg, 'u_alpha'),
    };

    this.catProg = createProgram(gl, VS_CAT, FS_CAT);
    this.catLocs = {
      a_pos: gl.getAttribLocation(this.catProg, 'a_pos'),
      a_uv: gl.getAttribLocation(this.catProg, 'a_uv'),
      a_data: gl.getAttribLocation(this.catProg, 'a_data'),
      u_viewSize: gl.getUniformLocation(this.catProg, 'u_viewSize'),
      u_rotate: gl.getUniformLocation(this.catProg, 'u_rotate'),
      u_body: gl.getUniformLocation(this.catProg, 'u_body'),
      u_fur: gl.getUniformLocation(this.catProg, 'u_fur'),
      u_bodyRect: gl.getUniformLocation(this.catProg, 'u_bodyRect'),
      u_furScale: gl.getUniformLocation(this.catProg, 'u_furScale'),
      u_hasLocks: gl.getUniformLocation(this.catProg, 'u_hasLocks'),
    };

    this.furProg = createProgram(gl, VS_FUR_CONTACT, FS_FUR_CONTACT);
    this.furLocs = {
      a_pos: gl.getAttribLocation(this.furProg, 'a_pos'),
      a_bedUv: gl.getAttribLocation(this.furProg, 'a_bedUv'),
      a_bodyUv: gl.getAttribLocation(this.furProg, 'a_bodyUv'),
      u_viewSize: gl.getUniformLocation(this.furProg, 'u_viewSize'),
      u_rotate: gl.getUniformLocation(this.furProg, 'u_rotate'),
      u_bed: gl.getUniformLocation(this.furProg, 'u_bed'),
      u_body: gl.getUniformLocation(this.furProg, 'u_body'),
      u_bodyRect: gl.getUniformLocation(this.furProg, 'u_bodyRect'),
      u_alpha: gl.getUniformLocation(this.furProg, 'u_alpha'),
      u_shade: gl.getUniformLocation(this.furProg, 'u_shade'),
    };

    this.mixProg = createProgram(gl, VS_FULLSCREEN, FS_MIX);
    this.mixLocs = {
      a_pos: gl.getAttribLocation(this.mixProg, 'a_pos'),
      u_texA: gl.getUniformLocation(this.mixProg, 'u_texA'),
      u_texB: gl.getUniformLocation(this.mixProg, 'u_texB'),
      u_blend: gl.getUniformLocation(this.mixProg, 'u_blend'),
    };

    this.dynVbo = gl.createBuffer();
    this.catVbo = gl.createBuffer();
    this.catIbo = gl.createBuffer();
    this.fsVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fsVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    this.quadBuf = new Float32Array(24);
    this.batchVerts = new Float32Array(4096 * 4);
    this.catIdxCount = 0;

    this.whiteTex = this.createTextureFromRawRGBA(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.texCache = new WeakMap();
    this.fboA = null;
    this.fboB = null;
    this.viewW = 1;
    this.viewH = 1;
    this.rotate = false;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  _configureTexture(tex) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  createTextureFromImage(img) {
    const gl = this.gl;
    const tex = gl.createTexture();
    this._configureTexture(tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    return tex;
  }

  createTextureFromCanvas(canvas, premultiply = true) {
    if (!canvas) return null;
    if (canvas._rgbaData) {
      return this.createTextureFromRGBA(canvas._rgbaData, canvas.width, canvas.height, premultiply);
    }
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return this.createTextureFromRGBA(imgData.data, canvas.width, canvas.height, premultiply);
  }

  createTextureFromRGBA(src, w, h, premultiply = true) {
    const gl = this.gl;
    let data;
    if (premultiply) {
      data = new Uint8Array(w * h * 4);
      for (let i = 0; i < data.length; i += 4) {
        const a = src[i + 3];
        if (a === 255) {
          data[i] = src[i];
          data[i + 1] = src[i + 1];
          data[i + 2] = src[i + 2];
          data[i + 3] = 255;
        } else if (a > 0) {
          const f = a / 255;
          data[i] = Math.round(src[i] * f);
          data[i + 1] = Math.round(src[i + 1] * f);
          data[i + 2] = Math.round(src[i + 2] * f);
          data[i + 3] = a;
        }
      }
    } else {
      data = src instanceof Uint8Array ? src : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    }
    const tex = gl.createTexture();
    this._configureTexture(tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return tex;
  }

  createTextureFromRawRGBA(uint8, w, h) {
    return this.createTextureFromRGBA(uint8, w, h, false);
  }

  getTexture(obj) {
    if (!obj) return null;
    if (obj._glTex) return obj._glTex;
    let tex = this.texCache.get(obj);
    if (tex) return tex;
    if (typeof obj.getContext === 'function' || obj._rgbaData) {
      tex = this.createTextureFromCanvas(obj, true);
    } else if (obj.img) {
      tex = this.createTextureFromImage(obj.img);
    } else {
      tex = this.createTextureFromImage(obj);
    }
    if (tex) this.texCache.set(obj, tex);
    return tex;
  }

  deleteTexture(tex) {
    if (tex) this.gl.deleteTexture(tex);
  }

  beginFrame(viewW, viewH, rotate) {
    const gl = this.gl;
    this.viewW = viewW;
    this.viewH = viewH;
    this.rotate = !!rotate;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  _ensureFbo(slot, w, h) {
    const gl = this.gl;
    if (slot && slot.w === w && slot.h === h) return slot;
    if (slot) {
      gl.deleteFramebuffer(slot.fbo);
      gl.deleteTexture(slot.tex);
    }
    const tex = gl.createTexture();
    this._configureTexture(tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, w, h };
  }

  beginOffscreen(index) {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (index === 0) {
      this.fboA = this._ensureFbo(this.fboA, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA.fbo);
    } else {
      this.fboB = this._ensureFbo(this.fboB, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboB.fbo);
    }
    gl.viewport(0, 0, w, h);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  endOffscreenAndCompositeMix(blend) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.mixProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboA.tex);
    gl.uniform1i(this.mixLocs.u_texA, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fboB.tex);
    gl.uniform1i(this.mixLocs.u_texB, 1);
    gl.uniform1f(this.mixLocs.u_blend, blend);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fsVbo);
    gl.enableVertexAttribArray(this.mixLocs.a_pos);
    gl.vertexAttribPointer(this.mixLocs.a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(this.mixLocs.a_pos);
  }

  _bindSpriteProg(tex, alpha = 1, uvRect = null, clipRect = 0, color = null) {
    const gl = this.gl;
    const L = this.spriteLocs;
    gl.useProgram(this.spriteProg);
    gl.uniform2f(L.u_viewSize, this.viewW, this.viewH);
    gl.uniform1f(L.u_rotate, this.rotate ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(L.u_tex, 0);
    if (uvRect) gl.uniform4f(L.u_uvRect, uvRect[0], uvRect[1], uvRect[2], uvRect[3]);
    else gl.uniform4f(L.u_uvRect, 0, 0, 1, 1);
    gl.uniform1f(L.u_clipRect, clipRect);
    if (color) gl.uniform4f(L.u_color, color[0], color[1], color[2], color[3]);
    else gl.uniform4f(L.u_color, 1, 1, 1, 1);
    gl.uniform1f(L.u_alpha, alpha);
  }

  _drawQuadArray(floats, vertexCount) {
    const gl = this.gl;
    const L = this.spriteLocs;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynVbo);
    gl.bufferData(gl.ARRAY_BUFFER, floats, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(L.a_pos);
    gl.enableVertexAttribArray(L.a_uv);
    gl.vertexAttribPointer(L.a_pos, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(L.a_uv, 2, gl.FLOAT, false, 16, 8);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
    gl.disableVertexAttribArray(L.a_pos);
    gl.disableVertexAttribArray(L.a_uv);
  }

  drawQuad(tex, x, y, w, h, alpha = 1, sx = 0, sy = 0, sw = 1, sh = 1, uvRect = null, clipRect = 0) {
    if (!tex || alpha <= 0) return;
    const q = this.quadBuf;
    const x2 = x + w;
    const y2 = y + h;
    const u2 = sx + sw;
    const v2 = sy + sh;
    q[0] = x; q[1] = y; q[2] = sx; q[3] = sy;
    q[4] = x2; q[5] = y; q[6] = u2; q[7] = sy;
    q[8] = x; q[9] = y2; q[10] = sx; q[11] = v2;
    q[12] = x; q[13] = y2; q[14] = sx; q[15] = v2;
    q[16] = x2; q[17] = y; q[18] = u2; q[19] = sy;
    q[20] = x2; q[21] = y2; q[22] = u2; q[23] = v2;
    this._bindSpriteProg(tex, alpha, uvRect, clipRect, null);
    this._drawQuadArray(q, 6);
  }

  drawTransformedQuad(tex, m, n, b, d, tx, ty, lx, ly, lw, lh, u0, v0, uw, vh, alpha = 1) {
    if (!tex || alpha <= 0) return;
    const q = this.quadBuf;
    const x1 = lx;
    const y1 = ly;
    const x2 = lx + lw;
    const y2 = ly + lh;
    const u1 = u0;
    const v1 = v0;
    const u2 = u0 + uw;
    const v2 = v0 + vh;
    const px1 = m * x1 + b * y1 + tx;
    const py1 = n * x1 + d * y1 + ty;
    const px2 = m * x2 + b * y1 + tx;
    const py2 = n * x2 + d * y1 + ty;
    const px3 = m * x1 + b * y2 + tx;
    const py3 = n * x1 + d * y2 + ty;
    const px4 = m * x2 + b * y2 + tx;
    const py4 = n * x2 + d * y2 + ty;
    q[0] = px1; q[1] = py1; q[2] = u1; q[3] = v1;
    q[4] = px2; q[5] = py2; q[6] = u2; q[7] = v1;
    q[8] = px3; q[9] = py3; q[10] = u1; q[11] = v2;
    q[12] = px3; q[13] = py3; q[14] = u1; q[15] = v2;
    q[16] = px2; q[17] = py2; q[18] = u2; q[19] = v1;
    q[20] = px4; q[21] = py4; q[22] = u2; q[23] = v2;
    this._bindSpriteProg(tex, alpha, null, 0, null);
    this._drawQuadArray(q, 6);
  }

  drawTriangles(tex, floatBuf, vertexCount, alpha = 1, uvRect = null, clipRect = 0) {
    if (!tex || vertexCount <= 0 || alpha <= 0) return;
    this._bindSpriteProg(tex, alpha, uvRect, clipRect, null);
    const view = floatBuf.subarray(0, vertexCount * 4);
    this._drawQuadArray(view, vertexCount);
  }

  setCatIndices(indices) {
    const gl = this.gl;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.catIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.catIdxCount = indices.length;
  }

  drawCatBody(bodyTex, furTex, bodyRect, furScaleX, furScaleY, hasLocks, verts) {
    if (!bodyTex || !furTex || !this.catIdxCount) return;
    const gl = this.gl;
    const L = this.catLocs;
    gl.useProgram(this.catProg);
    gl.uniform2f(L.u_viewSize, this.viewW, this.viewH);
    gl.uniform1f(L.u_rotate, this.rotate ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bodyTex);
    gl.uniform1i(L.u_body, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, furTex);
    gl.uniform1i(L.u_fur, 1);
    gl.uniform4f(L.u_bodyRect, bodyRect[0], bodyRect[1], bodyRect[2], bodyRect[3]);
    gl.uniform2f(L.u_furScale, furScaleX, furScaleY);
    gl.uniform1f(L.u_hasLocks, hasLocks ? 1 : 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.catVbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.catIbo);

    gl.enableVertexAttribArray(L.a_pos);
    gl.enableVertexAttribArray(L.a_uv);
    gl.enableVertexAttribArray(L.a_data);
    gl.vertexAttribPointer(L.a_pos, 2, gl.FLOAT, false, 28, 0);
    gl.vertexAttribPointer(L.a_uv, 2, gl.FLOAT, false, 28, 8);
    gl.vertexAttribPointer(L.a_data, 3, gl.FLOAT, false, 28, 16);
    gl.drawElements(gl.TRIANGLES, this.catIdxCount, gl.UNSIGNED_SHORT, 0);
    gl.disableVertexAttribArray(L.a_pos);
    gl.disableVertexAttribArray(L.a_uv);
    gl.disableVertexAttribArray(L.a_data);
  }

  drawFurContactQuad(bedTex, bodyTex, bodyRect, alpha, shade, verts6) {
    if (!bedTex || !bodyTex || alpha <= 0) return;
    const gl = this.gl;
    const L = this.furLocs;
    gl.useProgram(this.furProg);
    gl.uniform2f(L.u_viewSize, this.viewW, this.viewH);
    gl.uniform1f(L.u_rotate, this.rotate ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bedTex);
    gl.uniform1i(L.u_bed, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bodyTex);
    gl.uniform1i(L.u_body, 1);
    gl.uniform4f(L.u_bodyRect, bodyRect[0], bodyRect[1], bodyRect[2], bodyRect[3]);
    gl.uniform1f(L.u_alpha, alpha);
    gl.uniform1f(L.u_shade, shade);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynVbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts6, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(L.a_pos);
    gl.enableVertexAttribArray(L.a_bedUv);
    gl.enableVertexAttribArray(L.a_bodyUv);
    gl.vertexAttribPointer(L.a_pos, 2, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(L.a_bedUv, 2, gl.FLOAT, false, 24, 8);
    gl.vertexAttribPointer(L.a_bodyUv, 2, gl.FLOAT, false, 24, 16);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(L.a_pos);
    gl.disableVertexAttribArray(L.a_bedUv);
    gl.disableVertexAttribArray(L.a_bodyUv);
  }

  drawMoonlight(lightTex, view) {
    if (!lightTex) return;
    const gl = this.gl;
    // Multiply pass
    gl.blendFunc(gl.DST_COLOR, gl.ZERO);
    this.drawQuad(lightTex, view.roomX, view.roomY, view.roomW, view.roomH, 1);
    // Screen pass (#060a13)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    const q = this.quadBuf;
    const x2 = view.width;
    const y2 = view.height;
    q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 0;
    q[4] = x2; q[5] = 0; q[6] = 1; q[7] = 0;
    q[8] = 0; q[9] = y2; q[10] = 0; q[11] = 1;
    q[12] = 0; q[13] = y2; q[14] = 0; q[15] = 1;
    q[16] = x2; q[17] = 0; q[18] = 1; q[19] = 0;
    q[20] = x2; q[21] = y2; q[22] = 1; q[23] = 1;
    this._bindSpriteProg(this.whiteTex, 1, null, 0, [6 / 255, 10 / 255, 19 / 255, 1]);
    this._drawQuadArray(q, 6);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  destroy() {
    const gl = this.gl;
    if (this.fboA) {
      gl.deleteFramebuffer(this.fboA.fbo);
      gl.deleteTexture(this.fboA.tex);
    }
    if (this.fboB) {
      gl.deleteFramebuffer(this.fboB.fbo);
      gl.deleteTexture(this.fboB.tex);
    }
    gl.deleteTexture(this.whiteTex);
    gl.deleteBuffer(this.dynVbo);
    gl.deleteBuffer(this.catVbo);
    gl.deleteBuffer(this.catIbo);
    gl.deleteBuffer(this.fsVbo);
    gl.deleteProgram(this.spriteProg);
    gl.deleteProgram(this.catProg);
    gl.deleteProgram(this.furProg);
    gl.deleteProgram(this.mixProg);
  }
}

module.exports = { GLRenderer };
