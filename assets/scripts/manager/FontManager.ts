/**
 * FontManager - Quản lý font đa ngôn ngữ cho SuperNova.
 *
 * ★ MỤC ĐÍCH:
 *   Cung cấp font phù hợp cho từng ngôn ngữ. Game hỗ trợ 10 ngôn ngữ,
 *   mỗi ngôn ngữ có thể dùng font riêng để hiển thị đúng ký tự.
 *
 * ★ CÁCH DÙNG:
 *   // Trong Cocos Creator Editor:
 *   //   1. Gắn FontManager vào 1 Node persistent (e.g. Canvas hoặc GameManager node)
 *   //   2. Kéo font assets vào các slot tương ứng trong Inspector
 *   //
 *   // Trong code:
 *   const font = FontManager.instance.getFontForLanguage('ko');
 *   const cacheMode = FontManager.instance.getCacheModeForLanguage('ko');
 *
 * ★ FONT MAPPING:
 *   en    → defaultFont (RBNo31-Extra / Latin font)
 *   fil   → defaultFont (Latin-based, dùng chung font English)
 *   au    → defaultFont (Australia English / AUD — dùng chung font English)
 *   hk    → defaultFont (Hong Kong English / HKD — dùng chung font English)
 *   ko    → koreanFont  (Noto Sans KR / Pretendard)
 *   zh-cn → simplifiedChineseFont (Noto Sans SC)
 *   zh-tw → traditionalChineseFont (Noto Sans TC)
 *   ja    → japaneseFont (Noto Sans JP)
 *   th    → thaiFont (Noto Sans Thai / Sarabun)
 *   sg    → singaporeFont (Latin-based, dùng chung font English)
 *   ms    → malayFont (Latin-based, dùng chung font English)
 *   vi    → vietnameseFont (Noto Sans / Latin + Vietnamese diacritics)
 *
 * ★ CACHE MODE:
 *   BITMAP — mọi ngôn ngữ. Không dùng CHAR: atlas CHAR hash không gồm canvas/fontScale,
 *            nên window → fullscreen mix glyph cũ/mới (số 5 to hơn 0).
 */

import { _decorator, Component, Label, TTFFont } from 'cc';
import { LanguageCode, LocalizationManager } from '../core/LocalizationManager';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { CdnAssetManager } from '../core/CdnAssetManager';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

/** Mirror of Label.CacheMode — avoids namespace resolution issues with CC3 type declarations */
const enum CacheMode {
    NONE   = 0,
    BITMAP = 1,
    CHAR   = 2,
}

/**
 * Không dùng CHAR. Atlas CHAR tái sử dụng glyph theo fontSize+family+color,
 * không theo canvas scale — fullscreen rasterize chữ mới (vd. "5") to hơn chữ cũ.
 */
const CACHE_MODE_MAP: Record<LanguageCode, number> = {
    'en':    CacheMode.BITMAP,
    'fil':   CacheMode.BITMAP,
    'ko':    CacheMode.BITMAP,
    'zh-cn': CacheMode.BITMAP,
    'zh-tw': CacheMode.BITMAP,
    'ja':    CacheMode.BITMAP,
    'th':    CacheMode.BITMAP,
    'sg':    CacheMode.BITMAP,
    'ms':    CacheMode.BITMAP,
    'vi':    CacheMode.BITMAP,
    'au':    CacheMode.BITMAP,
    'hk':    CacheMode.BITMAP,
};

@ccclass('FontManager')
export class FontManager extends Component {

    // ─── SINGLETON ───
    private static _instance: FontManager | null = null;
    static get instance(): FontManager | null { return FontManager._instance; }

    // ─── FONT ASSETS (gán trong Inspector) ───

    @property({ type: TTFFont, tooltip: 'Font mặc định (English / Filipino). Ví dụ: RBNo31-Extra' })
    defaultFont: TTFFont | null = null;

    @property({ type: TTFFont, tooltip: 'Font cho Korean (한국어). Ví dụ: NotoSansKR-Bold' })
    koreanFont: TTFFont | null = null;

    @property({ type: TTFFont, tooltip: 'Font cho Simplified Chinese (简体中文). Ví dụ: NotoSansSC-Bold' })
    simplifiedChineseFont: TTFFont | null = null;

    @property({ type: TTFFont, tooltip: 'Font cho Traditional Chinese (繁體中文). Ví dụ: NotoSansTC-Bold' })
    traditionalChineseFont: TTFFont | null = null;

    @property({ type: TTFFont, tooltip: 'Font cho Japanese (日本語). Ví dụ: NotoSansJP-Bold' })
    japaneseFont: TTFFont | null = null;

    @property({ type: TTFFont, tooltip: 'Font cho Thai (ภาษาไทย). Ví dụ: NotoSansThai-Bold' })
    thaiFont: TTFFont | null = null;

    @property({ type: TTFFont, tooltip: 'Font cho Singapore English. Dùng chung font English nếu không có riêng.' })
    singaporeFont: TTFFont | null = null;

    @property({ type: TTFFont, tooltip: 'Font cho Malay (Bahasa Melayu). Ví dụ: NotoSans-Bold' })
    malayFont: TTFFont | null = null;

    @property({ type: TTFFont, tooltip: 'Font cho Vietnamese (Tiếng Việt). Ví dụ: NotoSans-Bold' })
    vietnameseFont: TTFFont | null = null;

    // ─── LIFECYCLE ───

