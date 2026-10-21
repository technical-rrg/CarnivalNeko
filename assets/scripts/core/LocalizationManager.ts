/**
 * LocalizationManager - Quản lý đa ngôn ngữ cho SuperNova.
 *
 * ★ CÁCH DÙNG:
 *   import { L } from '../core/LocalizationManager';
 *   label.string = L('good_luck');                        // → "GOOD LUCK!"
 *   label.string = L('free_spin_count', { count: 10 });   // → "10 FREE SPINS"
 *   label.string = L('win_amount', { amount: '500.00' }); // → "WIN $500.00"
 *
 * ★ CHUYỂN NGÔN NGỮ:
 *   LocalizationManager.instance.setLanguage('ko');        // Korean
 *   LocalizationManager.instance.setLanguage('en');        // English (default)
 *
 * ★ SUPPORTED LANGUAGES:
 *   en    — English (default)
 *   ko    — Korean (한국어)
 *   zh-cn — Simplified Chinese (简体中文)
 *   zh-tw — Traditional Chinese (繁體中文)
 *   fil   — Filipino (Tagalog)
 *   ja    — Japanese (日本語)
 *   th    — Thai (ภาษาไทย)
 *   sg    — Singapore English
 *   ms    — Malay (Bahasa Melayu)
 *   vi    — Vietnamese (Tiếng Việt)
 *   au    — Australia English (AUD / A$)
 *   hk    — Hong Kong English (HKD / HK$)
 *
 * ★ 2 CHẾ ĐỘ HOẠT ĐỘNG:
 *   LOCAL:  Dùng file .ts build sẵn trong game (mặc định, offline-safe).
 *   ONLINE: Fetch JSON từ server CDN rồi merge vào local → luôn cập nhật mới nhất.
 *           Gọi loadOnlineLocales(url) khi game start (sau login).
 *           Nếu fetch thất bại → fallback dùng local.
 *
 * ★ THÊM / CẬP NHẬT NGÔN NGỮ:
 *   1. Đối tác gửi file Excel mới
 *   2. Chạy: node tools/convert-localization-xlsx.js <path-to-xlsx>
 *      → Tự sinh tất cả .ts files + locale-online.json
 *   3. Upload locale-online.json lên CDN (cho online mode)
 *
 * ★ Event khi đổi ngôn ngữ:
 *   EventBus.instance.on(GameEvents.LANGUAGE_CHANGED, (code: string) => { ... });
 */

import { EventBus } from './EventBus';
import { GameEvents } from './GameEvents';
import { DEV_FORCE_LANG } from '../data/ServerConfig';

// ─── Language data imports ───
import { LocaleData } from '../data/locales/LocaleTypes';
import { LOCALE_EN } from '../data/locales/en';
import { LOCALE_KO } from '../data/locales/ko';
import { LOCALE_ZH_CN } from '../data/locales/zh-cn';
import { LOCALE_ZH_TW } from '../data/locales/zh-tw';
import { LOCALE_FIL } from '../data/locales/fil';
import { LOCALE_JA } from '../data/locales/ja';
import { LOCALE_TH } from '../data/locales/th';
import { LOCALE_SG } from '../data/locales/sg';
import { LOCALE_MS } from '../data/locales/ms';
import { LOCALE_VI } from '../data/locales/vi';
import { LOCALE_AU } from '../data/locales/au';
import { LOCALE_HK } from '../data/locales/hk';
import { LOCALE_ID } from '../data/locales/id';
import { LOCALE_TR } from '../data/locales/tr';
import { LOCALE_FR } from '../data/locales/fr';
import { LOCALE_PT } from '../data/locales/pt';
import { LOCALE_ES } from '../data/locales/es';
import { PLATFORM_CURRENCY_SYMBOLS, TRUNCATED_UNIT_SUFFIX } from '../data/PlatformCurrency';
import { Log } from './Logger';

// ─── Types ───

export type LanguageCode = 'en' | 'ko' | 'zh-cn' | 'zh-tw' | 'fil' | 'ja' | 'th' | 'sg' | 'ms' | 'vi' | 'au' | 'hk'
    | 'id' | 'tr' | 'fr' | 'pt' | 'es';

