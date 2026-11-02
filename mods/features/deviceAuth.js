/**
 * 设备授权（支付扫码）
 * - 不限制任何 JS 功能
 * - 未激活：启动约 5 分钟后首次弹窗，之后每 5 分钟一次（可选：仅在观看页）
 * - 已激活：不再自动弹；设置里再点只提示已授权
 * - 手动点「设备授权」可反复打开（不依赖重启 APP）
 * - 遥控器返回/Back 关闭弹窗时会结束轮询，允许再次打开
 */

import {
  showToast,
  showModal,
  QrCodeRenderer,
  overlayPanelItemListRenderer,
  overlayMessageRenderer
} from '../ui/ytUI.js';

const AUTH_BASE = 'https://tv.tubegpt.de5.net';

/** 未激活时弹窗间隔 */
const PROMPT_INTERVAL_MS = 5 * 60 * 1000;

/** 启动后多久第一次自动弹 */
const FIRST_PROMPT_DELAY_MS = 5 * 60 * 1000;

/**
 * true = 仅在观看视频页（url 含 watch）才自动弹
 * false = 任意界面到点都弹
 */
const AUTO_PROMPT_ONLY_ON_WATCH = true;

const TOKEN_KEY = 'tt_access_token';

let authCache = null;
let promptTimer = null;
let firstPromptTimer = null;
let pollTimer = null;
let promptInFlight = false;
let keyListenerAttached = false;

export function isAuthorizedSync() {
  return authCache === true;
}

export function getAccessToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || null;
  } catch (_) {
    return null;
  }
}

export function clearAuth() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch (_) {}
  authCache = false;
  schedulePrompts(true);
}

export function getAuthStatusLabel() {
  if (authCache === true) return '设备授权（已激活）';
  try {
    if (localStorage.getItem(TOKEN_KEY)) return '设备授权（已激活）';
  } catch (_) {}
  if (authCache === false) return '设备授权（未授权）';
  return '设备授权';
}

export async function checkAuth() {
  let token = null;
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch (e) {
    authCache = false;
    return false;
  }

  if (!token) {
    authCache = false;
    return false;
  }

  try {
    const res = await fetch(
      AUTH_BASE + '/token/validate?access_token=' + encodeURIComponent(token)
    );
    const data = await res.json();
    authCache = !!data.valid;
    if (!authCache) {
      try {
        localStorage.removeItem(TOKEN_KEY);
      } catch (_) {}
    }
    return authCache;
  } catch (e) {
    console.error('[DeviceAuth] 校验失败:', e);
    authCache = true;
    return true;
  }
}

export function initAuthOnStartup() {
  ensureDismissKeyListener();
  checkAuth().then(function (ok) {
    console.info('[DeviceAuth] 启动:', ok ? '已激活' : '未激活，将定时提示支付');
    if (ok) {
      stopPrompts();
    } else {
      schedulePrompts(true);
    }
  });
}

function stopPrompts() {
  if (promptTimer) {
    clearInterval(promptTimer);
    promptTimer = null;
  }
  if (firstPromptTimer) {
    clearTimeout(firstPromptTimer);
    firstPromptTimer = null;
  }
}

function schedulePrompts(withFirstDelay) {
  stopPrompts();
  if (authCache === true) return;

  if (withFirstDelay) {
    firstPromptTimer = setTimeout(function () {
      firstPromptTimer = null;
      if (authCache === true) return;
      maybeShowPayPrompt();
      promptTimer = setInterval(maybeShowPayPrompt, PROMPT_INTERVAL_MS);
    }, FIRST_PROMPT_DELAY_MS);
  } else {
    promptTimer = setInterval(maybeShowPayPrompt, PROMPT_INTERVAL_MS);
  }
}

function isWatchPage() {
  try {
    const href = String(window.location.href || '');
    return href.indexOf('watch') >= 0;
  } catch (_) {
    return true;
  }
}

async function maybeShowPayPrompt() {
  if (authCache === true) return;
  if (promptInFlight) return;
  if (AUTO_PROMPT_ONLY_ON_WATCH && !isWatchPage()) {
    return;
  }
  if (getAccessToken()) {
    const ok = await checkAuth();
    if (ok) {
      stopPrompts();
      return;
    }
  }
  startDeviceAuth({ fromTimer: true });
}

/**
 * 设置手动点击 或 定时器
 * 手动点击会强制结束上一轮轮询，可反复打开
 */
