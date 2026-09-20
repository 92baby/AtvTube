
/*
 * TizenTube Subtitle Language Persistence Mod
 *
 * Purpose:
 *   Remember the auto-translate subtitle language selected by the user
 *   and re-apply it when a new video starts or the player resets subtitles.
 *
 * This version keeps the original automatic-apply behavior and adds
 * detailed on-screen diagnostics.
 *
 * Debug panel:
 *   Top-left corner of the TV screen.
 *
 * Logged information:
 *   - Player discovery and video changes
 *   - Player lifecycle events
 *   - Retry scheduling and execution
 *   - captions.loadModule()
 *   - captions.setOption()
 *   - Full subtitle-related resolveCommand() data
 *   - Internal vs external commands
 *   - Translation and non-translation commands
 *   - Player reset and re-apply count
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

// Delay before each successive attempt, if the previous one
// did not verify as applied. Attempts are now serialized:
// apply -> wait -> verify -> (stop | next attempt).
const ATTEMPT_DELAYS_MS = [300, 900, 1800, 3500];

// How long to wait after an apply before checking whether the
// track actually landed on the desired language.
const VERIFY_DELAY_MS = 1200;

const REQUEST_STATUS = {
    IDLE: 'idle',
    PENDING: 'pending',
    CONFIRMED: 'confirmed',
    EXHAUSTED: 'exhausted',
};

// Periodic re-check while CONFIRMED, to catch the player silently
// reverting the track outside resolveCommand (so our patch never
// sees it). Two consecutive mismatches are required before we act,
// so a single transient read (mid-buffering, mid-ad-swap) can't by
// itself trigger a re-apply and collide with anything in flight.
const HEARTBEAT_INTERVAL_MS = 3000;
const HEARTBEAT_DRIFT_STRIKES_REQUIRED = 2;

// Debug settings.
const SHOW_DIAGNOSTICS = true;
const MAX_LOG_LINES = 45;
const DEBUG_PANEL_ID = 'subtitle-persistence-debug-panel';

let isInternalApply = false;
let logSequence = 0;
let applySequence = 0;
let debugPanel = null;
let debugLines = [];


/* ============================================================
 * Diagnostic helpers
 * ============================================================
 */

function getTimeString() {
    const now = new Date();

    try {
        return now.toLocaleTimeString('en-GB', {
            hour12: false,
            timeZoneName: 'short',
            fractionalSecondDigits: 3,
        });
    } catch (e) {
        // Compatibility fallback for older Tizen WebView.
        const h = String(now.getHours()).padStart(2, '0');
        const m = String(now.getMinutes()).padStart(2, '0');
        const s = String(now.getSeconds()).padStart(2, '0');
        const ms = String(now.getMilliseconds()).padStart(3, '0');

        return `${h}:${m}:${s}.${ms}`;
    }
}

function safeStringify(value, maxLength = 6000) {
    try {
        const result = JSON.stringify(value);

        if (!result) {
            return String(result);
        }

        if (result.length > maxLength) {
            return `${result.slice(0, maxLength)} ...[TRUNCATED]`;
        }

        return result;
    } catch (e) {
        return `[JSON ERROR: ${e?.message || e}]`;
    }
}

function ensureDebugPanel() {
    if (!SHOW_DIAGNOSTICS) return null;
    if (!document.body) return null;

    if (debugPanel && document.body.contains(debugPanel)) {
        return debugPanel;
    }

    debugPanel = document.getElementById(DEBUG_PANEL_ID);

    if (!debugPanel) {
        debugPanel = document.createElement('pre');
        debugPanel.id = DEBUG_PANEL_ID;

        debugPanel.style.cssText = [
            'position: fixed',
            'top: 12px',
            'left: 12px',
            'right: auto',
            'width: 720px',
            'max-width: 92vw',
            'max-height: 55vh',
            'overflow: hidden',
            'box-sizing: border-box',
            'margin: 0',
            'padding: 14px 16px',
            'border: 2px solid #00ff66',
            'border-radius: 8px',
            'background: rgba(0, 0, 0, 0.88)',
            'color: #00ff66',
            'font-family: monospace',
            'font-size: 14px',
            'font-weight: bold',
            'line-height: 1.35',
            'white-space: pre-wrap',
            'overflow-wrap: anywhere',
            'z-index: 2147483647',
            'pointer-events: none',
        ].join(';');

        document.body.appendChild(debugPanel);
    }

    return debugPanel;
}

