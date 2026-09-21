/*global navigate*/
import '../spatial-navigation-polyfill.js';
import css from './ui.css';
import { configRead, configWrite } from '../config.js';
import updateStyle from './theme.js';
import { showToast } from './ytUI.js';
import modernUI from './settings.js';
import resolveCommand, { patchResolveCommand } from '../resolveCommand.js';
import { pipToFullscreen } from '../features/pictureInPicture.js';
import getCommandExecutor from './customCommandExecution.js';
import { t } from 'i18next';

// It just works, okay?
const interval = setInterval(() => {
  const videoElement = document.querySelector('video');
  if (videoElement) {
    execute_once_dom_loaded();
    patchResolveCommand();
    clearInterval(interval);
  }
}, 250);

let keyTimeout = null;

const keys = {
  49: 1,
  50: 2,
  51: 3,
  52: 4,
  53: 5,
  54: 6,
  55: 7,
  56: 8,
  57: 9,
  48: 0
};

// ---------------------------------------------------------------------------
// Menu key toggle (Android TV / Cobalt)
// 独立于下方大 eventHandler：模块加载即注册，行为与已验证的 debugOverlay 一致。
// ---------------------------------------------------------------------------
const KNOWN_NAV_KEYS = new Set([13, 37, 38, 39, 40, 27]);
let lastKeyCode = null;
let toggleKeyCode = null;
let controlsWasVisible = false;
let watchDefaultObserved = null;

function isControlsVisible() {
  const el = document.querySelector('ytlr-watch-default');
  return !!el && el.getAttribute('hybridnavfocusable') === 'false';
}

function isOnWatchPage() {
  try {
    const url = new URL(location.hash.substring(1), location.href);
    return /[?&]v=/.test(url.search);
  } catch (e) {
    return false;
  }
}

function attachControlsObserver() {
  const el = document.querySelector('ytlr-watch-default');
  if (el === watchDefaultObserved) return;
  watchDefaultObserved = el;
  if (!el) return;

  controlsWasVisible = isControlsVisible();

  new MutationObserver(() => {
    const nowVisible = isControlsVisible();
    if (
      !controlsWasVisible &&
      nowVisible &&
      isOnWatchPage() &&
      lastKeyCode !== null &&
      !KNOWN_NAV_KEYS.has(lastKeyCode)
    ) {
      toggleKeyCode = lastKeyCode;
      console.info('[TT] learned toggle key =', toggleKeyCode);
    }
    controlsWasVisible = nowVisible;
  }).observe(el, { attributes: true, attributeFilter: ['hybridnavfocusable'] });
}

setInterval(attachControlsObserver, 500);

function menuToggleKeyHandler(evt) {
  lastKeyCode = evt.keyCode;

  if (toggleKeyCode === null || evt.keyCode !== toggleKeyCode) return;
  if (!isOnWatchPage() || !isControlsVisible()) return;

  // keydown / keypress / keyup 全部拦截，避免默认行为把控制条重新打开
  evt.preventDefault();
  evt.stopPropagation();
  if (typeof evt.stopImmediatePropagation === 'function') {
    evt.stopImmediatePropagation();
  }

  if (evt.type === 'keydown') {
    console.info('[TT] menu toggle → synthetic Back (key=' + toggleKeyCode + ')');
    const kE = document.createEvent('Event');
    kE.initEvent('keydown', true, true);
    kE.keyCode = 27;
    kE.which = 27;
    document.dispatchEvent(kE);
  }
}

document.addEventListener('keydown', menuToggleKeyHandler, true);
document.addEventListener('keypress', menuToggleKeyHandler, true);
document.addEventListener('keyup', menuToggleKeyHandler, true);
// ---------------------------------------------------------------------------