export async function startDeviceAuth(opts) {
  opts = opts || {};
  const fromTimer = !!opts.fromTimer;

  // 手动打开：始终允许，清掉卡住的 inFlight
  if (!fromTimer) {
    stopPolling();
    promptInFlight = false;
  }

  if (authCache === true) {
    if (!fromTimer) showToast('本机已授权，无需重复激活', '');
    return;
  }

  try {
    if (localStorage.getItem(TOKEN_KEY)) {
      const ok = await checkAuth();
      if (ok) {
        stopPrompts();
        if (!fromTimer) showToast('本机已授权，无需重复激活', '');
        return;
      }
    }
  } catch (_) {}

  if (promptInFlight) return;
  promptInFlight = true;

  let data;
  try {
    let res = await fetch(AUTH_BASE + '/device/code', { method: 'GET' });
    if (!res.ok) {
      res = await fetch(AUTH_BASE + '/device/code', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}'
      });
    }
    data = await res.json();
  } catch (err) {
    resetPromptState();
    console.error('[DeviceAuth] 请求失败:', err);
    if (!fromTimer) {
      showToast(
        '请求失败: ' +
          (err && err.name ? err.name + ' ' : '') +
          (err && err.message ? err.message : String(err)),
        ''
      );
    }
    return;
  }

  if (!data.device_code || !data.code_url) {
    resetPromptState();
    if (!fromTimer) {
      showToast(data.message || '创建支付订单失败', '');
    }
    return;
  }

  // 先尝试关掉可能残留的弹层，再展示，减轻「说明和码叠在一起」
  try {
    closeAuthModalSoft();
  } catch (_) {}

  try {
    await delay(120);
    showPayModal({
      codeUrl: data.code_url,
      amountYuan: data.amount_yuan || formatYuan(data.amount),
      description: data.description || '设备永久授权',
      expiresIn: data.expires_in || 1800,
      outTradeNo: data.out_trade_no || ''
    });
  } catch (err) {
    console.error('[DeviceAuth] 弹窗失败:', err);
    resetPromptState();
    if (!fromTimer) {
      showToast(
        '界面异常: ' + (err && err.message ? err.message : String(err)),
        ''
      );
    }
    return;
  }

  pollForToken(data.device_code, data.interval || 5, data.expires_in || 1800);
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function formatYuan(amountFen) {
  if (amountFen == null || amountFen === '') return '--';
  return (Number(amountFen) / 100).toFixed(2);
}

function buildQrImageUrl(content) {
  return (
    'https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=8&data=' +
    encodeURIComponent(content)
  );
}

function showPayModal(opts) {
  const minutes = Math.max(1, Math.round((opts.expiresIn || 1800) / 60));
  // 精简布局：码在上、文字少，减少拥挤、便于扫描
  const lines = [
    QrCodeRenderer(buildQrImageUrl(opts.codeUrl)),
    overlayMessageRenderer('¥' + opts.amountYuan + ' · 手机扫码支付'),
    overlayMessageRenderer(minutes + ' 分钟内有效 · 返回键关闭')
  ];
  showModal(
    {
      title: '设备授权',
      subtitle: opts.description || '支付后自动激活本机'
    },
    overlayPanelItemListRenderer(lines),
    'tt-device-auth-modal'
  );
}

function pollForToken(deviceCode, interval, expiresIn) {
  stopPolling();
  interval = interval || 5;
  expiresIn = expiresIn || 1800;
  const deadline = Date.now() + expiresIn * 1000;

  pollTimer = setInterval(async function () {
    if (Date.now() > deadline) {
      stopPolling();
      resetPromptState();
      return;
    }

    try {
      const res = await fetch(
        AUTH_BASE +
          '/device/token?device_code=' +
          encodeURIComponent(deviceCode)
      );
      const data = await res.json();

      if (data.access_token) {
        stopPolling();
        try {
          localStorage.setItem(TOKEN_KEY, data.access_token);
        } catch (e) {
          console.error('[DeviceAuth] 无法写入 localStorage', e);
        }
        authCache = true;
        stopPrompts();
        resetPromptState();
        closeAuthModalSoft();
        showToast('授权成功！本机已激活', '');
        try {
          window.dispatchEvent(
            new CustomEvent('tt-auth-success', {
              detail: { token: data.access_token }
            })
          );
        } catch (_) {}
        return;
      }

      if (data.error === 'authorization_pending') return;

      stopPolling();
      resetPromptState();
    } catch (err) {
      console.error('[DeviceAuth] 轮询出错:', err);
    }
  }, interval * 1000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function resetPromptState() {
  promptInFlight = false;
}

/** 模拟 ESC，尽量关掉 YT 弹层（不保证 100%） */
function closeAuthModalSoft() {
  try {
    const kE = document.createEvent('Event');
    kE.initEvent('keydown', true, true);
    kE.keyCode = 27;
    kE.which = 27;
    document.dispatchEvent(kE);
  } catch (e) {}
}

/**
 * 遥控器返回 / Back / ESC：结束本轮支付轮询，允许再次打开授权窗
 * 常见键值：27 ESC，461/10009 部分 TV Back
 */
function ensureDismissKeyListener() {
  if (keyListenerAttached) return;
  keyListenerAttached = true;
  document.addEventListener(
    'keydown',
    function (e) {
      const code = e.keyCode || e.which || 0;
      const key = e.key || '';
      const isBack =
        code === 27 ||
        code === 461 ||
        code === 10009 ||
        code === 8 ||
        key === 'Escape' ||
        key === 'Backspace';
      if (!isBack) return;
      if (!promptInFlight && !pollTimer) return;
      stopPolling();
      resetPromptState();
      // 不拦截事件，让 YT 自己关掉弹层
    },
    true
  );
}
