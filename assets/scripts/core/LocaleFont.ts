/**
 * LocaleFont - Component tự động chọn Font + Cache Mode theo ngôn ngữ.
 *
 * ★ CÁCH DÙNG:
 *   1. Gắn script LocaleFont vào bất kỳ Node nào có Label hoặc RichText.
 *   2. Không cần config gì thêm — component tự detect Label/RichText trên cùng Node.
 *   3. Khi game init, component sẽ:
 *      - Lấy ngôn ngữ hiện tại từ LocalizationManager
 *      - Lấy Font phù hợp từ FontManager
 *      - Gán Font + Cache Mode tối ưu cho Label/RichText
 *   4. Font chỉ được set 1 LẦN khi onLoad (không đổi runtime vì font change
 *      yêu cầu rebuild toàn bộ text mesh, tốn performance).
 *
 * ★ LƯU Ý:
 *   - FontManager phải được gắn vào scene và load TRƯỚC LocaleFont.
 *     (Đặt FontManager trên node cha hoặc node Canvas, đảm bảo onLoad chạy trước)
 *   - Nếu FontManager chưa init → component sẽ log warning và dùng font mặc định.
 *   - RichText không hỗ trợ cacheMode → chỉ set font cho RichText.
 *
 * ★ OVERRIDE:
 *   - overrideFont: Nếu set → bỏ qua FontManager, luôn dùng font này (mọi ngôn ngữ).
 *   - overrideCacheMode: Nếu bật → dùng cacheMode tùy chọn thay vì tự động.
 */

import { _decorator, Component, Label, RichText, TTFFont } from 'cc';
import { LocalizationManager, LanguageCode } from './LocalizationManager';
import { FontManager } from '../manager/FontManager';
import { EventBus } from './EventBus';
import { GameEvents } from './GameEvents';
import { Log } from './Logger';

const { ccclass, property, executeInEditMode } = _decorator;

@ccclass('LocaleFont')
@executeInEditMode(false)
export class LocaleFont extends Component {

    // ─── OPTIONAL OVERRIDES ───

    @property({ type: TTFFont, tooltip: 'Override: luôn dùng font này bất kể ngôn ngữ. Để trống = tự động.' })
    overrideFont: TTFFont | null = null;

    @property({ tooltip: 'Bật để dùng cacheMode tùy chọn thay vì tự động theo ngôn ngữ.' })
    useOverrideCacheMode: boolean = false;

    @property({
        tooltip: 'Cache mode tùy chọn (0=NONE,1=BITMAP,2=CHAR). Chỉ có tác dụng khi useOverrideCacheMode = true.',
        visible(this: LocaleFont) { return this.useOverrideCacheMode; },
    })
    overrideCacheMode: number = 0; // 0=NONE, 1=BITMAP, 2=CHAR

    // ─── LIFECYCLE ───

    onLoad(): void {
        this._applyFont();
        // Re-apply on language change (supports runtime switching, e.g. debug shortcuts)
        EventBus.instance.on(GameEvents.LANGUAGE_CHANGED, this._applyFont, this);
    }

    onDestroy(): void {
        EventBus.instance.off(GameEvents.LANGUAGE_CHANGED, this._applyFont, this);
    }

    // ─── CORE LOGIC ───

    private _applyFont(): void {
        const lang = LocalizationManager.instance.currentLanguage;
        const fontMgr = FontManager.instance;

        // Determine font
        let font: TTFFont | null = null;
        if (this.overrideFont) {
            font = this.overrideFont;
        } else if (fontMgr) {
            font = fontMgr.getFontForLanguage(lang);
        } else {
            Log.w('[LocaleFont] FontManager not found — using existing font on component.');
        }

        // Determine cache mode
        let cacheMode: number = 2; // CHAR
        if (this.useOverrideCacheMode) {
            cacheMode = this.overrideCacheMode;
        } else if (fontMgr) {
            cacheMode = fontMgr.getCacheModeForLanguage(lang);
        }

        // Apply to Label
        const label = this.getComponent(Label);
        if (label) {
            if (font) {
                label.font = font;
                label.useSystemFont = false;
            }
            // CHAR + Overflow.SHRINK không được Cocos hỗ trợ — mix glyph size sau fullscreen.
            label.cacheMode = fontMgr
                ? fontMgr.resolveCacheModeForLabel(lang, label.overflow, cacheMode)
                : (label.overflow === Label.Overflow.SHRINK ? 0 : (cacheMode === 2 ? 1 : cacheMode));
        }

        // Apply to RichText (no cacheMode support)
        const richText = this.getComponent(RichText);
        if (richText && font) {
            richText.font = font;
            richText.useSystemFont = false;
        }
    }
}
