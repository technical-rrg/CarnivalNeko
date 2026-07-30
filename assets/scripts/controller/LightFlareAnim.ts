import { _decorator, Component, Node, tween, Vec3 } from 'cc';

const { ccclass, property } = _decorator;

/**
 * LightFlareAnim
 * Gắn script này vào node hình ánh sáng lóe (light flare).
 * Tự động xoay nhẹ và zoom in/out liên tục.
 */
@ccclass('LightFlareAnim')
export class LightFlareAnim extends Component {

    @property({ tooltip: 'Tốc độ xoay (độ/giây). Dương = chiều kim đồng hồ.' })
    rotateSpeed: number = 20;

    @property({ tooltip: 'Scale nhỏ nhất khi zoom out.' })
    scaleMin: number = 0.92;

    @property({ tooltip: 'Scale lớn nhất khi zoom in.' })
    scaleMax: number = 1.08;

    @property({ tooltip: 'Thời gian (giây) cho một chu kỳ zoom in → zoom out.' })
    scaleDuration: number = 1.2;

    private _rotateTween: any = null;
    private _scaleTween: any = null;

    onEnable(): void {
        this._startRotate();
        this._startScale();
    }

    onDisable(): void {
        if (this._rotateTween) {
            this._rotateTween.stop();
            this._rotateTween = null;
        }
        if (this._scaleTween) {
            this._scaleTween.stop();
            this._scaleTween = null;
        }
    }

    private _startRotate(): void {
        // Xoay liên tục bằng cách cộng dồn góc mỗi frame
        const degreesPerSecond = this.rotateSpeed;
        const self = this;
        // Dùng tween xoay 360° rồi lặp lại
        const duration = Math.abs(360 / degreesPerSecond);
        const startAngle = this.node.angle;

        this._rotateTween = tween(this.node)
            .by(duration, { angle: -360 }, { easing: 'linear' })
            .repeatForever()
            .start();
    }

    private _startScale(): void {
        const half = this.scaleDuration / 2;
        const minScale = new Vec3(this.scaleMin, this.scaleMin, 1);
        const maxScale = new Vec3(this.scaleMax, this.scaleMax, 1);

        this._scaleTween = tween(this.node)
            .to(half, { scale: minScale }, { easing: 'sineInOut' })
            .to(half, { scale: maxScale }, { easing: 'sineInOut' })
            .repeatForever()
            .start();
    }
}
