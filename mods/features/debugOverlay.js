// 临时诊断用，确认好数据后就删掉，不进正式版本

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
  if (lines.length > 12) lines.shift();
  box.textContent = lines.join('\n');
}

document.addEventListener('keydown', (evt) => {
  log(`key: ${evt.keyCode}  (${evt.key || ''})`);
}, true);

let last = {};
setInterval(() => {
  const targets = {
    'ytlr-progress-bar': document.querySelector('ytlr-progress-bar'),
    'ytlr-watch-default': document.querySelector('ytlr-watch-default'),
  };
  for (const [name, el] of Object.entries(targets)) {
    const val = el ? el.getAttribute('hybridnavfocusable') : '(not found)';
    if (last[name] !== val) {
      log(`${name}.hybridnavfocusable = ${val}`);
      last[name] = val;
    }
  }
}, 300);