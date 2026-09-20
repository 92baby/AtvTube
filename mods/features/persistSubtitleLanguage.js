
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

// Limited retries after playback becomes active.
// Avoid repeatedly overriding the user's subtitle state.
const RETRY_DELAYS_MS = [1000, 2500];

// Prevent duplicate applications within a short interval.
const MIN_APPLY_INTERVAL_MS = 800;

let isInternalApply = false;
let lastApplyTime = 0;


/**
 * Recursively extract translationLanguage from a command tree.
 * Supports nested commandExecutorCommand.commands.
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
 * Check whether a command contains a subtitle track selection.
 */
function hasSelectSubtitlesTrackCommand(cmd) {
    if (!cmd) return false;

    if (cmd.selectSubtitlesTrackCommand) return true;

    if (Array.isArray(cmd.commandExecutorCommand?.commands)) {
        return cmd.commandExecutorCommand.commands.some(
            hasSelectSubtitlesTrackCommand
        );
    }

    return false;
}


/**
 * Apply the remembered translation language.
 *
 * Important:
 * - Does not call player.setOption().
 * - Does not explicitly enable CC.
 * - Only sends the translation-language selection command.
 */
function applyPreferredLanguage(reason) {
    if (!configRead(CONFIG_KEYS.ENABLED)) return;

    const languageCode = configRead(CONFIG_KEYS.CODE);
    const languageName = configRead(CONFIG_KEYS.NAME);

    if (!languageCode) return;

    const now = Date.now();

    // Avoid duplicate applications in a short interval.
    if (now - lastApplyTime < MIN_APPLY_INTERVAL_MS) {
        return;
    }

    lastApplyTime = now;

    console.log(
        `%c[Subtitle Persistence] Applying: ${languageName || languageCode} (${languageCode}) - ${reason}`,
        'background: #9C27B0; color: #ffffff; font-size: 12px;'
    );

    isInternalApply = true;

    try {
        resolveCommand({
            selectSubtitlesTrackCommand: {
                translationLanguage: {
                    languageCode,
                    languageName: languageName || languageCode,
                },
            },
        });
    } catch (e) {
        console.warn(
            '[Subtitle Persistence] Apply failed:',
            e
        );
    }

    // Clear flag on the next microtask.
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
            const stateObj = this.#player.getPlayerStateObject?.();

            if (stateObj && typeof stateObj.isPlaying === 'boolean') {
                return stateObj.isPlaying;
            }

            // Fallback: numeric state 1 = playing.
            const state = this.#player.getPlayerState?.();

            return state === 1;
        } catch (e) {
            return false;
        }
    }


    #startDOMCheck() {
        setInterval(() => {
            const playerElement = document.querySelector(
                SELECTORS.PLAYER
            );

            if (playerElement && this.#player !== playerElement) {
                if (this.#player) {
                    try {
                        this.#player.removeEventListener(
                            'onStateChange',
                            this.#handleStateChange
                        );

                        this.#player.removeEventListener(
                            'onPlaybackStartExternal',
                            this.#handlePlaybackStart
                        );

                        this.#player.removeEventListener(
                            'onApiChange',
                            this.#handleApiChange
                        );
                    } catch (e) {
                        // Ignore listener cleanup errors.
                    }
                }

                this.#player = playerElement;

                try {
                    this.#player.addEventListener(
                        'onStateChange',
                        this.#handleStateChange
                    );

                    this.#player.addEventListener(
                        'onPlaybackStartExternal',
                        this.#handlePlaybackStart
                    );

                    this.#player.addEventListener(
                        'onApiChange',
                        this.#handleApiChange
                    );
                } catch (e) {
                    // Ignore listener registration errors.
                }

                // Catch up if the player already exists and is playing.
                this.#handleStateChange();
            }
        }, 1500);
    }


    #clearRetryTimers() {
        for (const id of this.#retryTimers) {
            clearTimeout(id);
        }

        this.#retryTimers = [];
    }


    #scheduleRetries(reason, videoId) {
        if (!videoId) return;
        if (!configRead(CONFIG_KEYS.ENABLED)) return;
        if (!configRead(CONFIG_KEYS.CODE)) return;

        // Already scheduled a retry sequence for this video.
        if (
            videoId === this.#lastScheduledVideoId &&
            this.#retryTimers.length > 0
        ) {
            return;
        }

        this.#clearRetryTimers();
        this.#lastScheduledVideoId = videoId;

        RETRY_DELAYS_MS.forEach((delay, index) => {
            const timerId = setTimeout(() => {
                if (!configRead(CONFIG_KEYS.ENABLED)) return;

                const currentVid = this.#getVideoId();

                // Do not apply to another video.
                if (currentVid !== videoId) return;

                applyPreferredLanguage(
                    `retry +${delay}ms (${reason})`
                );

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
            this.#scheduleRetries(
                'stateChange:isPlaying',
                videoId
            );
        }
    };


    #handlePlaybackStart = () => {
        if (!configRead(CONFIG_KEYS.ENABLED)) return;

        const videoId = this.#getVideoId();

        if (!videoId) return;

        this.#updateVideoContext(videoId);

        this.#scheduleRetries(
            'playbackStartExternal',
            videoId
        );
    };


    #handleApiChange = () => {
        if (!configRead(CONFIG_KEYS.ENABLED)) return;
        if (!configRead(CONFIG_KEYS.CODE)) return;

        const videoId = this.#getVideoId();

        if (!videoId) return;

        this.#updateVideoContext(videoId);

        // Apply once when the API changes.
        // No explicit CC enabling.
        applyPreferredLanguage('onApiChange');
    };


    #setupConfigListener() {
        configChangeEmitter.addEventListener(
            'configChange',
            (ev) => {
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
                            this.#scheduleRetries(
                                `configChanged:${key}`,
                                videoId
                            );
                        } else {
                            applyPreferredLanguage(
                                `configChanged:${key} (not playing)`
                            );
                        }
                    }
                }
            }
        );
    }


    #patchResolveCommand() {
        const interval = setInterval(() => {
            if (this.#isPatched || !window._yttv) return;

            const yttvInstance = Object.values(window._yttv).find(
                (obj) =>
                    obj &&
                    obj.instance &&
                    typeof obj.instance.resolveCommand === 'function'
            );

            if (!yttvInstance) return;

            if (
                yttvInstance.instance.resolveCommand
                    .isPatchedByPersistSubtitleLanguage
            ) {
                this.#isPatched = true;
                clearInterval(interval);
                return;
            }

            const originalResolveCommand =
                yttvInstance.instance.resolveCommand;

            const self = this;

            yttvInstance.instance.resolveCommand = function (cmd, _) {
                if (
                    configRead(CONFIG_KEYS.ENABLED) &&
                    hasSelectSubtitlesTrackCommand(cmd)
                ) {
                    const translationLanguage =
                        extractTranslationCommand(cmd);

                    // Only remember the user's explicitly selected
                    // translation language.
                    //
                    // Non-translation commands are not reapplied.
                    // This prevents the script from fighting with:
                    // - CC off
                    // - local subtitle selection
                    // - auto-generated subtitle selection

                    if (
                        translationLanguage &&
                        !isInternalApply
                    ) {
                        const {
                            languageCode,
                            languageName
                        } = translationLanguage;

                        if (
                            languageCode &&
                            languageCode !==
                                configRead(CONFIG_KEYS.CODE)
                        ) {
                            console.log(
                                `%c[Subtitle Persistence] User remembered language: ${languageName} (${languageCode})`,
                                'background: #9C27B0; color: #ffffff; font-size: 14px; font-weight: bold;'
                            );

                            configWrite(
                                CONFIG_KEYS.CODE,
                                languageCode
                            );

                            configWrite(
                                CONFIG_KEYS.NAME,
                                languageName || languageCode
                            );
                        }
                    }
                }

                return originalResolveCommand.apply(
                    this,
                    arguments
                );
            };

            yttvInstance.instance.resolveCommand
                .isPatchedByPersistSubtitleLanguage = true;

            self.#isPatched = true;

            clearInterval(interval);

            console.log(
                '[Subtitle Persistence] resolveCommand patch OK'
            );
        }, 500);
    }
}


window.subtitlePersistenceHandler =
    new SubtitlePersistenceHandler();