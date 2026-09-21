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

let isInternalApply = false;

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

// Ask the player what caption track is actually active right now,
// instead of inferring success from "the earlier call didn't throw"
// (that inference is exactly what caused the regression where
// persistence silently stopped working — setOption not throwing did
// not mean it actually switched the track). getOption is the
// documented counterpart to setOption; if this player doesn't expose
// it, or the shape doesn't match what we expect, we simply can't
// verify and the caller falls back to its previous (safe) behaviour
// of firing the next scheduled attempt anyway.
function getActiveTranslationLanguageCode() {
    const player = getCurrentPlayer();

    if (!player || typeof player.getOption !== 'function') {
        return null;
    }

    try {
        const track = player.getOption('captions', 'track');

        if (!track) {
            return null;
        }

        return (
            (track.translationLanguage &&
                track.translationLanguage.languageCode) ||
            track.languageCode ||
            null
        );
    } catch (e) {
        return null;
    }
}

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
            player.setOption(
                'captions',
                'track',
                translationPayload
            );

            return true;
        } catch (e) {
        }

        try {
            player.setOption(
                'captions',
                'track',
                {
                    languageCode,
                }
            );

            return true;
        } catch (e) {
            return false;
        }
    } catch (e) {
        return false;
    }
}

function applyPreferredLanguage() {
    if (!configRead(CONFIG_KEYS.ENABLED)) {
        return;
    }

    const languageCode = configRead(CONFIG_KEYS.CODE);
    const languageName = configRead(CONFIG_KEYS.NAME);

    if (!languageCode) {
        return;
    }

    isInternalApply = true;

    try {
        tryPlayerSetOption(
            languageCode,
            languageName
        );

        resolveCommand({
            selectSubtitlesTrackCommand: {
                translationLanguage: {
                    languageCode,
                    languageName: languageName || languageCode,
                },
            },
        });
    } catch (e) {
    }

    Promise.resolve().then(() => {
        isInternalApply = false;
    });
}

class SubtitlePersistenceHandler {
    #player = null;
    #lastVideoId = null;
    #scheduledVideoId = null;
    #timers = [];
    #isPatched = false;
    // The video id the user manually overrode captions for (turned
    // them off, or picked a non-translated track) while persistence
    // was on. Scoped to a single video id on purpose: once the video
    // changes, this is simply never equal to the new video id again,
    // so the default language resumes applying with no extra reset
    // logic needed.
    #overriddenVideoId = null;

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
        if (!this.#player) {
            return false;
        }

