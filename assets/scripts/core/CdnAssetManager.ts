/**
 * CdnAssetManager - Tải assets từ CDN với version check.
 *
 * ★ TÍNH NĂNG:
 *   - locale-online.json: cache nội dung trong localStorage, chỉ re-fetch khi version đổi.
 *   - Font TTF: dùng assetManager.loadRemote() với ?v= để bust HTTP cache khi version đổi.
 *   - Fallback về cache cũ nếu mạng lỗi.
 *
 * ★ CDN MANIFEST (server cung cấp tại <cdnBase>/cdn-manifest.json):
 *   {
 *     "locale": { "v": "20260417001", "size": 12345 },
 *     "fonts": {
 *       "en":    { "v": "20260417001", "size": 45000 },
 *       "ko":    { "v": "20260417001", "size": 123000 },
 *       "zh-cn": { "v": "20260417001", "size": 456000 },
 *       "zh-tw": { "v": "20260417001", "size": 423000 },
 *       "fil":   { "v": "20260417001", "size": 45000 },
 *       "ja":    { "v": "20260417001", "size": 512000 },
 *       "th":    { "v": "20260417001", "size": 98000 },
 *       "sg":    { "v": "20260417001", "size": 45000 },
 *       "ms":    { "v": "20260417001", "size": 45000 },
 *       "vi":    { "v": "20260417001", "size": 67000 }
 *     }
 *   }
 *
 * ★ CÁCH DÙNG (trong LoadingController, sau login):
 *   const cdn = CdnAssetManager.instance;
 *   cdn.init('https://cdn.example.com/supernova');
 *
 *   await cdn.fetchManifest();                                         // 1. Lấy manifest
 *
 *   const locale = await cdn.loadLocale();                             // 2. Load locale
 *   if (locale) LocalizationManager.instance.loadOnlineLocalesFromData(locale);
 *
 *   const fonts = await cdn.loadAllFonts(['en','ko','zh-cn','zh-tw','fil','ja','th','sg','ms','vi']);
 *   FontManager.instance?.applyRemoteFonts(fonts);                     // 3. Apply fonts
 *
 * ★ CẤU TRÚC CDN:
 *   <cdnBase>/cdn-manifest.json
 *   <cdnBase>/locale-online.json
 *   <cdnBase>/fonts/en-subset.ttf
 *   <cdnBase>/fonts/ko-subset.ttf
 *   <cdnBase>/fonts/zh-cn-subset.ttf
 *   <cdnBase>/fonts/zh-tw-subset.ttf
 *   <cdnBase>/fonts/fil-subset.ttf
 *   <cdnBase>/fonts/ja-subset.ttf
 *   <cdnBase>/fonts/th-subset.ttf
 *   <cdnBase>/fonts/sg-subset.ttf
 *   <cdnBase>/fonts/ms-subset.ttf
 *   <cdnBase>/fonts/vi-subset.ttf
 *
 * ★ RESET CACHE (debug):
 *   CdnAssetManager.instance.clearCache();
 */

import { assetManager, TTFFont } from 'cc';
import { LocaleData } from '../data/locales/LocaleTypes';
import { LanguageCode } from './LocalizationManager';
import { Log } from './Logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CdnFileInfo {
    v: string;    // version string, e.g. "20260417001"
    size: number; // file size in bytes (informational)
}

export interface CdnManifest {
    locale: CdnFileInfo;
    fonts:  Partial<Record<LanguageCode, CdnFileInfo>>;
}

// ─── localStorage helpers (safe wrappers) ────────────────────────────────────

const LS_PREFIX = 'sn_cdn_';

function lsGet(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
}

function lsSet(key: string, val: string): void {
    try { localStorage.setItem(key, val); } catch { /* storage full — ignore */ }
}

function lsClearPrefix(prefix: string): number {
    try {
        const keys = Object.keys(localStorage).filter(k => k.startsWith(prefix));
        keys.forEach(k => localStorage.removeItem(k));
        return keys.length;
    } catch { return 0; }
}

// ─── CdnAssetManager ─────────────────────────────────────────────────────────

export class CdnAssetManager {

    private static _instance: CdnAssetManager;

    static get instance(): CdnAssetManager {
        if (!this._instance) this._instance = new CdnAssetManager();
        return this._instance;
    }