/**
 * Platform languages (server Lang ID = code, BR a6ff834f3). Exact match only — 'es419', 'pt-BR' → 'en'.
 * Texts: data/locales/{id,tr,fr,pt,es}.ts, generated from client-porting/rrg-web-template/locale-data.
 */
const PLATFORM_LANGUAGES: readonly LanguageCode[] = ['id', 'tr', 'fr', 'pt', 'es'];

/**
 * Map từ currency code (ISO 4217) → ký hiệu tiền tệ hiển thị.
 * Được dùng khi server trả về Currency trong AckLogin để override locale.
 */
export const CURRENCY_SYMBOL_MAP: Record<string, string> = {
    'USD': '$',
    'KRW': '₩',
    'JPY': '¥',
    'CNY': '¥',
    'TWD': 'NT$',
    'THB': '฿',
    'PHP': '₱',
    'EUR': '€',
    'GBP': '£',
    'VND': '₫',
    'SGD': 'S$',
    'MYR': 'RM',
    'IDR': 'Rp',
    'HKD': 'HK$',
    'AUD': 'A$',
    'CAD': 'CA$',
    'C$': 'CA$',
    'USDT': 'USD₮',
    'INR': '₹',
};

/** Symbol shown when the server currency is unknown or not received yet (platform rule, BR a6ff834f3). */
const DEFAULT_CURRENCY_SYMBOL = '$';
/** Right-to-left letters (Arabic/Hebrew) — e.g. TND "د.ت". */
const RTL_CHARS = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
/**
 * RTL symbols are drawn in their stored order, left to right — as the original Unity games
 * (Ranch Rush) show TND: DAL · dot · TEH · amount ("د.ت100"). The canvas text renderer
 * would otherwise reorder them to "ت.د". LEFT-TO-RIGHT OVERRIDE … POP DIRECTIONAL
 * FORMATTING keeps the stored order; LEFT-TO-RIGHT MARK keeps the symbol left of the number.
 */
const LEFT_TO_RIGHT_OVERRIDE = '\u202D';
const POP_DIRECTIONAL_FORMATTING = '\u202C';
const LEFT_TO_RIGHT_MARK = '\u200E';

// Re-export for backward compatibility
export type { LocaleData };

// ─── Locale registry ───

const LOCALE_MODULES: Record<LanguageCode, LocaleData> = {
    'en':    LOCALE_EN,
    'ko':    LOCALE_KO,
    'zh-cn': LOCALE_ZH_CN,
    'zh-tw': LOCALE_ZH_TW,
    'fil':   LOCALE_FIL,
    'ja':    LOCALE_JA,
    'th':    LOCALE_TH,
    'sg':    LOCALE_SG,
    'ms':    LOCALE_MS,
    'vi':    LOCALE_VI,
    'au':    LOCALE_AU,
    'hk':    LOCALE_HK,
    'id':    LOCALE_ID,
    'tr':    LOCALE_TR,
    'fr':    LOCALE_FR,
    'pt':    LOCALE_PT,
    'es':    LOCALE_ES,
};

/**
 * Supported languages list — dùng cho Settings UI dropdown.
 */
export const SUPPORTED_LANGUAGES: { code: LanguageCode; name: string; nativeName: string }[] = [
    { code: 'en',    name: 'English',              nativeName: 'English' },
    { code: 'ko',    name: 'Korean',               nativeName: '한국어' },
    { code: 'zh-cn', name: 'Simplified Chinese',   nativeName: '简体中文' },
    { code: 'zh-tw', name: 'Traditional Chinese',  nativeName: '繁體中文' },
    { code: 'fil',   name: 'Filipino',             nativeName: 'Filipino' },
    { code: 'ja',    name: 'Japanese',             nativeName: '日本語' },
    { code: 'th',    name: 'Thai',                 nativeName: 'ภาษาไทย' },
    { code: 'sg',    name: 'Singapore',            nativeName: 'English (SG)' },
    { code: 'ms',    name: 'Malay',                nativeName: 'Bahasa Melayu' },
    { code: 'vi',    name: 'Vietnamese',           nativeName: 'Tiếng Việt' },
    { code: 'au',    name: 'Australia',            nativeName: 'English (AU)' },
    { code: 'hk',    name: 'Hong Kong',            nativeName: 'English (HK)' },
    { code: 'id',    name: 'Indonesian',           nativeName: 'Bahasa Indonesia' },
    { code: 'tr',    name: 'Turkish',              nativeName: 'Türkçe' },
    { code: 'fr',    name: 'French',               nativeName: 'Français' },
    { code: 'pt',    name: 'Portuguese',           nativeName: 'Português' },
    { code: 'es',    name: 'Spanish',              nativeName: 'Español' },
];