function execute_once_dom_loaded() {

  // Add CSS to head.

  const existingStyle = document.querySelector('style[nonce]');
  if (existingStyle) {
    existingStyle.textContent += css;
  } else {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Fix UI issues.
  const ui = configRead('enableFixedUI');
  if (ui) {
    try {
      window.tectonicConfig.featureSwitches.isLimitedMemory = false;
      window.tectonicConfig.clientData.legacyApplicationQuality = 'full-animation';
      window.tectonicConfig.featureSwitches.enableAnimations = true;
      window.tectonicConfig.featureSwitches.enableOnScrollLinearAnimation = true;
      window.tectonicConfig.featureSwitches.enableListAnimations = true;
      window.tectonicConfig.featureSwitches.supportsLongPress = true;
    } catch (e) { }
  }

  // We handle key events ourselves.
  window.__spatialNavigation__.keyMode = 'NONE';

  var ARROW_KEY_CODE = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };

  var uiContainer = document.createElement('div');
  uiContainer.classList.add('ytaf-ui-container');
  uiContainer.style['display'] = 'none';
  uiContainer.setAttribute('tabindex', 0);
  uiContainer.addEventListener(
    'focus',
    () => console.info('uiContainer focused!'),
    true
  );
  uiContainer.addEventListener(
    'blur',
    () => console.info('uiContainer blured!'),
    true
  );

  uiContainer.addEventListener(
    'keydown',
    (evt) => {
      console.info('uiContainer key event:', evt.type, evt.keyCode, evt);
      if (evt.keyCode !== 404 && evt.keyCode !== 172) {
        if (evt.keyCode in ARROW_KEY_CODE) {
          navigate(ARROW_KEY_CODE[evt.keyCode]);
        } else if (evt.keyCode === 13 || evt.keyCode === 32) {
          // "OK" button
          console.log('OK button pressed');
          const focusedElement = document.querySelector(':focus');
          if (focusedElement.type === 'checkbox') {
            focusedElement.checked = !focusedElement.checked;
            focusedElement.dispatchEvent(new Event('change'));
          }
          evt.preventDefault();
          evt.stopPropagation();
          return;
        } else if (evt.keyCode === 27 && document.querySelector(':focus').type !== 'text') {
          // Back button
          uiContainer.style.display = 'none';
          uiContainer.blur();
        } else if (document.querySelector(':focus').type === 'text' && evt.keyCode === 27) {
          const focusedElement = document.querySelector(':focus');
          focusedElement.value = focusedElement.value.slice(0, -1);
        }


        if (evt.key === 'Enter' || evt.Uc?.key === 'Enter') {
          // If the focused element is a text input, emit a change event.
          if (document.querySelector(':focus').type === 'text') {
            document.querySelector(':focus').dispatchEvent(new Event('change'));
          }
        }
      }
    },
    true
  );

  try {
    uiContainer.innerHTML = `
<h1>TizenTube Theme Configuration</h1>
<label for="__barColor">Navigation Bar Color: <input type="text" id="__barColor"/></label>
<label for="__routeColor">Main Content Color: <input type="text" id="__routeColor"/></label>
<div><small>Sponsor segments skipping - https://sponsor.ajay.app</small></div>
`;
    document.querySelector('body').appendChild(uiContainer);

    uiContainer.querySelector('#__barColor').value = configRead('focusContainerColor');
    uiContainer.querySelector('#__barColor').addEventListener('change', (evt) => {
      configWrite('focusContainerColor', evt.target.value);
      updateStyle();
    });

    uiContainer.querySelector('#__routeColor').value = configRead('routeColor');
    uiContainer.querySelector('#__routeColor').addEventListener('change', (evt) => {
      configWrite('routeColor', evt.target.value);
      updateStyle();
    });
  } catch (e) { }

  var eventHandler = (evt) => {
    // We handle key events ourselves.
    console.info(
      'Key event:',
      evt.type,
      evt.keyCode,
      evt.keyCode,
      evt.defaultPrevented
    );

    if (evt.keyCode in keys) {
      const percentage = keys[evt.keyCode] * 10;
      const video = document.querySelector('video');
      video.currentTime = (percentage / 100) * video.duration;
    }

    const container = document.getElementById('container');

    if (window.screenTurnedOffAt && Date.now() - window.screenTurnedOffAt > 1000) {
      for (const child of document.body.children) {
        if (child.tagName.toLowerCase() === 'script' || child.tagName.toLowerCase() === 'svg') continue;

        child.style.setProperty('display', 'block', 'important');
      }
      window.screenTurnedOffAt = null;
    }

    if (configRead('enableScreenDimming')) {
      if (keyTimeout) {
        clearTimeout(keyTimeout);
      }
      container.style.setProperty('opacity', '1', 'important');
      keyTimeout = setTimeout(() => {
        const videoPlayer = document.querySelector('.html5-video-player');
        const playerStateObject = videoPlayer.getPlayerStateObject();
        if (playerStateObject.isPlaying) return;
        container.style.setProperty('opacity', (1 - configRead('dimmingOpacity')).toString(), 'important');
      }, configRead('dimmingTimeout') * 1000);
    }
    if (evt.keyCode == 403) {
      console.info('Taking over!');
      evt.preventDefault();
      evt.stopPropagation();
      if (evt.type === 'keydown') {
        try {
          if (uiContainer.style.display === 'none') {
            console.info('Showing and focusing!');
            uiContainer.style.display = 'block';
            uiContainer.focus();
          } else {
            console.info('Hiding!');
            uiContainer.style.display = 'none';
            uiContainer.blur();
          }
        } catch (e) { }
      }
      return false;
    } else if (evt.keyCode == 404) {
      if (evt.type === 'keydown') {
        modernUI();
      }
    } else if (evt.keyCode == 39) {
      // Right key, for PiP
      if (evt.type === 'keydown') {
        if (document.querySelector('ytlr-search-text-box > .zylon-focus') && window.isPipPlaying) {
          const ytlrPlayer = document.querySelector('ytlr-player');
          ytlrPlayer.style.setProperty('background-color', 'rgb(0, 0, 0)');
          pipToFullscreen();
        }
      }
    }
    // 菜单键开关控制条已移至模块顶层 menuToggleKeyHandler，此处不再处理
    return true;
  }

  // Red, Green, Yellow, Blue
  // 403, 404, 405, 406
  // ---, 172, 170, 191
  document.addEventListener('keydown', eventHandler, true);
  document.addEventListener('keypress', eventHandler, true);
  document.addEventListener('keyup', eventHandler, true);
  if (configRead('showWelcomeToast')) {
    setTimeout(() => {
      showToast(t('welcomeMsg.title'), t('welcomeMsg.subtitle'));
    }, 2000);
  }

  if (configRead('reloadHomeOnStartup')) {
    if (configRead('launchToOnStartup')) {
      resolveCommand(JSON.parse(configRead('launchToOnStartup')));
    } else {
      resolveCommand({
        signalAction: {
          signal: 'SOFT_RELOAD_PAGE'
        }
      });
    }
  }

  const commandExecutor = getCommandExecutor();
  if (commandExecutor) {
    commandExecutor.executeFunction(new commandExecutor.commandFunction('reloadGuideAction'));
  }

  // Fix UI issues, again. Love, Googol.

  if (configRead('enableFixedUI')) {
    try {
      const observer = new MutationObserver((_, _2) => {
        const body = document.body;
        if (body.classList.contains('app-quality-root')) {
          body.classList.remove('app-quality-root');
        }
      });
      observer.observe(document.body, { attributes: true, childList: false, subtree: false });
    } catch (e) { }
  }
}
