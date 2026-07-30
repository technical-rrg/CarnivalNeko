import { _decorator, Component, Widget, screen, UITransform, RichText } from 'cc';
import { EDITOR } from 'cc/env';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

/**
 * Dữ liệu layout HOÀN CHỈNH cho một hướng màn hình.
 * Widget luôn được cấu hình để đảm bảo tọa độ chính xác trên mọi kích thước màn hình.
 */
@ccclass('OrientationLayoutData')
class OrientationLayoutData {

    // ── POSITION ─────────────────────────────────────────────────────────────
    @property({ tooltip: 'Vị trí X' })
    posX: number = 0;

    @property({ tooltip: 'Vị trí Y' })
    posY: number = 0;

    // ── ANCHOR ────────────────────────────────────────────────────────────────
    @property({ tooltip: 'Anchor X (0 – 1)', slide: true, range: [0, 1, 0.01] })
    anchorX: number = 0.5;

    @property({ tooltip: 'Anchor Y (0 – 1)', slide: true, range: [0, 1, 0.01] })
    anchorY: number = 0.5;

    // ── SIZE ──────────────────────────────────────────────────────────────────
    @property({ tooltip: 'Chiều rộng (width)' })
    width: number = 100;

    @property({ tooltip: 'Chiều cao (height)' })
    height: number = 100;

    // ── SCALE ─────────────────────────────────────────────────────────────────
    @property({ tooltip: 'Scale X' })
    scaleX: number = 1;

    @property({ tooltip: 'Scale Y' })
    scaleY: number = 1;

    @property({ tooltip: 'Scale Z' })
    scaleZ: number = 1;

    // ── ROTATION ──────────────────────────────────────────────────────────────
    @property({ tooltip: 'Rotation X (độ)' })
    rotationX: number = 0;

    @property({ tooltip: 'Rotation Y (độ)' })
    rotationY: number = 0;

    @property({ tooltip: 'Rotation Z (độ)' })
    rotationZ: number = 0;

    // ── WIDGET ────────────────────────────────────────────────────────────────
    @property({ tooltip: 'Căn cạnh trái' })
    isAlignLeft: boolean = false;

    @property({ tooltip: 'Khoảng cách cạnh trái (px)' })
    left: number = 0;

    @property({ tooltip: 'Căn cạnh phải' })
    isAlignRight: boolean = false;

    @property({ tooltip: 'Khoảng cách cạnh phải (px)' })
    right: number = 0;

    @property({ tooltip: 'Căn cạnh trên' })
    isAlignTop: boolean = false;

    @property({ tooltip: 'Khoảng cách cạnh trên (px)' })
    top: number = 0;

    @property({ tooltip: 'Căn cạnh dưới' })
    isAlignBottom: boolean = false;

    @property({ tooltip: 'Khoảng cách cạnh dưới (px)' })
    bottom: number = 0;

    @property({ tooltip: 'Căn giữa theo chiều ngang' })
    isAlignHorizontalCenter: boolean = false;

    @property({ tooltip: 'Offset căn giữa ngang (px)' })
    horizontalCenter: number = 0;

    @property({ tooltip: 'Căn giữa theo chiều dọc' })
    isAlignVerticalCenter: boolean = false;

    @property({ tooltip: 'Offset căn giữa dọc (px)' })
    verticalCenter: number = 0;
    // ── RICHTEXT (Ô) ──────────────────────────────────────────────────────
    @property({ tooltip: 'maxWidth của RichText component (nếu có).\nBỏ trống = không đổi.' })
    richTextMaxWidth: number = 0;}

/**
 * ## OrientationLayout
 *
 * Gắn component này vào node để cấu hình layout **hoàn toàn khác nhau**
 * cho màn hình **ngang (landscape)** và **dọc (portrait)**.
 *
 * Mỗi hướng lưu một bộ layout đầy đủ gồm:
 * **anchor + size + Widget alignment**.
 *
 * Widget **luôn được bật** và cấu hình lại khi chuyển hướng,
 * đảm bảo tọa độ chính xác trên mọi kích thước màn hình.
 *
 * ### Cách dùng
 * 1. Thêm component vào node cần responsive.
 * 2. Điền thông số cho **Landscape** và **Portrait**,
 *    hoặc dùng nút **Capture** trong Inspector để gán nhanh từ trạng thái hiện tại.
 * 3. Chạy game – layout tự động cập nhật khi xoay / resize.
 */
@ccclass('OrientationLayout')
export class OrientationLayout extends Component {

    @property({ type: OrientationLayoutData, tooltip: 'Cấu hình khi màn hình NGANG (landscape)' })
    landscape: OrientationLayoutData = new OrientationLayoutData();

