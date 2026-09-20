// TizenTube Subtitle Language Persistence + TV Diagnostics
//
// Features:
// 1. Remember auto-translation subtitle language.
// 2. Display diagnostic logs directly on the TV screen.
// 3. Observe player events and subtitle commands.
// 4. Do not block or modify YouTube TV commands.
// 5. Do not automatically re-apply after non-translation commands.
//
// Diagnostic panel:
// - Visible on TV screen.
// - Maximum 35 log lines.
// - Click/tap the panel to clear logs.
// - Set SHOW_DIAGNOSTICS = false to disable the panel.

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

// =========================
// Diagnostic configuration
// =========================

const SHOW_DIAGNOSTICS = true;
const MAX_LOG_LINES = 35;
const PANEL_ID = 'subtitle-persistence-debug-panel';

let isInternalApply = false;
let debugPanel = null;
let debugLines = [];

// =========================
// TV visible diagnostics
// =========================

function getTimeString() {
    const now = new Date();

    return now.toLocaleTimeString('en-GB', {
        hour12: false,
        fractionalSecondDigits: 3,
    });
}

function safeString(value, maxLength = 500) {
    try {
        if (value === undefined) return 'undefined';
        if (value === null) return 'null';

        const text = typeof value === 'string'
            ? value
            : JSON.stringify(value);

        if (!text) return '';

        return text.length > maxLength
            ? text.substring(0, maxLength) + '...'
            : text;
    } catch (e) {
        return '[unserializable]';
    }
}

function ensureDebugPanel() {
    if (!SHOW_DIAGNOSTICS) return null;

    if (debugPanel && document.body.contains(debugPanel)) {
        return debugPanel;
    }

    debugPanel = document.getElementById(PANEL_ID);

    if (!debugPanel) {
        debugPanel = document.createElement('div');
        debugPanel.id = PANEL_ID;

        debugPanel.style.position = 'fixed';
        debugPanel.style.top = '20px';
        debugPanel.style.right = '20px';
        debugPanel.style.width = '620px';
        debugPanel.style.maxWidth = '90vw';
        debugPanel.style.maxHeight = '45vh';
        debugPanel.style.overflow = 'hidden';
        debugPanel.style.zIndex = '2147483647';

        debugPanel.style.background = 'rgba(0, 0, 0, 0.88)';
        debugPanel.style.color = '#00ff66';
        debugPanel.style.border = '2px solid #00ff66';
        debugPanel.style.borderRadius = '6px';

        debugPanel.style.padding = '10px';
        debugPanel.style.fontFamily = 'monospace';
        debugPanel.style.fontSize = '14px';
        debugPanel.style.lineHeight = '1.35';
        debugPanel.style.whiteSpace = 'pre-wrap';
        debugPanel.style.overflowWrap = 'anywhere';

        debugPanel.style.pointerEvents = 'auto';

        debugPanel.title = 'Click to clear subtitle diagnostics';

        debugPanel.addEventListener('click', () => {
            debugLines = [];
            renderDebugPanel();
        });

        document.body.appendChild(debugPanel);
    }

    return debugPanel;
}

function renderDebugPanel() {
    if (!SHOW_DIAGNOSTICS) return;

    const panel = ensureDebugPanel();
    if (!panel) return;

    panel.textContent = debugLines.join('\n');
}

function debugLog(eventName, details = '') {
    const line = `[${getTimeString()}] ${eventName}` +
        (details ? ` | ${details}` : '');

    debugLines.push(line);

    if (debugLines.length > MAX_LOG_LINES) {
        debugLines.splice(0, debugLines.length - MAX_LOG_LINES);
    }

    console.log('[Subtitle Persistence]', line);

    renderDebugPanel();
}

function debugWarn(eventName, details = '') {
    debugLog(`WARN: ${eventName}`, details);
}

// =========================
// Command inspection
// =========================

