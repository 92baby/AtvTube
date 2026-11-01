/**
 * 设备授权（支付扫码）
 * - 不限制任何 JS 功能：激活与否都全功能开放
 * - 未激活：约每 5 分钟弹出一次支付二维码
 * - 已激活：不再弹出；设置里再点只提示已授权
 *
 * Worker：
 *   GET/POST /device/code
 *   GET/POST /device/token?device_code=
 *   GET/POST /token/validate?access_token=
 *   POST /pay/mock/complete
 *   GET /verify
 */

import {
  showToast,
  showModal,
  QrCodeRenderer,
  overlayPanelItemListRenderer,
  overlayMessageRenderer
} from '../ui/ytUI.js';

const AUTH_BASE = 'https://tv.tubegpt.de5.net';

/** 未激活时弹窗间隔（毫秒） */
const PROMPT_INTERVAL_MS = 5 * 60 * 1000;

/** 首次启动延迟再弹，避免一进应用就挡画面（毫秒） */
const FIRST_PROMPT_DELAY_MS = 5 * 60 * 1000;

const TOKEN_KEY = 'tt_access_token';

let authCache = null; // null 未检查 / true 已激活 / false 未激活
let promptTimer = null;
let pollTimer = null;
let promptInFlight = false;

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
  schedulePrompts();
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
    // 网络异常：有本地 token 则暂视为已激活，避免反复弹窗
    authCache = true;
    return true;
  }
}

/**
 * 启动时调用一次：校验 token，未激活则开始 5 分钟弹窗循环
 */
export function initAuthOnStartup() {
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
}

function schedulePrompts(withFirstDelay) {
  stopPrompts();
  if (authCache === true) return;

  if (withFirstDelay) {
    setTimeout(function () {
      if (authCache === true) return;
      maybeShowPayPrompt();
      promptTimer = setInterval(maybeShowPayPrompt, PROMPT_INTERVAL_MS);
    }, FIRST_PROMPT_DELAY_MS);
  } else {
    promptTimer = setInterval(maybeShowPayPrompt, PROMPT_INTERVAL_MS);
  }
}

async function maybeShowPayPrompt() {
  if (authCache === true || promptInFlight) return;
  if (getAccessToken()) {
    const ok = await checkAuth();
    if (ok) {
      stopPrompts();
      return;
    }
  }
  // 定时自动弹出（与设置里手动点授权同一套建单）
  startDeviceAuth({ fromTimer: true });
}

/**
 * 设置菜单点击 或 定时器调用
 * @param {{ fromTimer?: boolean }} opts
 */
export async function startDeviceAuth(opts) {
  opts = opts || {};
  stopPolling();

  if (authCache === true) {
    showToast('本机已授权，无需重复激活', '');
    return;
  }

  try {
    if (localStorage.getItem(TOKEN_KEY)) {
      const ok = await checkAuth();
      if (ok) {
        stopPrompts();
        showToast('本机已授权，无需重复激活', '');
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
    promptInFlight = false;
    console.error('[DeviceAuth] 请求失败:', err);
    if (!opts.fromTimer) {
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
    promptInFlight = false;
    if (!opts.fromTimer) {
      showToast(data.message || '创建支付订单失败', '');
    }
    return;
  }

  try {
    showPayModal({
      codeUrl: data.code_url,
      amountYuan: data.amount_yuan || formatYuan(data.amount),
      description: data.description || '设备永久授权',
      expiresIn: data.expires_in || 300,
      outTradeNo: data.out_trade_no || ''
    });
  } catch (err) {
    console.error('[DeviceAuth] 弹窗失败:', err);
    if (!opts.fromTimer) {
      showToast(
        '界面异常: ' + (err && err.message ? err.message : String(err)),
        ''
      );
    }
  }

  pollForToken(data.device_code, data.interval || 5, data.expires_in || 300);
}

function formatYuan(amountFen) {
  if (amountFen == null || amountFen === '') return '--';
  return (Number(amountFen) / 100).toFixed(2);
}

function buildQrImageUrl(content) {
  return (
    'https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=8&data=' +
    encodeURIComponent(content)
  );
}

function showPayModal(opts) {
  const minutes = Math.max(1, Math.round((opts.expiresIn || 300) / 60));
  const lines = [
    overlayMessageRenderer(opts.description),
    overlayMessageRenderer('金额：¥' + opts.amountYuan),
    overlayMessageRenderer('请使用手机扫码完成支付以激活本机'),
    QrCodeRenderer(buildQrImageUrl(opts.codeUrl))
  ];
  if (opts.outTradeNo) {
    lines.push(overlayMessageRenderer('订单：' + opts.outTradeNo));
  }
  lines.push(
    overlayMessageRenderer(
      '请在 ' + minutes + ' 分钟内完成支付（未激活时约每 5 分钟提示一次）'
    )
  );
  lines.push(overlayMessageRenderer('等待支付中...'));

  showModal(
    { title: '设备授权' },
    overlayPanelItemListRenderer(lines),
    'tt-device-auth-modal'
  );
}

function pollForToken(deviceCode, interval, expiresIn) {
  stopPolling();
  interval = interval || 5;
  expiresIn = expiresIn || 300;
  const deadline = Date.now() + expiresIn * 1000;

  pollTimer = setInterval(async function () {
    if (Date.now() > deadline) {
      stopPolling();
      promptInFlight = false;
      closeAuthModal();
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
        promptInFlight = false;
        try {
          localStorage.setItem(TOKEN_KEY, data.access_token);
        } catch (e) {
          console.error('[DeviceAuth] 无法写入 localStorage', e);
        }
        authCache = true;
        stopPrompts();
        closeAuthModal();
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
      promptInFlight = false;
      closeAuthModal();
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

function closeAuthModal() {
  promptInFlight = false;
  try {
    const kE = document.createEvent('Event');
    kE.initEvent('keydown', true, true);
    kE.keyCode = 27;
    kE.which = 27;
    document.dispatchEvent(kE);
  } catch (e) {}
}
