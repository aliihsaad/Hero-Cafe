/* Vanilla sprite player. Each cell is an intact source frame.
 * Adjacent frames are motion-interpolated by motion-renderer.js.
 * Gaze calibration follows the actual new clip; speed uses visual motion.
 */
(() => {
  'use strict';
  const hero = document.querySelector('#hero');
  const stage = document.querySelector('#stage');
  const canvas = document.querySelector('#scene');
  const status = document.querySelector('#status');
  const hint = document.querySelector('#hint');
  const timeline = document.querySelector('#timeline');
  const replay = document.querySelector('#replay');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const stacked = matchMedia('(max-width: 760px)');
  const coarse = matchMedia('(pointer: coarse)');
  const debug = new URLSearchParams(location.search).has('debug');
  // Desktop's top quarter rests; lower three quarters track. The stacked
  // mobile layout uses its separate scene bounds instead of this hero zone.
  // Increase to .30 to make the active area slightly smaller.
  const FOLLOW_START = .25;
  // Extend the stable lower-side looks upward. Earlier gaze rows select other
  // takes of the same direction, over 100 frames away in the original clip.
  const SIDE_LOOK_ROW = .68;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const state = { frame: 0, target: 0, velocity: 0, mode: 'follow', active: false, playing: false, ready: false };
  const view = { w: 1, h: 1, dpr: 1, x: 0, y: 0, dw: 1, dh: 1 };
  let meta, sheet, motionImage, renderer, raf = 0, previous = 0, visible = true, pair = [-1, -1];
  let position = 0, contextLost = false;
  let lastDraw = NaN, sliderHeld = false, manualTarget = false, lastPointer = null;
  let touchContact = null, touchReturnTimer = 0;
  const drawnFrames = new Set();
  const metrics = { draws: 0, renderMs: 0, maxRenderMs: 0, maxMotionStep: 0, maxFrameStep: 0 };
  const samples = [];
  // Two small CPU-backed cells prevent a giant horizontal atlas GPU upload on
  // each animation tick. Only refresh a cell when its integer frame changes.
  const buffers = [document.createElement('canvas'), document.createElement('canvas')];
  const cells = buffers.map(c => c.getContext('2d', { alpha: false, willReadFrequently: true }));

  function setStatus(text) { if (status.textContent !== text) status.textContent = text; }
  function clearTouchReturn() {
    clearTimeout(touchReturnTimer); touchReturnTimer = 0;
  }
  function updateHint() {
    hint.textContent = reduced.matches ? 'Play at your pace'
      : state.mode === 'scrub' ? (coarse.matches ? 'Slide to explore' : 'Move left and right')
      : coarse.matches ? 'Tap or drag the scene' : 'Move your cursor';
  }
  function layout() {
    const r = stage.getBoundingClientRect();
    view.w = Math.max(1, r.width); view.h = Math.max(1, r.height);
    const scale = Math.max(view.w / meta.cell.width, view.h / meta.cell.height);
    // Interpolate at the source resolution, then let the compositor scale.
    // Extra shader pixels cannot recover detail from an 800x450 source cell.
    view.dpr = Math.min(devicePixelRatio || 1, 1 / scale);
    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);
    view.dw = meta.cell.width * scale; view.dh = meta.cell.height * scale;
    view.x = (view.w - view.dw) / 2; view.y = (view.h - view.dh) / 2;
    lastDraw = NaN;
    if (state.ready) { if (state.active && lastPointer) point(lastPointer); requestTick(); }
  }

  function render() {
    if (state.frame === lastDraw) return;
    const start = debug ? performance.now() : 0;
    const f = clamp(state.frame, 0, meta.frames - 1);
    const a = Math.floor(f), b = Math.min(a + 1, meta.frames - 1), mix = f - a;
    for (let slot = 0; slot < 2; slot++) {
      const index = slot ? b : a;
      if (pair[slot] !== index) {
        cells[slot].drawImage(sheet, index * meta.cell.width, 0, meta.cell.width, meta.cell.height, 0, 0, meta.cell.width, meta.cell.height);
        pair[slot] = index;
      }
      if (debug && (slot === 0 || mix > 0)) drawnFrames.add(index);
    }
    renderer.draw(a, b, mix, view);
    lastDraw = f;
    if (!sliderHeld && !manualTarget) timeline.value = String(f);
    timeline.setAttribute('aria-valuetext', `Frame ${Math.round(f) + 1} of ${meta.frames}`);
    if (debug) {
      const elapsed = performance.now() - start;
      metrics.draws++; metrics.renderMs += elapsed; metrics.maxRenderMs = Math.max(metrics.maxRenderMs, elapsed);
    }
  }

  function frameToDistance(frame) {
    const table = meta.motion?.distance;
    if (!table) return frame * 3;
    const a = Math.floor(frame), b = Math.min(a + 1, table.length - 1);
    return table[a] + (table[b] - table[a]) * (frame - a);
  }
  function distanceToFrame(distance) {
    const table = meta.motion?.distance;
    if (!table) return clamp(distance / 3, 0, meta.frames - 1);
    if (distance <= 0) return 0;
    if (distance >= table.at(-1)) return meta.frames - 1;
    let low = 0, high = table.length - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (table[mid] <= distance) low = mid; else high = mid;
    }
    return low + (distance - table[low]) / (table[high] - table[low]);
  }

  // Spring in measured motion distance, not arbitrary film time. Fast head
  // turns get more display frames; still holds no longer consume the easing.
  // Critically damped, with acceleration/velocity continuity on reversal.
  function integrate(dt) {
    const omega = state.active ? 14 : 8;
    const destination = frameToDistance(state.target);
    const delta = position - destination;
    const temp = (state.velocity + omega * delta) * dt;
    const decay = Math.exp(-omega * dt);
    const next = destination + (delta + temp) * decay;
    const speed = state.active ? 190 : 125;
    position += clamp(next - position, -speed * dt, speed * dt);
    position = clamp(position, 0, frameToDistance(meta.frames - 1));
    state.velocity = clamp((state.velocity - omega * temp) * decay, -speed, speed);
    state.frame = distanceToFrame(position);
    if (Math.abs(position - destination) < .008 && Math.abs(state.velocity) < .06) {
      position = destination; state.frame = state.target; state.velocity = 0;
    }
  }

  function tick(now) {
    raf = 0;
    const dt = Math.min((now - (previous || now)) / 1000, 1 / 30);
    previous = now;
    const priorFrame = state.frame, priorPosition = position;
    if (state.playing) {
      state.frame = Math.min(meta.frames - 1, state.frame + dt * meta.fps);
      state.target = state.frame;
      position = frameToDistance(state.frame);
      if (state.frame >= meta.frames - 1) {
        state.playing = false; state.active = false;
        state.target = nearestIdle(state.frame);
        replay.querySelector('span').textContent = 'Play hello';
        setStatus('Always happy to see you');
      }
    } else if (reduced.matches) {
      state.frame = state.target; position = frameToDistance(state.frame); state.velocity = 0;
    } else integrate(dt);
    render();
    if (debug) {
      metrics.maxFrameStep = Math.max(metrics.maxFrameStep, Math.abs(state.frame - priorFrame));
      metrics.maxMotionStep = Math.max(metrics.maxMotionStep, Math.abs(position - priorPosition));
      if (samples.length < 12000) samples.push({ time: now, frame: state.frame, target: state.target, position });
    }
    if (state.playing || state.frame !== state.target || state.velocity !== 0) requestTick();
    else previous = 0;
  }
  function requestTick() {
    if (!raf && !contextLost && visible && !document.hidden && state.ready) raf = requestAnimationFrame(tick);
  }
  function stopPlayback() {
    state.playing = false;
    replay.querySelector('span').textContent = 'Play hello';
  }
  function nearestIdle(frame) {
    // The new film passes through neutral several times. Return to the nearby
    // neutral pose instead of replaying unrelated glances to reach one timestamp.
    const at = frameToDistance(frame);
    return (meta.idleFrames || [meta.idleFrame]).reduce((best, candidate) =>
      Math.abs(frameToDistance(candidate) - at) < Math.abs(frameToDistance(best) - at) ? candidate : best
    );
  }
  function idle() {
    clearTouchReturn();
    if (!state.ready || state.playing) return;
    state.active = false; manualTarget = false; lastPointer = null; state.target = nearestIdle(state.frame);
    setStatus(reduced.matches ? 'Motion paused' : 'Always happy to see you');
    requestTick();
  }

  // Project onto the original 2D gaze trajectory. Favor nearby timeline
  // segments for ambiguous poses, but never rearrange the atlas itself.
  function gazeFrame(x, y) {
    if (Math.hypot(x, y) < .12) return nearestIdle(state.frame);
    let best = Infinity, frame = meta.idleFrame;
    for (let i = 0; i < meta.gaze.length - 1; i++) {
      const a = meta.gaze[i], b = meta.gaze[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
      if (length < .0001) continue;
      const t = clamp(((x - a.x) * dx + (y - a.y) * dy) / length, 0, 1);
      const candidate = a.frame + t * (b.frame - a.frame);
      const error = (x - a.x - dx * t) ** 2 + (y - a.y - dy * t) ** 2;
      const continuity = Math.abs(candidate - state.target) / meta.frames * .025;
      if (error + continuity < best) { best = error + continuity; frame = candidate; }
    }
    return clamp(frame, 0, meta.frames - 1);
  }
  function point(e) {
    if (!state.ready || sliderHeld || state.playing || reduced.matches) return;
    const h = hero.getBoundingClientRect();
    const r = stage.getBoundingClientRect();
    // On the stacked layout, the character is a separate scene below the copy.
    // Only that scene tracks; desktop's top-quarter reset belongs to its hero.
    if (stacked.matches && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) {
      if (state.active && !manualTarget) idle();
      return;
    }
    if (!stacked.matches && state.mode === 'follow' && e.clientY - h.top < h.height * FOLLOW_START) {
      if (state.active || manualTarget) idle();
      return;
    }
    // Check the reset zone before filtering controls so the header/logo also
    // returns the character to front. Scrub and explicit playback stay usable.
    if (e.target?.closest?.('button, a, input, [data-ui]')) return;
    const area = stacked.matches ? r : h;
    const x = clamp((e.clientX - area.left) / Math.max(1, area.width), 0, 1);
    const sceneY = (e.clientY - r.top) / Math.max(1, r.height);
    const side = clamp((Math.abs(x * 2 - 1) - .08) / .12, 0, 1);
    const sideWeight = side * side * (3 - 2 * side);
    // Preserve lower-area movement and center tracking. At either side, the
    // former middle-height switches now stay on the already-working lower row.
    // The desktop adjustment must not turn upper mobile touches into down looks.
    const followY = stacked.matches ? sceneY : sceneY + Math.max(0, SIDE_LOOK_ROW - sceneY) * sideWeight;
    const y = clamp((followY - .48) * 2.4, -1, 1);
    state.active = true; manualTarget = false;
    state.target = state.mode === 'scrub' ? x * (meta.frames - 1) : gazeFrame(x * 2 - 1, y);
    lastPointer = { clientX: e.clientX, clientY: e.clientY };
    setStatus(state.mode === 'scrub' ? 'The whole little story' : 'You have his attention');
    requestTick();
  }
  hero.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') {
      if (!e.buttons || touchContact?.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - touchContact.x, e.clientY - touchContact.y) > 12) touchContact.moved = true;
    }
    point(e);
  }, { passive: true });
  stage.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') {
      if (!e.isPrimary) return;
      clearTouchReturn();
      touchContact = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    }
    point(e);
  }, { passive: true });
  hero.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') idle(); });
  hero.addEventListener('pointercancel', () => { touchContact = null; sliderHeld = false; idle(); });
  window.addEventListener('pointerup', e => {
    sliderHeld = false;
    if (e.pointerType !== 'touch' || touchContact?.id !== e.pointerId) return;
    const tapped = !touchContact.moved;
    touchContact = null;
    // A brief tap previously reset before a visible response. Let it register.
    // Slider/buttons have their own behavior and never arm this scene return.
    if (tapped && state.active && !state.playing) touchReturnTimer = setTimeout(idle, 650);
    else idle();
  });
  window.addEventListener('blur', () => { stopPlayback(); touchContact = null; sliderHeld = false; idle(); });
  timeline.addEventListener('pointerdown', () => { clearTouchReturn(); sliderHeld = true; });
  timeline.addEventListener('input', () => {
    clearTouchReturn(); stopPlayback(); state.active = true; manualTarget = true;
    state.target = Number(timeline.value);
    setStatus('The whole little story'); requestTick();
  });
  timeline.addEventListener('keydown', e => { if (e.key === 'Escape') { stopPlayback(); idle(); } });
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    state.mode = button.dataset.mode; stopPlayback();
    document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    updateHint();
    idle();
  }));
  document.querySelector('#reset').addEventListener('click', () => { stopPlayback(); idle(); });
  function play() {
    if (!state.ready) return;
    clearTouchReturn();
    if (state.playing) { stopPlayback(); idle(); return; }
    state.active = false; manualTarget = false; state.playing = true; state.frame = 0; state.target = 0; state.velocity = 0;
    position = 0; previous = 0; setStatus('A little hello from your barista');
    replay.querySelector('span').textContent = 'Stop hello'; requestTick();
  }
  replay.addEventListener('click', play);
  document.querySelector('#invite').addEventListener('click', play);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; previous = 0; stopPlayback(); idle(); }
    else requestTick();
  });
  reduced.addEventListener('change', () => { stopPlayback(); idle(); updateHint(); });
  coarse.addEventListener('change', updateHint);
  new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (!visible) { cancelAnimationFrame(raf); raf = 0; previous = 0; }
    else requestTick();
  }).observe(stage);

  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault(); contextLost = true; cancelAnimationFrame(raf); raf = 0;
    document.body.classList.remove('is-ready');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    renderer = window.createMotionRenderer(canvas, meta, buffers, motionImage);
    contextLost = false; lastDraw = NaN; previous = 0;
    document.body.classList.add('is-ready'); requestTick();
  });

  async function boot() {
    try {
      const response = await fetch('assets/sequence.json?v=225025-5');
      if (!response.ok) throw new Error(`Sequence manifest: ${response.status}`);
      meta = await response.json();
      state.frame = state.target = meta.idleFrame;
      position = frameToDistance(meta.idleFrame);
      timeline.max = String(meta.frames - 1);
      sheet = new Image(); sheet.decoding = 'async'; sheet.src = meta.sheet;
      const motionReady = (async () => {
        if (!meta.motion) return;
        const image = new Image(); image.decoding = 'async'; image.src = meta.motion.src;
        try {
          await image.decode();
          if (image.naturalWidth === meta.frames * meta.motion.width && image.naturalHeight === meta.motion.height * 2) motionImage = image;
        }
        catch { /* Original-frame fallback remains usable if motion data fails. */ }
      })();
      await Promise.all([sheet.decode(), motionReady]);
      if (sheet.naturalWidth !== meta.cell.width * meta.frames || sheet.naturalHeight !== meta.cell.height) throw new Error('Sprite dimensions do not match the complete sequence');
      buffers.forEach(c => { c.width = meta.cell.width; c.height = meta.cell.height; });
      renderer = window.createMotionRenderer(canvas, meta, buffers, motionImage);
      state.ready = true; layout(); render();
      document.body.classList.add('is-ready');
      hero.querySelectorAll('button, input').forEach(el => { el.disabled = false; });
      updateHint();
      setStatus(reduced.matches ? 'Motion paused' : 'Always happy to see you');
      new ResizeObserver(layout).observe(stage);
      if (debug) window.__hero = {
        get state() { return { ...state, raf, reduced: reduced.matches }; },
        get frames() { return meta.frames; }, get drawnFrames() { return [...drawnFrames].sort((a,b) => a-b); },
        get source() { return { ...meta.source }; }, get idleFrames() { return meta.idleFrames || [meta.idleFrame]; },
        get metrics() { return { ...metrics, averageRenderMs: metrics.renderMs / Math.max(1, metrics.draws) }; },
        get sheet() { return { width: sheet.naturalWidth, height: sheet.naturalHeight }; },
        get view() { return { ...view }; }, gazeFrame,
        get renderer() { return renderer.kind; }, get glError() { return renderer.error || 0; },
        get samples() { return samples.slice(); }, frameToDistance,
        setMotion(enabled) { renderer.setMotion?.(enabled); lastDraw = NaN; render(); },
        seek(frame) { stopPlayback(); state.frame = state.target = clamp(frame, 0, meta.frames - 1); state.velocity = 0; position = frameToDistance(state.frame); lastDraw = NaN; render(); },
        resetMetrics() { drawnFrames.clear(); Object.keys(metrics).forEach(k => { metrics[k] = 0; }); samples.length = 0; }
      };
    } catch (error) {
      console.error('[Hero Café]', error);
      setStatus('Enjoy a quiet moment. Animation unavailable.');
      hint.textContent = 'Refresh to try again.';
      // The original idle poster remains visible and content stays readable.
    }
  }
  boot();
})();