// ═══════════════════════════════════════════════════════════
//  SINGLETON
// ═══════════════════════════════════════════════════════════

export class LocalizationManager {
    private static _instance: LocalizationManager;

    private _currentLang: LanguageCode = 'en'; // ← TEST: đổi lại 'en' khi xong
    private _currentData: LocaleData = LOCALE_EN;
    private _fallbackData: LocaleData = LOCALE_EN;

    /**
     * Bật/tắt tự động phát hiện ngôn ngữ từ thiết bị/trình duyệt.
     * - `true`  → Khi không có ngôn ngữ đã lưu, tự detect từ browser/device.
     * - `false` → Luôn mặc định English nếu không có ngôn ngữ đã lưu (default).
     */
    public autoDetectLanguage: boolean = true;

    /** Online overrides — merge vào local data (online keys ưu tiên hơn local) */
    private _onlineData: Record<string, LocaleData> = {};
    /** Đã load online data thành công chưa */
    private _onlineLoaded: boolean = false;
    /**
     * Ký hiệu tiền tệ override từ server (AckLogin Currency).
     * Khi được set, getText('CLIENT_CURRENENCY_SYMBOL') trả về giá trị này
     * bất kể ngôn ngữ UI đang chọn là gì.
     */
    private _currencyOverride: string | null = null;
    /** Currency code gốc từ server (ISO 4217), ví dụ "KRW", "USD". */
    private _currencyCode: string | null = null;

    static get instance(): LocalizationManager {
        if (!this._instance) {
            this._instance = new LocalizationManager();
        }
        return this._instance;
    }

    /** Ngôn ngữ hiện tại */
    get currentLanguage(): LanguageCode {
        return this._currentLang;
    }

    /** Đã load online locales chưa */
    get isOnlineLoaded(): boolean {
        return this._onlineLoaded;
    }

    /**
     * Set ký hiệu tiền tệ override từ currency code server trả về (ISO 4217).
     * Sau khi set, getText('CLIENT_CURRENENCY_SYMBOL') sẽ luôn trả về symbol này
     * bất kể ngôn ngữ UI đang chọn.
     *
     * @param currencyCode  ISO 4217 code, ví dụ "USD", "KRW", "JPY", ...
     *                      CURRENCY_SYMBOL_MAP → PLATFORM_CURRENCY_SYMBOLS (BR a6ff834f3).
     *                      Not found → getText returns '$'.
     */
    setCurrencyOverride(currencyCode: string): void {
        const code = currencyCode.toUpperCase();
        const symbol = CURRENCY_SYMBOL_MAP[code] ?? PLATFORM_CURRENCY_SYMBOLS[code];
        if (symbol) {
            this._currencyCode     = code;
            this._currencyOverride = symbol;
            Log.d(`[i18n] Currency override: ${currencyCode} → "${symbol}"`);
        } else {
            Log.w(`[i18n] Unknown currency code "${currencyCode}", showing "${DEFAULT_CURRENCY_SYMBOL}"`);
        }
    }

