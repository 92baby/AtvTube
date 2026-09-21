// 临时诊断 + 功能验证用，确认没问题后再迁移到 ui.js 里的正式实现，然后删掉这个文件

const box = document.createElement('div');
box.style.position = 'fixed';
box.style.top = '0';
box.style.left = '0';
box.style.zIndex = '2147483647';
box.style.background = 'rgba(0,0,0,0.8)';
box.style.color = '#0f0';
box.style.font = '20px monospace';
box.style.padding = '8px';
box.style.maxWidth = '90vw';
box.style.whiteSpace = 'pre-wrap';
document.body.appendChild(box);

const lines = [];
function log(line) {
  lines.push(`${new Date().toISOString().slice(11, 19)}  ${line}`);
  if (lines.length > 14) lines.shift();
  box.textContent = lines.join('\n');
}

const KNOWN_NAV_KEYS = new Set([13, 37, 38, 39, 40, 27]); // Tizen 强制按键，不学习为开关键

let lastKeyCode = null;
let toggleKeyCode = null;

function isControlsVisible() {
  const el = document.querySelector('ytlr-watch-default');
  return !!el && el.getAttribute('hybridnavfocusable') === 'false';
}

function isOnWatchPage() {
  return !!document.querySelector('ytlr-player') || !!document.querySelector('ytlr-player-container');
}

let wasVisible = false;
let observedEl = null;

function attachObserver() {
  const el = document.querySelector('ytlr-watch-default');
  if (el === observedEl) return; // 节点没变就不重挂
  observedEl = el;
  if (!el) return;

  wasVisible = isControlsVisible();
  log('attach observer to ytlr-watch-default');

  new MutationObserver(() => {
    const nowVisible = isControlsVisible();
    if (nowVisible !== wasVisible) {
      log(`controls visible: ${nowVisible}  (key=${lastKeyCode}, onWatchPage=${isOnWatchPage()})`);
    }
    if (!wasVisible && nowVisible && isOnWatchPage() && lastKeyCode !== null && !KNOWN_NAV_KEYS.has(lastKeyCode)) {
      if (toggleKeyCode !== lastKeyCode) {
        toggleKeyCode = lastKeyCode;
        log(`learned toggle key = ${toggleKeyCode}`);
      }
    }
    wasVisible = nowVisible;
  }).observe(el, { attributes: true, attributeFilter: ['hybridnavfocusable'] });
}

setInterval(attachObserver, 500);

document.addEventListener('keydown', (evt) => {
  lastKeyCode = evt.keyCode;
  log(`key: ${evt.keyCode}`);

  if (toggleKeyCode !== null && evt.keyCode === toggleKeyCode && isOnWatchPage() && isControlsVisible()) {
    evt.preventDefault();
    evt.stopPropagation();
    log(`>>> sending synthetic Back (toggle key ${toggleKeyCode})`);

    const kE = document.createEvent('Event');
    kE.initEvent('keydown', true, true);
    kE.keyCode = 27;
    kE.which = 27;
    document.dispatchEvent(kE);
  }
}, true);