    private _cdnBase: string = '';
    private _manifest: CdnManifest | null = null;

    /** Fonts đã tải từ CDN — persist qua scene switch (Cocos không release remote assets tự động) */
    private _cachedFonts: Partial<Record<LanguageCode, TTFFont>> = {};

    /** Lấy fonts đã cache — dùng bởi FontManager.onLoad() để re-apply sau scene switch */
    get cachedFonts(): Partial<Record<LanguageCode, TTFFont>> { return this._cachedFonts; }

    get hasCachedFonts(): boolean { return Object.keys(this._cachedFonts).length > 0; }

    // ─── INIT ─────────────────────────────────────────────────────────────────

    /**
     * Khởi tạo với CDN base URL. Gọi 1 lần trước mọi load method.
     * @param cdnBase  Ví dụ: 'https://d1234.cloudfront.net/supernova'
     */
    init(cdnBase: string): void {
        this._cdnBase = cdnBase.replace(/\/$/, '');
    }

    // ─── MANIFEST ─────────────────────────────────────────────────────────────

    /**
     * Fetch cdn-manifest.json từ CDN.
     * Dùng session cache (memory) trong cùng session; HTTP cache mặc định của browser
     * thay vì no-store mỗi lần launch.
     */
    async fetchManifest(): Promise<CdnManifest | null> {
        if (!this._cdnBase) {
            Log.w('[CDN] init(cdnBase) chưa được gọi.');
            return null;
        }
        if (this._manifest) {
            return this._manifest;
        }
        try {
            const url = `${this._cdnBase}/cdn-manifest.json`;
            const res = await fetch(url, { cache: 'default' });
            if (!res.ok) {
                Log.w(`[CDN] manifest fetch failed: HTTP ${res.status}`);
                return null;
            }
            this._manifest = (await res.json()) as CdnManifest;
            Log.d(`[CDN] manifest OK (locale v=${this._manifest?.locale?.v ?? '?'})`);
            return this._manifest;
        } catch (err) {
            Log.w('[CDN] manifest error:', err);
            return null;
        }
    }

    // ─── LOCALE JSON ──────────────────────────────────────────────────────────

    /**
     * Load locale-online.json với version check.
     *
     * - manifest.locale.v === cached version  → trả ngay từ localStorage (không fetch).
     * - version khác hoặc chưa có cache       → fetch từ CDN, lưu vào localStorage.
     * - fetch lỗi mạng                        → fallback về cache cũ (stale).
     * - hoàn toàn không có gì                 → trả null → game dùng local bundled data.
     *
     * @returns Parsed locale data { en: {...}, ko: {...}, ... } hoặc null
     */
    async loadLocale(): Promise<Record<string, LocaleData> | null> {
        const lsVerKey  = `${LS_PREFIX}locale_v`;
        const lsDataKey = `${LS_PREFIX}locale_data`;

        const cachedVer = lsGet(lsVerKey);
        const remoteVer = this._manifest?.locale?.v ?? null;

        // Cache hit: version khớp và data còn tồn tại
        if (remoteVer && cachedVer === remoteVer) {
            const raw = lsGet(lsDataKey);
            if (raw) {
                try {
                    const data = JSON.parse(raw) as Record<string, LocaleData>;
                    Log.d(`[CDN] locale: cache hit (v=${remoteVer})`);
                    return data;
                } catch {
                    // Dữ liệu bị hỏng → re-fetch bên dưới
                    Log.w('[CDN] locale: cached data corrupted, re-fetching...');
                }
            }
        }

        // Fetch từ CDN
        const url = `${this._cdnBase}/locale-online.json`;
        try {
            const res = await fetch(url);
            if (!res.ok) {
                Log.w(`[CDN] locale fetch failed: HTTP ${res.status}`);
                return this._staleLocale(lsDataKey);
            }
            const text = await res.text();
            const data = JSON.parse(text) as Record<string, LocaleData>;

            // Lưu cache mới
            lsSet(lsDataKey, text);
            if (remoteVer) lsSet(lsVerKey, remoteVer);

            Log.d(`[CDN] locale: downloaded (v=${remoteVer ?? 'no-manifest'})`);
            return data;
        } catch (err) {
            Log.w('[CDN] locale fetch error:', err);
            return this._staleLocale(lsDataKey);
        }
    }

