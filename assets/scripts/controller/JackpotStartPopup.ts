/**
 * JackpotStartPopup — thông báo trước khi vào Pick Game (Jackpot Feature).
 *
 * Prefab: assets/bundle/JackpotStartPopup.prefab (load qua PopupLoader).
 * Gán hết trong Editor (hoặc addComponent fallback qua PopupLoader):
 *   - title1Sprite / title2Sprite / pressButton → kéo node Title1, Title2, Press
 *   - congratulationsFrames / jackpotFeatureFrames / panelBgFrames → LocalizedSpriteFrames
 *
 * Intro: Title1 → Title2 → Press scale 0→1 lần lượt (stagger 0.06s).
 * Press / tap → PICK_GAME_START_POPUP_CLOSED → GameManager mở PickGamePopup.
 */

import {
    _decorator, Component, Node, Button, Sprite, Canvas,
    UITransform, UIOpacity, Widget, tween, Tween, Vec3, view,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { applyLocalizedSprite, LocalizedSpriteFrames } from '../core/LocalizedSpriteFrames';
import { LocalizationManager } from '../core/LocalizationManager';
import { Log } from '../core/Logger';
import { PickGameState } from '../data/SlotTypes';
import { SoundManager } from '../manager/SoundManager';

const { ccclass, property } = _decorator;

const AUTO_CLOSE_SECONDS = 30;
/** Thời gian scale 0→1 mỗi node (giây). */
const SCALE_IN_DURATION = 0.18;
/** Delay giữa lần lượt Title1 → Title2 → Press (giây). */
const SCALE_STAGGER = 0.06;
/** Chờ layout settle trước intro (frame). */
const SETTLE_FRAMES = 2;

@ccclass('JackpotStartPopup')
export class JackpotStartPopup extends Component {

    @property({ type: Node, tooltip: 'Overlay tối' })
    overlayNode: Node | null = null;

    @property({ type: Node, tooltip: 'Panel content' })
    popupNode: Node | null = null;

    @property({ type: Sprite, tooltip: 'Panel/Title1 — Sprite tiêu đề trên' })
    title1Sprite: Sprite | null = null;

    @property({ type: Sprite, tooltip: 'Panel/Title2 — Sprite tiêu đề dưới' })
    title2Sprite: Sprite | null = null;

    @property({ type: Button, tooltip: 'Panel/Press — nút vào Pick Game' })
    pressButton: Button | null = null;

    @property({ type: Sprite, tooltip: 'Panel — nền PopupPickGame' })
    panelBgSprite: Sprite | null = null;

    @property({ type: LocalizedSpriteFrames, tooltip: 'Title1 — CONGRATULATIONS (theo ngôn ngữ)' })
    congratulationsFrames: LocalizedSpriteFrames = new LocalizedSpriteFrames();

    @property({ type: LocalizedSpriteFrames, tooltip: 'Title2 — JACKPOT FEATURE (theo ngôn ngữ)' })
    jackpotFeatureFrames: LocalizedSpriteFrames = new LocalizedSpriteFrames();

    @property({ type: LocalizedSpriteFrames, tooltip: 'Nền panel (theo ngôn ngữ)' })
    panelBgFrames: LocalizedSpriteFrames = new LocalizedSpriteFrames();

    private _isOpen = false;
    private _introDone = false;
    private _pickState: PickGameState | null = null;
    private _refsReady = false;
    private _boundPress = () => this._closeAndEnter(true);
    private _autoCloseCb = () => this._closeAndEnter(false);
    private _settleLeft = 0;
    private _introCompleteCb = (): void => this._onIntroComplete();

    onLoad(): void {
        this._ensureRefs();
        this._resetContentIdle();
        this.pressButton?.node.on(Button.EventType.CLICK, this._boundPress, this);
        EventBus.instance.on(GameEvents.LANGUAGE_CHANGED, this._onLanguageChanged, this);
    }

    onDestroy(): void {
        this._cancelAutoClose();
        this.unschedule(this._onSettleTick);
        this.unschedule(this._introCompleteCb);
        this._unbindPressButton();
        EventBus.instance.offTarget(this);
    }

    showPopup(pickState: PickGameState): void {
        if (this._isOpen) return;
        this._ensureRefs();
        this._pickState = pickState;
        this._isOpen = true;
        this._introDone = false;

        this._setPressInteractable(false);
        this._applyLocalizedArtwork();

        this.node.setScale(1, 1, 1);
        if (this.overlayNode) {
            this.overlayNode.setScale(1, 1, 1);
            this.overlayNode.active = true;
        }
        this.node.active = true;
        this._fitOverlayFullscreen();
        EventBus.instance.emit(GameEvents.POPUP_OPENED);

        if (this.popupNode) {
            this.popupNode.setScale(1, 1, 1);
            Tween.stopAllByTarget(this.popupNode);
        }

        this._prepareContentHidden();

        this.unschedule(this._onSettleTick);
        this._settleLeft = SETTLE_FRAMES;
        this.schedule(this._onSettleTick, 0);

        this._scheduleAutoClose();

        Log.d(`[JackpotStartPopup] show — PRESS TO START → Pick Game (auto-close ${AUTO_CLOSE_SECONDS}s)`);
    }

    private _onSettleTick = (): void => {
        if (!this._isOpen) {
            this.unschedule(this._onSettleTick);
            return;
        }
        this._settleLeft -= 1;
        if (this._settleLeft > 0) return;
        this.unschedule(this._onSettleTick);
        this._fitOverlayFullscreen();
        this._playContentScaleInSequence();
    };

    private _ensureRefs(): void {
        if (this._refsReady) return;
        this._refsReady = true;

        if (!this.overlayNode) {
            this.overlayNode = this.node.getChildByName('Overlay');
        }
        if (!this.popupNode) {
            this.popupNode = this.node.getChildByName('Panel');
        }

        const panel = this.popupNode;
        if (panel) {
            if (!this.title1Sprite) {
                this.title1Sprite = panel.getChildByName('Title1')?.getComponent(Sprite) ?? null;
            }
            if (!this.title2Sprite) {
                this.title2Sprite = panel.getChildByName('Title2')?.getComponent(Sprite) ?? null;
            }
            if (!this.pressButton) {
                this.pressButton = panel.getChildByName('Press')?.getComponent(Button) ?? null;
            }
            if (!this.panelBgSprite) {
                this.panelBgSprite = panel.getComponent(Sprite) ?? null;
            }
        }

        this._bootstrapLocalizedFrame(this.congratulationsFrames, this.title1Sprite);
        this._bootstrapLocalizedFrame(this.jackpotFeatureFrames, this.title2Sprite);
        this._bootstrapLocalizedFrame(this.panelBgFrames, this.panelBgSprite);
    }

    private _bootstrapLocalizedFrame(frames: LocalizedSpriteFrames, sprite: Sprite | null): void {
        if (frames.defaultFrame || !sprite?.spriteFrame) return;
        frames.defaultFrame = sprite.spriteFrame;
    }

    private _onLanguageChanged = (): void => {
        if (!this._isOpen) return;
        this._applyLocalizedArtwork();
    };

    private _applyLocalizedArtwork(): void {
        const lang = LocalizationManager.instance.currentLanguage;
        applyLocalizedSprite(this.title1Sprite, this.congratulationsFrames, lang);
        applyLocalizedSprite(this.title2Sprite, this.jackpotFeatureFrames, lang);
        applyLocalizedSprite(this.panelBgSprite, this.panelBgFrames, lang);
    }

    private _introNodes(): Node[] {
        return [this.title1Sprite?.node, this.title2Sprite?.node, this.pressButton?.node]
            .filter((n): n is Node => !!n?.isValid);
    }

    private _ensureOpacity(node: Node): UIOpacity {
        return node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
    }

    private _resetContentIdle(): void {
        for (const n of this._introNodes()) {
            this._stopNodeTweens(n);
            n.setScale(0, 0, 1);
            this._ensureOpacity(n).opacity = 0;
        }
    }

    private _prepareContentHidden(): void {
        this._resetContentIdle();
    }

    private _stopNodeTweens(node: Node): void {
        Tween.stopAllByTarget(node);
        const op = node.getComponent(UIOpacity);
        if (op) Tween.stopAllByTarget(op);
    }

    private _scheduleAutoClose(): void {
        this._cancelAutoClose();
        this.scheduleOnce(this._autoCloseCb, AUTO_CLOSE_SECONDS);
    }

    private _cancelAutoClose(): void {
        this.unschedule(this._autoCloseCb);
    }

    /** Title1 → Title2 → Press: scale 0→1, node sau bắt đầu sớm hơn (stagger ngắn). */
    private _playContentScaleInSequence(): void {
        if (!this._isOpen) return;

        const nodes = this._introNodes();
        if (!nodes.length) {
            this._onIntroComplete();
            return;
        }

        this.unschedule(this._introCompleteCb);

        let introEnd = 0;
        nodes.forEach((node, index) => {
            const delay = index * SCALE_STAGGER;
            introEnd = Math.max(introEnd, delay + SCALE_IN_DURATION);

            this._stopNodeTweens(node);
            node.setScale(0, 0, 1);
            const op = this._ensureOpacity(node);
            op.opacity = 0;

            tween(node)
                .delay(delay)
                .to(SCALE_IN_DURATION, { scale: new Vec3(1, 1, 1) }, { easing: 'sineOut' })
                .start();

            tween(op)
                .delay(delay)
                .to(SCALE_IN_DURATION, { opacity: 255 }, { easing: 'sineOut' })
                .start();
        });

        this.scheduleOnce(this._introCompleteCb, introEnd);
    }

    private _onIntroComplete(): void {
        if (!this._isOpen || this._introDone) return;
        this._introDone = true;
        this._setPressInteractable(true);
        this._playPressPulse();
        EventBus.instance.emit(GameEvents.PICK_GAME_START_POPUP_INTRO_DONE);
        Log.d('[JackpotStartPopup] intro done');
    }

    private _playPressPulse(): void {
        if (!this._isOpen) return;
        const pressNode = this.pressButton?.node;
        if (!pressNode?.isValid) return;
        Tween.stopAllByTarget(pressNode);
        pressNode.setScale(1, 1, 1);
        tween(pressNode)
            .repeatForever(
                tween(pressNode)
                    .to(0.55, { scale: new Vec3(1.06, 1.06, 1) }, { easing: 'sineInOut' })
                    .to(0.55, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' }),
            )
            .start();
    }

    private _setPressInteractable(on: boolean): void {
        if (this.pressButton) this.pressButton.interactable = on;
    }

    private _stopContentTweens(): void {
        for (const n of this._introNodes()) {
            this._stopNodeTweens(n);
        }
    }

    private _unbindPressButton(): void {
        this.pressButton?.node?.off(Button.EventType.CLICK, this._boundPress, this);
    }

    private _closeAndEnter(fromUserInput: boolean): void {
        if (!this._isOpen) return;
        if (fromUserInput && !this._introDone) return;

        this._isOpen = false;
        this._cancelAutoClose();
        this.unschedule(this._onSettleTick);
        this.unschedule(this._introCompleteCb);

        const pickState = this._pickState;
        this._pickState = null;

        if (fromUserInput) {
            SoundManager.instance?.playButtonClick();
        }
        EventBus.instance.emit(GameEvents.POPUP_CLOSED);

        this._stopContentTweens();
        this._setPressInteractable(false);

        if (pickState) {
            Log.e(`[JackpotStartPopup] ${fromUserInput ? 'PRESS' : 'AUTO'} → enter Pick Game`);
            EventBus.instance.emit(GameEvents.PICK_GAME_START_POPUP_CLOSED, pickState);
        } else {
            Log.w('[JackpotStartPopup] close nhưng pickState=null');
            EventBus.instance.emit(GameEvents.PICK_GAME_START_POPUP_CLOSED, null);
        }

        this._resetContentIdle();
        if (this.overlayNode) this.overlayNode.active = false;
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

        apply(this.node);
        apply(this.overlayNode);
    }
}
