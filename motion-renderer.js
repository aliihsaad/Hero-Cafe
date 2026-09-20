/* Motion-compensated interpolation of adjacent ORIGINAL sprite cells.
 * Flow is precomputed; the browser only warps two small textures on the GPU.
 * Original frames are exact at integer positions. No camera/scene transform.
 */
(() => {
  'use strict';
  const vertex = `#version 300 es
    out vec2 screenUV;
    void main() {
      vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
      screenUV = vec2(p.x, 1.0 - p.y);
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`;
  const fragment = `#version 300 es
    precision highp float;
    uniform sampler2D imageA;
    uniform sampler2D imageB;
    uniform sampler2D forwardFlow;
    uniform sampler2D backwardFlow;
    uniform vec2 cropScale;
    uniform vec2 cropOffset;
    uniform vec2 imageSize;
    uniform float phase;
    uniform float useMotion;
    in vec2 screenUV;
    out vec4 color;
    void main() {
      vec2 uv = cropOffset + screenUV * cropScale;
      if (phase < 0.00001) {
        color = vec4(texture(imageA, uv).rgb, 1.0);
        return;
      }
      vec2 a = uv;
      vec2 b = uv;
      // Inverse warp: solve where the pixel at this intermediate position
      // came from in each endpoint. Two refinements handle varying flow.
      for (int i = 0; i < 3; ++i) {
        a = uv - phase * useMotion * texture(forwardFlow, a).rg / imageSize;
        b = uv - (1.0 - phase) * useMotion * texture(backwardFlow, b).rg / imageSize;
      }
      color = vec4(mix(texture(imageA, a).rgb, texture(imageB, b).rgb, phase), 1.0);
    }`;

  window.createMotionRenderer = (canvas, meta, buffers, motionImage) => {
    const gl = motionImage && canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false
    });
    if (!gl) {
      const ctx = canvas.getContext('2d', { alpha: false });
      return {
        kind: 'canvas-blend',
        draw(a, b, mix, view) {
          ctx.setTransform(canvas.width / view.w, 0, 0, canvas.height / view.h, 0, 0);
          ctx.globalAlpha = 1;
          ctx.drawImage(buffers[0], view.x, view.y, view.dw, view.dh);
          if (mix > .001) {
            ctx.globalAlpha = mix;
            ctx.drawImage(buffers[1], view.x, view.y, view.dw, view.dh);
            ctx.globalAlpha = 1;
          }
        }
      };
    }
    function shader(type, source) {
      const result = gl.createShader(type);
      gl.shaderSource(result, source); gl.compileShader(result);
      if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result));
      return result;
    }
    const program = gl.createProgram();
    const vs = shader(gl.VERTEX_SHADER, vertex), fs = shader(gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const uniforms = {};
    ['imageA', 'imageB', 'forwardFlow', 'backwardFlow', 'cropScale', 'cropOffset', 'imageSize', 'phase', 'useMotion'].forEach(key => {
      uniforms[key] = gl.getUniformLocation(program, key);
    });
    gl.uniform1i(uniforms.imageA, 0); gl.uniform1i(uniforms.imageB, 1);
    gl.uniform1i(uniforms.forwardFlow, 2); gl.uniform1i(uniforms.backwardFlow, 3);
    gl.uniform2f(uniforms.imageSize, meta.cell.width, meta.cell.height);
    gl.uniform1f(uniforms.useMotion, 1);
    const textures = Array.from({ length: 4 }, (_, unit) => {
      const texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (unit < 2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, meta.cell.width, meta.cell.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, meta.motion.width, meta.motion.height, 0, gl.RG, gl.FLOAT, null);
      return texture;
    });
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const flowCanvas = document.createElement('canvas');
    const { width: fw, height: fh } = meta.motion;
    flowCanvas.width = fw; flowCanvas.height = fh * 2;
    const flowContext = flowCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    const vectors = [new Float32Array(fw * fh * 2), new Float32Array(fw * fh * 2)];
    const uploaded = [-1, -1];
    let flowIndex = -1;
    let motionEnabled = true;
    function uploadFlow(index) {
      const source = motionImage.getFrame ? motionImage.getFrame(index) : { image: motionImage, x: index * fw };
      if (source) flowContext.drawImage(source.image, source.x, 0, fw, fh * 2, 0, 0, fw, fh * 2);
      const bytes = source ? flowContext.getImageData(0, 0, fw, fh * 2).data : null;
      for (let direction = 0; direction < 2; direction++) {
        const offset = direction * fw * fh * 4;
        const v = vectors[direction];
        for (let p = 0; p < fw * fh; p++) {
          const at = offset + p * 4;
          const x = bytes ? bytes[at] * 16 + (bytes[at + 1] >> 4) : meta.motion.zero;
          const y = bytes ? (bytes[at + 1] & 15) * 256 + bytes[at + 2] : meta.motion.zero;
          v[p * 2] = (x - meta.motion.zero) / meta.motion.scale;
          v[p * 2 + 1] = (y - meta.motion.zero) / meta.motion.scale;
        }
        gl.activeTexture(gl.TEXTURE0 + 2 + direction);
        gl.bindTexture(gl.TEXTURE_2D, textures[2 + direction]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, fw, fh, gl.RG, gl.FLOAT, v);
      }
      flowIndex = index;
    }
    return {
      kind: 'webgl2-optical-flow',
      setMotion(enabled) { motionEnabled = enabled; },
      draw(a, b, mix, view) {
        gl.useProgram(program);
        for (let slot = 0; slot < 2; slot++) {
          const index = slot ? b : a;
          gl.activeTexture(gl.TEXTURE0 + slot); gl.bindTexture(gl.TEXTURE_2D, textures[slot]);
          if (uploaded[slot] !== index) {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, buffers[slot]);
            uploaded[slot] = index;
          }
        }
        if (flowIndex !== a) uploadFlow(a);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(uniforms.cropScale, view.w / view.dw, view.h / view.dh);
        gl.uniform2f(uniforms.cropOffset, -view.x / view.dw, -view.y / view.dh);
        gl.uniform1f(uniforms.phase, mix);
        gl.uniform1f(uniforms.useMotion, motionEnabled ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      get error() { return gl.getError(); }
    };
  };
})();
