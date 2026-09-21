
/*
 * TizenTube Subtitle Language Persistence Mod
 *
 * Purpose:
 *   Remember the auto-translate subtitle language selected by the user
 *   and re-apply it when a new video starts.
 *
 * Behavior:
 *   - When a new video starts playing, wait 5s then apply the saved
 *     translation language once (skipped if the video has no captions
 *     or no translation languages available).
 *   - At 10s after the video starts, check the current track once; if
 *     it isn't already on the saved language, apply it once more as a
 *     backup. If it already matches, do nothing (avoids interrupting
 *     a track that's already working).
 *   - Each video gets at most these two apply attempts - no ongoing
 *     verification, retries, or polling beyond that.
 *   - If the player later resets subtitles to a non-translated track
 *     on its own (outside this mod), re-apply once immediately.
 *   - If the user manually picks a different translation language via
 *     the normal UI, remember it as the new preferred language.
 *   - Toggling the "remember translated subtitles" option off disables
 *     all of the above; the original resolveCommand is always called
 *     unmodified regardless of this setting.
 */

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

// Fixed-time apply schedule, per video, measured from when the video
// is first observed playing. No verification/retry beyond these two.
const FIRST_APPLY_DELAY_MS = 5000;
const SECOND_APPLY_DELAY_MS = 10000;

let isInternalApply = false;


/* ============================================================
 * Player helpers
 * ============================================================
 */

function getCurrentPlayer() {
    try {
        return document.querySelector(SELECTORS.PLAYER);
    } catch (e) {
        return null;
    }
}

function getPlayerVideoId(player) {
    if (!player) return null;

    try {
        return player.getVideoData?.()?.video_id || null;
    } catch (e) {
        return null;
    }
}


/* ============================================================
 * Subtitle command helpers
 * ============================================================
 */

function extractTranslationCommand(cmd) {
    if (!cmd) return null;

    if (cmd.selectSubtitlesTrackCommand?.translationLanguage) {
        return cmd.selectSubtitlesTrackCommand.translationLanguage;
    }

    if (Array.isArray(cmd.commandExecutorCommand?.commands)) {
        for (const subCmd of cmd.commandExecutorCommand.commands) {
            const result = extractTranslationCommand(subCmd);

            if (result) return result;
        }
    }

    return null;
}

function hasSelectSubtitlesTrackCommand(cmd) {
    if (!cmd) return false;

    if (cmd.selectSubtitlesTrackCommand) {
        return true;
    }

    if (Array.isArray(cmd.commandExecutorCommand?.commands)) {
        return cmd.commandExecutorCommand.commands.some(
            hasSelectSubtitlesTrackCommand
        );
    }

    return false;
}

function isNonTranslationSubtitleCommand(cmd) {
    if (!cmd) return false;

    if (
        cmd.selectSubtitlesTrackCommand &&
        !cmd.selectSubtitlesTrackCommand.translationLanguage
    ) {
        return true;
    }

    if (Array.isArray(cmd.commandExecutorCommand?.commands)) {
        return cmd.commandExecutorCommand.commands.some(
            isNonTranslationSubtitleCommand
        );
    }

    return false;
}


/* ============================================================
 * Captions API helpers
 * ============================================================
 */

function tryPlayerSetOption(languageCode, languageName) {
    const player = getCurrentPlayer();

    if (!player || typeof player.setOption !== 'function') {
        return false;
    }

    try {
        if (typeof player.loadModule === 'function') {
            try {
                player.loadModule('captions');
            } catch (e) {
                // ignore - setOption below still gets a chance to work
            }
        }

        const translationPayload = {
            languageCode,
            translationLanguage: {
                languageCode,
                languageName: languageName || languageCode,
            },
        };

        try {
            player.setOption('captions', 'track', translationPayload);
            return true;
        } catch (e) {
            // fall through to the simpler payload below
        }

        try {
            player.setOption('captions', 'track', { languageCode });
            return true;
        } catch (e2) {
            return false;
        }
    } catch (e) {
        return false;
    }
}

function getCurrentCaptionsTrackLanguage(player) {
    if (!player || typeof player.getOption !== 'function') {
        return null;
    }

    try {
        const track = player.getOption('captions', 'track');

        return (
            track?.translationLanguage?.languageCode ||
            track?.languageCode ||
            null
        );
    } catch (e) {
        return null;
    }
}