function updateDebugPanel() {
    const panel = ensureDebugPanel();

    if (!panel) return;

    panel.textContent = debugLines.join('\n');
}

function debugLog(message, detail = undefined) {
    const sequence = String(++logSequence).padStart(4, '0');
    const time = getTimeString();

    const prefix = `[${sequence} ${time}]`;

    let panelLine = `${prefix} ${message}`;

    if (detail !== undefined) {
        const detailText = typeof detail === 'string'
            ? detail
            : safeStringify(detail, 1800);

        panelLine += ` | ${detailText}`;

        // Keep the full object in the browser console.
        console.log(`${prefix} ${message}`, detail);
    } else {
        console.log(`${prefix} ${message}`);
    }

    debugLines.push(panelLine);

    while (debugLines.length > MAX_LOG_LINES) {
        debugLines.shift();
    }

    updateDebugPanel();
}

function debugWarn(message, detail = undefined) {
    const sequence = String(++logSequence).padStart(4, '0');
    const time = getTimeString();

    const prefix = `[${sequence} ${time}] WARN`;

    let panelLine = `${prefix} ${message}`;

    if (detail !== undefined) {
        const detailText = typeof detail === 'string'
            ? detail
            : safeStringify(detail, 1800);

        panelLine += ` | ${detailText}`;

        console.warn(`${prefix} ${message}`, detail);
    } else {
        console.warn(`${prefix} ${message}`);
    }

    debugLines.push(panelLine);

    while (debugLines.length > MAX_LOG_LINES) {
        debugLines.shift();
    }

    updateDebugPanel();
}

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

function getPlayerStateObject(player) {
    if (!player) return null;

    try {
        return player.getPlayerStateObject?.() || null;
    } catch (e) {
        return null;
    }
}

