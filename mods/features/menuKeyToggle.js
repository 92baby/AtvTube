/**
 * Menu key toggle for Android TV (TizenTube Cobalt)
 *
 * When the video player controls overlay is visible, pressing the Menu key
 * acts like the Back key (closes the overlay and returns to normal playback).
 * When controls are hidden, Menu behaves normally (opens the overlay).
 *
 * DEBUG: shows last keyCode / key / code at top-left of the screen.
 * Set SHOW_KEY_DEBUG = false after you confirm the Menu keyCode.
 */

// ========== 调试开关 ==========
// 确认菜单键 keyCode 后，改成 false 即可关闭左上角显示
const SHOW_KEY_DEBUG = true;

// 已知菜单键（可按实测结果增删）
const MENU_KEY_CODES = [82]; // 82 = Android KEYCODE_MENU，测到后可改/追加

function isPlayerControlsVisible() {
  const progressBar = document.querySelector('ytlr-progress-bar');
  if (progressBar) {
    return progressBar.getAttribute('hybridnavfocusable') !== 'false';
  }
  const focused = document.activeElement;
  if (
    focused &&
    focused.closest(
      'ytlr-player, ytlr-watch-default, ytlr-player-container, ytlr-progress-bar'
    )
  ) {
    return true;
  }
  return false;
}

function isOnWatchPage() {
  return !!(
    document.querySelector('ytlr-watch-default') ||
    document.querySelector('ytlr-player') ||
    document.querySelector('video')
  );
}

function simulateBackKey() {
  const down = document.createEvent('Event');
  down.initEvent('keydown', true, true);
  down.keyCode = 27;
  down.which = 27;
  document.dispatchEvent(down);

  const up = document.createEvent('Event');
  up.initEvent('keyup', true, true);
  up.keyCode = 27;
  up.which = 27;
  document.dispatchEvent(up);
}

function isMenuKey(evt) {
  return (
    MENU_KEY_CODES.includes(evt.keyCode) ||
    evt.key === 'ContextMenu' ||
    evt.key === 'Menu' ||
    evt.code === 'ContextMenu'
  );
}

// ---------- 左上角按键调试浮层 ----------
let debugEl = null;
let debugHideTimer = null;

function ensureDebugOverlay() {
  if (debugEl) return debugEl;
  debugEl = document.createElement('div');
  debugEl.id = 'tt-key-debug';
  debugEl.style.cssText = [
    'position:fixed',
    'top:12px',
    'left:12px',
    'z-index:2147483647',
    'padding:10px 14px',
    'background:rgba(0,0,0,0.85)',
    'color:#0f0',
    'font:16px/1.4 monospace',
    'border-radius:6px',
    'pointer-events:none',
    'white-space:pre',
    'max-width:90vw',
    'box-shadow:0 2px 8px rgba(0,0,0,0.5)',
  ].join(';');
  (document.body || document.documentElement).appendChild(debugEl);
  return debugEl;
}

function showKeyDebug(evt) {
  if (!SHOW_KEY_DEBUG) return;
  const el = ensureDebugOverlay();
  const lines = [
    'keyCode: ' + evt.keyCode,
    'key:     ' + (evt.key || ''),
    'code:    ' + (evt.code || ''),
    'type:    ' + evt.type,
  ];
  el.textContent = lines.join('\n');
  el.style.display = 'block';

  clearTimeout(debugHideTimer);
  debugHideTimer = setTimeout(() => {
    if (debugEl) debugEl.style.display = 'none';
  }, 3000); // 3 秒后自动隐藏
}

function menuToggleHandler(evt) {
  // 每次按键都显示调试信息（仅 keydown，避免刷屏）
  if (evt.type === 'keydown') {
    showKeyDebug(evt);
  }

  if (!isMenuKey(evt)) return;

  if (!isOnWatchPage() || !isPlayerControlsVisible()) {
    return;
  }

  evt.preventDefault();
  evt.stopPropagation();
  if (typeof evt.stopImmediatePropagation === 'function') {
    evt.stopImmediatePropagation();
  }

  if (evt.type === 'keydown') {
    simulateBackKey();
  }
}

(function enableMenuKeyToggle() {
  document.addEventListener('keydown', menuToggleHandler, true);
  document.addEventListener('keypress', menuToggleHandler, true);
  document.addEventListener('keyup', menuToggleHandler, true);
  console.info(
    '[TizenTube] Menu key toggle enabled (debug overlay: ' +
      SHOW_KEY_DEBUG +
      ')'
  );
})();
