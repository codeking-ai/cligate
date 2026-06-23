/* CliGate desktop mascot — pluggable renderer shell.
 *
 * Loads the active character pack (/api/mascot/config → /api/mascot/characters),
 * then dispatches to a renderer by pack.renderer:
 *   - placeholder : CSS-drawn character (no assets), cursor eye-tracking
 *   - live2d      : pixi-live2d-display, loads runtime from /mascot/vendor/
 * Unknown/failed renderers fall back to placeholder so the mascot is never blank.
 *
 * Runs in the Electron mascot window (preload → window.cligateMascot); also
 * renders in a plain browser (open /mascot/ for preview) without window control.
 */
(function () {
  'use strict';

  const api = window.cligateMascot || null;
  const mascotEl = document.getElementById('mascot');
  const bubble = document.getElementById('bubble');
  const bubbleText = document.getElementById('bubble-text');
  const STATES = ['idle', 'listening', 'thinking', 'talking', 'notify'];

  let activeRenderer = null;
  let bubbleTimer = null;

  function showBubble(text, autoHideMs) {
    if (!text) { hideBubble(); return; }
    bubbleText.textContent = text;
    bubble.hidden = false;
    if (bubbleTimer) clearTimeout(bubbleTimer);
    if (autoHideMs) bubbleTimer = setTimeout(hideBubble, autoHideMs);
  }
  function hideBubble() {
    bubble.hidden = true;
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some((s) => s.src.endsWith(src))) { resolve(); return; }
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('failed to load ' + src));
      document.head.appendChild(el);
    });
  }

  // ── Placeholder renderer (CSS) ──────────────────────────────────────────────
  const PlaceholderRenderer = {
    pupils: [],
    mount(container) {
      container.innerHTML = `
        <div class="character">
          <div class="antenna"></div>
          <div class="head">
            <div class="eye eye-left"><div class="pupil"></div></div>
            <div class="eye eye-right"><div class="pupil"></div></div>
            <div class="mouth"></div>
            <div class="thinking-dots"><span></span><span></span><span></span></div>
          </div>
          <div class="body"></div>
          <div class="shadow"></div>
        </div>`;
      this.pupils = [...container.querySelectorAll('.pupil')];
      this.setState('idle');
    },
    setState(state) {
      for (const s of STATES) mascotEl.classList.remove('state-' + s);
      mascotEl.classList.add('state-' + (STATES.includes(state) ? state : 'idle'));
    },
    onPointerMove(x, y) {
      for (const pupil of this.pupils) {
        const eye = pupil.parentElement.getBoundingClientRect();
        const cx = eye.left + eye.width / 2;
        const cy = eye.top + eye.height / 2;
        const dx = Math.max(-2.5, Math.min(2.5, (x - cx) / 14));
        const dy = Math.max(-2.5, Math.min(2.5, (y - cy) / 14));
        pupil.style.transform = `translate(${dx}px, ${dy}px)`;
      }
    },
    destroy() { this.pupils = []; }
  };

  // ── Live2D renderer (pixi-live2d-display) ───────────────────────────────────
  const Live2DRenderer = {
    app: null, model: null, manifest: null,
    async mount(container, manifest, entry) {
      // Cubism Core is proprietary (Live2D license) — the user supplies it; the
      // two pixi libs are MIT and fetched by scripts/fetch-mascot-runtime.mjs.
      await loadScript('/mascot/vendor/live2dcubismcore.min.js');
      await loadScript('/mascot/vendor/pixi.min.js');
      await loadScript('/mascot/vendor/pixi-live2d-display.min.js');
      if (!window.PIXI || !window.PIXI.live2d) throw new Error('Live2D runtime not available');

      const model = String(manifest?.assets?.model || '').trim();
      if (!model) throw new Error('character.json is missing assets.model');
      const modelUrl = `${entry.baseUrl}/${model.replace(/^\/+/, '')}`;

      container.innerHTML = '<canvas class="l2d-canvas"></canvas>';
      const canvas = container.querySelector('.l2d-canvas');
      this.app = new window.PIXI.Application({ view: canvas, backgroundAlpha: 0, transparent: true, resizeTo: container, antialias: true });
      this.model = await window.PIXI.live2d.Live2DModel.from(modelUrl);
      this.manifest = manifest;
      this.app.stage.addChild(this.model);
      this.fitModel(container);
    },
    fitModel(container) {
      if (!this.model) return;
      const b = container.getBoundingClientRect();
      const scale = Math.min(b.width / this.model.width, b.height / this.model.height);
      this.model.scale.set(scale);
      this.model.x = (b.width - this.model.width * scale) / 2;
      this.model.y = (b.height - this.model.height * scale) / 2;
    },
    setState(state) {
      const mapped = this.manifest?.states?.[state];
      if (!mapped || !this.model) return;
      const name = String(mapped).replace(/^motion:/, '');
      try { this.model.motion(name); } catch { /* motion group not in this model */ }
    },
    onPointerMove(x, y) { try { this.model?.focus?.(x, y); } catch { /* ignore */ } },
    destroy() {
      try { this.app?.destroy(true, { children: true }); } catch { /* ignore */ }
      this.app = null; this.model = null; this.manifest = null;
    }
  };

  function rendererFor(name) {
    return name === 'live2d' ? Live2DRenderer : PlaceholderRenderer;
  }

  async function loadCharacter() {
    let activeId = 'placeholder';
    try {
      const cfg = await fetch('/api/mascot/config').then((r) => r.json());
      activeId = cfg?.config?.character || 'placeholder';
    } catch { /* default */ }

    let entry = { id: 'placeholder', renderer: 'placeholder', baseUrl: '/mascot/characters/placeholder' };
    try {
      const list = await fetch('/api/mascot/characters').then((r) => r.json());
      const chars = list?.characters || [];
      entry = chars.find((c) => c.id === activeId) || chars.find((c) => c.id === 'placeholder') || entry;
    } catch { /* default */ }

    let manifest = {};
    try { manifest = await fetch(`${entry.baseUrl}/character.json`).then((r) => r.json()); } catch { /* optional */ }

    if (activeRenderer?.destroy) activeRenderer.destroy();
    activeRenderer = rendererFor(entry.renderer);
    try {
      await activeRenderer.mount(mascotEl, manifest, entry);
    } catch (err) {
      // Renderer (e.g. missing Live2D runtime/model) failed → never go blank.
      activeRenderer = PlaceholderRenderer;
      await activeRenderer.mount(mascotEl, {}, { id: 'placeholder' });
      showBubble(`「${entry.id}」renderer unavailable — using the default. ${err?.message || ''}`, 7000);
    }
    if (manifest?.greeting) showBubble(manifest.greeting, 4000);
  }

  function applyState(state, text) {
    const next = STATES.includes(state) ? state : 'idle';
    if (activeRenderer?.setState) activeRenderer.setState(next, text);
    if (next === 'talking' || next === 'notify') {
      showBubble(text || (next === 'notify' ? 'I have something for you.' : ''), next === 'notify' ? 8000 : 0);
    } else if (next === 'idle') {
      hideBubble();
    }
  }

  function connectEvents() {
    try {
      const es = new EventSource('/api/mascot/events');
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data?.directive === 'reload') { location.reload(); return; }
          if (data?.state) applyState(data.state, data.text);
        } catch { /* malformed frame */ }
      };
    } catch { /* no EventSource */ }
  }

  // ── Click-through hit-testing ──────────────────────────────────────────────
  let mouseInside = false;
  function setIgnore(ignore) {
    if (api?.setMouseIgnore) api.setMouseIgnore(ignore);
  }
  function isOverMascot(x, y) {
    const r = mascotEl.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  // ── Drag vs click ──────────────────────────────────────────────────────────
  let dragging = false, dragStart = null, moved = false;
  document.addEventListener('mousemove', (e) => {
    if (activeRenderer?.onPointerMove) activeRenderer.onPointerMove(e.clientX, e.clientY);
    if (dragging && dragStart) {
      const dx = e.screenX - dragStart.x;
      const dy = e.screenY - dragStart.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      if (api?.moveBy) api.moveBy(dx, dy);
      dragStart = { x: e.screenX, y: e.screenY };
      return;
    }
    const over = isOverMascot(e.clientX, e.clientY);
    if (over && !mouseInside) { mouseInside = true; setIgnore(false); }
    else if (!over && mouseInside) { mouseInside = false; setIgnore(true); }
  });
  mascotEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true; moved = false;
    dragStart = { x: e.screenX, y: e.screenY };
    mascotEl.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; dragStart = null;
    mascotEl.classList.remove('dragging');
    if (!moved) onClick();
  });
  mascotEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (api?.showMenu) api.showMenu();
  });

  function onClick() {
    if (api?.openChat) api.openChat();
    else { applyState('talking', 'Open me in the desktop app to chat!'); setTimeout(() => applyState('idle'), 2500); }
  }

  async function init() {
    setIgnore(true);
    await loadCharacter();
    applyState('idle');
    connectEvents();
  }

  init();
})();