    @property({ type: OrientationLayoutData, tooltip: 'Cấu hình khi màn hình DỌC (portrait)' })
    portrait: OrientationLayoutData = new OrientationLayoutData();

    private _lastApplyKey: string = '';

    /** Copy landscape/portrait từ layout khác rồi apply theo orientation hiện tại. */
    copyFrom(other: OrientationLayout): void {
        if (!other) return;
        this._copyData(other.landscape, this.landscape);
        this._copyData(other.portrait, this.portrait);
        this._lastApplyKey = '';
        this._applyOrientation();
    }

    private _copyData(from: OrientationLayoutData, to: OrientationLayoutData): void {
        to.posX = from.posX;
        to.posY = from.posY;
        to.anchorX = from.anchorX;
        to.anchorY = from.anchorY;
        to.width = from.width;
        to.height = from.height;
        to.scaleX = from.scaleX;
        to.scaleY = from.scaleY;
        to.scaleZ = from.scaleZ;
        to.rotationX = from.rotationX;
        to.rotationY = from.rotationY;
        to.rotationZ = from.rotationZ;
        to.isAlignLeft = from.isAlignLeft;
        to.left = from.left;
        to.isAlignRight = from.isAlignRight;
        to.right = from.right;
        to.isAlignTop = from.isAlignTop;
        to.top = from.top;
        to.isAlignBottom = from.isAlignBottom;
        to.bottom = from.bottom;
        to.isAlignHorizontalCenter = from.isAlignHorizontalCenter;
        to.horizontalCenter = from.horizontalCenter;
        to.isAlignVerticalCenter = from.isAlignVerticalCenter;
        to.verticalCenter = from.verticalCenter;
        to.richTextMaxWidth = from.richTextMaxWidth;
    }

    // ── Editor Capture Buttons ────────────────────────────────────────────────

    @property({
        tooltip: 'Nhấn để gán thông số node hiện tại (anchor / size / widget) → Landscape',
        displayName: '[Editor] Capture Node → Landscape',
    })
    get captureToLandscape(): boolean { return false; }
    set captureToLandscape(v: boolean) {
        if (EDITOR && v) {
            this._captureToData(this.landscape);
            Log.d('[OrientationLayout] Captured node state → Landscape');
        }
    }

    @property({
        tooltip: 'Nhấn để áp dụng dữ liệu Landscape → node hiện tại',
        displayName: '[Editor] Apply Landscape → Node',
    })
    get applyLandscapeToNode(): boolean { return false; }
    set applyLandscapeToNode(v: boolean) {
        if (EDITOR && v) {
            this._applyData(this.landscape);
            Log.d('[OrientationLayout] Applied Landscape data → Node');
        }
    }

    @property({
        tooltip: 'Nhấn để gán thông số node hiện tại (anchor / size / widget) → Portrait',
        displayName: '[Editor] Capture Node → Portrait',
    })
    get captureToPortrait(): boolean { return false; }
    set captureToPortrait(v: boolean) {
        if (EDITOR && v) {
            this._captureToData(this.portrait);
            Log.d('[OrientationLayout] Captured node state → Portrait');
        }
    }

