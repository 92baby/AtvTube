import { configRead, configWrite, configChangeEmitter } from '../config.js';
import resolveCommand from '../resolveCommand.js';
import { getUserCountryCode, getCountryLanguage } from './moreSubtitles.js';
import languageNames from '../translations/language-names.js';

const SELECTORS = {
    PLAYER: '.html5-video-player',
};

const CONFIG_KEYS = {
    ENABLED: 'enablePersistSubtitleLanguage',
    CODE: 'preferredSubtitleLanguageCode',
    NAME: 'preferredSubtitleLanguageName',
};

// One-time flag: once the app has run the auto-default logic below a
// single time (successfully or not), it never runs it again, so a user
// who later turns persistence off — or picks a different language — is
// never overridden by this again.
const DEFAULT_INIT_KEY = 'subtitleLanguageDefaultInitialized';
const DEFAULT_INIT_MAX_ATTEMPTS = 40; // ~20s at 500ms intervals
const DEFAULT_INIT_POLL_INTERVAL_MS = 500;

// When a video first loads, YouTube TV's own player can silently replay
// the previous video's "captions off" state as a selectSubtitlesTrackCommand
// with no translationLanguage — indistinguishable, by shape alone, from the
// user actually clicking to turn captions off. We only treat such a command
// as a genuine manual override once the new video has been underway longer
// than this grace period, since native restores fire almost immediately on
// load while a real user click happens later. This is a heuristic, not a
// guarantee.
const MANUAL_OVERRIDE_GRACE_PERIOD_MS = 3000;

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

function guessLanguageFromNavigator() {
    try {
        const raw = navigator.language || 'en';
        const code = raw.split('-')[0].toLowerCase();
        const name =
            languageNames.language.standard.long[code] || code;

        return { code, name };
    } catch (e) {
        return null;
    }
}

function resolveDeviceDefaultLanguage() {
    try {
        const countryCode = getUserCountryCode();

        if (countryCode) {
            const lang = getCountryLanguage(countryCode);

            if (lang) {
                return lang;
            }
        }
    } catch (e) {
    }

    return guessLanguageFromNavigator();
}

// Runs at most once ever (gated by DEFAULT_INIT_KEY). On a fresh setup,
// turns persistence on and seeds it with the device/region's language, the
// same way it's inferred for the "add my local language" subtitle-menu
// option elsewhere in this codebase. Deliberately never runs again after
// that, so a later manual change to either the toggle or the language is
// permanent and won't be reset back to this default.
function initializeDefaultSubtitleLanguage(attempt = 0) {
    if (configRead(DEFAULT_INIT_KEY)) {
        return;
    }

    const lang = resolveDeviceDefaultLanguage();

    // getUserCountryCode() depends on window.yt.config_.GL, which — like
    // .HL used for UI language elsewhere — may not be populated yet this
    // early in startup. Retry briefly before falling back permanently to
    // whatever guessLanguageFromNavigator() can give us.
    if (!lang && attempt < DEFAULT_INIT_MAX_ATTEMPTS) {
        setTimeout(
            () => initializeDefaultSubtitleLanguage(attempt + 1),
            DEFAULT_INIT_POLL_INTERVAL_MS
        );

        return;
    }

    if (lang) {
        configWrite(CONFIG_KEYS.ENABLED, true);
        configWrite(CONFIG_KEYS.CODE, lang.code);
        configWrite(CONFIG_KEYS.NAME, lang.name);
    }

    // Mark this done even on total failure to resolve a language, so we
    // never keep retrying indefinitely on every app launch.
    configWrite(DEFAULT_INIT_KEY, true);
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
    // Timestamp (Date.now()) of when the current #lastVideoId started
    // being tracked. Used to tell a native "restore previous off state"
    // command (fires right at load) apart from a real user click (fires
    // later, after the grace period below has elapsed).
    #videoStartTime = 0;

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

        const timerId = setTimeout(() => {
            if (!configRead(CONFIG_KEYS.ENABLED)) {
                return;
            }

            if (this.#getVideoId() !== videoId) {
                return;
            }

            applyPreferredLanguage();
        }, 3000);

        this.#timers.push(timerId);
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
        this.#videoStartTime = Date.now();

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
                        const videoId = self.#getVideoId();

                        const elapsedSinceVideoStart =
                            Date.now() - self.#videoStartTime;

                        const looksLikeNativeRestore =
                            videoId === self.#lastVideoId &&
                            elapsedSinceVideoStart <
                                MANUAL_OVERRIDE_GRACE_PERIOD_MS;

                        if (looksLikeNativeRestore) {
                            // Almost certainly YouTube TV replaying the
                            // previous video's "captions off" state on
                            // this new video, not a real click — ignore
                            // it so the scheduled auto-apply below still
                            // runs and turns translated captions back on.
                        } else if (videoId) {
                            // Past the grace period, so this is treated
                            // as the user genuinely turning captions off
                            // or picking a non-translated track: honour
                            // that for the rest of THIS video (cancel any
                            // still-pending auto-apply timers so they
                            // don't silently undo the choice a few
                            // seconds later), but don't touch the saved
                            // preferred language — the next video still
                            // defaults to it.
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
    initializeDefaultSubtitleLanguage();
} catch (e) {
    console.error(
        '[Subtitle Persistence] Default language init failed:',
        e
    );
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
