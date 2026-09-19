// TizenTube Subtitle Language Persistence Mod (Production Ready)
// Applies the same command shape as a manual pick in the auto-translate menu
// (see moreSubtitles.js createLanguageOption), so Cobalt/YouTube TV selects
// auto-translate rather than leaving auto-generated English.

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

// Retries after playback starts — YouTube TV often overrides captions late.
const RETRY_DELAYS_MS = [400, 1200, 2500, 4500, 7000, 10000];

let isInternalApply = false;

/**
 * Recursively find translationLanguage in nested resolveCommand payloads.
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

/**
 * Build the same command a menu click uses (moreSubtitles.createLanguageOption),
 * without POPUP_BACK (no open popup when applying in background).
 */
function buildTranslateCommand(languageCode, languageName) {
    return {
        commandExecutorCommand: {
            commands: [
                {
                    selectSubtitlesTrackCommand: {
                        translationLanguage: {
                            languageCode,
                            languageName,
                        },
                    },
                },
                {
                    openClientOverlayAction: {
                        type: 'CLIENT_OVERLAY_TYPE_CAPTIONS_LANGUAGE',
                        updateAction: true,
                    },
                },
            ],
        },
    };
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
        // Primary: menu-identical shape (required for auto-translate on Cobalt).
        resolveCommand(buildTranslateCommand(languageCode, languageName));

        // Fallback: bare command some builds still honor.
        resolveCommand({
            selectSubtitlesTrackCommand: {
                translationLanguage: {
                    languageCode,
                    languageName,
                },
            },
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
                        this.#player.removeEventListener(
                            'onPlaybackStartExternal',
                            this.#handlePlaybackStart
                        );
                    } catch (e) {
                        /* ignore */
                    }
                }
                this.#player = playerElement;
                this.#player.addEventListener('onStateChange', this.#handleStateChange);
                this.#player.addEventListener(
                    'onPlaybackStartExternal',
                    this.#handlePlaybackStart
                );
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
        if (videoId === this.#lastScheduledVideoId && this.#retryTimers.length > 0) {
            return;
        }

        this.#clearRetryTimers();
        this.#lastScheduledVideoId = videoId;

        RETRY_DELAYS_MS.forEach((delay, index) => {
            const timerId = setTimeout(() => {
                if (!configRead(CONFIG_KEYS.ENABLED)) return;
                if (this.#getVideoId() !== videoId) return;

                applyPreferredLanguage(`retry +${delay}ms (${reason})`);

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
                (obj) =>
                    obj && obj.instance && typeof obj.instance.resolveCommand === 'function'
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

                if (
                    translationLanguage &&
                    configRead(CONFIG_KEYS.ENABLED) &&
                    !isInternalApply
                ) {
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
