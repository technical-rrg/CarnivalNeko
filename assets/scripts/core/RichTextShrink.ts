/**
 * RichTextShrink – Tự động thu nhỏ fontSize của RichText cho vừa khung (Width × Height).
 *
 * ── SETUP ──
 *   1. Gắn component này vào node đã có RichText.
 *   2. Điền containerWidth / containerHeight trong Inspector.
 *      Để 0 = tự lấy từ UITransform.contentSize lúc onLoad (chỉ đáng tin khi node có kích thước cố định).
 *
 * ── THUẬT TOÁN ──
 *   1. allowWrap=true: set richText.maxWidth = containerWidth → tự xuống dòng khi vượt ngang.
 *      allowWrap=false: maxWidth=0, 1 dòng, chỉ thu nhỏ font cho vừa width.
 *   2. Binary search fontSize trong [minFontSize, maxFontSize]:
 *      - Mỗi bước scale lineHeight theo tỉ lệ (luôn lineHeight ≥ fontSize để không overlap).
 *      - Chờ 2 frame sau mỗi lần đổi fontSize để RichText layout xong.
 *      - Đọc contentSize.height để quyết định giảm hay tăng.
 *   3. Tìm fontSize lớn nhất mà: contentSize.width ≤ bounds.width AND contentSize.height ≤ bounds.height
 *      AND numLines ≤ maxLines (nếu maxLines > 0).
 *
 * ── CÁCH ĐẾM DÒNG ──
 *   RichText không expose lineCount trực tiếp.
 *   Ước tính: numLines = round(contentSize.height / lineHeight).
 *   Cách này chính xác khi lineHeight đồng nhất (không dùng inline size override trong tag).
 */

import { _decorator, Component, RichText, UITransform, Size } from 'cc';
import { EventBus } from './EventBus';
import { GameEvents } from './GameEvents';
import { Log } from './Logger';

const { ccclass, property } = _decorator;

@ccclass('RichTextShrink')
export class RichTextShrink extends Component {

    @property({
        tooltip: 'Font size tối đa (= thiết kế ban đầu). Để 0 = tự đọc từ RichText.fontSize.',
    })
    public maxFontSize: number = 0;

    @property({ tooltip: 'Font size nhỏ nhất cho phép thu nhỏ' })
    public minFontSize: number = 10;

    @property({
        tooltip: 'Chiều rộng khung giới hạn (px). Để 0 = lấy từ UITransform.contentSize.width lúc onLoad.',
    })
    public containerWidth: number = 0;

    @property({
        tooltip: 'Chiều cao khung giới hạn (px). Để 0 = lấy từ UITransform.contentSize.height lúc onLoad.',
    })
    public containerHeight: number = 0;

    @property({
        tooltip: 'Số dòng tối đa cho phép. Nếu text vượt quá số dòng này, fontSize sẽ tự giảm. Để 0 = không giới hạn.',
    })
    public maxLines: number = 0;

    @property({
        tooltip: 'true = set maxWidth và cho phép xuống dòng. false = 1 dòng, chỉ thu nhỏ font cho vừa width.',
    })
    public allowWrap: boolean = true;

    private _richText: RichText | null = null;
    private _uiTransform: UITransform | null = null;
    private _bounds: Size = new Size(0, 0);
    private _maxFs: number = 40;
    /** lineHeight / fontSize gốc (tỉ lệ khoảng cách dòng). Mặc định 1.0 nếu editor set sai. */
    private _lineHeightRatio: number = 1.0;
    private _lo: number = 10;
    private _hi: number = 40;

    onLoad() {
        this._richText = this.getComponent(RichText);
        this._uiTransform = this.getComponent(UITransform);

        if (!this._richText || !this._uiTransform) {
            Log.w('[RichTextShrink] Không tìm thấy RichText hoặc UITransform trên node.');
            return;
        }

        this._maxFs = this.maxFontSize > 0 ? this.maxFontSize : this._richText.fontSize;

        // Tính tỉ lệ lineHeight / fontSize để giữ nguyên khoảng cách dòng khi scale.
        // Nếu editor set lineHeight < fontSize (không hợp lệ), dùng tỉ lệ 1.0 (lineHeight = fontSize).
        const editorFs = this._richText.fontSize > 0 ? this._richText.fontSize : this._maxFs;
        const editorLh = this._richText.lineHeight;
        this._lineHeightRatio = editorLh >= editorFs ? editorLh / editorFs : 1.0;

        const w = this.containerWidth > 0 ? this.containerWidth : this._uiTransform.contentSize.width;
        const h = this.containerHeight > 0 ? this.containerHeight : this._uiTransform.contentSize.height;
        this._bounds = new Size(w, h);

        EventBus.instance.on(GameEvents.LANGUAGE_CHANGED, this.startShrink, this);
    }

    start() {
        this.startShrink();
    }

    onDestroy() {
        EventBus.instance.off(GameEvents.LANGUAGE_CHANGED, this.startShrink, this);
    }

