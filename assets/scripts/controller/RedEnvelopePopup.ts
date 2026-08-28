/**
 * RedEnvelopePopup — notify Red Mystery Envelope (instant payout).
 *
 * ── SETUP TRONG EDITOR ──
 *   RedEnvelopePopup (component này)
 *     ├── Overlay        ← overlayNode + clickOverlay
 *     └── Panel          ← popupNode
 *           ├── Base     ← sp.Skeleton (In → Loop → Out)
 *           ├── TextLayer (tuỳ chọn) — Title / Awarded Label
 *           └── AmountDisplay ← SpriteNumber (amountDisplay)
 *
 * Flow:
 *   1. Base spine play In → Loop
 *   2. Khi In xong → SpriteNumber count-up nhanh tới số thưởng (Loop đang chạy)
 *   3. Đóng: tap hoặc auto → Base spine play Out → ẩn popup
 *
 * Đóng: tap hoặc auto → CARNIVAL_RED_ENVELOPE_CLOSED.
 */

import {
    _decorator, Component, Node, Label, UIOpacity, Canvas, UITransform, Widget,
    tween, Tween, Vec3, EventTouch, input, Input, EventMouse, view, sp, ParticleSystem,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { L } from '../core/LocalizationManager';
import { naturalCountUpValue } from '../core/FormatUtils';
import { Log } from '../core/Logger';
import { SoundManager } from '../manager/SoundManager';
import { SpriteNumber } from '../core/SpriteNumber';

const { ccclass, property } = _decorator;

const AUTO_CLOSE_SEC = 3.0;

@ccclass('RedEnvelopePopup')
export class RedEnvelopePopup extends Component {

    @property({ type: Node })
    overlayNode: Node | null = null;

    @property({ type: Node })
    popupNode: Node | null = null;

    /** sp.Skeleton trên node Base — In → Loop khi mở, Out khi đóng */
    @property({ type: sp.Skeleton, tooltip: 'Spine trên node Base (In → Loop → Out)\n→ Kéo sp.Skeleton node Base vào đây' })
    baseSpine: sp.Skeleton | null = null;

    @property({ type: Label })
    titleLabel: Label | null = null;

    @property({ type: Label })
    awardedLabel: Label | null = null;

    @property({ type: SpriteNumber, tooltip: 'SpriteNumber hiển thị số tiền thưởng (count-up)' })
    amountDisplay: SpriteNumber | null = null;

    @property({ type: Node })
    clickOverlay: Node | null = null;

    /** Particle FX — ẩn lúc mở, hiện khi spine In xong */
    @property({ type: Node, tooltip: 'Fx1 — particle FX\n→ Kéo node Fx1 vào đây' })
    fx1: Node | null = null;

    @property({ type: Node, tooltip: 'Fx2 — particle FX\n→ Kéo node Fx2 vào đây' })
    fx2: Node | null = null;

    @property({ type: Node, tooltip: 'Fx3 — particle FX\n→ Kéo node Fx3 vào đây' })
    fx3: Node | null = null;

    @property({ tooltip: 'Timeout tự đóng (giây)' })
    autoCloseTimeout: number = AUTO_CLOSE_SEC;

    @property({ tooltip: 'Thời gian count-up số tiền sau khi spine In xong (giây)' })
    countUpDuration: number = 0.9;

    private _isOpen = false;
    private _boundPress = () => this._closePopup();
    private _countUpTween: Tween<{ value: number }> | null = null;
    private _countUpTarget = 0;
    private _countUpSoundEnded = false;
    private _outHideCb: (() => void) | null = null;
    private _amountStarted = false;
    private _isHiding = false;

    onLoad(): void {
        this.node.active = false;
        if (!this.baseSpine && this.popupNode) {
            const base = this.popupNode.getChildByName('Base');
            if (base) this.baseSpine = base.getComponent(sp.Skeleton);
        }
        if (!this.fx1) this.fx1 = this.node.getChildByName('Fx1');
        if (!this.fx2) this.fx2 = this.node.getChildByName('Fx2');
        if (!this.fx3) this.fx3 = this.node.getChildByName('Fx3');
    }

    onDestroy(): void {
        this._stopAnimations();
        this._unbindInput();
        this.unschedule(this._boundPress);
        EventBus.instance.offTarget(this);
    }

    showPopup(amount: number): void {
        if (this._isOpen) return;
        this._isOpen = true;
        this._isHiding = false;
        this._amountStarted = false;

        const pay = Number(amount) || 0;
        this._countUpTarget = pay;
        this._countUpSoundEnded = false;

        const title = L('red_mystery_envelope_title');
        const awarded = L('red_mystery_envelope_awarded');

        if (this.titleLabel) {
            this.titleLabel.string = title.includes('[red_mystery_envelope_title]')
                ? 'RED MYSTERY ENVELOPE'
                : title;
        }
        if (this.awardedLabel) {
            this.awardedLabel.string = awarded.includes('[red_mystery_envelope_awarded]')
                ? 'AWARDED'
                : awarded;
        }

        Log.e(`[RedEnvelopePopup] show API RedEnvelopePay=${pay}`);

        this._stopAnimations();

        this.node.setScale(1, 1, 1);
        if (this.overlayNode) {
            this.overlayNode.setScale(1, 1, 1);
            this.overlayNode.active = true;
        }
        if (this.clickOverlay && this.clickOverlay !== this.overlayNode) {
            this.clickOverlay.active = true;
        }
        if (this.popupNode) {
            this.popupNode.active = true;
            this.popupNode.setScale(1, 1, 1);
            const op = this.popupNode.getComponent(UIOpacity);
            if (op) op.opacity = 255;
        }
        this._hideAmountDisplay();

        this.node.active = true;
        this._fitOverlayFullscreen();
        this.scheduleOnce(() => this._fitOverlayFullscreen(), 0);
        EventBus.instance.emit(GameEvents.POPUP_OPENED);
        SoundManager.instance?.playRedMysteryEnv();

        this._playSpineIn(pay);

        this.scheduleOnce(() => this._bindInput(), 0.2);
        this.unschedule(this._boundPress);
        this.scheduleOnce(this._boundPress, Math.max(0.5, this.autoCloseTimeout));
    }

    /** Base spine: In → Loop; count-up bắt đầu khi In xong. */
    private _playSpineIn(pay: number): void {
        const spine = this.baseSpine;
        if (!spine?.isValid) {
            this._playFxNodes();
            this._startAmountCountUp(pay);
            return;
        }

        spine.node.active = true;
        spine.setCompleteListener(null);
        spine.setAnimation(0, 'In', false);
        spine.setCompleteListener(() => {
            spine.setCompleteListener(null);
            if (!this._isOpen) return;
            spine.setAnimation(0, 'Loop', true);
            this._playFxNodes();
            this._startAmountCountUp(pay);
        });
    }

    private _playFxNodes(): void {
        this._playFxNode(this.fx1);
        this._playFxNode(this.fx2);
        this._playFxNode(this.fx3);
    }

    private _playFxNode(node: Node | null): void {
        if (!node?.isValid) return;
        node.active = true;
        for (const child of node.children) {
            if (!child?.isValid) continue;
            child.active = true;
            for (const ps of child.getComponents(ParticleSystem)) {
                ps.stop();
                ps.clear();
                ps.play();
            }
        }
        for (const ps of node.getComponents(ParticleSystem)) {
            ps.stop();
            ps.clear();
            ps.play();
        }
    }

    private _hideFxNodes(): void {
        for (const node of [this.fx1, this.fx2, this.fx3]) {
            if (!node?.isValid) continue;
            for (const child of node.children) {
                if (!child?.isValid) continue;
                for (const ps of child.getComponents(ParticleSystem)) {
                    ps.stop();
                    ps.clear();
                }
                child.active = false;
            }
            for (const ps of node.getComponents(ParticleSystem)) {
                ps.stop();
                ps.clear();
            }
            node.active = false;
        }
    }

    private _resolveOutAnimName(): string | null {
        if (!this.baseSpine) return null;
        if (this.baseSpine.findAnimation('Out')) return 'Out';
        if (this.baseSpine.findAnimation('out')) return 'out';
        return null;
    }

    private _hideAmountDisplay(): void {
        if (!this.amountDisplay) return;
        Tween.stopAllByTarget(this.amountDisplay.node);
        this.amountDisplay.node.setScale(1, 1, 1);
        this.amountDisplay.node.active = false;
    }

    /** Count-up nhanh sau khi spine In xong (Loop đang chạy). */
    private _startAmountCountUp(pay: number): void {
        if (!this._isOpen || this._amountStarted) return;
        this._amountStarted = true;

        const sn = this.amountDisplay;
        if (!sn) return;

        this._stopCountUp();
        this._countUpSoundEnded = false;
        SoundManager.instance?.stopCoinLoop();

        sn.node.active = true;
        this._configureAmountDisplay();
        sn.enableCountSound = true;
        sn.lockWidth(pay, 0, 3);
        sn.setData(0, 0, 3);
        sn.beginCountUp();

        const progress = { value: 0 };
        this._countUpTween = tween(progress)
            .to(this.countUpDuration, { value: pay }, {
                easing: 'quadOut',
                onUpdate: (_target, ratio) => {
                    const cur = naturalCountUpValue(0, pay, ratio ?? 0, 3);
                    sn.setData(cur, 0, 3);
                },
            })
            .call(() => this._finishCountUp())
            .start();
    }

    private _finishCountUp(): void {
        this._stopCountUp();
        const pay = this._countUpTarget;
        const sn = this.amountDisplay;

        if (sn) {
            if (!this._countUpSoundEnded) {
                sn.endCountUp();
                this._countUpSoundEnded = true;
            }
            const isInt = Number.isInteger(pay) || Math.abs(pay - Math.round(pay)) < 0.0005;
            sn.unlockWidth();
            if (isInt) {
                sn.setData(Math.floor(pay), 0, 0);
            } else {
                sn.setData(Math.floor(pay * 1000) / 1000, 0, 3);
            }
        } else {
            SoundManager.instance?.stopCoinLoop();
            this._countUpSoundEnded = true;
        }
    }

    private _stopCountUp(): void {
        if (this._countUpTween) {
            this._countUpTween.stop();
            this._countUpTween = null;
        }
    }

    private _stopAnimations(): void {
        if (this._outHideCb) {
            this.unschedule(this._outHideCb);
            this._outHideCb = null;
        }
        this._hideFxNodes();
        this._stopCountUp();
        if (this.baseSpine?.isValid) {
            this.baseSpine.setCompleteListener(null);
        }
        if (this.amountDisplay) {
            Tween.stopAllByTarget(this.amountDisplay.node);
            if (!this._countUpSoundEnded) {
                this.amountDisplay.endCountUp();
                this._countUpSoundEnded = true;
            }
        }
        SoundManager.instance?.stopCoinLoop();
    }

    private _closePopup(): void {
        if (!this._isOpen) return;
        this._isOpen = false;
        this.unschedule(this._boundPress);
        this._unbindInput();

        if (this._countUpTween) {
            this._finishCountUp();
        }

        SoundManager.instance?.playButtonClick();
        EventBus.instance.emit(GameEvents.POPUP_CLOSED);
        EventBus.instance.emit(GameEvents.CARNIVAL_RED_ENVELOPE_CLOSED);

        const spine = this.baseSpine;
        const outAnim = spine?.isValid ? this._resolveOutAnimName() : null;
        if (!spine?.isValid || !outAnim) {
            this._stopAnimations();
            this._finishHide();
            return;
        }

        spine.setCompleteListener(null);
        this._stopCountUp();
        if (this.amountDisplay) {
            Tween.stopAllByTarget(this.amountDisplay.node);
        }
        SoundManager.instance?.stopCoinLoop();

        spine.setAnimation(0, outAnim, false);
        spine.setCompleteListener(() => {
            spine.setCompleteListener(null);
            if (this._outHideCb) {
                this.unschedule(this._outHideCb);
                this._outHideCb = null;
            }
            this._finishHide();
        });

        const outDur = spine.findAnimation(outAnim)?.duration ?? 0.5;
        if (this._outHideCb) this.unschedule(this._outHideCb);
        this._outHideCb = () => {
            this._outHideCb = null;
            spine.setCompleteListener(null);
            this._finishHide();
        };
        this.scheduleOnce(this._outHideCb, outDur + 0.05);
    }

    private _finishHide(): void {
        if (this._isHiding) return;
        this._isHiding = true;
        this._stopAnimations();
        if (this.overlayNode) this.overlayNode.active = false;
        if (this.clickOverlay) this.clickOverlay.active = false;
        if (this.popupNode) this.popupNode.active = false;
        if (this.baseSpine) this.baseSpine.node.active = false;
        this.node.active = false;
    }

    private _bindInput(): void {
        if (!this._isOpen) return;
        const targets = [
            this.clickOverlay, this.overlayNode, this.popupNode, this.node,
        ].filter((n): n is Node => !!n?.isValid);
        for (const n of targets) {
            n.off(Node.EventType.TOUCH_END, this._boundPress, this);
            n.off(Node.EventType.MOUSE_UP, this._boundPress, this);
            n.on(Node.EventType.TOUCH_END, this._boundPress, this);
            n.on(Node.EventType.MOUSE_UP, this._boundPress, this);
        }
        input.off(Input.EventType.TOUCH_END, this._onGlobalTouch, this);
        input.off(Input.EventType.MOUSE_UP, this._onGlobalMouse, this);
        input.on(Input.EventType.TOUCH_END, this._onGlobalTouch, this);
        input.on(Input.EventType.MOUSE_UP, this._onGlobalMouse, this);
    }

    private _unbindInput(): void {
        const targets = [
            this.clickOverlay, this.overlayNode, this.popupNode, this.node,
        ].filter((n): n is Node => !!n?.isValid);
        for (const n of targets) {
            n.off(Node.EventType.TOUCH_END, this._boundPress, this);
            n.off(Node.EventType.MOUSE_UP, this._boundPress, this);
        }
        input.off(Input.EventType.TOUCH_END, this._onGlobalTouch, this);
        input.off(Input.EventType.MOUSE_UP, this._onGlobalMouse, this);
    }

    private _onGlobalTouch = (_e: EventTouch): void => { this._closePopup(); };
    private _onGlobalMouse = (_e: EventMouse): void => { this._closePopup(); };

    /**
     * Widget root/Overlay mặc định align parent PopupLoader (thường nhỏ hơn Canvas) → overlay bị co.
     * Ép target = Canvas và updateAlignment để luôn full màn.
     */
    private _fitOverlayFullscreen(): void {
        let canvasNode: Node | null = this.node;
        while (canvasNode) {
            if (canvasNode.getComponent(Canvas)) break;
            canvasNode = canvasNode.parent;
        }
        const target = canvasNode;
        const vs = view.getVisibleSize();
        const targetUt = target?.getComponent(UITransform);
        const w = targetUt?.contentSize.width || vs.width || 1920;
        const h = targetUt?.contentSize.height || vs.height || 1080;

        const apply = (n: Node | null) => {
            if (!n?.isValid) return;
            n.setScale(1, 1, 1);
            const ut = n.getComponent(UITransform);
            if (ut) ut.setContentSize(w, h);
            const widget = n.getComponent(Widget);
            if (widget) {
                if (target) widget.target = target;
                widget.isAlignTop = widget.isAlignBottom = true;
                widget.isAlignLeft = widget.isAlignRight = true;
                widget.top = widget.bottom = widget.left = widget.right = 0;
                widget.alignMode = Widget.AlignMode.ALWAYS;
                widget.updateAlignment();
            }
        };

        apply(this.node);
        apply(this.overlayNode);
        if (this.clickOverlay && this.clickOverlay !== this.overlayNode) {
            apply(this.clickOverlay);
        }
    }

    /** Cấu hình SpriteNumber theo khung rect đặt trong Editor (550×250). */
    private _configureAmountDisplay(): void {
        const sn = this.amountDisplay;
        if (!sn) return;

        sn.shrinkToFit = true;
        sn.fillContainer = true;
        sn.maxWidth = 0;
        sn.enableLangCurrency = true;
        sn.refreshContainerDims();
    }
}