    /**
     * Symbol placed before amounts — what L('CLIENT_CURRENENCY_SYMBOL') returns.
     * Platform rule (BR a6ff834f3): server Currency decides it, never the UI language;
     * unknown / before login → '$'. RTL symbols keep their stored order, left of the number.
     * Truncated units (IDK/VNK/MY1) show the code in the symbol slot, so a space follows.
     */
    getCurrencyDisplaySymbol(): string {
        const symbol = this._currencyOverride ?? DEFAULT_CURRENCY_SYMBOL;
        const pinned = RTL_CHARS.test(symbol)
            ? LEFT_TO_RIGHT_OVERRIDE + symbol + POP_DIRECTIONAL_FORMATTING + LEFT_TO_RIGHT_MARK
            : symbol;
        return this._currencyCode !== null && TRUNCATED_UNIT_SUFFIX[this._currencyCode] !== undefined
            ? `${pinned} `
            : pinned;
    }

    /** Text appended after amounts — "K" for IDK/VNK (1 = 1,000), "" otherwise (BR CurrencyFormatUtil.GetSuffix). */
    getAmountSuffix(): string {
        return this._currencyCode !== null ? (TRUNCATED_UNIT_SUFFIX[this._currencyCode] ?? '') : '';
    }

    /**
     * Trả về currency code từ server (ISO 4217) nếu đã được override,
     * hoặc null nếu chưa set (đang dùng locale symbol).
     * SpriteNumber dùng field này để chọn đúng currency sprite theo currency thật.
     */
    get currencyCode(): string | null {
        return this._currencyCode;
    }

    /**
     * Trả về số ký tự logic của ký hiệu tiền tệ cho ngôn ngữ hiện tại (hoặc ngôn ngữ chỉ định).
     * Nếu có currency override từ server, dùng symbol đó để tính.
     *
     * Dùng để canh size khung node chứa số tiền:
     *   - 'zh-tw' / 'hk' → 3  (NT$ / HK$)
     *   - 'sg' / 'au' / 'ms' → 2  (S$ / A$ / RM)
     *   - tất cả còn lại → 1  (ký hiệu là "$", "₩", "¥", "฿", "₱" — 1 ký tự)
     *
     * @param lang  (Tuỳ chọn) Ngôn ngữ cần kiểm tra. Mặc định là ngôn ngữ hiện tại.
     */
    getCurrencyCharCount(lang?: LanguageCode): number {
        if (this._currencyOverride !== null) return this._currencyOverride.length;
        const code = lang ?? this._currentLang;
        if (code === 'zh-tw' || code === 'hk') return 3;  // NT$ / HK$
        if (code === 'sg' || code === 'au' || code === 'ms') return 2;  // S$ / A$ / RM
        return 1;
    }

    /**
     * Trả về true nếu ngôn ngữ hiện tại (hoặc ngôn ngữ chỉ định) dùng ký hiệu tiền tệ nhiều ký tự.
     * Tiện cho các điều kiện phân nhánh đơn giản.
     *
     * @param lang  (Tuỳ chọn) Ngôn ngữ cần kiểm tra. Mặc định là ngôn ngữ hiện tại.
     */
    hasMultiCharCurrency(lang?: LanguageCode): boolean {
        return this.getCurrencyCharCount(lang) > 1;
    }

    /**
     * Chuyển ngôn ngữ. Tất cả component đang listen LANGUAGE_CHANGED sẽ tự cập nhật.
     * @param persist  false = chỉ đổi trong session (debug overlay). true = ghi localStorage.
     */
    setLanguage(code: LanguageCode, persist: boolean = true): void {
        if (!LOCALE_MODULES[code]) {
            Log.w(`[i18n] Unknown language: ${code}, fallback to 'en'`);
            code = 'en';
        }
        this._currentLang = code;
        this._currentData = this._buildMergedData(code);
        if (persist && typeof localStorage !== 'undefined') {
            localStorage.setItem('supernova_lang', code);
        }
        EventBus.instance.emit(GameEvents.LANGUAGE_CHANGED, code);
    }

    /**
     * Load ngôn ngữ khi game start.
     *
     * Quy tắc:
     * 1. DEV_FORCE_LANG override (dev only)
     * 2. URL query string `gl` parameter takes priority
     * 3. Nếu `gl` không có → default "en"
     * Không đọc Lang từ gp token, không dùng browser language.
     */
    loadSavedLanguage(): void {
        // DEV override — set by Language Switcher extension (Extensions → 🌐 Language Switcher)
        if (DEV_FORCE_LANG !== null && LOCALE_MODULES[DEV_FORCE_LANG as LanguageCode]) {
            this.setLanguage(DEV_FORCE_LANG as LanguageCode);
            return;
        }
        // Rule 1: URL `gl` parameter takes priority; Rule 3: default to "en" if missing
        this.setLanguage(this._detectFromUrlGl());
    }