        try {
            const stateObject =
                this.#player.getPlayerStateObject?.();

            if (
                stateObject &&
                typeof stateObject.isPlaying === 'boolean'
            ) {
                return stateObject.isPlaying;
            }

            return this.#player.getPlayerState?.() === 1;
        } catch (e) {
            return false;
        }
    }

    #clearTimers() {
        for (const timerId of this.#timers) {
            clearTimeout(timerId);
        }

        this.#timers = [];
    }

    #scheduleApply(videoId) {
        if (!videoId) {
            return;
        }

        if (!configRead(CONFIG_KEYS.CODE)) {
            return;
        }

        // The user already chose something else for this specific
        // video (see the resolveCommand wrapper below) — respect that
        // for the rest of this video instead of fighting it.
        if (videoId === this.#overriddenVideoId) {
            return;
        }

        if (
            videoId === this.#scheduledVideoId &&
            this.#timers.length > 0
        ) {
            return;
        }

        this.#clearTimers();

        this.#scheduledVideoId = videoId;

        for (const delay of [3000, 6000]) {
            const timerId = setTimeout(() => {
                if (!configRead(CONFIG_KEYS.ENABLED)) {
                    return;
                }

                if (this.#getVideoId() !== videoId) {
                    return;
                }

                // Only skip when we can positively confirm the
                // target language is already active. If the player
                // doesn't expose getOption, or the returned track
                // doesn't match, this falls through and fires again —
                // same as before, just with a real check added on
                // top rather than replacing the safety net.
                const target = configRead(CONFIG_KEYS.CODE);
                const active = getActiveTranslationLanguageCode();

                if (target && active === target) {
                    return;
                }

                applyPreferredLanguage();
            }, delay);

            this.#timers.push(timerId);
        }
    }

    #updateVideoContext(videoId) {
        if (!videoId) {
            return;
        }

        if (videoId === this.#lastVideoId) {
            return;
        }

        this.#lastVideoId = videoId;
        this.#scheduledVideoId = null;

        this.#clearTimers();
    }

    #handleStateChange = () => {
        const videoId = this.#getVideoId();

        if (!configRead(CONFIG_KEYS.ENABLED)) {
            return;
        }

        if (!videoId) {
            return;
        }

        this.#updateVideoContext(videoId);

        if (this.#isPlayerPlaying()) {
            this.#scheduleApply(videoId);
        }
    };

    #handlePlaybackStart = () => {
        const videoId = this.#getVideoId();

        if (!configRead(CONFIG_KEYS.ENABLED)) {
            return;
        }

        if (!videoId) {
            return;
        }

        this.#updateVideoContext(videoId);
        this.#scheduleApply(videoId);
    };

    #setupPlayer(player) {
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
            }
        }

        this.#player = player;

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
        }

        this.#handleStateChange();
    }

    #startDOMCheck() {
        setInterval(() => {
            const playerElement = getCurrentPlayer();

            if (
                playerElement &&
                this.#player !== playerElement
            ) {
                this.#setupPlayer(playerElement);
            }
        }, 1500);
    }

    #setupConfigListener() {
        configChangeEmitter.addEventListener(
            'configChange',
            (ev) => {
                const key = ev.detail?.key;

                if (
                    key !== CONFIG_KEYS.ENABLED &&
                    key !== CONFIG_KEYS.CODE &&
                    key !== CONFIG_KEYS.NAME
                ) {
                    return;
                }

                this.#scheduledVideoId = null;
                this.#overriddenVideoId = null;
                this.#clearTimers();

                if (
                    configRead(CONFIG_KEYS.ENABLED) &&
                    configRead(CONFIG_KEYS.CODE)
                ) {
                    const videoId = this.#getVideoId();

                    if (videoId) {
                        this.#scheduleApply(videoId);
                    }
                }
            }
        );
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

            const originalResolveCommand =
                instance.resolveCommand;

            const self = this;

            instance.resolveCommand = function(cmd, _) {
                const hasSubtitleCommand =
                    hasSelectSubtitlesTrackCommand(cmd);

                const result = originalResolveCommand.apply(
                    this,
                    arguments
                );

                if (
                    configRead(CONFIG_KEYS.ENABLED) &&
                    hasSubtitleCommand &&
                    !isInternalApply
                ) {
                    const translationLanguage =
                        extractTranslationCommand(cmd);

                    if (translationLanguage) {
                        const {
                            languageCode,
                            languageName,
                        } = translationLanguage;

                        if (languageCode) {
                            configWrite(
                                CONFIG_KEYS.CODE,
                                languageCode
                            );

                            configWrite(
                                CONFIG_KEYS.NAME,
                                languageName || languageCode
                            );
                        }
                    } else if (
                        isNonTranslationSubtitleCommand(cmd)
                    ) {
                        // User manually turned captions off or picked
                        // a non-translated track: honour that for the
                        // rest of THIS video (cancel any still-pending
                        // auto-apply timers so they don't silently
                        // undo the choice a few seconds later), but
                        // don't touch the saved preferred language —
                        // the next video still defaults to it.
                        const videoId = self.#getVideoId();

                        if (videoId) {
                            self.#overriddenVideoId = videoId;
                            self.#scheduledVideoId = null;
                            self.#clearTimers();
                        }
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

try {
    window.subtitlePersistenceHandler =
        new SubtitlePersistenceHandler();
} catch (e) {
    console.error(
        '[Subtitle Persistence] Startup failed:',
        e
    );
}