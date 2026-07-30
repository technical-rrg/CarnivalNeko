/**
 * FeatureEntryGuideEffect — Hiệu ứng nữ thần "dẫn dắt" vào Feature.
 *
 * characterSpine: In (xuất hiện) → Loop (chờ, loop) → OUT (biến mất).
 *
 * Prefab lazy (FeatureEntryGuide.prefab) — FeatureEntryGuideLoader gọi playGuide()
 * sau FEATURE_ENTRY_GUIDE_SHOW; effect emit FEATURE_ENTRY_GUIDE_DONE khi xong.
 */

import {
    _decorator, Component, Node, sp, tween, Tween, Vec3, UIOpacity, AudioClip,
} from 'cc';
import { EventBus }     from '../core/EventBus';
import { GameEvents }   from '../core/GameEvents';
import { Log }          from '../core/Logger';
import { SoundManager } from '../manager/SoundManager';

const { ccclass, property } = _decorator;

@ccclass('FeatureEntryGuideEffect')
export class FeatureEntryGuideEffect extends Component {

    @property({ type: Node, tooltip: 'Overlay tối (vignette) full màn hình — fade in khi Appear.' })
    dimNode: Node | null = null;

    @property({ type: Node, tooltip: 'Node nhân vật nữ thần (dùng khi KHÔNG có Spine).' })
    characterNode: Node | null = null;

    @property({ type: sp.Skeleton, tooltip: 'Spine nhân vật (ưu tiên hơn characterNode nếu có).' })
    characterSpine: sp.Skeleton | null = null;

    @property({ type: Node, tooltip: 'Node flash trắng full màn hình — light burst white-out khi Exit.' })
    whiteFlashNode: Node | null = null;

    @property({ type: AudioClip, tooltip: 'SFX khi nhân vật xuất hiện (optional).' })
    sfxAppear: AudioClip | null = null;

    @property({ tooltip: 'Spine: xuất hiện (one-shot).' })
    animAppear: string = 'In';
    @property({ tooltip: 'Spine: chờ / idle (loop).' })
    animIdle: string = 'Loop';
    @property({ tooltip: 'Spine: biến mất (one-shot).' })
    animExit: string = 'OUT';

    @property({ tooltip: 'Thời lượng phase Appear (dim + fallback node).' })
    appearDuration: number = 0.8;
    @property({ tooltip: 'Thời lượng giữ Loop sau khi In xong.' })
    holdDuration: number = 1.8;
    @property({ tooltip: 'Thời lượng white flash sau OUT.' })
    exitDuration: number = 0.4;

    private _playing: boolean = false;

    onLoad(): void {
        // Chỉ reset visual — KHÔNG tắt node / không đụng _playing.
        // Race cũ: playGuide() bật active → onLoad → _hideAll() tắt lại + kẹt _playing → treo game.
        this._resetVisuals();
    }

    onDestroy(): void {
        this._clearSpineListener();
        this.unscheduleAllCallbacks();
    }

    /** Gọi từ FeatureEntryGuideLoader sau khi prefab đã load. */
    playGuide(): void {
        // Recover nếu lần trước bị kẹt (_playing=true nhưng node inactive)
        if (this._playing && !this.node.active) {
            Log.w('[FeatureEntryGuide] recover stuck state before play');
            this._playing = false;
            this.unscheduleAllCallbacks();
            this._clearSpineListener();
        }
        this._play();
    }

    private _resetVisuals(): void {
        this._setOpacity(this.dimNode, 0);
        this._setOpacity(this.whiteFlashNode, 0);
        if (this.whiteFlashNode) this.whiteFlashNode.active = false;
        if (this.characterNode) this.characterNode.active = false;
        if (this.characterSpine) this.characterSpine.node.active = false;
    }

    private _hideAll(): void {
        this._clearSpineListener();
        this.unscheduleAllCallbacks();
        this._resetVisuals();
        this.node.active = false;
    }

    private _play(): void {
        if (this._playing) return;
        this._playing = true;
        this.unscheduleAllCallbacks();
        this._clearSpineListener();
        this.node.active = true;
        Log.d('[FeatureEntryGuide] play — node.active=true');

        SoundManager.instance?.playLuchHas();
        this._phaseAppear();
    }

    private _phaseAppear(): void {
        if (this.dimNode) {
            this.dimNode.active = true;
            this._setOpacity(this.dimNode, 0);
            const op = this.dimNode.getComponent(UIOpacity);
            if (op) tween(op).to(this.appearDuration * 0.6, { opacity: 200 }).start();
        }

        if (this.characterSpine) {
            this._playSpineSequence();
            return;
        }

        if (this.characterNode) {
            this.characterNode.active = true;
            this.characterNode.setScale(0.7, 0.7, 1);
            this._setOpacity(this.characterNode, 0);
            const cop = this.characterNode.getComponent(UIOpacity);
            if (cop) tween(cop).to(this.appearDuration, { opacity: 255 }).start();
            tween(this.characterNode)
                .to(this.appearDuration, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
                .repeatForever(
                    tween<Node>()
                        .to(this.holdDuration * 0.5, { scale: new Vec3(1.02, 1.02, 1) })
                        .to(this.holdDuration * 0.5, { scale: new Vec3(1, 1, 1) })
                )
                .start();
        }
        this.scheduleOnce(() => this._phaseExitFlash(), this.appearDuration + this.holdDuration);
    }

    /** In → Loop (holdDuration) → OUT → white flash */
    private _playSpineSequence(): void {
        const skel = this.characterSpine!;
        skel.node.active = true;
        this._clearSpineListener();

        skel.setAnimation(0, this.animAppear, false);
        skel.setCompleteListener((entry) => {
            if (!this._playing || !entry?.animation || entry.animation.name !== this.animAppear) return;
            this._clearSpineListener();
            skel.setAnimation(0, this.animIdle, true);
            this.scheduleOnce(() => this._playSpineOut(), this.holdDuration);
        });
    }

    private _playSpineOut(): void {
        if (!this._playing || !this.characterSpine) return;
        const skel = this.characterSpine;
        this._clearSpineListener();

        skel.setAnimation(0, this.animExit, false);
        skel.setCompleteListener((entry) => {
            if (!this._playing || !entry?.animation || entry.animation.name !== this.animExit) return;
            this._clearSpineListener();
            this._phaseExitFlash();
        });
    }

    private _phaseExitFlash(): void {
        if (this.characterNode) {
            Tween.stopAllByTarget(this.characterNode);
        }

        if (this.whiteFlashNode) {
            this.whiteFlashNode.active = true;
            this._setOpacity(this.whiteFlashNode, 0);
            const op = this.whiteFlashNode.getComponent(UIOpacity) ?? this.whiteFlashNode.addComponent(UIOpacity);
            tween(op)
                .to(this.exitDuration * 0.5, { opacity: 255 })
                .call(() => { this._finish(); })
                .to(this.exitDuration * 0.5, { opacity: 0 })
                .call(() => { this._hideAll(); })
                .start();
        } else {
            this._finish();
            this._hideAll();
        }
    }

    private _finish(): void {
        if (!this._playing) return;
        this._playing = false;
        Log.d('[FeatureEntryGuide] done — emit FEATURE_ENTRY_GUIDE_DONE');
        EventBus.instance.emit(GameEvents.FEATURE_ENTRY_GUIDE_DONE);
    }

    private _clearSpineListener(): void {
        if (this.characterSpine?.isValid) {
            this.characterSpine.setCompleteListener(null);
        }
    }

    private _setOpacity(node: Node | null, value: number): void {
        if (!node) return;
        const op = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
        op.opacity = value;
    }
}
