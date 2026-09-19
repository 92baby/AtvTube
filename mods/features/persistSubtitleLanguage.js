// TizenTube Subtitle Language Persistence Mod
// Remembers the auto-translate subtitle language the user picks and
// re-applies it on every new video (optionally per-channel), across restarts.
//
// Settings -> Subtitle Settings -> Remember Translated Subtitle Language
//
// Storage:
//   preferredSubtitleLanguageCode / Name  — global fallback
//   preferredSubtitleByChannel            — { [channelId]: { languageCode, languageName } }
//
// Cobalt / YouTube TV notes:
// - Apply via selectSubtitlesTrackCommand (same as a manual menu pick).
// - YouTube often overrides captions after first apply → multi-retry burst.
// - channelId is resolved from player / yt state / Innertube next when possible.

import { configRead, configWrite, configChangeEmitter } from '../config.js';
import resolveCommand from '../resolveCommand.js';

const PLAYER_SELECTOR = '.html5-video-player';
const RETRY_DELAYS_MS = [400, 1000, 2000, 3500, 5500, 8000];
const CHANNEL_ID_RE = /^UC[\w-]{20,}$/;

let isPatched = false;
let player = null;
let attachTimeout = null;

let lastSeenVideoId = null;
let lastScheduledVideoId = null;
let isInternalApply = false;
let retryTimers = [];
let retryDeadline = 0;

/** Cache: videoId -> channelId (or null if looked up and missing). */
const channelIdByVideo = new Map();
/** In-flight Innertube lookups to avoid duplicate /next calls. */
const channelLookupInflight = new Map();

function log(msg, style) {
    console.log(
        `%c[TizenTube Subtitle Persistence] ${msg}`,
        style || 'background: #9C27B0; color: #ffffff; font-size: 12px;'
    );
}

function getPlayer() {
    return document.querySelector(PLAYER_SELECTOR);
}

function getCurrentVideoId(p) {
    const pl = p || player || getPlayer();
    if (!pl || typeof pl.getVideoData !== 'function') return null;
    try {
        const data = pl.getVideoData();
        return (data && data.video_id) || null;
    } catch (e) {
        return null;
    }
}

function isPlayerPlaying(p) {
    const pl = p || player || getPlayer();
    if (!pl) return false;
    try {
        if (typeof pl.getPlayerStateObject === 'function') {
            const state = pl.getPlayerStateObject();
            if (state && state.isPlaying) return true;
        }
        const video = document.querySelector('video');
        if (video && !video.paused && !video.ended && video.readyState >= 2) {
            return true;
        }
    } catch (e) {
        /* ignore */
    }
    return false;
}

function normalizeChannelId(value) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (CHANNEL_ID_RE.test(trimmed)) return trimmed;
    // /channel/UCxxxx or full URL
    const match = trimmed.match(/(UC[\w-]{20,})/);
    return match ? match[1] : null;
}

/**
 * Best-effort synchronous channelId extraction from player / page state.
 * Returns null if unknown (async Innertube path may still resolve it).
 */
function getChannelIdSync() {
    const pl = player || getPlayer();

    // 1) player.getVideoData() — fields vary by Cobalt/YT-TV build
    try {
        if (pl && typeof pl.getVideoData === 'function') {
            const d = pl.getVideoData() || {};
            const candidates = [
                d.channel_id,
                d.channelId,
                d.ucid,
                d.author_id,
                d.authorId,
                d.external_channel_id
            ];
            for (const c of candidates) {
                const id = normalizeChannelId(c);
                if (id) return id;
            }
        }
    } catch (e) {
        /* ignore */
    }

    // 2) Common YT global blobs (present on some TV builds)
    try {
        const details =
            window.ytplayer?.config?.args?.raw_player_response?.videoDetails ||
            window.ytInitialPlayerResponse?.videoDetails ||
            window.yt?.player?.getPlayerResponse?.()?.videoDetails;
        if (details) {
            const id = normalizeChannelId(details.channelId || details.externalChannelId);
            if (id) return id;
        }
    } catch (e) {
        /* ignore */
    }

    // 3) Cached from a previous successful lookup for this video
    const videoId = getCurrentVideoId(pl);
    if (videoId && channelIdByVideo.has(videoId)) {
        return channelIdByVideo.get(videoId);
    }

    return null;
}

/**
 * Resolve channelId asynchronously via KabukiInnertubeClient /youtubei/v1/next
 * (same client TizenTube already uses in innerTubeCalls.js).
 */