function extractTranslationCommand(cmd) {
    if (!cmd) return null;

    if (cmd.selectSubtitlesTrackCommand?.translationLanguage) {
        return cmd.selectSubtitlesTrackCommand.translationLanguage;
    }

    if (Array.isArray(cmd.commandExecutorCommand?.commands)) {
        for (const subCmd of cmd.commandExecutorCommand.commands) {
            const result = extractTranslationCommand(subCmd);

            if (result) {
                return result;
            }
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

function getSubtitleCommandSummary(cmd) {
    const translationLanguage = extractTranslationCommand(cmd);

    const result = {
        hasSubtitleCommand: hasSelectSubtitlesTrackCommand(cmd),
        translationLanguage: translationLanguage || null,
        command: cmd,
    };

    return result;
}

function logSubtitleCommand(source, cmd) {
    const summary = getSubtitleCommandSummary(cmd);

    if (!summary.hasSubtitleCommand) {
        return;
    }

    const translation = summary.translationLanguage;

    if (translation) {
        debugLog(
            `${source}: translation command`,
            `code=${translation.languageCode || 'none'}, ` +
            `name=${translation.languageName || 'none'}, ` +
            `internal=${isInternalApply}`
        );
    } else {
        debugLog(
            `${source}: non-translation command`,
            `internal=${isInternalApply}`
        );
    }

    // For detailed investigation, print the command structure
    // in the browser console as well.
    console.log('[Subtitle Debug] Full subtitle command:', cmd);
}

// =========================
// Player API diagnostics
// =========================

function tryPlayerSetOption(languageCode, languageName) {
    const player = document.querySelector(SELECTORS.PLAYER);

    if (!player || typeof player.setOption !== 'function') {
        debugWarn(
            'setOption unavailable',
            'player or setOption is missing'
        );

        return false;
    }

    try {
        if (typeof player.loadModule === 'function') {
            debugLog('captions.loadModule', 'called');

            try {
                player.loadModule('captions');

                debugLog('captions.loadModule', 'returned');
            } catch (error) {
                debugWarn(
                    'captions.loadModule',
                    safeString(error)
                );
            }
        }

        const translatedTrack = {
            languageCode,
            translationLanguage: {
                languageCode,
                languageName: languageName || languageCode,
            },
        };

        debugLog(
            'captions.setOption',
            safeString(translatedTrack)
        );

        try {
            player.setOption(
                'captions',
                'track',
                translatedTrack
            );

            debugLog(
                'captions.setOption',
                'translation payload returned'
            );

            return true;
        } catch (error) {
            debugWarn(
                'captions.setOption translation failed',
                safeString(error)
            );
        }

        const normalTrack = {
            languageCode,
        };

        debugLog(
            'captions.setOption fallback',
            safeString(normalTrack)
        );

        try {
            player.setOption(
                'captions',
                'track',
                normalTrack
            );

            debugLog(
                'captions.setOption',
                'normal payload returned'
            );

            return true;
        } catch (error) {
            debugWarn(
                'captions.setOption fallback failed',
                safeString(error)
            );

            return false;
        }
    } catch (error) {
        debugWarn(
            'setOption outer exception',
            safeString(error)
        );

        return false;
    }
}

// =========================
// Apply remembered language
// =========================

function applyPreferredLanguage(reason) {
    if (!configRead(CONFIG_KEYS.ENABLED)) {
        debugLog('apply skipped', 'feature disabled');
        return;
    }

    const languageCode = configRead(CONFIG_KEYS.CODE);
    const languageName = configRead(CONFIG_KEYS.NAME);

    if (!languageCode) {
        debugLog('apply skipped', 'no remembered language');
        return;
    }

    debugLog(
        'APPLY START',
        `language=${languageName || languageCode}, ` +
        `code=${languageCode}, reason=${reason}`
    );

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

        debugLog(
            'resolveCommand internal',
            safeString(command)
        );

        resolveCommand(command);

        debugLog('APPLY END', 'resolveCommand returned');
    } catch (error) {
        debugWarn(
            'applyPreferredLanguage failed',
            safeString(error)
        );
    }

    Promise.resolve().then(() => {
        isInternalApply = false;

        debugLog(
            'internal flag cleared',
            'isInternalApply=false'
        );
    });
}

// =========================
// Main handler
// =========================

class SubtitlePersistenceHandler {
    #player = null;
    #lastVideoId = null;
    #isPatched = false;

    constructor() {
        debugLog('handler', 'created');

        this.init();
    }

    init() {
        debugLog('handler', 'initializing');

        this.#startDOMCheck();
        this.#setupConfigListener();
        this.#patchResolveCommand();
    }

    #getVideoId() {
        if (!this.#player) return null;

        try {
            return this.#player.getVideoData?.()?.video_id || null;
        } catch (error) {
            debugWarn(
                'getVideoId failed',
                safeString(error)
            );

            return null;
        }
    }

    #getPlayerState() {
        if (!this.#player) {
            return 'no-player';
        }

        try {
            const stateObject =
                this.#player.getPlayerStateObject?.();

            if (stateObject) {
                return safeString(stateObject, 250);
            }

            return String(
                this.#player.getPlayerState?.()
            );
        } catch (error) {
            return `state-error:${safeString(error, 150)}`;
        }
    }

    #isPlayerPlaying() {
        if (!this.#player) return false;

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
        } catch (error) {
            return false;
        }
    }

    #updateVideoContext() {
        const videoId = this.#getVideoId();

        if (videoId !== this.#lastVideoId) {
            debugLog(
                'VIDEO CHANGE',
                `old=${this.#lastVideoId || 'none'}, ` +
                `new=${videoId || 'none'}`
            );

            this.#lastVideoId = videoId;
        }

        return videoId;
    }

    #startDOMCheck() {
        setInterval(() => {
            const playerElement =
                document.querySelector(SELECTORS.PLAYER);

            if (!playerElement) {
                return;
            }

            if (this.#player === playerElement) {
                return;
            }

            if (this.#player) {
                debugLog(
                    'PLAYER CHANGE',
                    'removing old event listeners'
                );

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
                } catch (error) {
                    debugWarn(
                        'removeEventListener failed',
                        safeString(error)
                    );
                }
            }

            this.#player = playerElement;

            debugLog(
                'PLAYER FOUND',
                `video=${this.#getVideoId() || 'none'}`
            );

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
                    'PLAYER EVENTS',
                    'listeners registered'
                );
            } catch (error) {
                debugWarn(
                    'addEventListener failed',
                    safeString(error)
                );
            }

            this.#handleStateChange();
        }, 1500);
    }

    #handleStateChange = () => {
        const videoId = this.#updateVideoContext();

        debugLog(
            'EVENT onStateChange',
            `video=${videoId || 'none'}, ` +
            `playing=${this.#isPlayerPlaying()}, ` +
            `state=${this.#getPlayerState()}`
        );
    };

    #handlePlaybackStart = () => {
        const videoId = this.#updateVideoContext();

        debugLog(
            'EVENT onPlaybackStartExternal',
            `video=${videoId || 'none'}, ` +
            `playing=${this.#isPlayerPlaying()}`
        );
    };

    #handleApiChange = () => {
        const videoId = this.#updateVideoContext();

        debugLog(
            'EVENT onApiChange',
            `video=${videoId || 'none'}`
        );

        if (!this.#player) {
            return;
        }

        try {
            const captionsModule =
                this.#player.getOptions?.('captions');

            debugLog(
                'captions options',
                safeString(captionsModule, 350)
            );
        } catch (error) {
            debugWarn(
                'getOptions captions failed',
                safeString(error)
            );
        }
    };

    #setupConfigListener() {
        configChangeEmitter.addEventListener(
            'configChange',
            (event) => {
                const detail = event.detail || {};
                const key = detail.key;

                debugLog(
                    'CONFIG CHANGE',
                    `key=${key || 'unknown'}`
                );

                if (
                    key === CONFIG_KEYS.ENABLED ||
                    key === CONFIG_KEYS.CODE ||
                    key === CONFIG_KEYS.NAME
                ) {
                    debugLog(
                        'CONFIG VALUES',
                        `enabled=${configRead(CONFIG_KEYS.ENABLED)}, ` +
                        `code=${configRead(CONFIG_KEYS.CODE) || 'none'}, ` +
                        `name=${configRead(CONFIG_KEYS.NAME) || 'none'}`
                    );

                    if (configRead(CONFIG_KEYS.ENABLED)) {
                        applyPreferredLanguage(
                            `configChange:${key}`
                        );
                    }
                }
            }
        );
    }

    #patchResolveCommand() {
        const interval = setInterval(() => {
            if (this.#isPatched || !window._yttv) {
                return;
            }

            const yttvEntry = Object.values(window._yttv).find(
                (obj) =>
                    obj &&
                    obj.instance &&
                    typeof obj.instance.resolveCommand === 'function'
            );

            if (!yttvEntry) {
                return;
            }

            const instance = yttvEntry.instance;

            if (
                instance.resolveCommand
                    .isPatchedByPersistSubtitleLanguage
            ) {
                this.#isPatched = true;
                clearInterval(interval);

                debugLog(
                    'resolveCommand',
                    'already patched'
                );

                return;
            }

            const originalResolveCommand =
                instance.resolveCommand;

            const self = this;

            instance.resolveCommand = function (cmd, _) {
                try {
                    if (hasSelectSubtitlesTrackCommand(cmd)) {
                        logSubtitleCommand(
                            'resolveCommand',
                            cmd
                        );

                        if (
                            configRead(CONFIG_KEYS.ENABLED) &&
                            !isInternalApply
                        ) {
                            const translationLanguage =
                                extractTranslationCommand(cmd);

                            if (translationLanguage) {
                                const languageCode =
                                    translationLanguage.languageCode;

                                const languageName =
                                    translationLanguage.languageName ||
                                    languageCode;

                                if (languageCode) {
                                    debugLog(
                                        'REMEMBER LANGUAGE',
                                        `code=${languageCode}, ` +
                                        `name=${languageName}`
                                    );

                                    configWrite(
                                        CONFIG_KEYS.CODE,
                                        languageCode
                                    );

                                    configWrite(
                                        CONFIG_KEYS.NAME,
                                        languageName
                                    );
                                }
                            } else {
                                debugLog(
                                    'NON-TRANSLATION COMMAND',
                                    'not automatically reapplied'
                                );
                            }
                        }
                    }
                } catch (error) {
                    debugWarn(
                        'resolveCommand diagnostic failed',
                        safeString(error)
                    );
                }

                // Always allow the original YouTube TV command.
                return originalResolveCommand.apply(
                    this,
                    arguments
                );
            };

            instance.resolveCommand
                .isPatchedByPersistSubtitleLanguage = true;

            this.#isPatched = true;
            clearInterval(interval);

            debugLog(
                'PATCH READY',
                'resolveCommand patch installed'
            );
        }, 500);
    }
}

// =========================
// Startup
// =========================

try {
    ensureDebugPanel();

    debugLog(
        'STARTUP',
        'subtitle persistence diagnostics enabled'
    );

    window.subtitlePersistenceHandler =
        new SubtitlePersistenceHandler();
} catch (error) {
    console.error(
        '[Subtitle Persistence] startup failed:',
        error
    );
}