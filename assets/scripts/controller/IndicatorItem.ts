import { _decorator, Component, Sprite, SpriteFrame, Label, Color, Tween, Vec3, tween } from 'cc';

const { ccclass, property } = _decorator;

@ccclass('IndicatorItem')
export class IndicatorItem extends Component {

    @property({ type: Sprite, tooltip: 'Sprite nền của ô indicator' })
    bgSprite: Sprite | null = null;

    @property({ type: SpriteFrame, tooltip: 'SpriteFrame nền lúc tắt (idle)' })
    idleFrame: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: 'SpriteFrame nền lúc trúng thưởng (highlight) - Base Game' })
    highlightFrame: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: 'SpriteFrame nền lúc trúng thưởng (highlight) - Feature/Free Bonus Game' })
    highlightFrameFeature: SpriteFrame | null = null;

    @property({ type: Label, tooltip: 'Label hiển thị số đường thắng' })
    numberLabel: Label | null = null;

    @property({ type: Color, tooltip: 'Màu chữ lúc tắt (xám)' })
    idleColor: Color = new Color(150, 150, 150, 255);

    @property({ type: Color, tooltip: 'Màu chữ lúc trúng thưởng (vàng)' })
    highlightColor: Color = new Color(255, 215, 0, 255);

    /** Trạng thái mode game hiện tại: true = Feature/Free Bonus, false = Base Game */
    private _isFeatureGameMode: boolean = false;

    setHighlight(isHighlight: boolean): void {
        if (isHighlight) {
            // Chọn frame phù hợp với mode game hiện tại
            const frameToUse = this._isFeatureGameMode ? this.highlightFrameFeature : this.highlightFrame;
            
            if (this.bgSprite && frameToUse) {
                this.bgSprite.spriteFrame = frameToUse;
            }
            if (this.numberLabel) {
                this.numberLabel.color = this.highlightColor;
            }
            Tween.stopAllByTarget(this.node);
            // tween(this.node)
            //     .to(0.1, { scale: new Vec3(1.2, 1.2, 1) }, { easing: 'quadOut' })
            //     .to(0.15, { scale: new Vec3(1.0, 1.0, 1) }, { easing: 'elasticOut' })
            //     .start();
        } else {
            Tween.stopAllByTarget(this.node);
            this.node.setScale(1, 1, 1);
            if (this.bgSprite && this.idleFrame) {
                this.bgSprite.spriteFrame = this.idleFrame;
            }
            if (this.numberLabel) {
                this.numberLabel.color = this.idleColor;
            }
        }
    }

    /** Đặt mode game để chọn frame highlight phù hợp */
    public setFeatureGameMode(isFeature: boolean): void {
        this._isFeatureGameMode = isFeature;
    }
}
