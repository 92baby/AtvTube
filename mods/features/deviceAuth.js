/**
 * 设备授权
 * - 未激活自动提示：与 deviceAuth-13 相同（setTimeout + setInterval，仅 watch 页）
 * - 设置→设备授权：一单一码；device_id 绑定；pending 恢复不重复建单
 * - 轮询有界；付成功立即停；启动 recoverPending
 * - 已激活再点：说明弹窗（可后续加售后文案），不出支付码
 * - 支付由 Creem 托管结账；二维码内容即 Worker 返回的 Creem checkout_url，
 *   二维码图片由 Worker 的 /qr 生成（不经第三方）
 * - 同一设备已付款时，Worker 返回 already_paid，直接取回授权（恢复购买）
 * - 界面文案默认英文
 */

import {
  showToast,
  showModal,
  overlayPanelItemListRenderer,
  overlayMessageRenderer
} from '../ui/ytUI.js';

const AUTH_BASE = 'https://tv.tubegpt.de5.net';

const TIP_INTERVAL_MS = 5 * 60 * 1000;
const TIP_FIRST_DELAY_MS = 5 * 60 * 1000;
const AUTO_TIP_ONLY_ON_WATCH = true;

const TOKEN_KEY = 'tt_access_token';
const DEVICE_ID_KEY = 'tt_device_id';
const LAST_OK_KEY = 'tt_auth_last_ok';
const PENDING_KEY = 'tt_pending_auth';

const VALIDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_INTERVAL_SEC = 5;
const POLL_FAST_MS = 3 * 60 * 1000;
const POLL_SLOW_INTERVAL_SEC = 15;
const POLL_STOP_MS = 10 * 60 * 1000;

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

let authCache = null;
let tipTimer = null;
let tipFirstTimer = null;
let pollTimer = null;
let keyListenerAttached = false;
let paymentSessionActive = false;
let startingSession = false;
let pollBaseIntervalSec = DEFAULT_INTERVAL_SEC;
let pollStartedAt = 0;

/* ------------------------------ 本地存储 ------------------------------ */

function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return localStorage.getItem(key) === value;
  } catch (_) {
    return false;
  }
}

function lsRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch (_) {}
}