function resolveChannelIdAsync(videoId) {
    if (!videoId) return Promise.resolve(null);
    if (channelIdByVideo.has(videoId)) {
        return Promise.resolve(channelIdByVideo.get(videoId));
    }
    if (channelLookupInflight.has(videoId)) {
        return channelLookupInflight.get(videoId);
    }

    const promise = new Promise((resolve) => {
        try {
            const mappings = Object.values(window._yttv || {}).find((a) => a && a.mappings);
            if (!mappings) {
                resolve(null);
                return;
            }
            const CurrentIdentityService = mappings.get('CurrentIdentityService');
            const KabukiInnerTubeClient = mappings.get('KabukiInnerTubeClient');
            if (!CurrentIdentityService || !KabukiInnerTubeClient) {
                resolve(null);
                return;
            }

            const finish = (id) => {
                channelIdByVideo.set(videoId, id || null);
                resolve(id || null);
            };

            CurrentIdentityService.get()
                .then((identity) => {
                    const request = {
                        identity,
                        isPrefetch: false,
                        path: '/youtubei/v1/next',
                        payload: {
                            videoId,
                            racyCheckOk: true,
                            contentCheckOk: true,
                            playbackContext: {
                                lactMilliseconds: 0,
                                isLyricsMode: false
                            },
                            autonavState: 'STATE_NONE'
                        },
                        clickTracking: { clickTrackingParams: null }
                    };

                    KabukiInnerTubeClient.fetch(request).subscribe((response) => {
                        try {
                            const contents =
                                response?.contents?.singleColumnWatchNextResults?.results?.results
                                    ?.contents;
                            if (!contents) {
                                finish(null);
                                return;
                            }
                            const itemSection = contents.find((item) => item.itemSectionRenderer);
                            const videoMetadata = itemSection?.itemSectionRenderer?.contents?.find(
                                (item) => item.videoMetadataRenderer
                            );
                            const nav =
                                videoMetadata?.videoMetadataRenderer?.owner?.videoOwnerRenderer
                                    ?.navigationEndpoint;
                            const browseId =
                                nav?.browseEndpoint?.browseId ||
                                nav?.commandExecutorCommand?.commands?.find?.(
                                    (c) => c?.browseEndpoint?.browseId
                                )?.browseEndpoint?.browseId;

                            finish(normalizeChannelId(browseId));
                        } catch (e) {
                            finish(null);
                        }
                    });
                })
                .catch(() => finish(null));
        } catch (e) {
            resolve(null);
        }
    }).finally(() => {
        channelLookupInflight.delete(videoId);
    });

    channelLookupInflight.set(videoId, promise);
    return promise;
}

function getPreferredLanguageForChannel(channelId) {
    if (channelId) {
        const map = configRead('preferredSubtitleByChannel') || {};
        const entry = map[channelId];
        if (entry && entry.languageCode) {
            return {
                languageCode: entry.languageCode,
                languageName: entry.languageName || entry.languageCode,
                source: `channel:${channelId}`
            };
        }
    }
    const languageCode = configRead('preferredSubtitleLanguageCode');
    if (!languageCode) return null;
    return {
        languageCode,
        languageName: configRead('preferredSubtitleLanguageName') || languageCode,
        source: 'global'
    };
}

function rememberLanguage(languageCode, languageName, channelId) {
    if (!languageCode) return;

    // Always keep global fallback up to date.
    if (languageCode !== configRead('preferredSubtitleLanguageCode')) {
        configWrite('preferredSubtitleLanguageCode', languageCode);
        configWrite('preferredSubtitleLanguageName', languageName || languageCode);
    }

    if (channelId) {
        const map = { ...(configRead('preferredSubtitleByChannel') || {}) };
        const prev = map[channelId];
        if (!prev || prev.languageCode !== languageCode) {
            map[channelId] = {
                languageCode,
                languageName: languageName || languageCode
            };
            configWrite('preferredSubtitleByChannel', map);
            log(
                `Remembered for channel ${channelId}: ${languageName} (${languageCode})`,
                'background: #9C27B0; color: #ffffff; font-size: 14px; font-weight: bold;'
            );
        }
    } else {
        log(
            `Remembered global: ${languageName} (${languageCode}) (no channelId yet)`,
            'background: #9C27B0; color: #ffffff; font-size: 14px; font-weight: bold;'
        );
    }
}

function clearRetryTimers() {
    for (const id of retryTimers) clearTimeout(id);
    retryTimers = [];
    retryDeadline = 0;
}

function applyPreferredLanguage(reason) {
    if (!configRead('enablePersistSubtitleLanguage')) return false;

    const channelId = getChannelIdSync();
    const preferred = getPreferredLanguageForChannel(channelId);
    if (!preferred) return false;

    log(
        `Applying ${preferred.languageName} (${preferred.languageCode}) [${preferred.source}] - ${reason}`
    );

    isInternalApply = true;
    try {
        resolveCommand({
            selectSubtitlesTrackCommand: {
                translationLanguage: {
                    languageCode: preferred.languageCode,
                    languageName: preferred.languageName
                }
            }
        });
    } catch (e) {
        console.warn('[TizenTube Subtitle Persistence] resolveCommand failed:', e);
        isInternalApply = false;
        return false;
    }

    Promise.resolve().then(() => {
        isInternalApply = false;
    });
    return true;
}

