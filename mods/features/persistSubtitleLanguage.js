// TizenTube Subtitle Language Persistence Mod (Production Ready)
import { configRead, configWrite, configChangeEmitter } from '../config.js';
import resolveCommand from '../resolveCommand.js';

const SELECTORS = {
    PLAYER: '.html5-video-player',
};

const CONFIG_KEYS = {
    ENABLED: 'enablePersistSubtitleLanguage',
    CODE: 'preferredSubtitleLanguageCode',
    NAME: 'preferredSubtitleLanguageName',
};

// 视频开始后的重试延迟（ms）
const RETRY_DELAYS_MS = [400, 1200, 2500, 4500, 7000];

let isInternalApply = false;

/**
 * 递归提取 command 中的 translationLanguage (兼容嵌套结构)
 */
function extractTranslationCommand(cmd) {
    if (!cmd) return null;
    if (cmd.selectSubtitlesTrackCommand?.translationLanguage) {
        return cmd.selectSubtitlesTrackCommand.translationLanguage;
    }
    if (Array.isArray(cmd.commandExecutorCommand?.commands)) {
        for (const subCmd of cmd.commandExecutorCommand.commands) {
            const res = extractTranslationCommand(subCmd);
            if (res) return res;
        }
    }
    return null;
}

function applyPreferredLanguage(reason) {
    if (!configRead(CONFIG_KEYS.ENABLED)) return;

    const languageCode = configRead(CONFIG_KEYS.CODE);
    const languageName = configRead(CONFIG_KEYS.NAME);
    if (!languageCode) return;

    console.log(
        `%c[Subtitle Persistence] Applying language: ${languageName} (${languageCode}) - ${reason}`,
        'background: #9C27B0; color: #ffffff; font-size: 12px;'
    );

    isInternalApply = true;

    try {
        resolveCommand({
            selectSubtitlesTrackCommand: {
                translationLanguage: {
                    languageCode,
                    languageName
                }
            }
        });
    } catch (e) {
        console.warn('[Subtitle Persistence] resolveCommand failed:', e);
    }

    Promise.resolve().then(() => {
        isInternalApply = false;
    });
}

class SubtitlePersistenceHandler {
    #player = null;
    #lastVideoId = null;
    #lastScheduledVideoId = null;
    #retryTimers = [];
    #isPatched = false;

    constructor() {
        this.init();
    }

    init() {
        this.#startDOMCheck();
        this.#setupConfigListener();
        this.#patchResolveCommand();
    }

    #getVideoId() {
        if (!this.#player) return null;
        try {
            return this.#player.getVideoData?.()?.video_id || null;
        } catch (e) {
            return null;
        }
    }

    #isPlayerPlaying() {
        if (!this.#player) return false;
        try {
            return !!this.#player.getPlayerStateObject?.()?.isPlaying;
        } catch (e) {
            return false;
        }
    }