function getCaptionsAvailability(player) {
    if (!player || typeof player.getOption !== 'function') {
        // Unknown - don't block the apply attempt on an unreadable state.
        return { known: false };
    }

    try {
        const tracklist = player.getOption('captions', 'tracklist');
        const translationLanguages = player.getOption(
            'captions',
            'translationLanguages'
        );

        return {
            known: true,
            hasTracks: !Array.isArray(tracklist) || tracklist.length > 0,
            hasTranslations:
                !Array.isArray(translationLanguages) ||
                translationLanguages.length > 0,
        };
    } catch (e) {
        return { known: false };
    }
}


/* ============================================================
 * Automatic subtitle application
 * ============================================================
 */

function applyPreferredLanguage() {
    if (!configRead(CONFIG_KEYS.ENABLED)) return;

    const languageCode = configRead(CONFIG_KEYS.CODE);
    const languageName = configRead(CONFIG_KEYS.NAME);

    if (!languageCode) return;

    isInternalApply = true;

    try {
        tryPlayerSetOption(languageCode, languageName);

        const command = {
            selectSubtitlesTrackCommand: {
                translationLanguage: {
                    languageCode,
                    languageName: languageName || languageCode,
                },
            },
        };

        try {
            resolveCommand(command);
        } catch (e) {
            // ignore - nothing else to fall back to here
        }
    } catch (e) {
        // Never let a failure here leave isInternalApply stuck true.
    }

    Promise.resolve().then(() => {
        isInternalApply = false;
    });
}


/* ============================================================
 * Main handler
 * ============================================================
 */

class SubtitlePersistenceHandler {
    #player = null;
    #isPatched = false;

    // At most one 5s timer and one 10s timer per video. A video is
    // "scheduled" the moment its timers are set, so later events for
    // the same video never schedule a second pair.
    #scheduledVideoId = null;
    #firstTimer = null;
    #secondTimer = null;

    constructor() {
        this.init();
    }

    init() {
        this.#startDOMCheck();
        this.#setupConfigListener();
        this.#patchResolveCommand();
    }

    #getVideoId() {
        return getPlayerVideoId(this.#player);
    }

    #isPlayerPlaying() {
        if (!this.#player) return false;

        try {
            const stateObject = this.#player.getPlayerStateObject?.();

            if (stateObject && typeof stateObject.isPlaying === 'boolean') {
                return stateObject.isPlaying;
            }

            const numericState = this.#player.getPlayerState?.();

            // Numeric state 1 = playing on many YouTube players.
            return numericState === 1;
        } catch (e) {
            return false;
        }
    }