    private _staleLocale(lsDataKey: string): Record<string, LocaleData> | null {
        const raw = lsGet(lsDataKey);
        if (raw) {
            try {
                Log.d('[CDN] locale: dùng stale cache (mạng lỗi)');
                return JSON.parse(raw) as Record<string, LocaleData>;
            } catch { /* corrupted */ }
        }
        return null;
    }

    // ─── FONT TTF ─────────────────────────────────────────────────────────────

    /**
     * Load 1 font TTF từ CDN với version check.
     *
     * Cơ chế cache:
     *   - Version lưu trong localStorage (chỉ 1 string nhỏ, không lưu binary).
     *   - Font binary được cache bởi HTTP browser cache (Cache-Control: immutable từ CDN).
     *   - Cùng version → cùng URL → browser trả từ HTTP cache (không có network request).
     *   - Khác version → URL mới có ?v=<ver> → browser fetch mới từ CDN.
     *   - Cocos assetManager cache font trong bộ nhớ theo URL (cùng session).
     *
     * @param lang  Language code, ví dụ: 'ko', 'zh-cn'
     * @returns TTFFont asset hoặc null nếu thất bại
     */
    loadFont(lang: LanguageCode): Promise<TTFFont | null> {
        const lsVerKey   = `${LS_PREFIX}font_${lang}_v`;
        const cachedVer  = lsGet(lsVerKey);
        const remoteInfo = this._manifest?.fonts?.[lang];
        const remoteVer  = remoteInfo?.v ?? null;

        // Build URL: thêm ?v= nếu có version từ manifest để bust cache khi thay đổi
        const baseUrl = `${this._cdnBase}/fonts/${lang}-subset.ttf`;
        const url     = remoteVer ? `${baseUrl}?v=${remoteVer}` : baseUrl;

        if (remoteVer && cachedVer === remoteVer) {
            Log.d(`[CDN] font ${lang}: version unchanged (${remoteVer}), reusing HTTP cache`);
        } else if (cachedVer) {
            Log.d(`[CDN] font ${lang}: update ${cachedVer} → ${remoteVer ?? '?'}`);
        } else {
            Log.d(`[CDN] font ${lang}: first load`);
        }

        return new Promise<TTFFont | null>((resolve) => {
            assetManager.loadRemote<TTFFont>(url, { ext: '.ttf' }, (err, font) => {
                if (err || !font) {
                    Log.w(`[CDN] font ${lang} failed:`, err?.message ?? err);
                    resolve(null);
                    return;
                }
                if (remoteVer) lsSet(lsVerKey, remoteVer);
                // Cache để FontManager có thể re-apply sau scene switch
                this._cachedFonts[lang] = font;
                Log.d(`[CDN] font ${lang}: OK`);
                resolve(font);
            });
        });
    }

    /**
     * Load nhiều fonts song song (Promise.all).
     * @param langs  Danh sách ngôn ngữ cần load
     * @returns Map lang → TTFFont (chỉ chứa các font load thành công)
     */
    async loadAllFonts(langs: LanguageCode[]): Promise<Partial<Record<LanguageCode, TTFFont>>> {
        const results: Partial<Record<LanguageCode, TTFFont>> = {};
        await Promise.all(
            langs.map(async (lang) => {
                const font = await this.loadFont(lang);
                if (font) results[lang] = font;
            })
        );
        // Cache để FontManager trong scene mới có thể re-apply sau scene switch
        Object.assign(this._cachedFonts, results);
        return results;
    }

    // ─── UTILS ────────────────────────────────────────────────────────────────

    /**
     * Xóa toàn bộ CDN cache trong localStorage.
     * Lần chạy tiếp theo sẽ re-download tất cả assets từ CDN.
     */
    clearCache(): void {
        const count = lsClearPrefix(LS_PREFIX);
        Log.d(`[CDN] Cleared ${count} cache entries`);
    }

    /** Manifest hiện tại (sau khi fetchManifest). */
    get manifest(): CdnManifest | null { return this._manifest; }

    /** CDN base URL đã set. */
    get cdnBase(): string { return this._cdnBase; }
}
