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

let isPatched = false;
let lastAppliedVideoId = null;
let lastSeenVideoId = null;
let applyTimeout = null;

function getCurrentVideoId() {
    const player = document.querySelector('.html5-video-player');
    if (!player || typeof player.getVideoData !== 'function') return null;
    try {
        const data = player.getVideoData();
        return (data && data.video_id) || null;
    } catch (e) {
        return null;
    }
}

// Re-issue the same command shape a manual menu click would produce.
// It flows back through resolveCommand.js's own instance lookup, so it
// behaves like the user picked the language themselves.
function applyPreferredLanguage(reason) {
    const languageCode = configRead('preferredSubtitleLanguageCode');
    const languageName = configRead('preferredSubtitleLanguageName');

    if (!languageCode) return;

    console.log(
        `%c[TizenTube Subtitle Persistence] Applying saved language ${languageName} (${languageCode}) - ${reason}`,
        'background: #9C27B0; color: #ffffff; font-size: 12px;'
    );

    resolveCommand({
        selectSubtitlesTrackCommand: {
            translationLanguage: {
                languageCode,
                languageName
            }
        }
    });
}

// Poll for the video changing (new video opened, or navigated within
// the same watch session) and (re)apply the saved language once the
// player has had a moment to set up its own caption menu.
function watchForVideoChanges() {
    setInterval(() => {
        if (!configRead('enablePersistSubtitleLanguage')) return;

        const videoId = getCurrentVideoId();
        if (!videoId || videoId === lastSeenVideoId) return;

        lastSeenVideoId = videoId;

        if (applyTimeout) clearTimeout(applyTimeout);
        applyTimeout = setTimeout(() => {
            if (lastAppliedVideoId === videoId) return;
            lastAppliedVideoId = videoId;
            applyPreferredLanguage('new video detected');
        }, 2000);
    }, 1000);
}

// Patch resolveCommand (independently from other mods, same pattern as
// moreSubtitles.js) purely to observe when the user manually picks a
// translated-subtitle language, so we can remember it.
function patchForCapture() {
    if (isPatched) return;

    if (!window._yttv) return setTimeout(patchForCapture, 250);

    const yttvInstance = Object.values(window._yttv).find(
        (obj) => obj && obj.instance && typeof obj.instance.resolveCommand === 'function'
    );

    if (!yttvInstance) return setTimeout(patchForCapture, 250);

    if (yttvInstance.instance.resolveCommand.isPatchedByPersistSubtitleLanguage) {
        return;
    }

    const originalResolveCommand = yttvInstance.instance.resolveCommand;

    yttvInstance.instance.resolveCommand = function (cmd, _) {
        const translationLanguage = cmd?.selectSubtitlesTrackCommand?.translationLanguage;

        if (translationLanguage && configRead('enablePersistSubtitleLanguage')) {
            const { languageCode, languageName } = translationLanguage;

            if (languageCode && languageCode !== configRead('preferredSubtitleLanguageCode')) {
                console.log(
                    `%c[TizenTube Subtitle Persistence] Remembering language: ${languageName} (${languageCode})`,
                    'background: #9C27B0; color: #ffffff; font-size: 14px; font-weight: bold;'
                );

                configWrite('preferredSubtitleLanguageCode', languageCode);
                configWrite('preferredSubtitleLanguageName', languageName || languageCode);
            }

            // The video the user just manually chose a language for
            // should not immediately get "corrected" again by our own poller.
            lastAppliedVideoId = getCurrentVideoId();
        }

        return originalResolveCommand.apply(this, arguments);
    };

    yttvInstance.instance.resolveCommand.isPatchedByPersistSubtitleLanguage = true;
    isPatched = true;
    console.log('TizenTube Subtitle Persistence: Patch successful!');
}

// If the user turns the setting on later (rather than at startup) and a
// language is already saved, apply it to whatever is currently playing.
configChangeEmitter.addEventListener('configChange', (event) => {
    const { key, value } = event.detail;
    if (key === 'enablePersistSubtitleLanguage' && value) {
        lastAppliedVideoId = null;
        applyPreferredLanguage('setting turned on');
    }
});

const interval = setInterval(() => {
    if (window._yttv && Object.keys(window._yttv).length > 0) {
        patchForCapture();
        clearInterval(interval);
    }
}, 1000);

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchForVideoChanges);
} else {
    watchForVideoChanges();
}

console.log('TizenTube Subtitle Persistence: Module loaded, waiting for YouTube TV...');