    #startDOMCheck() {
        setInterval(() => {
            const playerElement = document.querySelector(SELECTORS.PLAYER);
            if (playerElement && this.#player !== playerElement) {
                if (this.#player) {
                    try {
                        this.#player.removeEventListener('onStateChange', this.#handleStateChange);
                        this.#player.removeEventListener('onPlaybackStartExternal', this.#handlePlaybackStart);
                    } catch (e) { /* ignore */ }
                }
                this.#player = playerElement;
                this.#player.addEventListener('onStateChange', this.#handleStateChange);
                this.#player.addEventListener('onPlaybackStartExternal', this.#handlePlaybackStart);
                
                // 首次 Attach 补漏检查
                this.#handleStateChange();
            }
        }, 1500);
    }

    #clearRetryTimers() {
        for (const id of this.#retryTimers) clearTimeout(id);
        this.#retryTimers = [];
    }

    #scheduleRetries(reason, videoId) {
        if (!videoId) return;

        // 若当前视频已调度过重试序列，直接跳过
        if (videoId === this.#lastScheduledVideoId && this.#retryTimers.length > 0) {
            return;
        }

        this.#clearRetryTimers();
        this.#lastScheduledVideoId = videoId;

        RETRY_DELAYS_MS.forEach((delay, index) => {
            const timerId = setTimeout(() => {
                if (!configRead(CONFIG_KEYS.ENABLED)) return;

                const currentVid = this.#getVideoId();
                if (currentVid !== videoId) return;

                applyPreferredLanguage(`retry +${delay}ms (${reason})`);

                // 最后一轮重试跑完后，清空定时器引用数组
                if (index === RETRY_DELAYS_MS.length - 1) {
                    this.#retryTimers = [];
                }
            }, delay);

            this.#retryTimers.push(timerId);
        });
    }

    #updateVideoContext(videoId) {
        if (videoId && videoId !== this.#lastVideoId) {
            this.#lastVideoId = videoId;
            this.#lastScheduledVideoId = null;
            this.#clearRetryTimers();
        }
    }

    #handleStateChange = () => {
        if (!configRead(CONFIG_KEYS.ENABLED)) return;

        const videoId = this.#getVideoId();
        if (!videoId) return;

        this.#updateVideoContext(videoId);

        if (this.#isPlayerPlaying()) {
            this.#scheduleRetries('stateChange:isPlaying', videoId);
        }
    };

    #handlePlaybackStart = () => {
        if (!configRead(CONFIG_KEYS.ENABLED)) return;

        const videoId = this.#getVideoId();
        if (!videoId) return;

        this.#updateVideoContext(videoId);
        this.#scheduleRetries('playbackStartExternal', videoId);
    };

    #setupConfigListener() {
        configChangeEmitter.addEventListener('configChange', (ev) => {
            const { key } = ev.detail || {};
            const isEnabled = configRead(CONFIG_KEYS.ENABLED);

            if (!isEnabled) {
                this.#clearRetryTimers();
                this.#lastScheduledVideoId = null;
                return;
            }

            if (
                key === CONFIG_KEYS.ENABLED ||
                key === CONFIG_KEYS.CODE ||
                key === CONFIG_KEYS.NAME
            ) {
                this.#lastScheduledVideoId = null;
                this.#clearRetryTimers();

                const videoId = this.#getVideoId();
                if (videoId) {
                    if (this.#isPlayerPlaying()) {
                        this.#scheduleRetries(`configChanged:${key}`, videoId);
                    } else {
                        applyPreferredLanguage(`configChanged:${key} (not playing)`);
                    }
                }
            }
        });
    }

    #patchResolveCommand() {
        const interval = setInterval(() => {
            if (this.#isPatched || !window._yttv) return;

            const yttvInstance = Object.values(window._yttv).find(
                (obj) => obj && obj.instance && typeof obj.instance.resolveCommand === 'function'
            );

            if (!yttvInstance) return;

            if (yttvInstance.instance.resolveCommand.isPatchedByPersistSubtitleLanguage) {
                this.#isPatched = true;
                clearInterval(interval);
                return;
            }

            const originalResolveCommand = yttvInstance.instance.resolveCommand;

            yttvInstance.instance.resolveCommand = function (cmd, _) {
                const translationLanguage = extractTranslationCommand(cmd);

                if (translationLanguage && configRead(CONFIG_KEYS.ENABLED) && !isInternalApply) {
                    const { languageCode, languageName } = translationLanguage;

                    if (languageCode && languageCode !== configRead(CONFIG_KEYS.CODE)) {
                        console.log(
                            `%c[Subtitle Persistence] User remembered language: ${languageName} (${languageCode})`,
                            'background: #9C27B0; color: #ffffff; font-size: 14px; font-weight: bold;'
                        );
                        configWrite(CONFIG_KEYS.CODE, languageCode);
                        configWrite(CONFIG_KEYS.NAME, languageName || languageCode);
                    }
                }

                return originalResolveCommand.apply(this, arguments);
            };

            yttvInstance.instance.resolveCommand.isPatchedByPersistSubtitleLanguage = true;
            this.#isPatched = true;
            clearInterval(interval);
        }, 500);
    }
}

window.subtitlePersistenceHandler = new SubtitlePersistenceHandler();