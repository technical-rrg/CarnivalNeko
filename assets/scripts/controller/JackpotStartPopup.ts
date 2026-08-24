/**
 * JackpotStartPopup — thông báo trước khi vào Pick Game (Jackpot Feature).
 *
 * Prefab: assets/bundle/JackpotStartPopup.prefab (load qua PopupLoader).
 * Chỉ dùng UI từ prefab — không tạo Graphics/Label bằng code.
 * Press / tap → PICK_GAME_START_POPUP_CLOSED → GameManager mở PickGamePopup.
 */

import {
    _decorator, Component, Node, Label, Button, Canvas,
    UITransform, UIOpacity, BlockInputEvents, Widget, tween, Tween, Vec3,
    EventTouch, input, Input, EventMouse, view,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { L } from '../core/LocalizationManager';
import { Log } from '../core/Logger';
import { PickGameState } from '../data/SlotTypes';
import { SoundManager } from '../manager/SoundManager';

const { ccclass, property } = _decorator;

const AUTO_CLOSE_SECONDS = 30;
/** Scale panel từ nhỏ → 1 khi mở. */
const SCALE_IN_FROM = 0.2;
const SCALE_IN_DURATION = 0.28;

@ccclass('JackpotStartPopup')
export class JackpotStartPopup extends Component {

    @property({ type: Node, tooltip: 'Overlay tối' })
    overlayNode: Node | null = null;

    @property({ type: Node, tooltip: 'Panel content' })
    popupNode: Node | null = null;

    @property({ type: Label, tooltip: 'TitleLabel (optional — prefab có sẵn text)' })
    titleLabel: Label | null = null;

    @property({ type: Label, tooltip: 'FeatureLabel (optional)' })
    featureLabel: Label | null = null;

    @property({ type: Label, tooltip: 'ReelLabel / mô tả (optional)' })
    reelLabel: Label | null = null;

    @property({ type: Label, tooltip: 'HintLabel — PRESS TO START (optional)' })
    hintLabel: Label | null = null;

    @property({ type: Button, tooltip: 'Nút Start / Press (optional)' })
    startButton: Button | null = null;

    @property({ type: Node, tooltip: 'Layer bắt tap full-screen (mặc định = Overlay)' })
    clickOverlay: Node | null = null;

    private _isOpen = false;
    private _pickState: PickGameState | null = null;
    private _refsReady = false;
    private _boundPress = () => this._closeAndEnter(true);
    private _autoCloseCb = () => this._closeAndEnter(false);

    onLoad(): void {
        this._ensureRefs();
        this.startButton?.node.on(Button.EventType.CLICK, this._boundPress, this);
    }

    onDestroy(): void {
        this._cancelAutoClose();
        this._unbindInput();
        EventBus.instance.offTarget(this);
    }

    showPopup(pickState: PickGameState): void {
        if (this._isOpen) return;
        this._ensureRefs();
        this._pickState = pickState;
        this._isOpen = true;
        SoundManager.instance?.enterPickGameBgm();

        this._applyLabels();

        this.node.setScale(1, 1, 1);
        if (this.overlayNode) {
            this.overlayNode.setScale(1, 1, 1);
            this.overlayNode.active = true;
            const ovOp = this.overlayNode.getComponent(UIOpacity) ?? this.overlayNode.addComponent(UIOpacity);
            Tween.stopAllByTarget(ovOp);
            ovOp.opacity = 0;
            tween(ovOp).to(SCALE_IN_DURATION, { opacity: 255 }, { easing: 'sineOut' }).start();
        }
        if (this.clickOverlay && this.clickOverlay !== this.overlayNode) {
            this.clickOverlay.setScale(1, 1, 1);
            this.clickOverlay.active = true;
        }
        this.node.active = true;
        this._fitOverlayFullscreen();
        EventBus.instance.emit(GameEvents.POPUP_OPENED);

        const panel = this.popupNode ?? this.node;
        Tween.stopAllByTarget(panel);
        panel.setScale(SCALE_IN_FROM, SCALE_IN_FROM, 1);
        const op = panel.getComponent(UIOpacity) ?? panel.addComponent(UIOpacity);
        Tween.stopAllByTarget(op);
        op.opacity = 255;
        tween(panel)
            .to(SCALE_IN_DURATION, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
            .start();

        if (this.hintLabel) {
            const hn = this.hintLabel.node;
            Tween.stopAllByTarget(hn);
            tween(hn)
                .repeatForever(
                    tween(hn)
                        .to(0.55, { scale: new Vec3(1.06, 1.06, 1) }, { easing: 'sineInOut' })
                        .to(0.55, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' }),
                )
                .start();
        }

        this.scheduleOnce(() => this._bindInput(), SCALE_IN_DURATION + 0.05);
        this._scheduleAutoClose();

        Log.d(`[JackpotStartPopup] show — PRESS TO START → Pick Game (auto-close ${AUTO_CLOSE_SECONDS}s)`);
    }

    private _applyLabels(): void {
        if (this.titleLabel) {
            const award = L('jackpot_feature_award');
            this.titleLabel.string = award.includes('[jackpot_feature_award]')
                ? 'JACKPOT FEATURE AWARD'
                : award;
        }
        if (this.featureLabel) {
            const feat = L('jackpot_feature_type');
            this.featureLabel.string = feat.includes('[jackpot_feature_type]')
                ? 'Jackpot Feature'
                : feat;
        }
        if (this.reelLabel) {
            const desc = L('jackpot_feature_desc');
            this.reelLabel.string = desc.includes('[jackpot_feature_desc]')
                ? 'Match 3 Lucky Symbols'
                : desc;
        }
        if (this.hintLabel) {
            const hint = L('press_to_start');
            this.hintLabel.string = hint.includes('[press_to_start]')
                ? 'PRESS TO START'
                : hint;
        }
    }

    private _ensureRefs(): void {
        if (this._refsReady) return;
        this._refsReady = true;

        if (!this.overlayNode) {
            this.overlayNode = this.node.getChildByName('Overlay');
        }
        if (!this.popupNode) {
            this.popupNode = this.node.getChildByName('Panel');
        }
        if (!this.clickOverlay) {
            this.clickOverlay = this.overlayNode;
        }

        const panel = this.popupNode;
        if (panel) {
            if (!this.titleLabel) {
                this.titleLabel = panel.getChildByName('TitleLabel')?.getComponent(Label)
                    ?? panel.getChildByName('Title')?.getComponent(Label)
                    ?? null;
            }
            if (!this.featureLabel) {
                this.featureLabel = panel.getChildByName('FeatureLabel')?.getComponent(Label)
                    ?? panel.getChildByName('Feature')?.getComponent(Label)
                    ?? null;
            }
            if (!this.reelLabel) {
                this.reelLabel = panel.getChildByName('ReelLabel')?.getComponent(Label)
                    ?? panel.getChildByName('Reel')?.getComponent(Label)
                    ?? panel.getChildByName('Desc')?.getComponent(Label)
                    ?? null;
            }
            if (!this.hintLabel) {
                this.hintLabel = panel.getChildByName('HintLabel')?.getComponent(Label)
                    ?? panel.getChildByName('Hint')?.getComponent(Label)
                    ?? panel.getChildByName('Press')?.getComponent(Label)
                    ?? null;
            }
            if (!this.startButton) {
                this.startButton = panel.getChildByName('Press')?.getComponent(Button)
                    ?? panel.getChildByName('Start')?.getComponent(Button)
                    ?? null;
            }
        }

        if (this.overlayNode && !this.overlayNode.getComponent(BlockInputEvents)) {
            this.overlayNode.addComponent(BlockInputEvents);
        }
        if (this.overlayNode && !this.overlayNode.getComponent(UITransform)) {
            this.overlayNode.addComponent(UITransform);
        }
    }

    private _scheduleAutoClose(): void {
        this._cancelAutoClose();
        this.scheduleOnce(this._autoCloseCb, AUTO_CLOSE_SECONDS);
    }

    private _cancelAutoClose(): void {
        this.unschedule(this._autoCloseCb);
    }

    private _bindInput(): void {
        if (!this._isOpen) return;

        if (this.startButton?.node?.isValid) {
            this.startButton.node.off(Button.EventType.CLICK, this._boundPress, this);
            this.startButton.node.on(Button.EventType.CLICK, this._boundPress, this);
        }

        const targets = [
            this.clickOverlay,
            this.overlayNode,
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
            this.clickOverlay,
            this.overlayNode,
        ].filter((n): n is Node => !!n?.isValid);
        for (const n of targets) {
            n.off(Node.EventType.TOUCH_END, this._boundPress, this);
            n.off(Node.EventType.MOUSE_UP, this._boundPress, this);
        }
        input.off(Input.EventType.TOUCH_END, this._onGlobalTouch, this);
        input.off(Input.EventType.MOUSE_UP, this._onGlobalMouse, this);
        if (this.startButton?.node?.isValid) {
            this.startButton.node.off(Button.EventType.CLICK, this._boundPress, this);
        }
    }

    private _onGlobalTouch = (_e: EventTouch): void => {
        this._closeAndEnter(true);
    };

    private _onGlobalMouse = (_e: EventMouse): void => {
        this._closeAndEnter(true);
    };

    private _closeAndEnter(fromUserInput: boolean): void {
        if (!this._isOpen) return;
        this._isOpen = false;
        this._cancelAutoClose();
        this._unbindInput();

        const pickState = this._pickState;
        this._pickState = null;

        if (fromUserInput) {
            SoundManager.instance?.playButtonClick();
        }
        EventBus.instance.emit(GameEvents.POPUP_CLOSED);
        if (this.hintLabel) Tween.stopAllByTarget(this.hintLabel.node);

        if (pickState) {
            Log.e(`[JackpotStartPopup] ${fromUserInput ? 'PRESS' : 'AUTO'} → enter Pick Game`);
            EventBus.instance.emit(GameEvents.PICK_GAME_START_POPUP_CLOSED, pickState);
        } else {
            Log.w('[JackpotStartPopup] close nhưng pickState=null');
            EventBus.instance.emit(GameEvents.PICK_GAME_START_POPUP_CLOSED, null);
        }

        if (this.overlayNode) this.overlayNode.active = false;
        if (this.clickOverlay && this.clickOverlay !== this.overlayNode) {
            this.clickOverlay.active = false;
        }
        const panel = this.popupNode ?? this.node;
        Tween.stopAllByTarget(panel);
        panel.setScale(1, 1, 1);
        this.node.active = false;
    }

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
                widget.isAlignTop = true;
                widget.isAlignBottom = true;
                widget.isAlignLeft = true;
                widget.isAlignRight = true;
                widget.top = widget.bottom = widget.left = widget.right = 0;
                widget.alignMode = Widget.AlignMode.ALWAYS;
                widget.updateAlignment();
            }
        };

        apply(this.overlayNode);
    }
}
