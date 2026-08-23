/**
 * RedEnvelopePopup — notify Red Mystery Envelope (instant payout).
 *
 * ── SETUP TRONG EDITOR ──
 *   RedEnvelopePopup (component này)
 *     ├── Overlay        ← overlayNode + clickOverlay
 *     └── Panel          ← popupNode (zoom in + pulse)
 *           ├── Base     ← sprite/panel art
 *           ├── TextLayer (tuỳ chọn) — Title / Awarded Label
 *           └── AmountDisplay ← SpriteNumber (amountDisplay)
 *
 * Flow:
 *   1. Panel zoom scale in (backOut)
 *   2. Sau zoom xong → SpriteNumber xuất hiện, count-up nhanh tới số thưởng
 *   3. Sau count-up → Panel pulse zoom nhẹ in/out liên tục
 *
 * Đóng: tap hoặc auto 3s → CARNIVAL_RED_ENVELOPE_CLOSED.
 */

import {
    _decorator, Component, Node, Label, UIOpacity, Canvas, UITransform, Widget,
    tween, Tween, Vec3, EventTouch, input, Input, EventMouse, view,
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
const PANEL_ZOOM_IN_DUR = 0.32;
const PANEL_ZOOM_SETTLE_DUR = 0.12;
/** Hiện số tiền sớm trong lúc Panel còn đang zoom (không đợi zoom xong). */
const AMOUNT_SHOW_DELAY = 0.16;

@ccclass('RedEnvelopePopup')
export class RedEnvelopePopup extends Component {

    @property({ type: Node })
    overlayNode: Node | null = null;

    @property({ type: Node })
    popupNode: Node | null = null;

    @property({ type: Label })
    titleLabel: Label | null = null;

    @property({ type: Label })
    awardedLabel: Label | null = null;

    @property({ type: SpriteNumber, tooltip: 'SpriteNumber hiển thị số tiền thưởng (count-up)' })
    amountDisplay: SpriteNumber | null = null;

    @property({ type: Node })
    clickOverlay: Node | null = null;

    @property({ tooltip: 'Timeout tự đóng (giây)' })
    autoCloseTimeout: number = AUTO_CLOSE_SEC;

    @property({ tooltip: 'Thời gian count-up số tiền sau khi Panel zoom xong (giây)' })
    countUpDuration: number = 0.9;

    @property({ tooltip: 'Scale đỉnh khi Panel pulse (nhẹ in/out sau count-up)' })
    panelPulseScale: number = 1.04;

    @property({ tooltip: 'Một nửa chu kỳ pulse Panel (giây)' })
    panelPulseHalfDuration: number = 0.55;

    private _isOpen = false;
    private _boundPress = () => this._closePopup();
    private _countUpTween: Tween<{ value: number }> | null = null;
    private _countUpTarget = 0;
    private _countUpSoundEnded = false;
    private _panelPulseTween: Tween<Node> | null = null;

    onLoad(): void {
        this.node.active = false;
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
            this.popupNode.setScale(0.15, 0.15, 1);
            const op = this.popupNode.getComponent(UIOpacity);
            if (op) op.opacity = 255;
        }
        this._hideAmountDisplay();

        this.node.active = true;
        this._fitOverlayFullscreen();
        this.scheduleOnce(() => this._fitOverlayFullscreen(), 0);
        EventBus.instance.emit(GameEvents.POPUP_OPENED);

        this._playPanelZoomIn(pay);

        this.scheduleOnce(() => this._bindInput(), 0.2);
        this.unschedule(this._boundPress);
        this.scheduleOnce(this._boundPress, Math.max(0.5, this.autoCloseTimeout));
    }

    /** Chỉ zoom Panel — không scale Overlay / root riêng. Số tiền hiện sớm giữa lúc zoom. */
    private _playPanelZoomIn(pay: number): void {
        const panel = this.popupNode;
        if (!panel?.isValid) {
            this._startAmountCountUp(pay);
            return;
        }

        Tween.stopAllByTarget(panel);
        tween(panel)
            .to(PANEL_ZOOM_IN_DUR, { scale: new Vec3(1.08, 1.08, 1) }, { easing: 'backOut' })
            .to(PANEL_ZOOM_SETTLE_DUR, { scale: new Vec3(1, 1, 1) }, { easing: 'sineOut' })
            .start();

        this.unschedule(this._boundStartAmount);
        this._pendingPay = pay;
        this.scheduleOnce(this._boundStartAmount, AMOUNT_SHOW_DELAY);
    }

    private _pendingPay = 0;
    private _boundStartAmount = (): void => {
        this._startAmountCountUp(this._pendingPay);
    };

    private _hideAmountDisplay(): void {
        if (!this.amountDisplay) return;
        Tween.stopAllByTarget(this.amountDisplay.node);
        this.amountDisplay.node.setScale(1, 1, 1);
        this.amountDisplay.node.active = false;
    }

    /** Xuất hiện + count-up nhanh sau khi Panel zoom xong. */
    private _startAmountCountUp(pay: number): void {
        if (!this._isOpen) return;

        const sn = this.amountDisplay;
        if (!sn) {
            this._startPanelPulse();
            return;
        }

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

        if (this._isOpen) {
            this._startPanelPulse();
        }
    }

    /** Pulse zoom nhẹ in/out trên Panel sau count-up. */
    private _startPanelPulse(): void {
        const panel = this.popupNode;
        if (!panel?.isValid || !this._isOpen) return;

        this._stopPanelPulse();
        const peak = Math.max(1.01, this.panelPulseScale);
        const half = Math.max(0.2, this.panelPulseHalfDuration);

        this._panelPulseTween = tween(panel)
            .to(half, { scale: new Vec3(peak, peak, 1) }, { easing: 'sineInOut' })
            .to(half, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start() as Tween<Node>;
    }

    private _stopPanelPulse(): void {
        if (this._panelPulseTween) {
            this._panelPulseTween.stop();
            this._panelPulseTween = null;
        }
        if (this.popupNode?.isValid) {
            Tween.stopAllByTarget(this.popupNode);
        }
    }

    private _stopCountUp(): void {
        if (this._countUpTween) {
            this._countUpTween.stop();
            this._countUpTween = null;
        }
    }

    private _stopAnimations(): void {
        this.unschedule(this._boundStartAmount);
        this._stopCountUp();
        this._stopPanelPulse();
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

        const hide = () => {
            if (this.overlayNode) this.overlayNode.active = false;
            if (this.clickOverlay) this.clickOverlay.active = false;
            this.node.active = false;
        };

        this._stopPanelPulse();

        const panel = this.popupNode;
        if (panel?.isValid) {
            Tween.stopAllByTarget(panel);
            tween(panel)
                .to(0.1, { scale: new Vec3(1.05, 1.05, 1) }, { easing: 'sineOut' })
                .to(0.14, { scale: new Vec3(0.01, 0.01, 1) }, { easing: 'sineIn' })
                .call(hide)
                .start();
        } else {
            this._stopAnimations();
            hide();
        }
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
        // Đọc lại contentSize hiện tại (override prefab) — tránh snapshot size mặc định 600×100.
        sn.refreshContainerDims();
    }
}