    @property({
        tooltip: 'Nhấn để áp dụng dữ liệu Portrait → node hiện tại',
        displayName: '[Editor] Apply Portrait → Node',
    })
    get applyPortraitToNode(): boolean { return false; }
    set applyPortraitToNode(v: boolean) {
        if (EDITOR && v) {
            this._applyData(this.portrait);
            Log.d('[OrientationLayout] Applied Portrait data → Node');
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    onLoad(): void {
        screen.on('window-resize', this._onScreenChange, this);
        screen.on('orientation-change', this._onScreenChange, this);
        this._applyOrientation();
    }

    start(): void {
        this.scheduleOnce(this._applyOrientation, 0);
    }

    onDestroy(): void {
        screen.off('window-resize', this._onScreenChange, this);
        screen.off('orientation-change', this._onScreenChange, this);
        this.unschedule(this._applyOrientation);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    public applyOrientation(): void {
        this._lastApplyKey = '';
        this._applyOrientation();
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private _onScreenChange(): void {
        this.unschedule(this._applyOrientation);
        this.scheduleOnce(this._applyOrientation, 0);
    }

    private _isRemainDebugTarget(): boolean {
        // Chỉ Remain dưới TopUpUI — tránh spam sibling.
        return this.node.name === 'Remain' && this.node.parent?.name === 'TopUpUI';
    }

    private _applyOrientation(): void {
        const size = screen.windowSize;
        const isPortrait = size.height > size.width;
        const applyKey = `${isPortrait ? 'p' : 'l'}:${size.width}x${size.height}`;
        if (applyKey === this._lastApplyKey) return;
        this._lastApplyKey = applyKey;
        const data = isPortrait ? this.portrait : this.landscape;
        this._applyData(data);
    }

    private _applyData(data: OrientationLayoutData): void {
        const debug = this._isRemainDebugTarget();

        // 1. Position
        this.node.setPosition(data.posX, data.posY, this.node.position.z);

        // 2. Scale
        this.node.setScale(data.scaleX, data.scaleY, data.scaleZ);

        // 3. Rotation
        this.node.setRotationFromEuler(data.rotationX, data.rotationY, data.rotationZ);

        // 4. Anchor + Size
        const uiTransform = this.node.getComponent(UITransform);
        if (uiTransform) {
            uiTransform.setAnchorPoint(data.anchorX, data.anchorY);
            uiTransform.setContentSize(data.width, data.height);
        }

        // 5. Widget – luôn được cấu hình
        let widget = this.node.getComponent(Widget);
        if (!widget) {
            widget = this.node.addComponent(Widget);
        }
        if (!widget) return;

        widget.isAlignLeft              = data.isAlignLeft;
        widget.left                     = data.left;
        widget.isAlignRight             = data.isAlignRight;
        widget.right                    = data.right;
        widget.isAlignTop               = data.isAlignTop;
        widget.top                      = data.top;
        widget.isAlignBottom            = data.isAlignBottom;
        widget.bottom                   = data.bottom;
        widget.isAlignHorizontalCenter  = data.isAlignHorizontalCenter;
        widget.horizontalCenter         = data.horizontalCenter;
        widget.isAlignVerticalCenter    = data.isAlignVerticalCenter;
        widget.verticalCenter           = data.verticalCenter;
        widget.enabled = true;

        const beforeAlignWorldY = this.node.worldPosition.y;
        widget.updateAlignment();
        if (debug) {
            const deltaWorldY = this.node.worldPosition.y - beforeAlignWorldY;
            if (Math.abs(deltaWorldY) > 0.5) {
                Log.e(
                    `[REMAIN-POS] Widget kéo Remain ΔworldY=${deltaWorldY.toFixed(1)} ` +
                    `localY=${this.node.position.y.toFixed(1)} worldY=${this.node.worldPosition.y.toFixed(1)} ` +
                    `Widget(T=${widget.isAlignTop}/${widget.top.toFixed(0)},VC=${widget.isAlignVerticalCenter}/${widget.verticalCenter.toFixed(0)})`
                );
            }
        }

        // 6. RichText maxWidth (nếu có)
        if (data.richTextMaxWidth > 0) {
            const richText = this.node.getComponent(RichText);
            if (richText) {
                richText.maxWidth = data.richTextMaxWidth;
            }
        }
    }

    private _captureToData(data: OrientationLayoutData): void {
        const uiTransform = this.node.getComponent(UITransform);
        const widget = this.node.getComponent(Widget);

        // Position
        data.posX = this.node.position.x;
        data.posY = this.node.position.y;

        // Scale
        data.scaleX = this.node.scale.x;
        data.scaleY = this.node.scale.y;
        data.scaleZ = this.node.scale.z;

        // Rotation (X, Y, Z trong độ)
        const euler = this.node.eulerAngles;
        data.rotationX = euler.x;
        data.rotationY = euler.y;
        data.rotationZ = euler.z;

        // Anchor + Size
        if (uiTransform) {
            data.anchorX = uiTransform.anchorX;
            data.anchorY = uiTransform.anchorY;
            data.width   = uiTransform.width;
            data.height  = uiTransform.height;
        }

        // Widget
        if (widget) {
            data.isAlignLeft             = widget.isAlignLeft;
            data.left                    = widget.left;
            data.isAlignRight            = widget.isAlignRight;
            data.right                   = widget.right;
            data.isAlignTop              = widget.isAlignTop;
            data.top                     = widget.top;
            data.isAlignBottom           = widget.isAlignBottom;
            data.bottom                  = widget.bottom;
            data.isAlignHorizontalCenter = widget.isAlignHorizontalCenter;
            data.horizontalCenter        = widget.horizontalCenter;
            data.isAlignVerticalCenter   = widget.isAlignVerticalCenter;
            data.verticalCenter          = widget.verticalCenter;
        }

        // RichText maxWidth
        const richText = this.node.getComponent(RichText);
        if (richText) {
            data.richTextMaxWidth = richText.maxWidth;
        } else {
            data.richTextMaxWidth = 0;
        }
    }
}