    /**
     * Detect ngôn ngữ từ URL `gl` hoặc hint được truyền vào.
     * Nếu không có → default "en".
     */
    detectLanguage(langHint?: string): void {
        if (langHint) {
            const normalized = this._normalizeLangCode(langHint);
            if (LOCALE_MODULES[normalized]) {
                this.setLanguage(normalized);
                return;
            }
        }
        // Fallback: URL gl parameter, then default to English
        this.setLanguage(this._detectFromUrlGl());
    }

    /** Same mapping as `gl` — used for the launch-link Lang (core/LinkLanguage.ts). */
    normalizeLanguageCode(input: string): LanguageCode {
        return this._normalizeLangCode(input);
    }

    /**
     * Lấy text đã dịch theo key.
     * Hỗ trợ placeholder: {count}, {amount}, {name}, ...
     *
     * @param key     Localization key (e.g. 'good_luck', 'win_amount')
     * @param params  Placeholder values (e.g. { count: 10, amount: '500.00' })
     * @returns       Translated string (fallback English nếu thiếu)
     */
    getText(key: string, params?: Record<string, string | number>): string {
        // Currency symbol follows the server Currency, not the UI language
        if (key === 'CLIENT_CURRENENCY_SYMBOL') {
            return this.getCurrencyDisplaySymbol();
        }
        let text = this._currentData[key] ?? this._fallbackData[key] ?? `[${key}]`;
        if (params) {
            for (const k in params) {
                text = text.split(`{${k}}`).join(String(params[k]));
            }
        }
        return text;
    }

    // ═══════════════════════════════════════════════════════════
    //  ONLINE MODE — Fetch locale JSON từ server CDN
    // ═══════════════════════════════════════════════════════════

    /**
     * Fetch locale data từ remote URL và merge vào local data.
     *
     * ★ Gọi khi game start (sau login hoặc trong loading screen).
     * ★ Nếu fetch thất bại → tiếp tục dùng local data (không block game).
     * ★ Sau khi load xong → tự emit LANGUAGE_CHANGED để UI refresh.
     *
     * @param url  URL tới file locale-online.json (hoặc API endpoint).
     *             Format: { "en": { key: value, ... }, "ko": { ... }, ... }
     *
     * Ví dụ:
     *   await LocalizationManager.instance.loadOnlineLocales(
     *     'https://cdn.example.com/supernova/locale-online.json'
     *   );
     */
    async loadOnlineLocales(url: string): Promise<boolean> {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                Log.w(`[i18n] Online locale fetch failed: ${response.status}`);
                return false;
            }
            const json = await response.json();
            if (typeof json !== 'object' || json === null) {
                Log.w('[i18n] Online locale data invalid format');
                return false;
            }

            // Validate & store per-language data
            for (const lang of Object.keys(json)) {
                if (typeof json[lang] === 'object' && json[lang] !== null) {
                    this._onlineData[lang] = json[lang] as LocaleData;
                }
            }

            this._onlineLoaded = true;

            // Rebuild current data with online overrides
            this._currentData = this._buildMergedData(this._currentLang);
            this._fallbackData = this._buildMergedData('en');

            // Emit event để tất cả UI component refresh text
            EventBus.instance.emit(GameEvents.LANGUAGE_CHANGED, this._currentLang);