function randomHex(byteCount) {
  try {
    const c = window.crypto || window.msCrypto;
    const arr = new Uint8Array(byteCount);
    c.getRandomValues(arr);
    let out = '';
    for (let i = 0; i < arr.length; i++) {
      out += ('0' + arr[i].toString(16)).slice(-2);
    }
    return out;
  } catch (_) {}
  let out = '';
  for (let i = 0; i < byteCount * 2; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

function getDeviceId() {
  const existing = lsGet(DEVICE_ID_KEY);
  if (existing && DEVICE_ID_RE.test(existing)) return existing;
  const id = randomHex(16);
  return lsSet(DEVICE_ID_KEY, id) ? id : null;
}

/* ------------------------------ 对外 ------------------------------ */

export function isAuthorizedSync() {
  return authCache === true;
}

export function getAccessToken() {
  return lsGet(TOKEN_KEY) || null;
}

export function clearAuth() {
  lsRemove(TOKEN_KEY);
  lsRemove(LAST_OK_KEY);
  authCache = false;
  scheduleTips(true);
}

export function getAuthStatusLabel() {
  if (authCache === true) return 'Device authorization (activated)';
  if (lsGet(TOKEN_KEY)) return 'Device authorization (activated)';
  if (authCache === false) return 'Device authorization (not activated)';
  return 'Device authorization';
}

/* ------------------------------ 网络 ------------------------------ */

async function postJson(path, body) {
  const res = await fetch(AUTH_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  return { ok: res.ok, status: res.status, data: data || {} };
}

async function pollOnce(deviceCode) {
  try {
    const r = await postJson('/device/token', { device_code: deviceCode });
    if (r.data && (r.data.access_token || r.data.error)) return r.data;
    return { error: 'network' };
  } catch (err) {
    console.error('[DeviceAuth] 轮询出错:', err);
    return { error: 'network' };
  }
}

/* ------------------------------ 校验 ------------------------------ */

export async function checkAuth() {
  const token = lsGet(TOKEN_KEY);
  if (!token) {
    authCache = false;
    return false;
  }
  const deviceId = getDeviceId();
  if (!deviceId) {
    authCache = false;
    return false;
  }

  const lastOk = Number(lsGet(LAST_OK_KEY)) || 0;
  const age = Date.now() - lastOk;
  if (lastOk && age >= 0 && age < VALIDATE_INTERVAL_MS) {
    authCache = true;
    return true;
  }

  try {
    const r = await postJson('/token/validate', {
      access_token: token,
      device_id: deviceId
    });
    if (!r.ok || typeof r.data.valid !== 'boolean') {
      throw new Error('validate_failed_' + r.status);
    }
    if (r.data.valid) {
      lsSet(LAST_OK_KEY, String(Date.now()));
      authCache = true;
      return true;
    }
    lsRemove(TOKEN_KEY);
    lsRemove(LAST_OK_KEY);
    authCache = false;
    return false;
  } catch (e) {
    console.error('[DeviceAuth] 校验失败:', e);
    authCache = lastOk > 0;
    return authCache;
  }
}

export function initAuthOnStartup() {
  ensureDismissKeyListener();
  checkAuth().then(function (ok) {
    console.info('[DeviceAuth] 启动:', ok ? '已激活' : '未激活');
    if (ok) {
      stopTips();
      return;
    }
    scheduleTips(true);
    recoverPending();
  });
}

/* ------------------------------ 未激活提示（deviceAuth-13 实测逻辑） ------------------------------ */

function stopTips() {
  if (tipTimer) {
    clearInterval(tipTimer);
    tipTimer = null;
  }
  if (tipFirstTimer) {
    clearTimeout(tipFirstTimer);
    tipFirstTimer = null;
  }
}

function scheduleTips(withFirstDelay) {
  stopTips();
  if (authCache === true) return;
  if (withFirstDelay) {
    tipFirstTimer = setTimeout(function () {
      tipFirstTimer = null;
      if (authCache === true) return;
      maybeShowInactiveTip();
      tipTimer = setInterval(maybeShowInactiveTip, TIP_INTERVAL_MS);
    }, TIP_FIRST_DELAY_MS);
  } else {
    tipTimer = setInterval(maybeShowInactiveTip, TIP_INTERVAL_MS);
  }
}

function isWatchPage() {
  try {
    return String(window.location.href || '').indexOf('watch') >= 0;
  } catch (_) {
    return true;
  }
}

async function maybeShowInactiveTip() {
  if (authCache === true || paymentSessionActive) return;
  if (AUTO_TIP_ONLY_ON_WATCH && !isWatchPage()) return;
  if (getAccessToken()) {
    const ok = await checkAuth();
    if (ok) {
      stopTips();
      return;
    }
  }
  showModal(
    {
      title: 'Device not activated',
      subtitle: 'Activate this device to stop this reminder'
    },
    overlayPanelItemListRenderer([
      overlayMessageRenderer('This device has not been activated yet.'),
      overlayMessageRenderer(
        'Open Settings → Device authorization and scan the QR code to pay. Activation stops this reminder.'
      ),
      overlayMessageRenderer('Press Back to close')
    ]),
    'tt-device-auth-tip-modal'
  );
}

/* ------------------------------ pending ------------------------------ */

function loadPending() {
  const raw = lsGet(PENDING_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (
      p &&
      typeof p.device_code === 'string' &&
      typeof p.code_url === 'string' &&
      typeof p.expires_at === 'number'
    ) {
      return p;
    }
  } catch (_) {}
  lsRemove(PENDING_KEY);
  return null;
}

function savePending(p) {
  lsSet(PENDING_KEY, JSON.stringify(p));
}

function clearPending() {
  lsRemove(PENDING_KEY);
}

async function recoverPending() {
  const p = loadPending();
  if (!p) return;
  const r = await pollOnce(p.device_code);
  if (r.access_token) {
    finishActivation(r.access_token);
    return;
  }
  if (r.error === 'expired_token' || r.error === 'access_denied') {
    clearPending();
  }
}

/* ------------------------------ 已激活说明弹窗 ------------------------------ */

function showActivatedInfoModal() {
  try {
    showModal(
      {
        title: 'Device authorization',
        subtitle: 'This device is activated'
      },
      overlayPanelItemListRenderer([
        overlayMessageRenderer('This device is licensed. The periodic reminder is turned off.'),
        overlayMessageRenderer('No further payment is needed.'),
        // 后续可增加售后联系方式
        overlayMessageRenderer('Press Back to close')
      ]),
      'tt-device-auth-activated-modal'
    );
  } catch (err) {
    console.error('[DeviceAuth] 已激活弹窗失败:', err);
    showToast('This device is already activated', '');
  }
}

/* ------------------------------ 设置 → 设备授权 ------------------------------ */

export async function startDeviceAuth(opts) {
  opts = opts || {};
  if (opts.fromTimer) {
    maybeShowInactiveTip();
    return;
  }

  if (authCache === true) {
    showActivatedInfoModal();
    return;
  }

  if (lsGet(TOKEN_KEY)) {
    const ok = await checkAuth();
    if (ok) {
      stopTips();
      showActivatedInfoModal();
      return;
    }
  }

  if (startingSession) return;
  startingSession = true;
  try {
    await openOrResumeSession();
  } finally {
    startingSession = false;
  }
}

async function openOrResumeSession() {
  let pending = loadPending();

  if (pending && paymentSessionActive) {
    showPayModalFor(pending);
    return;
  }

  if (pending) {
    const r = await pollOnce(pending.device_code);
    if (r.access_token) {
      finishActivation(r.access_token);
      return;
    }
    if (r.error === 'network') {
      showToast('Network error. Please try again later.', '');
      return;
    }
    if (r.error === 'authorization_pending' && Date.now() < pending.expires_at) {
      showPayModalFor(pending);
      startPolling(pending);
      return;
    }
    clearPending();
  }

  const deviceId = getDeviceId();
  if (!deviceId) {
    showToast('Local storage is unavailable, so this device cannot be activated', '');
    return;
  }

  let data;
  try {
    const r = await postJson('/device/code', { device_id: deviceId });
    data = r.data;
  } catch (err) {
    console.error('[DeviceAuth] 建单失败:', err);
    showToast(
      'Request failed: ' +
        (err && err.name ? err.name + ' ' : '') +
        (err && err.message ? err.message : String(err)),
      ''
    );
    return;
  }

  // 恢复购买：本机此前已付款，直接取回授权，不再出支付码
  if (data && data.already_paid && data.device_code) {
    const restored = await pollOnce(data.device_code);
    if (restored.access_token) {
      finishActivation(restored.access_token);
      return;
    }
    showToast('Could not restore your purchase. Please contact support.', '');
    return;
  }

  if (!data || !data.device_code || !data.code_url) {
    showToast((data && data.message) || 'Could not create the payment order', '');
    return;
  }

  const expiresIn = data.expires_in || 1800;
  pending = {
    device_code: data.device_code,
    code_url: data.code_url,
    price_label: data.price_label || '',
    expires_at: Date.now() + expiresIn * 1000,
    interval: data.interval || DEFAULT_INTERVAL_SEC
  };
  savePending(pending);

  showPayModalFor(pending);
  startPolling(pending);
}

function buildQrImageUrl(content) {
  // 二维码由我们自己的 Worker 生成，结账链接不会发给第三方
  return AUTH_BASE + '/qr?data=' + encodeURIComponent(content);
}

function qrCodeListItem(imageUrl) {
  return {
    qrCodeRenderer: {
      qrCodeImage: { thumbnails: [{ url: imageUrl }] },
      style: 'QR_CODE_RENDERER_STYLE_ATA_SIDESHEET',
      trackingParams: null
    }
  };
}

function showPayModalFor(pending) {
  try {
    const minutes = Math.max(
      1,
      Math.round((pending.expires_at - Date.now()) / 60000)
    );
    showModal(
      {
        title: 'Device authorization · Stops the reminder',
        subtitle:
          (pending.price_label ? pending.price_label + ' · One-time, per device · ' : '') +
          'Scan to pay · Valid for ' +
          minutes +
          ' min · Press Back to close'
      },
      overlayPanelItemListRenderer([
        qrCodeListItem(buildQrImageUrl(pending.code_url))
      ]),
      'tt-device-auth-modal'
    );
  } catch (err) {
    console.error('[DeviceAuth] 弹窗失败:', err);
    showToast(
      'Display error: ' + (err && err.message ? err.message : String(err)),
      ''
    );
  }
}

/* ------------------------------ 有界轮询 ------------------------------ */

function startPolling(pending) {
  stopPolling();
  paymentSessionActive = true;
  pollStartedAt = Date.now();
  pollBaseIntervalSec = Math.max(
    pending.interval || DEFAULT_INTERVAL_SEC,
    DEFAULT_INTERVAL_SEC
  );

  function nextWaitMs() {
    const fast = Date.now() - pollStartedAt < POLL_FAST_MS;
    const sec = fast
      ? pollBaseIntervalSec
      : Math.max(POLL_SLOW_INTERVAL_SEC, pollBaseIntervalSec);
    return sec * 1000;
  }

  function scheduleNextTick() {
    stopPolling();
    if (!paymentSessionActive || authCache === true) return;
    pollTimer = setTimeout(tick, nextWaitMs());
  }

  async function tick() {
    if (authCache === true) {
      stopPolling();
      paymentSessionActive = false;
      return;
    }
    if (Date.now() - pollStartedAt > POLL_STOP_MS) {
      stopPolling();
      paymentSessionActive = false;
      showToast('Stopped checking automatically. After paying, reopen Device authorization.', '');
      return;
    }

    const data = await pollOnce(pending.device_code);

    if (data.access_token) {
      finishActivation(data.access_token);
      return;
    }

    if (data.error === 'authorization_pending') {
      if (data.interval) {
        pollBaseIntervalSec = Math.max(data.interval, DEFAULT_INTERVAL_SEC);
      }
      scheduleNextTick();
      return;
    }

    if (data.error === 'slow_down') {
      pollBaseIntervalSec = Math.max(
        data.interval || pollBaseIntervalSec + 5,
        DEFAULT_INTERVAL_SEC
      );
      scheduleNextTick();
      return;
    }

    if (data.error === 'expired_token') {
      stopPolling();
      paymentSessionActive = false;
      clearPending();
      showToast('This payment session expired. Please reopen Device authorization.', '');
      return;
    }

    if (data.error === 'access_denied') {
      stopPolling();
      paymentSessionActive = false;
      clearPending();
      showToast('Authorization is not available for this device', '');
      return;
    }

    scheduleNextTick();
  }

  tick();
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/* ------------------------------ 激活完成 ------------------------------ */

function saveAccessToken(token) {
  if (!lsSet(TOKEN_KEY, token)) return false;
  lsSet(LAST_OK_KEY, String(Date.now()));
  return true;
}

function finishActivation(token) {
  stopPolling();
  paymentSessionActive = false;
  if (saveAccessToken(token)) {
    clearPending();
    authCache = true;
    stopTips();
    showToast('Activated! This device is now licensed and the reminder will stop.', '');
    try {
      window.dispatchEvent(
        new CustomEvent('tt-auth-success', { detail: { token: token } })
      );
    } catch (_) {}
    return true;
  }
  showToast('Activated, but saving failed on this device. Please restart the app and try again.', '');
  return false;
}

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
    },
    true
  );
}