    /**
     * Khởi động lại quá trình shrink.
     * Gọi thủ công khi nội dung RichText thay đổi từ bên ngoài.
     */
    public startShrink() {
        if (!this._richText || !this._uiTransform) return;

        this.unschedule(this._evalStep);

        if (this.maxFontSize > 0) this._maxFs = this.maxFontSize;

        const w = this.containerWidth > 0 ? this.containerWidth : this._uiTransform.contentSize.width;
        const h = this.containerHeight > 0 ? this.containerHeight : this._uiTransform.contentSize.height;
        this._bounds = new Size(w, h);

        // allowWrap: giới hạn ngang → text tự xuống dòng. Tắt = 1 dòng, chỉ shrink font.
        this._richText.maxWidth = this.allowWrap && this._bounds.width > 0 ? this._bounds.width : 0;

        this._lo = this.minFontSize;
        this._hi = this._maxFs;

        this._applyFontSize(this._maxFs);
        this._waitFrames(this._evalStep);
    }

    // ── Binary search: tìm fontSize lớn nhất vừa khung (cả width lẫn height) ──

    private _evalStep = () => {
        if (!this._richText || !this._uiTransform) return;

        const current = this._richText.fontSize;

        if (this._fitsContainer()) {
            // current vừa khung → lưu lại, thử lớn hơn
            this._lo = current;
        } else {
            // current tràn (width hoặc height) → phải nhỏ hơn
            this._hi = current - 1;
        }

        if (this._lo >= this._hi) {
            // Hội tụ. _lo = fontSize lớn nhất đã verify vừa khung.
            if (current !== this._lo) {
                // Cần set lại font về giá trị đã verify, sau đó dừng.
                this._applyFontSize(this._lo);
            }
            return;
        }

        // ceil((lo + hi) / 2) — tránh infinite loop khi hi = lo + 1
        this._applyFontSize(Math.floor((this._lo + this._hi + 1) / 2));
        this._waitFrames(this._evalStep);
    };

    /**
     * Set fontSize và scale lineHeight theo tỉ lệ gốc.
     *
     * lineHeight luôn ≥ fontSize để các dòng không chồng lên nhau khi text xuống dòng.
     *
     * Ví dụ: editorFontSize=60, editorLineHeight=72 → ratio=1.2
     *   fontSize=40 → lineHeight=48 (giữ 1.2× spacing)
     *   fontSize=40, containerHeight=100 → 2 dòng = 96 ≤ 100 ✓
     */
    private _applyFontSize(fs: number) {
        if (!this._richText) return;
        this._richText.fontSize = fs;
        const lh = Math.max(Math.round(fs * this._lineHeightRatio), fs);
        this._richText.lineHeight = lh;
    }

    /**
     * Chờ 1 frame rồi gọi callback.
     *
     * RichText._updateRichText() chạy synchronously khi set fontSize/lineHeight/maxWidth.
     * UITransform.contentSize được cập nhật ngay trong cùng call đó.
     * scheduleOnce(fn, 0) fire vào cuối frame hiện tại — sau khi mọi component
     * đã chạy update() — nên contentSize đã chính xác khi evalStep đọc.
     */
    private _waitFrames(cb: () => void) {
        this.scheduleOnce(cb, 0);
    }

    /**
     * Đọc content height thực tế từ RichText internal property.
     *
     * UITransform.contentSize được RichText set thành (_labelWidth, _labelHeight).
     * _labelHeight = (lineCount + BASELINE_RATIO) * lineHeight  (BASELINE_RATIO ≈ 0.26)
     *
     * Để binary search hoạt động chính xác với containerHeight,
     * ta đọc trực tiếp _labelHeight thay vì UITransform để tránh stale value.
     * Fallback về UITransform nếu internal property không tồn tại.
     */
    private _getContentSize(): { width: number; height: number } {
        const rt = this._richText as any;
        if (typeof rt._labelWidth === 'number' && typeof rt._labelHeight === 'number') {
            return { width: rt._labelWidth, height: rt._labelHeight };
        }
        const s = this._uiTransform!.contentSize;
        return { width: s.width, height: s.height };
    }

    /**
     * Kiểm tra content hiện tại có nằm trong _bounds không.
     */
    private _fitsContainer(): boolean {
        const s = this._getContentSize();
        const wOk = this._bounds.width <= 0 || s.width <= this._bounds.width + 0.5;
        const hOk = this._bounds.height <= 0 || s.height <= this._bounds.height + 0.5;

        // Kiểm tra số dòng: ước tính từ _labelHeight / lineHeight.
        let linesOk = true;
        if (this.maxLines > 0 && this._richText) {
            const lh = this._richText.lineHeight;
            if (lh > 0) {
                const numLines = Math.round(s.height / lh);
                linesOk = numLines <= this.maxLines;
            }
        }

        return wOk && hOk && linesOk;
    }
}

