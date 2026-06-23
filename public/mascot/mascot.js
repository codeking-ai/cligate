/* CliGate desktop mascot — placeholder renderer + interaction shell.
 *
 * Runs inside the Electron mascot window (preload exposes window.cligateMascot).
 * Also degrades gracefully in a plain browser (open /mascot/ for preview): the
 * character renders and reacts to state, just without window control.
 */
(function () {
  'use strict';

  const api = window.cligateMascot || null; // Electron preload bridge (may be null)
  const root = document.getElementById('mascot');
  const stage = document.getElementById('stage');
  const bubble = document.getElementById('bubble');
  const bubbleText = document.getElementById('bubble-text');

  const STATES = ['idle', 'listening', 'thinking', 'talking', 'notify'];
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

  function applyState(state, text) {
    const next = STATES.includes(state) ? state : 'idle';
    for (const s of STATES) root.classList.remove('state-' + s);
    root.classList.add('state-' + next);
    if (next === 'talking' || next === 'notify') {
      showBubble(text || (next === 'notify' ? 'I have something for you.' : ''), next === 'notify' ? 8000 : 0);
    } else if (next === 'idle') {
      hideBubble();
    }
  }

  // ── Live state via SSE ─────────────────────────────────────────────────────
  function connectEvents() {
    try {
      const es = new EventSource('/api/mascot/events');
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data && data.state) applyState(data.state, data.text);
        } catch { /* ignore malformed frame */ }
      };
      es.onerror = () => { /* EventSource auto-reconnects */ };
    } catch { /* no EventSource (shouldn't happen in Chromium) */ }
  }

  // ── Click-through hit-testing ──────────────────────────────────────────────
  // The window starts ignoring mouse events (forward:true keeps move events
  // flowing). When the cursor is over the opaque mascot we enable interaction;
  // over empty space we let clicks pass through to the desktop.
  let mouseInside = false;
  function setIgnore(ignore) {
    if (api && typeof api.setMouseIgnore === 'function') api.setMouseIgnore(ignore);
  }
  function isOverMascot(x, y) {
    const r = root.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }
  window.addEventListener('mousemove', (e) => {
    if (dragging) return;
    const over = isOverMascot(e.clientX, e.clientY);
    if (over && !mouseInside) { mouseInside = true; setIgnore(false); }
    else if (!over && mouseInside) { mouseInside = false; setIgnore(true); }
  });

  // ── Drag vs click ──────────────────────────────────────────────────────────
  let dragging = false;
  let dragStart = null;
  let moved = false;

  root.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    dragStart = { x: e.screenX, y: e.screenY };
    root.parentElement.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging || !dragStart) return;
    const dx = e.screenX - dragStart.x;
    const dy = e.screenY - dragStart.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    if (api && typeof api.moveBy === 'function') api.moveBy(dx, dy);
    dragStart = { x: e.screenX, y: e.screenY };
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    dragStart = null;
    stage.classList.remove('dragging');
    if (!moved) onClick();
  });

  function onClick() {
    if (api && typeof api.openChat === 'function') {
      api.openChat();
    } else {
      // Browser preview fallback: just flash a talking bubble.
      applyState('talking', 'Open me in the desktop app to chat!');
      setTimeout(() => applyState('idle'), 2500);
    }
  }

  // Right-click → context menu (Electron handles via preload; ignore in browser).
  root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (api && typeof api.showMenu === 'function') api.showMenu();
  });

  // ── Boot ────────────────────────────────────────────────────────────────────
  async function init() {
    setIgnore(true); // start click-through; hit-test re-enables over the mascot
    applyState('idle');
    try {
      const res = await fetch('/mascot/characters/placeholder/character.json');
      if (res.ok) {
        const pack = await res.json();
        if (pack?.greeting) { showBubble(pack.greeting, 4000); }
        document.title = `CliGate · ${pack?.name || 'Mascot'}`;
      }
    } catch { /* greeting is optional */ }
    connectEvents();
  }

  init();
})();