    #clearScheduledTimers() {
        if (this.#firstTimer) {
            clearTimeout(this.#firstTimer);
            this.#firstTimer = null;
        }

        if (this.#secondTimer) {
            clearTimeout(this.#secondTimer);
            this.#secondTimer = null;
        }
    }

    #scheduleForVideo(videoId) {
        if (!videoId) return;
        if (!configRead(CONFIG_KEYS.ENABLED)) return;
        if (!configRead(CONFIG_KEYS.CODE)) return;

        if (this.#scheduledVideoId === videoId) {
            // Already scheduled (or already ran) for this video.
            return;
        }

        this.#clearScheduledTimers();
        this.#scheduledVideoId = videoId;

        this.#firstTimer = setTimeout(() => {
            this.#firstTimer = null;
            this.#runFirstApply(videoId);
        }, FIRST_APPLY_DELAY_MS);

        this.#secondTimer = setTimeout(() => {
            this.#secondTimer = null;
            this.#runSecondApply(videoId);
        }, SECOND_APPLY_DELAY_MS);
    }

    #runFirstApply(videoId) {
        if (this.#getVideoId() !== videoId) return;
        if (!configRead(CONFIG_KEYS.ENABLED)) return;

        const availability = getCaptionsAvailability(getCurrentPlayer());

        if (
            availability.known &&
            (!availability.hasTracks || !availability.hasTranslations)
        ) {
            // No captions, or no translation support, for this video.
            return;
        }

        applyPreferredLanguage();
    }

    #runSecondApply(videoId) {
        if (this.#getVideoId() !== videoId) return;
        if (!configRead(CONFIG_KEYS.ENABLED)) return;

        const desiredCode = configRead(CONFIG_KEYS.CODE);
        const currentCode = getCurrentCaptionsTrackLanguage(
            getCurrentPlayer()
        );

        if (currentCode === desiredCode) {
            // Already on the right language from the first apply -
            // leave it alone rather than risk interrupting it.
            return;
        }

        applyPreferredLanguage();
    }

    #startDOMCheck() {
        setInterval(() => {
            const playerElement = getCurrentPlayer();

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
                    } catch (e) {
                        // ignore
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
                } catch (e) {
                    // ignore
                }

                // Catch up if the player already exists and is playing.
                this.#handleStateChange();
            }
        }, 1500);
    }

    #handleStateChange = () => {
        const videoId = this.#getVideoId();

        if (!videoId) return;
        if (!configRead(CONFIG_KEYS.ENABLED)) return;

        if (this.#isPlayerPlaying()) {
            this.#scheduleForVideo(videoId);
        }
    };

    #handlePlaybackStart = () => {
        const videoId = this.#getVideoId();

        if (!videoId) return;
        if (!configRead(CONFIG_KEYS.ENABLED)) return;

        this.#scheduleForVideo(videoId);
    };

    #onExternalReset() {
        if (!configRead(CONFIG_KEYS.ENABLED)) return;
        if (!configRead(CONFIG_KEYS.CODE)) return;
        if (isInternalApply) return;
        if (!this.#getVideoId()) return;

        applyPreferredLanguage();
    }

    #setupConfigListener() {
        configChangeEmitter.addEventListener('configChange', (ev) => {
            const detail = ev.detail || {};
            const key = detail.key;
            const isEnabled = configRead(CONFIG_KEYS.ENABLED);

            if (!isEnabled) {
                this.#clearScheduledTimers();
                this.#scheduledVideoId = null;
                return;
            }

            if (
                key === CONFIG_KEYS.ENABLED ||
                key === CONFIG_KEYS.CODE ||
                key === CONFIG_KEYS.NAME
            ) {
                this.#clearScheduledTimers();
                this.#scheduledVideoId = null;

                const videoId = this.#getVideoId();

                if (videoId) {
                    this.#scheduleForVideo(videoId);
                }
            }
        });
    }

    #patchResolveCommand() {
        const interval = setInterval(() => {
            if (this.#isPatched) {
                clearInterval(interval);
                return;
            }

            if (!window._yttv) {
                return;
            }

            const yttvInstance = Object.values(window._yttv).find(
                (obj) =>
                    obj &&
                    obj.instance &&
                    typeof obj.instance.resolveCommand === 'function'
            );

            if (!yttvInstance) {
                return;
            }

            const instance = yttvInstance.instance;

            if (
                instance.resolveCommand
                    .isPatchedByPersistSubtitleLanguage
            ) {
                this.#isPatched = true;
                clearInterval(interval);
                return;
            }

            const originalResolveCommand = instance.resolveCommand;
            const self = this;

            instance.resolveCommand = function(cmd, _) {
                const hasSubtitleCommand =
                    hasSelectSubtitlesTrackCommand(cmd);

                // The original command handler always runs unmodified,
                // regardless of this mod's enabled state.
                const result = originalResolveCommand.apply(
                    this,
                    arguments
                );

                if (
                    configRead(CONFIG_KEYS.ENABLED) &&
                    hasSubtitleCommand
                ) {
                    const translationLanguage =
                        extractTranslationCommand(cmd);

                    if (translationLanguage && !isInternalApply) {
                        const { languageCode, languageName } =
                            translationLanguage;

                        if (
                            languageCode &&
                            languageCode !==
                                configRead(CONFIG_KEYS.CODE)
                        ) {
                            // The user manually picked a different
                            // translation language - remember it.
                            configWrite(CONFIG_KEYS.CODE, languageCode);

                            configWrite(
                                CONFIG_KEYS.NAME,
                                languageName || languageCode
                            );
                        }
                    } else if (
                        !isInternalApply &&
                        isNonTranslationSubtitleCommand(cmd)
                    ) {
                        // The player reset subtitles to a
                        // non-translated track on its own.
                        self.#onExternalReset();
                    }
                }

                return result;
            };

            instance.resolveCommand
                .isPatchedByPersistSubtitleLanguage = true;

            this.#isPatched = true;
            clearInterval(interval);
        }, 500);
    }
}


/* ============================================================
 * Start
 * ============================================================
 */

try {
    window.subtitlePersistenceHandler = new SubtitlePersistenceHandler();
} catch (e) {
    console.error('[Subtitle Persistence] Startup failed:', e);
}
