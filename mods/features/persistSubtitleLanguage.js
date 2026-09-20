
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

// Original retry schedule.
const RETRY_DELAYS_MS = [300, 900, 1800, 3500];

// Original maximum number of re-applies after player reset.
const MAX_RESET_REAPPLY = 3;

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
    #lastScheduledVideoId = null;
    #retryTimers = [];
    #resetReapplyCount = 0;
    #isPatched = false;

    constructor() {
        debugLog('SubtitlePersistenceHandler constructor');
        this.init();
    }

    init() {
        debugLog('Subtitle persistence initialization START');

        this.#startDOMCheck();
        this.#setupConfigListener();
        this.#patchResolveCommand();

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

    #clearRetryTimers(reason = 'unspecified') {
        const count = this.#retryTimers.length;

        for (const timerId of this.#retryTimers) {
            clearTimeout(timerId);
        }

        this.#retryTimers = [];

        debugLog(
            `Retry timers cleared | count=${count} | reason=${reason}`
        );
    }

    #scheduleRetries(reason, videoId) {
        if (!videoId) {
            debugLog(
                `Retry schedule skipped | no videoId | reason=${reason}`
            );

            return;
        }

        if (!configRead(CONFIG_KEYS.CODE)) {
            debugLog(
                `Retry schedule skipped | no language code | reason=${reason}`
            );

            return;
        }

        if (
            videoId === this.#lastScheduledVideoId &&
            this.#retryTimers.length > 0
        ) {
            debugLog(
                `Retry schedule skipped | already scheduled | videoId=${videoId}`
            );

            return;
        }

        this.#clearRetryTimers('before new retry sequence');

        this.#lastScheduledVideoId = videoId;

        debugLog(
            `RETRY SEQUENCE scheduled | videoId=${videoId} | reason=${reason}`,
            RETRY_DELAYS_MS
        );

        RETRY_DELAYS_MS.forEach((delay, index) => {
            const timerId = setTimeout(() => {
                if (!configRead(CONFIG_KEYS.ENABLED)) {
                    debugLog(
                        `RETRY skipped | disabled | delay=${delay}ms`
                    );

                    return;
                }

                const currentVideoId = this.#getVideoId();

                if (currentVideoId !== videoId) {
                    debugLog(
                        `RETRY skipped | video changed | expected=${videoId} | actual=${currentVideoId}`
                    );

                    return;
                }

                debugLog(
                    `RETRY EXECUTE | index=${index + 1}/${RETRY_DELAYS_MS.length} | delay=${delay}ms | videoId=${videoId} | reason=${reason}`
                );

                applyPreferredLanguage(
                    `retry +${delay}ms (${reason})`
                );

                if (index === RETRY_DELAYS_MS.length - 1) {
                    this.#retryTimers = [];

                    debugLog(
                        `RETRY SEQUENCE finished | videoId=${videoId}`
                    );
                }
            }, delay);

            this.#retryTimers.push(timerId);

            debugLog(
                `RETRY timer created | index=${index + 1} | delay=${delay}ms | videoId=${videoId}`
            );
        });
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
            this.#lastScheduledVideoId = null;
            this.#resetReapplyCount = 0;

            this.#clearRetryTimers('video context changed');
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
            this.#scheduleRetries(
                'stateChange:isPlaying',
                videoId
            );
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

        this.#scheduleRetries(
            'playbackStartExternal',
            videoId
        );
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

        // Original behavior:
        // apply once when the captions module becomes available.
        applyPreferredLanguage('onApiChange');
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

        if (this.#resetReapplyCount >= MAX_RESET_REAPPLY) {
            debugWarn(
                'Player reset ignored | maximum re-apply count reached',
                {
                    videoId,
                    count: this.#resetReapplyCount,
                    max: MAX_RESET_REAPPLY,
                }
            );

            return;
        }

        this.#resetReapplyCount += 1;

        debugWarn(
            'PLAYER RESET TO NON-TRANSLATION',
            {
                videoId,
                count: this.#resetReapplyCount,
                max: MAX_RESET_REAPPLY,
            }
        );

        const countAtScheduleTime = this.#resetReapplyCount;

        setTimeout(() => {
            debugLog(
                `RESET RE-APPLY timer executed | count=${countAtScheduleTime} | videoId=${this.#getVideoId()}`
            );

            applyPreferredLanguage(
                `player reset #${countAtScheduleTime}`
            );
        }, 350);

        debugLog(
            `RESET RE-APPLY timer created | delay=350ms | count=${countAtScheduleTime}`
        );
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
                    this.#clearRetryTimers(
                        'configuration disabled'
                    );

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

                    this.#clearRetryTimers(
                        `configuration changed: ${key}`
                    );

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