function getPlayerStateSummary(player) {
    if (!player) {
        return {
            exists: false,
        };
    }

    let numericState = null;

    try {
        numericState = player.getPlayerState?.() ?? null;
    } catch (e) {
        numericState = null;
    }

    return {
        videoId: getPlayerVideoId(player),
        numericState,
        stateObject: getPlayerStateObject(player),
    };
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

function getSubtitleCommandType(cmd) {
    const translationLanguage = extractTranslationCommand(cmd);

    if (translationLanguage) {
        return 'translation';
    }

    if (isNonTranslationSubtitleCommand(cmd)) {
        return 'non-translation';
    }

    if (hasSelectSubtitlesTrackCommand(cmd)) {
        return 'subtitle-track-unknown';
    }

    return 'other';
}

function logSubtitleCommand(stage, cmd) {
    const type = getSubtitleCommandType(cmd);
    const translationLanguage = extractTranslationCommand(cmd);

    debugLog(
        `${stage} | type=${type} | internal=${isInternalApply}`,
        {
            translationLanguage,
            command: cmd,
        }
    );
}


/* ============================================================
 * Player captions API diagnostics
 * ============================================================
 */

function logCaptionsOptions(player, reason) {
    if (!player || typeof player.getOptions !== 'function') {
        debugLog(`captions.getOptions unavailable | reason=${reason}`);
        return;
    }

    try {
        const options = player.getOptions('captions');

        debugLog(
            `captions options | reason=${reason}`,
            options
        );
    } catch (e) {
        debugWarn(
            `captions.getOptions failed | reason=${reason}`,
            e?.message || e
        );
    }
}

function tryPlayerSetOption(languageCode, languageName, applyId) {
    const player = getCurrentPlayer();

    if (!player) {
        debugWarn(
            `setOption skipped | applyId=${applyId} | player not found`
        );

        return false;
    }

    if (typeof player.setOption !== 'function') {
        debugWarn(
            `setOption skipped | applyId=${applyId} | setOption unavailable`
        );

        return false;
    }

    debugLog(
        `captions.setOption START | applyId=${applyId}`,
        {
            languageCode,
            languageName,
            videoId: getPlayerVideoId(player),
        }
    );

    try {
        if (typeof player.loadModule === 'function') {
            debugLog(
                `captions.loadModule called | applyId=${applyId}`
            );

            try {
                const loadResult = player.loadModule('captions');

                debugLog(
                    `captions.loadModule returned | applyId=${applyId}`,
                    loadResult
                );
            } catch (e) {
                debugWarn(
                    `captions.loadModule threw | applyId=${applyId}`,
                    e?.message || e
                );
            }
        } else {
            debugLog(
                `captions.loadModule unavailable | applyId=${applyId}`
            );
        }

        const translationPayload = {
            languageCode,
            translationLanguage: {
                languageCode,
                languageName: languageName || languageCode,
            },
        };

        debugLog(
            `captions.setOption translation payload | applyId=${applyId}`,
            translationPayload
        );

        try {
            const result = player.setOption(
                'captions',
                'track',
                translationPayload
            );

            debugLog(
                `captions.setOption translation returned | applyId=${applyId}`,
                result
            );

            debugLog(
                `captions.setOption SUCCESS | mode=translation | applyId=${applyId}`
            );

            return true;
        } catch (e) {
            debugWarn(
                `captions.setOption translation threw | applyId=${applyId}`,
                e?.message || e
            );
        }

        const fallbackPayload = {
            languageCode,
        };

        debugLog(
            `captions.setOption fallback payload | applyId=${applyId}`,
            fallbackPayload
        );

        try {
            const result = player.setOption(
                'captions',
                'track',
                fallbackPayload
            );

            debugLog(
                `captions.setOption fallback returned | applyId=${applyId}`,
                result
            );

            debugLog(
                `captions.setOption SUCCESS | mode=fallback | applyId=${applyId}`
            );

            return true;
        } catch (e2) {
            debugWarn(
                `captions.setOption fallback threw | applyId=${applyId}`,
                e2?.message || e2
            );

            return false;
        }
    } catch (e) {
        debugWarn(
            `captions.setOption outer failure | applyId=${applyId}`,
            e?.message || e
        );

        return false;
    }
}


function getCurrentCaptionsTrackInfo(player) {
    if (!player || typeof player.getOption !== 'function') {
        return { available: false };
    }

    try {
        const track = player.getOption('captions', 'track');

        const languageCode =
            track?.translationLanguage?.languageCode ||
            track?.languageCode ||
            null;

        return {
            available: true,
            raw: track,
            languageCode,
        };
    } catch (e) {
        return {
            available: false,
            error: e?.message || e,
        };
    }
}

function isTrackOnDesiredLanguage(player, desiredCode) {
    const info = getCurrentCaptionsTrackInfo(player);

    debugLog(
        'VERIFY captions track read',
        {
            desiredCode,
            info,
        }
    );

    if (!info.available) {
        // Can't confirm either way - treat as not-yet-verified
        // rather than as success, so we retry instead of
        // silently declaring victory.
        return false;
    }

    return info.languageCode === desiredCode;
}


function getCaptionsAvailabilitySnapshot(player) {
    if (!player || typeof player.getOption !== 'function') {
        return { available: false };
    }

    try {
        const tracklist = player.getOption('captions', 'tracklist');
        const translationLanguages = player.getOption(
            'captions',
            'translationLanguages'
        );

        return {
            available: true,
            trackCount: Array.isArray(tracklist) ? tracklist.length : null,
            translationLanguageCount: Array.isArray(translationLanguages)
                ? translationLanguages.length
                : null,
        };
    } catch (e) {
        return {
            available: false,
            error: e?.message || e,
        };
    }
}


/* ============================================================
 * Automatic subtitle application
 * ============================================================
 */

function applyPreferredLanguage(reason) {
    if (!configRead(CONFIG_KEYS.ENABLED)) {
        debugLog(`APPLY skipped | disabled | reason=${reason}`);
        return;
    }

    const languageCode = configRead(CONFIG_KEYS.CODE);
    const languageName = configRead(CONFIG_KEYS.NAME);

    if (!languageCode) {
        debugLog(`APPLY skipped | no language code | reason=${reason}`);
        return;
    }

    const applyId = ++applySequence;
    const player = getCurrentPlayer();

    debugLog(
        `APPLY START | applyId=${applyId} | reason=${reason}`,
        {
            languageCode,
            languageName,
            videoId: getPlayerVideoId(player),
            playerState: getPlayerStateSummary(player),
        }
    );

    isInternalApply = true;

    let setOptionResult = false;
    let resolveResult;

    try {
        setOptionResult = tryPlayerSetOption(
            languageCode,
            languageName,
            applyId
        );

        debugLog(
            `APPLY setOption finished | applyId=${applyId}`,
            {
                setOptionResult,
            }
        );

        const command = {
            selectSubtitlesTrackCommand: {
                translationLanguage: {
                    languageCode,
                    languageName: languageName || languageCode,
                },
            },
        };

        debugLog(
            `APPLY resolveCommand payload | applyId=${applyId}`,
            command
        );

        try {
            resolveResult = resolveCommand(command);

            debugLog(
                `APPLY resolveCommand returned | applyId=${applyId}`,
                resolveResult
            );
        } catch (e) {
            debugWarn(
                `APPLY resolveCommand threw | applyId=${applyId}`,
                e?.message || e
            );
        }
    } catch (e) {
        debugWarn(
            `APPLY failed | applyId=${applyId}`,
            e?.message || e
        );
    }

    debugLog(
        `APPLY END | applyId=${applyId}`,
        {
            setOptionResult,
            resolveResult,
        }
    );

    // Keep the original behavior:
    // clear the internal flag on the next microtask.
    Promise.resolve().then(() => {
        isInternalApply = false;

        debugLog(
            `APPLY internal flag cleared | applyId=${applyId}`
        );
    });
}


/* ============================================================
 * Main handler
 * ============================================================
 */

class SubtitlePersistenceHandler {
    #player = null;
    #lastVideoId = null;
    #isPatched = false;

    // Single source of truth for "where are we with this video's
    // subtitle language". Only one attempt chain is ever in
    // flight at a time, regardless of which event triggered it.
    #requestState = {
        videoId: null,
        status: REQUEST_STATUS.IDLE,
        attempt: 0,
        timer: null,
    };

    // Consecutive heartbeat mismatches for the current CONFIRMED
    // video. Reset on match, on video change, and once acted on.
    #heartbeatDriftStrikes = 0;

    constructor() {
        debugLog('SubtitlePersistenceHandler constructor');
        this.init();
    }

    init() {
        debugLog('Subtitle persistence initialization START');

        this.#startDOMCheck();
        this.#setupConfigListener();
        this.#patchResolveCommand();
        this.#startHeartbeat();

        debugLog('Subtitle persistence initialization END');
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

    #startDOMCheck() {
        debugLog('DOM player check started | interval=1500ms');

        setInterval(() => {
            const playerElement = getCurrentPlayer();

            if (playerElement && this.#player !== playerElement) {
                const oldVideoId = getPlayerVideoId(this.#player);
                const newVideoId = getPlayerVideoId(playerElement);

                debugLog(
                    'PLAYER CHANGE detected',
                    {
                        oldVideoId,
                        newVideoId,
                    }
                );

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

                        debugLog('Old player listeners removed');
                    } catch (e) {
                        debugWarn(
                            'Old player listener removal failed',
                            e?.message || e
                        );
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

                    debugLog(
                        'New player listeners installed',
                        {
                            videoId: newVideoId,
                        }
                    );
                } catch (e) {
                    debugWarn(
                        'New player listener installation failed',
                        e?.message || e
                    );
                }

                logCaptionsOptions(
                    this.#player,
                    'player change'
                );

                // Catch up if the player already exists and is playing.
                this.#handleStateChange();
            }
        }, 1500);
    }

    #clearRequestTimer(reason = 'unspecified') {
        if (this.#requestState.timer) {
            clearTimeout(this.#requestState.timer);
            this.#requestState.timer = null;

            debugLog(`Request timer cleared | reason=${reason}`);
        }
    }

    // Single entry point for every trigger (state change, playback
    // start, onApiChange, player reset). It decides whether an
    // attempt chain needs to start; it never applies directly.
    #requestApply(reason) {
        const videoId = this.#getVideoId();

        if (!videoId) {
            debugLog(`REQUEST skipped | no videoId | reason=${reason}`);
            return;
        }

        if (!configRead(CONFIG_KEYS.CODE)) {
            debugLog(`REQUEST skipped | no language code | reason=${reason}`);
            return;
        }

        if (this.#requestState.videoId !== videoId) {
            debugLog(
                'REQUEST new video | resetting request state',
                {
                    oldVideoId: this.#requestState.videoId,
                    newVideoId: videoId,
                }
            );

            this.#clearRequestTimer('new video');

            this.#requestState = {
                videoId,
                status: REQUEST_STATUS.IDLE,
                attempt: 0,
                timer: null,
            };

            this.#heartbeatDriftStrikes = 0;
        }

        if (this.#requestState.status === REQUEST_STATUS.CONFIRMED) {
            debugLog(
                `REQUEST skipped | already confirmed | videoId=${videoId} | reason=${reason}`
            );

            return;
        }

        if (this.#requestState.status === REQUEST_STATUS.PENDING) {
            debugLog(
                `REQUEST skipped | attempt already in flight | videoId=${videoId} | reason=${reason}`
            );

            return;
        }

        if (this.#requestState.status === REQUEST_STATUS.EXHAUSTED) {
            debugLog(
                `REQUEST skipped | attempts exhausted for this video | videoId=${videoId} | reason=${reason}`
            );

            return;
        }

        debugLog(
            `REQUEST accepted | videoId=${videoId} | reason=${reason}`
        );

        this.#startAttempt(reason);
    }

    #startAttempt(reason) {
        const videoId = this.#requestState.videoId;

        this.#requestState.status = REQUEST_STATUS.PENDING;
        this.#requestState.attempt += 1;

        const attempt = this.#requestState.attempt;

        debugLog(
            `ATTEMPT START | attempt=${attempt}/${ATTEMPT_DELAYS_MS.length} | videoId=${videoId} | reason=${reason}`
        );

        applyPreferredLanguage(`${reason} (attempt ${attempt})`);

        this.#clearRequestTimer('scheduling verify');

        this.#requestState.timer = setTimeout(() => {
            this.#verifyAttempt(videoId, attempt, reason);
        }, VERIFY_DELAY_MS);
    }

    #verifyAttempt(videoId, attempt, reason) {
        if (!configRead(CONFIG_KEYS.ENABLED)) {
            debugLog(
                `VERIFY skipped | disabled | videoId=${videoId} | attempt=${attempt}`
            );

            return;
        }

        const currentVideoId = this.#getVideoId();

        if (currentVideoId !== videoId) {
            debugLog(
                `VERIFY skipped | video changed | expected=${videoId} | actual=${currentVideoId}`
            );

            return;
        }

        // Video is still the one we're tracking - a stale
        // requestState (e.g. overwritten by a newer video that
        // then changed back) shouldn't happen, but guard anyway.
        if (this.#requestState.videoId !== videoId) {
            debugLog(
                `VERIFY skipped | request state moved on | videoId=${videoId}`
            );

            return;
        }

        const desiredCode = configRead(CONFIG_KEYS.CODE);
        const player = getCurrentPlayer();
        const matched = isTrackOnDesiredLanguage(player, desiredCode);

        if (matched) {
            this.#requestState.status = REQUEST_STATUS.CONFIRMED;

            debugLog(
                `VERIFY CONFIRMED | videoId=${videoId} | attempt=${attempt}`
            );

            return;
        }

        if (attempt >= ATTEMPT_DELAYS_MS.length) {
            this.#requestState.status = REQUEST_STATUS.EXHAUSTED;

            const availability = getCaptionsAvailabilitySnapshot(player);

            if (availability.available && availability.trackCount === 0) {
                debugWarn(
                    `VERIFY FAILED | no captions track exists for this video | videoId=${videoId} | attempt=${attempt}`,
                    availability
                );
            } else if (
                availability.available &&
                availability.translationLanguageCount === 0
            ) {
                debugWarn(
                    `VERIFY FAILED | video has captions but no translation languages offered | videoId=${videoId} | attempt=${attempt}`,
                    availability
                );
            } else {
                debugWarn(
                    `VERIFY FAILED | giving up after max attempts | videoId=${videoId} | attempt=${attempt}`,
                    availability
                );
            }

            return;
        }

        const delay = ATTEMPT_DELAYS_MS[attempt];

        debugLog(
            `VERIFY NOT MATCHED | scheduling next attempt | videoId=${videoId} | nextDelay=${delay}ms`
        );

        this.#requestState.status = REQUEST_STATUS.IDLE;

        this.#clearRequestTimer('scheduling next attempt');

        this.#requestState.timer = setTimeout(() => {
            this.#startAttempt(`retry +${delay}ms (${reason})`);
        }, delay);
    }

    #startHeartbeat() {
        debugLog(
            `Heartbeat drift check started | interval=${HEARTBEAT_INTERVAL_MS}ms`
        );

        setInterval(() => {
            this.#heartbeatCheck();
        }, HEARTBEAT_INTERVAL_MS);
    }

    // Only ever reads and compares - never calls setOption
    // directly. If drift is confirmed, it demotes the state to
    // IDLE and hands off to #requestApply, the same single entry
    // point every other trigger uses. That guarantees this can
    // never overlap with an attempt already in flight (PENDING
    // blocks it) and never issues a competing setOption call.
    #heartbeatCheck() {
        if (!configRead(CONFIG_KEYS.ENABLED)) return;
        if (!configRead(CONFIG_KEYS.CODE)) return;

        // Don't sample while our own apply is actively running -
        // the track is expected to be in flux at that moment.
        if (isInternalApply) return;

        if (this.#requestState.status !== REQUEST_STATUS.CONFIRMED) {
            this.#heartbeatDriftStrikes = 0;
            return;
        }

        const videoId = this.#getVideoId();

        if (!videoId || videoId !== this.#requestState.videoId) {
            this.#heartbeatDriftStrikes = 0;
            return;
        }

        if (!this.#isPlayerPlaying()) {
            // Paused / buffering / ad transition - too easy to
            // misread a transient state here, so skip this tick
            // rather than risk a false strike.
            return;
        }

        const desiredCode = configRead(CONFIG_KEYS.CODE);
        const player = getCurrentPlayer();
        const matched = isTrackOnDesiredLanguage(player, desiredCode);

        if (matched) {
            if (this.#heartbeatDriftStrikes > 0) {
                debugLog(
                    `HEARTBEAT drift strike reset | videoId=${videoId}`
                );
            }

            this.#heartbeatDriftStrikes = 0;
            return;
        }

        this.#heartbeatDriftStrikes += 1;

        debugWarn(
            `HEARTBEAT drift suspected | videoId=${videoId} | strikes=${this.#heartbeatDriftStrikes}/${HEARTBEAT_DRIFT_STRIKES_REQUIRED}`
        );

        if (this.#heartbeatDriftStrikes < HEARTBEAT_DRIFT_STRIKES_REQUIRED) {
            return;
        }

        debugWarn(
            `HEARTBEAT DRIFT CONFIRMED | demoting and re-requesting | videoId=${videoId}`
        );

        this.#heartbeatDriftStrikes = 0;

        this.#clearRequestTimer('heartbeat drift');
        this.#requestState.status = REQUEST_STATUS.IDLE;

        this.#requestApply('heartbeatDrift');
    }

    #updateVideoContext(videoId) {
        if (videoId && videoId !== this.#lastVideoId) {
            debugLog(
                'VIDEO CONTEXT changed',
                {
                    oldVideoId: this.#lastVideoId,
                    newVideoId: videoId,
                }
            );

            this.#lastVideoId = videoId;
        }
    }

    #handleStateChange = () => {
        const videoId = this.#getVideoId();
        const playing = this.#isPlayerPlaying();

        debugLog(
            'EVENT onStateChange',
            {
                videoId,
                playing,
                state: getPlayerStateObject(this.#player),
            }
        );

        if (!configRead(CONFIG_KEYS.ENABLED)) {
            debugLog('onStateChange ignored | persistence disabled');
            return;
        }

        if (!videoId) {
            debugLog('onStateChange ignored | no videoId');
            return;
        }

        this.#updateVideoContext(videoId);

        if (playing) {
            this.#requestApply('stateChange:isPlaying');
        }
    };

    #handlePlaybackStart = () => {
        const videoId = this.#getVideoId();
        const playing = this.#isPlayerPlaying();

        debugLog(
            'EVENT onPlaybackStartExternal',
            {
                videoId,
                playing,
                state: getPlayerStateObject(this.#player),
            }
        );

        if (!configRead(CONFIG_KEYS.ENABLED)) {
            debugLog(
                'onPlaybackStartExternal ignored | persistence disabled'
            );

            return;
        }

        if (!videoId) {
            debugLog(
                'onPlaybackStartExternal ignored | no videoId'
            );

            return;
        }

        this.#updateVideoContext(videoId);

        this.#requestApply('playbackStartExternal');
    };

    #handleApiChange = () => {
        const videoId = this.#getVideoId();

        debugLog(
            'EVENT onApiChange',
            {
                videoId,
                playing: this.#isPlayerPlaying(),
            }
        );

        logCaptionsOptions(
            this.#player,
            'onApiChange'
        );

        if (!configRead(CONFIG_KEYS.ENABLED)) {
            debugLog('onApiChange ignored | persistence disabled');
            return;
        }

        if (!configRead(CONFIG_KEYS.CODE)) {
            debugLog('onApiChange ignored | no language code');
            return;
        }

        if (!videoId) {
            debugLog('onApiChange ignored | no videoId');
            return;
        }

        this.#updateVideoContext(videoId);

        this.#requestApply('onApiChange');
    };

    #onPlayerResetToNonTranslation() {
        if (!configRead(CONFIG_KEYS.ENABLED)) {
            debugLog(
                'Player reset ignored | persistence disabled'
            );

            return;
        }

        if (!configRead(CONFIG_KEYS.CODE)) {
            debugLog(
                'Player reset ignored | no language code'
            );

            return;
        }

        if (isInternalApply) {
            debugLog(
                'Player reset ignored | internal apply is active'
            );

            return;
        }

        const videoId = this.#getVideoId();

        if (!videoId) {
            debugLog(
                'Player reset ignored | no videoId'
            );

            return;
        }

        debugWarn(
            'PLAYER RESET TO NON-TRANSLATION',
            { videoId }
        );

        // The player fell back to a non-translated track, which
        // means any earlier CONFIRMED/EXHAUSTED verdict for this
        // video no longer holds. Demote it back to idle so
        // #requestApply is willing to start a fresh attempt chain,
        // then go through the same single entry point as every
        // other trigger (no separate ad-hoc timer/counter here).
        if (this.#requestState.videoId === videoId) {
            this.#clearRequestTimer('player reset');

            this.#requestState.status = REQUEST_STATUS.IDLE;
        }

        this.#requestApply('playerReset');
    }

    #setupConfigListener() {
        configChangeEmitter.addEventListener(
            'configChange',
            (ev) => {
                const detail = ev.detail || {};
                const key = detail.key;
                const isEnabled = configRead(CONFIG_KEYS.ENABLED);

                debugLog(
                    'CONFIG CHANGE',
                    {
                        key,
                        enabled: isEnabled,
                        code: configRead(CONFIG_KEYS.CODE),
                        name: configRead(CONFIG_KEYS.NAME),
                    }
                );

                if (!isEnabled) {
                    this.#clearRequestTimer(
                        'configuration disabled'
                    );

                    this.#requestState = {
                        videoId: null,
                        status: REQUEST_STATUS.IDLE,
                        attempt: 0,
                        timer: null,
                    };

                    return;
                }

                if (
                    key === CONFIG_KEYS.ENABLED ||
                    key === CONFIG_KEYS.CODE ||
                    key === CONFIG_KEYS.NAME
                ) {
                    this.#clearRequestTimer(
                        `configuration changed: ${key}`
                    );

                    // A new desired language means any earlier
                    // confirmation is for the old language, not
                    // this one - force a fresh attempt chain.
                    this.#requestState = {
                        videoId: null,
                        status: REQUEST_STATUS.IDLE,
                        attempt: 0,
                        timer: null,
                    };

                    const videoId = this.#getVideoId();

                    debugLog(
                        'CONFIG APPLY DECISION',
                        {
                            key,
                            videoId,
                            playing: this.#isPlayerPlaying(),
                        }
                    );

                    if (videoId) {
                        this.#requestApply(`configChanged:${key}`);
                    }
                }
            }
        );

        debugLog('Config listener installed');
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

                debugLog(
                    'resolveCommand already patched by this mod'
                );

                return;
            }

            const originalResolveCommand = instance.resolveCommand;
            const self = this;

            instance.resolveCommand = function(cmd, _) {
                const hasSubtitleCommand =
                    hasSelectSubtitlesTrackCommand(cmd);

                const commandType =
                    getSubtitleCommandType(cmd);

                if (hasSubtitleCommand) {
                    logSubtitleCommand(
                        'resolveCommand BEFORE',
                        cmd
                    );

                    debugLog(
                        'resolveCommand classification',
                        {
                            commandType,
                            internal: isInternalApply,
                            videoId: self.#getVideoId(),
                        }
                    );
                }

                let result;

                try {
                    result = originalResolveCommand.apply(
                        this,
                        arguments
                    );

                    if (hasSubtitleCommand) {
                        debugLog(
                            'resolveCommand ORIGINAL returned',
                            result
                        );
                    }
                } catch (e) {
                    if (hasSubtitleCommand) {
                        debugWarn(
                            'resolveCommand ORIGINAL threw',
                            e?.message || e
                        );
                    }

                    throw e;
                }

                if (
                    configRead(CONFIG_KEYS.ENABLED) &&
                    hasSubtitleCommand
                ) {
                    const translationLanguage =
                        extractTranslationCommand(cmd);

                    if (translationLanguage && !isInternalApply) {
                        const {
                            languageCode,
                            languageName,
                        } = translationLanguage;

                        debugLog(
                            'EXTERNAL TRANSLATION COMMAND',
                            {
                                languageCode,
                                languageName,
                                videoId: self.#getVideoId(),
                            }
                        );

                        if (
                            languageCode &&
                            languageCode !== configRead(CONFIG_KEYS.CODE)
                        ) {
                            debugLog(
                                'REMEMBERING NEW USER LANGUAGE',
                                {
                                    oldCode: configRead(CONFIG_KEYS.CODE),
                                    oldName: configRead(CONFIG_KEYS.NAME),
                                    newCode: languageCode,
                                    newName: languageName,
                                }
                            );

                            configWrite(
                                CONFIG_KEYS.CODE,
                                languageCode
                            );

                            configWrite(
                                CONFIG_KEYS.NAME,
                                languageName || languageCode
                            );
                        } else {
                            debugLog(
                                'External translation language equals saved language'
                            );
                        }
                    } else if (
                        !isInternalApply &&
                        isNonTranslationSubtitleCommand(cmd)
                    ) {
                        debugWarn(
                            'EXTERNAL NON-TRANSLATION COMMAND',
                            {
                                videoId: self.#getVideoId(),
                                message: 'Player may have reset subtitles',
                            }
                        );

                        self.#onPlayerResetToNonTranslation();
                    } else if (isInternalApply) {
                        debugLog(
                            'SUBTITLE COMMAND ignored for user-memory logic | internal apply'
                        );
                    }
                }

                if (hasSubtitleCommand) {
                    logSubtitleCommand(
                        'resolveCommand AFTER',
                        cmd
                    );
                }

                return result;
            };

            instance.resolveCommand
                .isPatchedByPersistSubtitleLanguage = true;

            this.#isPatched = true;
            clearInterval(interval);

            debugLog(
                'resolveCommand patch OK'
            );
        }, 500);

        debugLog(
            'resolveCommand patch watcher started | interval=500ms'
        );
    }
}


/* ============================================================
 * Start
 * ============================================================
 */

try {
    ensureDebugPanel();

    debugLog(
        'Subtitle Persistence diagnostic version starting'
    );

    debugLog(
        'Configuration at startup',
        {
            enabled: configRead(CONFIG_KEYS.ENABLED),
            languageCode: configRead(CONFIG_KEYS.CODE),
            languageName: configRead(CONFIG_KEYS.NAME),
        }
    );

    window.subtitlePersistenceHandler =
        new SubtitlePersistenceHandler();

    debugLog(
        'Subtitle Persistence diagnostic version started'
    );
} catch (e) {
    console.error(
        '[Subtitle Persistence] Startup failed:',
        e
    );

    debugWarn(
        'STARTUP FAILED',
        e?.message || e
    );
}