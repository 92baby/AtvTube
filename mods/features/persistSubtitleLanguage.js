// TizenTube Subtitle Language Persistence Mod
// Remembers the auto-translate subtitle language the user picks and
// re-applies it on every new video, across app restarts.
//
// Strategy:
// 1. Capture translationLanguage from menu / nested commandExecutor commands.
// 2. On new video / playback start, apply early (setOption when possible +
//    selectSubtitlesTrackCommand) with a short staged retry schedule.
// 3. If the player later selects a non-translation track, re-apply a limited
//    number of times for that video to reduce endless contention.
// 4. Ignore our own apply commands so they are not saved as "user choice".
//
// Settings -> Subtitle Settings -> Remember Translated Subtitle Language.

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

// Staged retries after playback becomes active (ms).
const RETRY_DELAYS_MS = [300, 900, 1800, 3500];

// Max times we fight a player reset to a non-translation track, per video.
const MAX_RESET_REAPPLY = 3;

let isInternalApply = false;

/**
 * Recursively extract translationLanguage from a command tree
 * (supports nested commandExecutorCommand.commands).
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

function hasSelectSubtitlesTrackCommand(cmd) {
    if (!cmd) return false;
    if (cmd.selectSubtitlesTrackCommand) return true;
    if (Array.isArray(cmd.commandExecutorCommand?.commands)) {
        return cmd.commandExecutorCommand.commands.some(hasSelectSubtitlesTrackCommand);
    }
    return false;
}

function isNonTranslationSubtitleCommand(cmd) {
    if (!cmd) return false;
    if (cmd.selectSubtitlesTrackCommand && !cmd.selectSubtitlesTrackCommand.translationLanguage) {
        return true;
    }
    if (Array.isArray(cmd.commandExecutorCommand?.commands)) {
        return cmd.commandExecutorCommand.commands.some(isNonTranslationSubtitleCommand);
    }
    return false;
}

function ensureCaptionsModule(player) {
    if (!player) return;
    try {
        if (typeof player.loadModule === 'function') {
            player.loadModule('captions');
        }
    } catch (e) { /* already loaded */ }
}

/**
 * Set track + force caption data reload so the UI selection actually renders.
 * Menu can show the right language while on-screen captions stay blank without reload.
 */
function tryPlayerSetOption(languageCode, languageName) {
    const player = document.querySelector(SELECTORS.PLAYER);
    if (!player || typeof player.setOption !== 'function') return false;

    try {
        ensureCaptionsModule(player);

        const trackPayload = {
            languageCode,
            translationLanguage: {
                languageCode,
                languageName: languageName || languageCode,
            },
        };

        let ok = false;
        try {
            player.setOption('captions', 'track', trackPayload);
            ok = true;
        } catch (e) {
            try {
                player.setOption('captions', 'track', { languageCode });
                ok = true;
            } catch (e2) { /* ignore */ }
        }

        // Critical for 2nd+ videos: preference is set but track text never loads
        // until captions module reloads data for the current video.
        try {
            player.setOption('captions', 'reload', true);
            ok = true;
        } catch (e) { /* ignore */ }

        return ok;
    } catch (e) {
        return false;
    }
}

function scheduleCaptionReload(languageCode, languageName) {
    const delays = [200, 800, 2000];
    delays.forEach((ms) => {
        setTimeout(() => {
            const player = document.querySelector(SELECTORS.PLAYER);
            if (!player || typeof player.setOption !== 'function') return;
            try {
                ensureCaptionsModule(player);
                try {
                    player.setOption('captions', 'track', {
                        languageCode,
                        translationLanguage: {
                            languageCode,
                            languageName: languageName || languageCode,
                        },
                    });
                } catch (e) { /* ignore */ }
                try {
                    player.setOption('captions', 'reload', true);
                } catch (e) { /* ignore */ }
            } catch (e) { /* ignore */ }
        }, ms);
    });
}