            const onlineLangs = Object.keys(this._onlineData);
            Log.d(`[i18n] Online locales loaded: ${onlineLangs.join(', ')}`);
            return true;
        } catch (err) {
            Log.w('[i18n] Online locale fetch error:', err);
            return false;
        }
    }

    /**
     * Load online data từ raw JSON object (dùng khi server trả locale trong Enter response
     * hoặc khi embed JSON trực tiếp).
     */
    loadOnlineLocalesFromData(data: Record<string, LocaleData>): void {
        for (const lang of Object.keys(data)) {
            if (typeof data[lang] === 'object' && data[lang] !== null) {
                this._onlineData[lang] = data[lang];
            }
        }
        this._onlineLoaded = true;
        this._currentData = this._buildMergedData(this._currentLang);
        this._fallbackData = this._buildMergedData('en');
        EventBus.instance.emit(GameEvents.LANGUAGE_CHANGED, this._currentLang);
    }

    // ─── Private ───

    /**
     * Merge local + online data cho 1 ngôn ngữ.
     * Local là base, online override (ưu tiên cao hơn).
     */
    private _buildMergedData(code: LanguageCode): LocaleData {
        const local = LOCALE_MODULES[code] || LOCALE_EN;
        const online = this._onlineData[code];
        if (!online) return local;
        // Merge: local base + online override
        return { ...local, ...online };
    }

    /**
     * Đọc `gl` từ URL query string và trả về LanguageCode.
     * Nếu không có hoặc không nhận ra → trả về 'en'.
     */
    private _detectFromUrlGl(): LanguageCode {
        if (typeof window !== 'undefined' && window.location && window.location.search) {
            const urlParams = new URLSearchParams(window.location.search);
            const gl = urlParams.get('gl');
            if (gl) {
                const normalized = this._normalizeLangCode(gl);
                Log.d(`[i18n] gl="${gl}" → language: ${normalized}`);
                return normalized;
            }
        }
        return 'en';
    }

    /**
     * Chuẩn hoá language code theo spec:
     *   zh-s, zh-c  → zh-cn  (Simplified Chinese / zh-Hans)
     *   zh-t        → zh-tw  (Traditional Chinese / zh-Hant)
     *   tl          → fil    (Filipino / fil-PH)
     *   au / en-au  → au     (Australia English / AUD)
     *   hk / en-hk  → hk     (Hong Kong English / HKD)
     *   Others      → as-is mapping (ko, en, ja, th, fil, ...)
     */
    private _normalizeLangCode(input: string): LanguageCode {
        const lower = input.toLowerCase().trim();

        // Special conversions per spec
        if (lower === 'zh-s' || lower === 'zh-c') return 'zh-cn'; // zh-Hans
        if (lower === 'zh-t') return 'zh-tw';                       // zh-Hant
        if (lower === 'tl') return 'fil';                           // fil-PH

        // Australia / Hong Kong English — phải check TRƯỚC Chinese variants
        // (tránh 'zh-hk' bị bắt nhầm; 'hk'/'en-hk' = HKD English)
        if (lower === 'au' || lower === 'en-au') return 'au';
        if (lower === 'hk' || lower === 'en-hk') return 'hk';

        // General Chinese variants (zh-hk / zh-hant → Traditional Chinese)
        if (lower.startsWith('zh')) {
            if (lower.includes('tw') || lower.includes('hant') || lower.includes('hk')) {
                return 'zh-tw';
            }
            return 'zh-cn';
        }

        if (lower.startsWith('ko')) return 'ko';
        if (lower.startsWith('ja')) return 'ja';
        if (lower.startsWith('th')) return 'th';
        if (lower.startsWith('fil')) return 'fil';
        if (lower === 'sg' || lower.startsWith('sg')) return 'sg';
        if (lower === 'ms' || lower.startsWith('ms')) return 'ms';
        if (lower === 'vi' || lower.startsWith('vi')) return 'vi';
        const platform = PLATFORM_LANGUAGES.find((code) => code === lower);
        if (platform) return platform;
        if (lower.startsWith('en')) return 'en';
        return 'en';
    }
}

// ═══════════════════════════════════════════════════════════
//  SHORTCUT FUNCTION — import { L } from '...'
// ═══════════════════════════════════════════════════════════

/**
 * Shortcut: L('key') hoặc L('key', { count: 5 }).
 * Viết tắt cho LocalizationManager.instance.getText().
 */
export function L(key: string, params?: Record<string, string | number>): string {
    return LocalizationManager.instance.getText(key, params);
}
