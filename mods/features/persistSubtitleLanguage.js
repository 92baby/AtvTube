// TizenTube Subtitle Language Persistence Mod
// Remembers the auto-translate subtitle language the user picks and
// automatically re-applies it on every new video, across app restarts.
//
// This only touches the language the user picked from the
// "auto-translate" captions menu (selectSubtitlesTrackCommand /
// translationLanguage). It does not change caption styling, and it
// does nothing unless the user turns on
// Settings -> Subtitle Settings -> Remember Translated Subtitle Language.

import { configRead, configWrite, configChangeEmitter } from '../config.js';
import resolveCommand from '../resolveCommand.js';

const SELECTORS = {
    PLAYER: '.html5-video-player',
};

const EVENTS = {
    YT_STATE_CHANGE: 'onStateChange',
    PLAYBACK_START_EXTERNAL: 'onPlaybackStartExternal',
    CONFIG_CHANGE: 'configChange',
};

const CONFIG_KEYS = {
    ENABLED: 'enablePersistSubtitleLanguage',
    CODE: 'preferredSubtitleLanguageCode',
    NAME: 'preferredSubtitleLanguageName',
};

// Re-issue the same command shape a manual menu click would produce.
// It flows back through resolveCommand.js's own instance lookup, so it
// behaves like the user picked the language themselves.
//
// Must mirror the exact command shape the real "auto-translate" menu
// item sends (see moreSubtitles.js's createLanguageOption). A bare
// selectSubtitlesTrackCommand only swaps the track for the current
// player session - it does NOT get recognized by YouTube TV as an
// explicit user choice, so the next video (or the player's own
// deferred init on cold start) resets back to the default track.
// openClientOverlayAction with updateAction:true is what actually
// persists the choice into the client's internal state.
function applyPreferredLanguage(reason) {
    const languageCode = configRead(CONFIG_KEYS.CODE);
    const languageName = configRead(CONFIG_KEYS.NAME);

    if (!languageCode) return;

    console.log(
        `%c[TizenTube Subtitle Persistence] Applying saved language ${languageName} (${languageCode}) - ${reason}`,
        'background: #9C27B0; color: #ffffff; font-size: 12px;'
    );

    resolveCommand({
        commandExecutorCommand: {
            commands: [
                {
                    selectSubtitlesTrackCommand: {
                        translationLanguage: {
                            languageCode,
                            languageName
                        }
                    }
                },
                {
                    openClientOverlayAction: {
                        type: 'CLIENT_OVERLAY_TYPE_CAPTIONS_LANGUAGE',
                        updateAction: true
                    }
                }
            ]
        }
    });
}

// Event-driven trigger, same pattern as features/preferredVideoQuality.js
// (onStateChange + isPlaying) instead of a blind 1s poll + fixed delay.
// autoFrameRate.js's onPlaybackStartExternal is also listened to as a
// second, earlier-firing signal - whichever fires first applies once
// per video.
class SubtitlePersistenceHandler {
    #player = null;
    #attachTimeout = null;
    #lastVideoId = null;
    #hasAppliedForVideo = false;
    #isPatchedForCapture = false;

    constructor() {
        this.init();
    }

    init() {
        this.#pollForPlayer();
        this.#setupConfigListener();
        this.#pollForResolveCommandCapture();
    }

    #pollForPlayer() {
        clearTimeout(this.#attachTimeout);

        const playerElement = document.querySelector(SELECTORS.PLAYER);

        if (!playerElement) {
            this.#attachTimeout = setTimeout(() => this.#pollForPlayer(), 100);
            return;
        }

        if (this.#player !== playerElement) {
            this.#player = playerElement;
            this.#player.addEventListener(EVENTS.YT_STATE_CHANGE, this.#handleStateChange);
            this.#player.addEventListener(EVENTS.PLAYBACK_START_EXTERNAL, this.#handleStateChange);
            this.#handleStateChange();
        }
    }

    #setupConfigListener() {
        configChangeEmitter.addEventListener(EVENTS.CONFIG_CHANGE, (ev) => {
            if (ev.detail?.key === CONFIG_KEYS.ENABLED && ev.detail?.value) {
                // Re-apply to whatever is currently playing right now.
                this.#hasAppliedForVideo = false;
                applyPreferredLanguage('setting turned on');
            }
        });
    }

    #handleStateChange = () => {
        if (!configRead(CONFIG_KEYS.ENABLED)) return;
        if (!this.#player) return;

        const videoData = this.#player?.getVideoData?.();
        const videoId = videoData?.video_id;
        if (!videoId) return;

        if (videoId !== this.#lastVideoId) {
            this.#lastVideoId = videoId;
            this.#hasAppliedForVideo = false;
        }

        const isShorts = Object.values(this.#player.getVideoStats?.() || {}).find((a) => a === 'shortspage');
        if (isShorts) return;

        const state = this.#player?.getPlayerStateObject?.();
        if (state?.isPlaying && !this.#hasAppliedForVideo) {
            this.#hasAppliedForVideo = true;
            applyPreferredLanguage('playback started');
        }
    };

    // Patch resolveCommand (independently from other mods, same pattern as
    // moreSubtitles.js) purely to observe when the user manually picks a
    // translated-subtitle language, so we can remember it.
    #pollForResolveCommandCapture() {
        const interval = setInterval(() => {
            if (this.#isPatchedForCapture) {
                clearInterval(interval);
                return;
            }

            if (!window._yttv) return;

            const yttvInstance = Object.values(window._yttv).find(
                (obj) => obj && obj.instance && typeof obj.instance.resolveCommand === 'function'
            );

            if (!yttvInstance) return;

            if (yttvInstance.instance.resolveCommand.isPatchedByPersistSubtitleLanguage) {
                this.#isPatchedForCapture = true;
                clearInterval(interval);
                return;
            }

            const originalResolveCommand = yttvInstance.instance.resolveCommand;
            const self = this;

            yttvInstance.instance.resolveCommand = function (cmd, _) {
                const translationLanguage = cmd?.selectSubtitlesTrackCommand?.translationLanguage;

                if (translationLanguage && configRead(CONFIG_KEYS.ENABLED)) {
                    const { languageCode, languageName } = translationLanguage;

                    if (languageCode && languageCode !== configRead(CONFIG_KEYS.CODE)) {
                        console.log(
                            `%c[TizenTube Subtitle Persistence] Remembering language: ${languageName} (${languageCode})`,
                            'background: #9C27B0; color: #ffffff; font-size: 14px; font-weight: bold;'
                        );

                        configWrite(CONFIG_KEYS.CODE, languageCode);
                        configWrite(CONFIG_KEYS.NAME, languageName || languageCode);
                    }

                    // The video the user just manually chose a language for
                    // should not immediately get "corrected" again by our
                    // own onStateChange handler.
                    self.#hasAppliedForVideo = true;
                }

                return originalResolveCommand.apply(this, arguments);
            };

            yttvInstance.instance.resolveCommand.isPatchedByPersistSubtitleLanguage = true;
            this.#isPatchedForCapture = true;
            clearInterval(interval);
            console.log('TizenTube Subtitle Persistence: Capture patch successful!');
        }, 500);
    }
}

window.subtitlePersistenceHandler = new SubtitlePersistenceHandler();

console.log('TizenTube Subtitle Persistence: Module loaded, waiting for YouTube TV...');