function scheduleRetries(reason) {
    if (!configRead('enablePersistSubtitleLanguage')) return;
    if (!getPreferredLanguageForChannel(getChannelIdSync())) return;

    const videoId = getCurrentVideoId();
    if (!videoId) return;

    if (videoId === lastScheduledVideoId && retryTimers.length > 0) return;

    clearRetryTimers();
    lastScheduledVideoId = videoId;
    retryDeadline = Date.now() + RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] + 500;

    log(`Scheduling ${RETRY_DELAYS_MS.length} apply attempts for video ${videoId} (${reason})`);

    for (const delay of RETRY_DELAYS_MS) {
        const timerId = setTimeout(() => {
            if (!configRead('enablePersistSubtitleLanguage')) return;
            if (getCurrentVideoId() !== videoId) return;
            if (Date.now() > retryDeadline) return;
            applyPreferredLanguage(`retry +${delay}ms after ${reason}`);
        }, delay);
        retryTimers.push(timerId);
    }
}

function onVideoContextChanged(reason) {
    const videoId = getCurrentVideoId();
    if (!videoId) return;

    if (videoId !== lastSeenVideoId) {
        lastSeenVideoId = videoId;
        lastScheduledVideoId = null;
        clearRetryTimers();
        log(`New video detected: ${videoId}`);

        // Kick async channel resolve; when it completes, reschedule if needed
        // so per-channel preference can take effect.
        resolveChannelIdAsync(videoId).then((channelId) => {
            if (getCurrentVideoId() !== videoId) return;
            if (channelId) {
                log(`Resolved channelId ${channelId} for video ${videoId}`);
                const preferred = getPreferredLanguageForChannel(channelId);
                if (preferred && preferred.source.startsWith('channel:')) {
                    // Force a fresh burst with channel-specific language.
                    lastScheduledVideoId = null;
                    if (isPlayerPlaying() || reason === 'playbackStart') {
                        scheduleRetries('channelId resolved');
                    }
                }
            }
        });
    }

    if (isPlayerPlaying() || reason === 'playbackStart') {
        scheduleRetries(reason);
    }
}

function handleStateChange() {
    if (!configRead('enablePersistSubtitleLanguage')) return;
    onVideoContextChanged('stateChange');
}

function handlePlaybackStart() {
    if (!configRead('enablePersistSubtitleLanguage')) return;
    onVideoContextChanged('playbackStart');
}

function attachToPlayer() {
    clearTimeout(attachTimeout);

    const el = getPlayer();
    if (!el) {
        attachTimeout = setTimeout(attachToPlayer, 200);
        return;
    }

    if (player === el) return;

    if (player) {
        try {
            player.removeEventListener('onStateChange', handleStateChange);
            player.removeEventListener('onPlaybackStartExternal', handlePlaybackStart);
        } catch (e) {
            /* ignore */
        }
    }

    player = el;
    player.addEventListener('onStateChange', handleStateChange);
    player.addEventListener('onPlaybackStartExternal', handlePlaybackStart);

    log('Attached to player (onStateChange + onPlaybackStartExternal)');

    if (configRead('enablePersistSubtitleLanguage') && isPlayerPlaying()) {
        onVideoContextChanged('attachWhilePlaying');
    }
}

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

            if (languageCode && !isInternalApply) {
                const channelId = getChannelIdSync();
                const videoId = getCurrentVideoId();

                // Persist immediately (global + channel if known).
                rememberLanguage(languageCode, languageName || languageCode, channelId);

                // If channel unknown yet, resolve then store under channel key.
                if (!channelId && videoId) {
                    resolveChannelIdAsync(videoId).then((resolved) => {
                        if (resolved) {
                            rememberLanguage(languageCode, languageName || languageCode, resolved);
                        }
                    });
                }
            }

            if (getCurrentVideoId()) {
                lastSeenVideoId = getCurrentVideoId();
            }
        }

        return originalResolveCommand.apply(this, arguments);
    };

    yttvInstance.instance.resolveCommand.isPatchedByPersistSubtitleLanguage = true;
    isPatched = true;
    log('Patch successful!', 'background: #9C27B0; color: #ffffff; font-size: 12px; font-weight: bold;');
}

configChangeEmitter.addEventListener('configChange', (event) => {
    const { key, value } = event.detail;

    if (key === 'enablePersistSubtitleLanguage') {
        if (value) {
            lastScheduledVideoId = null;
            clearRetryTimers();
            if (isPlayerPlaying()) {
                onVideoContextChanged('setting turned on');
            } else {
                applyPreferredLanguage('setting turned on (not yet playing)');
            }
        } else {
            clearRetryTimers();
            lastScheduledVideoId = null;
        }
    }

    if (
        (key === 'preferredSubtitleLanguageCode' ||
            key === 'preferredSubtitleLanguageName' ||
            key === 'preferredSubtitleByChannel') &&
        configRead('enablePersistSubtitleLanguage')
    ) {
        lastScheduledVideoId = null;
        clearRetryTimers();
        if (isPlayerPlaying()) {
            onVideoContextChanged('preferred language updated');
        }
    }
});

const bootInterval = setInterval(() => {
    if (window._yttv && Object.keys(window._yttv).length > 0) {
        patchForCapture();
        clearInterval(bootInterval);
    }
}, 500);

attachToPlayer();

setInterval(() => {
    const el = getPlayer();
    if (el && el !== player) {
        attachToPlayer();
    }
}, 2000);

log('Module loaded (per-channel + global), waiting for YouTube TV / Cobalt player...');
