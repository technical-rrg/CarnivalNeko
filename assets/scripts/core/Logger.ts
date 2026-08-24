/**
 * Logger - production-safe logging utility.
 * Runtime logging is intentionally disabled except whitelist tags.
 */

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
if (_c) {
    _c.log = noop;
    _c.info = noop;
    _c.debug = noop;
    _c.warn = noop;
    _c.trace = noop;
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
    d: (...args: any[]) => { if (_orig && _matchWhitelist(args)) { _orig.log(...args); } },
    w: (...args: any[]) => { if (_orig && _matchWhitelist(args)) { _orig.warn(...args); } },
    e: (...args: any[]) => { if (_orig && _matchWhitelist(args)) { _orig.error(...args); } },
    isEnabled: (tag: string = ''): boolean => {
        if (!tag) return false;
        const s = tag.toLowerCase();
        for (const t of _white) {
            if (s.includes(t) || t.includes(s)) return true;
        }
        return false;
    },
    // Cho phép bật thêm tag khi đang làm Carnival (không block nữa)
    enable: (tag: string): void => {
        if (tag) _white.add(String(tag).toLowerCase());
    },
    disable: (tag: string): void => { if (tag) _white.delete(String(tag).toLowerCase()); },
    setWhitelist: (tags: readonly string[] | string[]): void => {
        _white.clear();
        if (!tags) return;
        for (const tg of tags as any) {
            if (tg) _white.add(String(tg).toLowerCase());
        }
    },
    clearWhitelist: (): void => { _white.clear(); },
};

// Tag mới PHẢI thêm vào đây — Log.d/w/e bị nuốt nếu không whitelist.
Log.setWhitelist([
    'pickgame',       // [PickGame] pick cell, result PS ID, 3 ID trúng, server JackpotName
    'jackpot',        // [Jackpot] claim / trigger sau pick game
    'multi-line-win', // [MULTI-LINE-WIN] debug per-line animation + payout summation
]);
