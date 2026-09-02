/**
 * Logger - production-safe logging utility.
 * Khi SILENCE_LOGS=true (ServerConfig): mọi Log.* và console.* đều im lặng.
 * Dev: đặt SILENCE_LOGS=false rồi dùng Log.enable(tag) + whitelist.
 */

import { SILENCE_LOGS } from '../data/ServerConfig';

const SILENT = SILENCE_LOGS;

const noop = (..._args: any[]): void => {};

const _c: any = (typeof console !== 'undefined') ? console : null;
const _orig = _c ? {
    log: (_c.log && typeof _c.log === 'function') ? _c.log.bind(_c) : noop,
    info: (_c.info && typeof _c.info === 'function') ? _c.info.bind(_c) : noop,
    debug: (_c.debug && typeof _c.debug === 'function') ? _c.debug.bind(_c) : noop,
    warn: (_c.warn && typeof _c.warn === 'function') ? _c.warn.bind(_c) : noop,
    error: (_c.error && typeof _c.error === 'function') ? _c.error.bind(_c) : noop,
    trace: (_c.trace && typeof _c.trace === 'function') ? _c.trace.bind(_c) : noop,
} : null;
if (_c && SILENT) {
    _c.log = noop;
    _c.info = noop;
    _c.debug = noop;
    _c.warn = noop;
    _c.trace = noop;
    _c.error = noop;
}

const _white: Set<string> = new Set();
const _matchWhitelist = (args: any[]): boolean => {
    if (_white.size === 0) return false;
    const a0 = args && args.length > 0 ? args[0] : null;
    const s = (typeof a0 === 'string') ? a0.toLowerCase() : '';
    if (!s) return false;
    for (const t of _white) {
        if (s.includes(t)) return true;
    }
    return false;
};

export const Log = {
    d: (...args: any[]) => { if (!SILENT && _orig && _matchWhitelist(args)) { _orig.log(...args); } },
    w: (...args: any[]) => { if (!SILENT && _orig && _matchWhitelist(args)) { _orig.warn(...args); } },
    /** Debug trace — không dùng cho lỗi thật (silent khi SILENT). */
    e: (...args: any[]) => { if (!SILENT && _orig && _matchWhitelist(args)) { _orig.log(...args); } },
    /** Lỗi thật — silent khi SILENCE_LOGS. */
    err: (...args: any[]) => { if (!SILENT && _orig) { _orig.error(...args); } },
    isEnabled: (tag: string = ''): boolean => {
        if (SILENT || !tag) return false;
        const s = tag.toLowerCase();
        for (const t of _white) {
            if (s.includes(t) || t.includes(s)) return true;
        }
        return false;
    },
    enable: (tag: string): void => {
        if (SILENT || !tag) return;
        _white.add(String(tag).toLowerCase());
    },
    disable: (tag: string): void => { if (SILENT || !tag) return; _white.delete(String(tag).toLowerCase()); },
    setWhitelist: (tags: readonly string[] | string[]): void => {
        if (SILENT) return;
        _white.clear();
        if (!tags) return;
        for (const tg of tags as any) {
            if (tg) _white.add(String(tg).toLowerCase());
        }
    },
    clearWhitelist: (): void => { _white.clear(); },
};