    onLoad(): void {
        if (FontManager._instance && FontManager._instance !== this) {
            Log.w('[FontManager] Duplicate instance destroyed');
            this.node.destroy();
            return;
        }
        FontManager._instance = this;

        // Re-apply CDN fonts nếu đã tải trước đó (ví dụ: tải ở loading scene, sang game scene)
        const cdn = CdnAssetManager.instance;
        if (cdn.hasCachedFonts) {
            this.applyRemoteFonts(cdn.cachedFonts);
            Log.d('[FontManager] Re-applied CDN fonts from cache (scene switch)');
        } else {
            // Không có CDN font, nhưng vẫn cần notify tất cả LanguageChange component
            // để re-apply font bằng bundled font. Defer sang frame tiếp theo để đảm bảo
            // TẤT CẢ onLoad() trong cùng prefab/scene đã chạy xong và đã register listener.
            // Điều này fix race condition khi LanguageChange.onLoad() chạy trước FontManager.onLoad().
            this.scheduleOnce(() => {
                EventBus.instance.emit(GameEvents.LANGUAGE_CHANGED,
                    LocalizationManager.instance.currentLanguage);
                Log.d('[FontManager] Deferred LANGUAGE_CHANGED emitted (bundled fonts)');
            }, 0);
        }
    }

    onDestroy(): void {
        if (FontManager._instance === this) FontManager._instance = null;
    }

    // ─── PUBLIC API ───

    /**
     * Lấy Font asset phù hợp cho ngôn ngữ.
     * Nếu không có font riêng → fallback về defaultFont.
     */
    getFontForLanguage(lang: LanguageCode): TTFFont | null {
        switch (lang) {
            case 'ko':    return this.koreanFont || this.defaultFont;
            case 'zh-cn': return this.simplifiedChineseFont || this.defaultFont;
            case 'zh-tw': return this.traditionalChineseFont || this.defaultFont;
            case 'ja':    return this.japaneseFont || this.defaultFont;
            case 'th':    return this.thaiFont || this.defaultFont;
            case 'sg':    return this.singaporeFont || this.defaultFont;
            case 'ms':    return this.malayFont || this.defaultFont;
            case 'vi':    return this.vietnameseFont || this.defaultFont;
            case 'en':
            case 'fil':
            case 'au':
            case 'hk':
            default:      return this.defaultFont ?? null;
        }
    }

    /**
     * Cache mode theo ngôn ngữ — luôn BITMAP (không CHAR).
     */
    getCacheModeForLanguage(lang: LanguageCode): number {
        return CACHE_MODE_MAP[lang] ?? CacheMode.BITMAP;
    }

    /**
     * Cache mode an toàn cho 1 Label.
     * CHAR bị hạ: SHRINK → NONE (Cocos không hỗ trợ CHAR+SHRINK), còn lại → BITMAP.
     */
    resolveCacheModeForLabel(lang: LanguageCode, overflow: number, requested?: number): number {
        const mode = requested ?? this.getCacheModeForLanguage(lang);
        if (mode === CacheMode.CHAR) {
            return overflow === Label.Overflow.SHRINK ? CacheMode.NONE : CacheMode.BITMAP;
        }
        return mode;
    }

    /**
     * Hạ CHAR trên mọi Label trong scene (kể cả prefab/popup chưa qua LanguageChange).
     */
    static sanitizeLabelCacheMode(label: Label): void {
        if ((label.cacheMode as number) !== CacheMode.CHAR) return;
        label.cacheMode = (label.overflow === Label.Overflow.SHRINK
            ? CacheMode.NONE
            : CacheMode.BITMAP) as never;
    }

    /**
     * Áp dụng fonts tải từ CDN vào FontManager.
     * Gọi sau khi CdnAssetManager.loadAllFonts() hoàn tất.
     *
     * - Cập nhật từng font property tương ứng với lang.
     * - Sau khi update → emit LANGUAGE_CHANGED để toàn bộ LocaleFont re-apply.
     *
     * @param fonts  Map lang → TTFFont từ CdnAssetManager.loadAllFonts()
     *
     * Ví dụ:
     *   const fonts = await CdnAssetManager.instance.loadAllFonts([...]);
     *   FontManager.instance?.applyRemoteFonts(fonts);
     */
    applyRemoteFonts(fonts: Partial<Record<LanguageCode, TTFFont>>): void {
        let updated = 0;

        for (const langStr of Object.keys(fonts)) {
            const lang = langStr as LanguageCode;
            const font = fonts[lang];
            if (!font) continue;

            switch (lang) {
                case 'en':
                case 'fil':
                case 'au':
                case 'hk':   this.defaultFont = font;              updated++; break;
                case 'ko':    this.koreanFont = font;               updated++; break;
                case 'zh-cn': this.simplifiedChineseFont = font;    updated++; break;
                case 'zh-tw': this.traditionalChineseFont = font;   updated++; break;
                case 'ja':    this.japaneseFont = font;             updated++; break;
                case 'th':    this.thaiFont = font;                 updated++; break;
                case 'sg':    this.singaporeFont = font;            updated++; break;
                case 'ms':    this.malayFont = font;                updated++; break;
                case 'vi':    this.vietnameseFont = font;           updated++; break;
            }
        }

        if (updated > 0) {
            // Notify tất cả LocaleFont components để re-apply font mới
            EventBus.instance.emit(GameEvents.LANGUAGE_CHANGED,
                LocalizationManager.instance.currentLanguage);
            Log.d(`[FontManager] Applied ${updated} CDN fonts`);
        }
    }
}
