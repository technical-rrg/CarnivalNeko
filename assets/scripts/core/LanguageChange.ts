import { _decorator, Component, Label, RichText, TTFFont } from 'cc';
import { L, LocalizationManager } from './LocalizationManager';
import { FontManager } from '../manager/FontManager';
import { EventBus } from './EventBus';
import { GameEvents } from './GameEvents';

const { ccclass, property } = _decorator;

@ccclass('LanguageChange')
export class LanguageChange extends Component {

    @property({ tooltip: 'Key dung de tra cuu text ngon ngu' })
    public translationKey: string = '';

    @property({ tooltip: 'Bat de tu dong thay doi text theo key locale khi doi ngon ngu. Mac dinh = true.' })
    public enableTextChange: boolean = true;

    @property({ tooltip: 'Bat de tu dong doi font theo ngon ngu (tich hop chuc nang LocaleFont)' })
    public enableFontChange: boolean = false;

    @property({
        type: TTFFont,
        tooltip: 'Override font — luon dung font nay bat ke ngon ngu. De trong = tu dong theo FontManager.',
        visible(this: LanguageChange) { return this.enableFontChange; },
    })
    public overrideFont: TTFFont | null = null;

    @property({
        tooltip: 'Bat de dung cacheMode tuy chon thay vi tu dong.',
        visible(this: LanguageChange) { return this.enableFontChange; },
    })
    public useOverrideCacheMode: boolean = false;

    @property({
        tooltip: 'Cache mode (0=NONE, 1=BITMAP, 2=CHAR). Chi co tac dung khi useOverrideCacheMode = true.',
        visible(this: LanguageChange) { return this.enableFontChange && this.useOverrideCacheMode; },
    })
    public overrideCacheMode: number = 2;

    private _label: Label | null = null;
    private _richText: RichText | null = null;

    onLoad() {
        this._label = this.getComponent(Label);
        this._richText = this.getComponent(RichText);
        this._update();
        EventBus.instance.on(GameEvents.LANGUAGE_CHANGED, this._update, this);
    }

    onDestroy() {
        EventBus.instance.off(GameEvents.LANGUAGE_CHANGED, this._update, this);
    }

    private _update() {
        if (this.enableTextChange) {
            this._applyText();
        }
        if (this.enableFontChange) {
            this._applyFont();
        }
    }

    private _applyText() {
        if (!this.translationKey) return;
        const text = L(this.translationKey);
        if (this._label) {
            this._label.string = text;
        } else if (this._richText) {
            this._richText.string = text;
        }
    }

    private _applyFont() {
        const lang = LocalizationManager.instance.currentLanguage;
        const fontMgr = FontManager.instance;

        let font: TTFFont | null = null;
        if (this.overrideFont) {
            font = this.overrideFont;
        } else if (fontMgr) {
            font = fontMgr.getFontForLanguage(lang);
        }

        // Nếu không có font (FontManager chưa sẵn sàng) → bỏ qua hoàn toàn.
        // Không được set cacheMode mà không có font vì sẽ khởi tạo char atlas với
        // system font (useSystemFont vẫn = true từ prefab), gây lỗi font hệ thống
        // không thể khôi phục trong super-html build.
        // Component sẽ được gọi lại qua LANGUAGE_CHANGED khi FontManager sẵn sàng.
        if (!font) return;

        const cacheMode: number = this.useOverrideCacheMode
            ? this.overrideCacheMode
            : (fontMgr ? fontMgr.getCacheModeForLanguage(lang) : 2);

        if (this._label) {
            this._label.font = font;
            this._label.useSystemFont = false;
            this._label.cacheMode = cacheMode;
        }
        if (this._richText) {
            this._richText.font = font;
            this._richText.useSystemFont = false;
        }
    }
}