function applyPreferredLanguage(reason) {
    if (!configRead(CONFIG_KEYS.ENABLED)) return;

    const languageCode = configRead(CONFIG_KEYS.CODE);
    const languageName = configRead(CONFIG_KEYS.NAME);
    if (!languageCode) return;

    console.log(
        `%c[Subtitle Persistence] Applying: ${languageName || languageCode} (${languageCode}) - ${reason}`,
        'background: #9C27B0; color: #ffffff; font-size: 12px;'
    );

    isInternalApply = true;
    try {
        // 1) Tell player the preferred track
        tryPlayerSetOption(languageCode, languageName);

        // 2) Same command shape as a manual auto-translate menu click
        resolveCommand({
            selectSubtitlesTrackCommand: {
                translationLanguage: {
                    languageCode,
                    languageName: languageName || languageCode,
                },
            },
        });

        // 3) Delayed track + reload: new videos often mark the menu selection
        //    before caption data for THIS video is fetchable; reload forces paint.
        scheduleCaptionReload(languageCode, languageName);
    } catch (e) {
        console.warn('[Subtitle Persistence] apply failed:', e);
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
    #resetReapplyCount = 0;
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
            const stateObj = this.#player.getPlayerStateObject?.();
            if (stateObj && typeof stateObj.isPlaying === 'boolean') {
                return stateObj.isPlaying;
            }
            // Fallback: numeric state 1 = playing on many YT players
            const state = this.#player.getPlayerState?.();
            return state === 1;
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
                        this.#player.removeEventListener('onApiChange', this.#handleApiChange);
                    } catch (e) { /* ignore */ }
                }
                this.#player = playerElement;
                try {
                    this.#player.addEventListener('onStateChange', this.#handleStateChange);
                    this.#player.addEventListener('onPlaybackStartExternal', this.#handlePlaybackStart);
                    this.#player.addEventListener('onApiChange', this.#handleApiChange);
                } catch (e) { /* ignore */ }

                // Catch-up if player already exists and is playing.
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
        if (!configRead(CONFIG_KEYS.CODE)) return;

        // Already scheduled a full retry sequence for this video.
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
            this.#resetReapplyCount = 0;
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

    #handleApiChange = () => {
        if (!configRead(CONFIG_KEYS.ENABLED)) return;
        if (!configRead(CONFIG_KEYS.CODE)) return;
        const videoId = this.#getVideoId();
        if (!videoId) return;
        this.#updateVideoContext(videoId);
        // Captions module often becomes ready here — one early apply.
        applyPreferredLanguage('onApiChange');
    };

    #onPlayerResetToNonTranslation() {
        if (!configRead(CONFIG_KEYS.ENABLED)) return;
        if (!configRead(CONFIG_KEYS.CODE)) return;
        if (isInternalApply) return;

        const videoId = this.#getVideoId();
        if (!videoId) return;

        if (this.#resetReapplyCount >= MAX_RESET_REAPPLY) return;

        this.#resetReapplyCount += 1;
        console.log(
            `%c[Subtitle Persistence] Player reset to non-translation; re-apply (${this.#resetReapplyCount}/${MAX_RESET_REAPPLY})`,
            'background: #9C27B0; color: #ffffff; font-size: 12px;'
        );
        setTimeout(() => {
            applyPreferredLanguage(`player reset #${this.#resetReapplyCount}`);
        }, 350);
    }

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
                this.#resetReapplyCount = 0;
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
            const self = this;

            yttvInstance.instance.resolveCommand = function (cmd, _) {
                if (configRead(CONFIG_KEYS.ENABLED) && hasSelectSubtitlesTrackCommand(cmd)) {
                    const translationLanguage = extractTranslationCommand(cmd);

                    if (translationLanguage && !isInternalApply) {
                        const { languageCode, languageName } = translationLanguage;
                        if (languageCode && languageCode !== configRead(CONFIG_KEYS.CODE)) {
                            console.log(
                                `%c[Subtitle Persistence] User remembered language: ${languageName} (${languageCode})`,
                                'background: #9C27B0; color: #ffffff; font-size: 14px; font-weight: bold;'
                            );
                            configWrite(CONFIG_KEYS.CODE, languageCode);
                            configWrite(CONFIG_KEYS.NAME, languageName || languageCode);
                        }
                    } else if (!isInternalApply && isNonTranslationSubtitleCommand(cmd)) {
                        // Player (or user path) selected local / autogen / off without translation.
                        self.#onPlayerResetToNonTranslation();
                    }
                }

                return originalResolveCommand.apply(this, arguments);
            };

            yttvInstance.instance.resolveCommand.isPatchedByPersistSubtitleLanguage = true;
            this.#isPatched = true;
            clearInterval(interval);
            console.log('[Subtitle Persistence] resolveCommand patch OK');
        }, 500);
    }
}

window.subtitlePersistenceHandler = new SubtitlePersistenceHandler();
