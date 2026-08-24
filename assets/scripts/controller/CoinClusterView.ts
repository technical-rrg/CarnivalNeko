/**
 * CoinClusterView — chùm sprite đồng xu bay theo Fx_Coin_Trail.
 * Gắn trên node CoinCluster (child của Fx_Coin_Trail), các Coin_* là child sprite.
 */
import {
    _decorator, Component, Node, Sprite, SpriteFrame, tween, Tween, Vec3,
} from 'cc';

const { ccclass, property } = _decorator;

export interface CoinClusterSetupOptions {
    spread?: number;
    coinScale?: number;
    rotateSpeedMin?: number;
    rotateSpeedMax?: number;
    randomizeLayout?: boolean;
    maxCount?: number;
}

@ccclass('CoinClusterView')
export class CoinClusterView extends Component {

    @property({ tooltip: 'Bán kính random quanh tâm chùm (local px) — dùng khi randomizeLayout' })
    coinSpread = 36;

    @property({ tooltip: 'Scale mỗi đồng xu' })
    coinScale = 0.52;

    @property({ tooltip: 'Tốc độ xoay trục Y tối thiểu (deg/giây)' })
    rotateSpeedMin = 200;

    @property({ tooltip: 'Tốc độ xoay trục Y tối đa (deg/giây)' })
    rotateSpeedMax = 480;

    private _spinning = false;

    /** Gán frame màu trail + bố cục chùm + bắt đầu xoay Y. */
    setup(frame: SpriteFrame | null, options?: CoinClusterSetupOptions): void {
        this.stop();
        if (!frame?.isValid) return;

        const spread = options?.spread ?? this.coinSpread;
        const baseScale = options?.coinScale ?? this.coinScale;
        const speedMin = Math.max(30, options?.rotateSpeedMin ?? this.rotateSpeedMin);
        const speedMax = Math.max(speedMin, options?.rotateSpeedMax ?? this.rotateSpeedMax);
        const randomize = options?.randomizeLayout ?? true;
        const maxCount = options?.maxCount ?? 0;

        const coins = this._coinNodes();
        for (let i = 0; i < coins.length; i++) {
            const coin = coins[i];
            if (!coin?.isValid) continue;
            if (maxCount > 0 && i >= maxCount) {
                coin.active = false;
                continue;
            }
            coin.active = true;

            const sprite = coin.getComponent(Sprite);
            if (sprite) sprite.spriteFrame = frame;

            if (randomize) {
                const angle = Math.random() * Math.PI * 2;
                const radius = Math.max(8, spread) * (0.25 + Math.random() * 0.75);
                coin.setPosition(
                    Math.cos(angle) * radius,
                    Math.sin(angle) * radius * 0.85,
                    (Math.random() - 0.5) * 6,
                );
            }

            const s = baseScale * (0.82 + Math.random() * 0.28);
            coin.setScale(s, s, s);
            coin.setRotationFromEuler(0, Math.random() * 360, 0);

            const degPerSec = speedMin + Math.random() * (speedMax - speedMin);
            tween(coin)
                .by(360 / degPerSec, { eulerAngles: new Vec3(0, 360, 0) })
                .union()
                .repeatForever()
                .start();
        }

        this._spinning = true;
        this.node.active = true;
    }

    stop(): void {
        if (!this._spinning && !this.node?.isValid) return;
        this._spinning = false;
        Tween.stopAllByTarget(this.node);
        for (const coin of this._coinNodes()) {
            if (coin?.isValid) Tween.stopAllByTarget(coin);
        }
    }

    onDestroy(): void {
        this.stop();
    }

    private _coinNodes(): Node[] {
        if (!this.node?.isValid) return [];
        return this.node.children.filter(c => c.name.startsWith('Coin'));
    }
}
