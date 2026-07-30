import { _decorator, Component, view } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('ResponsiveScale')
export class ResponsiveScale extends Component {

    /** Chiều rộng thiết kế gốc — 1920 tương đương scale = 1.
     *  Có thể đổi trong Editor nếu cần. */
    @property({ tooltip: 'Chiều rộng thiết kế gốc (scale=1). Mặc định 1920.' })
    designWidth: number = 1920;

    protected onLoad() {
        // Scale ngay khi load
        this._updateScale();

        // Lắng nghe resize — callback nhận (width, height) nhưng ta dùng view.getVisibleSize()
        view.setResizeCallback(() => this._updateScale());
    }

    protected onDestroy() {
        // Xoá resize callback để tránh leak khi node bị destroy
        view.setResizeCallback(null!);
    }

    private _updateScale() {
        const visibleWidth = view.getVisibleSize().width;

        // scaleRatio = 1 khi visibleWidth == designWidth (1920)
        const scaleRatio = visibleWidth / this.designWidth;

        this.node.setScale(scaleRatio, scaleRatio, 1);
    }
}