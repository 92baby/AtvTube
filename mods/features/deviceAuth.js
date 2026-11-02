/**
 * 设备授权（支付扫码）
 * - 不限制任何 JS 功能
 * - 未激活：启动约 5 分钟后首次弹窗，之后每 5 分钟一次（默认仅观看页）
 * - 已激活：不再自动弹；设置里再点只提示已授权
 * - 手动可反复打开；返回键关闭后可再次打开
 * - 弹窗：标题/副标题 + 二维码在上、说明在下（避免 SIDESHEET 样式盖住文字）
 */

import {
  showToast,
  showModal,
  overlayPanelItemListRenderer,
  overlayMessageRenderer
} from '../ui/ytUI.js';

const AUTH_BASE = 'https://tv.tubegpt.de5.net';

const PROMPT_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_PROMPT_DELAY_MS = 5 * 60 * 1000;
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
    return String(window.location.href || '').indexOf('watch') >= 0;
  } catch (_) {
    return true;
  }
}

async function maybeShowPayPrompt() {
  if (authCache === true) return;
  if (promptInFlight) return;
  if (AUTO_PROMPT_ONLY_ON_WATCH && !isWatchPage()) return;
  if (getAccessToken()) {
    const ok = await checkAuth();
    if (ok) {
      stopPrompts();
      return;
    }
  }
  startDeviceAuth({ fromTimer: true });
}

export async function startDeviceAuth(opts) {
  opts = opts || {};
  const fromTimer = !!opts.fromTimer;

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

  try {
    showPayModal({
      codeUrl: data.code_url,
      amountYuan: data.amount_yuan || formatYuan(data.amount),
      description: data.description || '设备永久授权',
      expiresIn: data.expires_in || 1800
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

function formatYuan(amountFen) {
  if (amountFen == null || amountFen === '') return '--';
  return (Number(amountFen) / 100).toFixed(2);
}

function buildQrImageUrl(content) {
  return (
    'https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=8&data=' +
    encodeURIComponent(content)
  );
}

/**
 * 使用 SIDESHEET 以获得较大二维码。
 * 该样式会占满内容区，若在同一列表再放 overlayMessage 极易与码重叠。
 * 因此内容区只放二维码；金额/时限/说明全部放进标题与副标题。
 */
function qrCodeListItem(imageUrl) {
  return {
    qrCodeRenderer: {
      qrCodeImage: {
        thumbnails: [{ url: imageUrl }]
      },
      style: 'QR_CODE_RENDERER_STYLE_ATA_SIDESHEET',
      trackingParams: null
    }
  };
}

function showPayModal(opts) {
  const amount = opts.amountYuan || '--';

  showModal(
    {
      title: '设备授权 · 授权后不再弹出',
      subtitle: '¥' + amount + ' · 扫码支付 · 返回关闭'
    },
    overlayPanelItemListRenderer([qrCodeListItem(buildQrImageUrl(opts.codeUrl))]),
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
        showToast('授权成功！本机已激活，播放中将不再弹出', '');
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

/**
 * 仅复位业务状态，不向页面注入 ESC（注入 ESC 容易造成「要按两次返回」）。
 * 真正关弹窗交给遥控器返回，由 YouTube 处理。
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
      // 只清轮询/锁，不 stopPropagation，让第一次返回就能关掉 YT 弹层
      stopPolling();
      resetPromptState();
    },
    true
  );
}
