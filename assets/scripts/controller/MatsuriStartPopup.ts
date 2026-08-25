/**
 * MatsuriStartPopup — thông báo trong Feature (sau khi vào overlay), trước khi seed / Cat.
 *
 * Prefab: assets/bundle/MatsuriStartPopup.prefab
 * Gán hết trong Editor:
 *   - titleSprite / gridSprite / pressButton → kéo node Title, Grid, Press
 *   - mightyTitleFrames … ultimateTitleFrames → tiêu đề feature (LocalizedSpriteFrames)
 *   - prizesAppearFrames / minorMiniAppearFrames / panelBgFrames → ghi chú & nền (LocalizedSpriteFrames)
 *   - grid5x3Frame / grid5x4Frame / grid5x5Frame → sprite kích thước lưới (không đổi theo ngôn ngữ)
 *
 * Intro: Title → Grid → Press scale 0→1 lần lượt (stagger 0.06s).
 */

import {
    _decorator, Component, Node, Button, Sprite, SpriteFrame, Canvas,
    UITransform, UIOpacity, Widget, tween, Tween, Vec3, view,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { applyLocalizedSprite, LocalizedSpriteFrames } from '../core/LocalizedSpriteFrames';
import { LocalizationManager } from '../core/LocalizationManager';
import { Log } from '../core/Logger';
import { CarnivalFeatureKind, CarnivalFeatureTrigger } from '../data/SlotTypes';
import { SoundManager } from '../manager/SoundManager';

const { ccclass, property } = _decorator;

const AUTO_CLOSE_SECONDS = 30;
/** Thời gian scale 0→1 mỗi node (giây). */
const SCALE_IN_DURATION = 0.18;
/** Delay giữa lần lượt Title → Grid → Press (giây). */
const SCALE_STAGGER = 0.06;
/** Chờ layout settle trước intro (frame). */
const SETTLE_FRAMES = 2;

@ccclass('MatsuriStartPopup')
export class MatsuriStartPopup extends Component {

    @property({ type: Node, tooltip: 'Overlay tối' })
    overlayNode: Node | null = null;

    @property({ type: Node, tooltip: 'Panel content' })
    popupNode: Node | null = null;

    @property({ type: Sprite, tooltip: 'Panel/Base/Title — Sprite hiển thị tiêu đề feature' })
    titleSprite: Sprite | null = null;

    @property({ type: Sprite, tooltip: 'Panel/Base/Grid — Sprite hiển thị 5×N' })
    gridSprite: Sprite | null = null;

    @property({ type: Button, tooltip: 'Panel/Base/Press — nút vào feature' })
    pressButton: Button | null = null;

    @property({ type: Sprite, tooltip: 'Panel/Base/Note1 — ghi chú PRIZES APPEAR ON' })
    note1Sprite: Sprite | null = null;

    @property({ type: Sprite, tooltip: 'Panel/Base/Note2 — ghi chú MINOR OR MINI APPEAR ON' })
    note2Sprite: Sprite | null = null;

    @property({ type: Sprite, tooltip: 'Panel/Base — nền Group' })
    panelBgSprite: Sprite | null = null;

    @property({ type: LocalizedSpriteFrames, tooltip: 'Title — Mighty (theo ngôn ngữ)' })
    mightyTitleFrames: LocalizedSpriteFrames = new LocalizedSpriteFrames();

    @property({ type: LocalizedSpriteFrames, tooltip: 'Title — Mega (theo ngôn ngữ)' })
    megaTitleFrames: LocalizedSpriteFrames = new LocalizedSpriteFrames();

    @property({ type: LocalizedSpriteFrames, tooltip: 'Title — Super (theo ngôn ngữ)' })
    superTitleFrames: LocalizedSpriteFrames = new LocalizedSpriteFrames();

    @property({ type: LocalizedSpriteFrames, tooltip: 'Title — Ultra (theo ngôn ngữ)' })
    ultraTitleFrames: LocalizedSpriteFrames = new LocalizedSpriteFrames();

    @property({ type: LocalizedSpriteFrames, tooltip: 'Title — Supreme (theo ngôn ngữ)' })
    supremeTitleFrames: LocalizedSpriteFrames = new LocalizedSpriteFrames();

    @property({ type: LocalizedSpriteFrames, tooltip: 'Title — Ultimate (theo ngôn ngữ)' })
    ultimateTitleFrames: LocalizedSpriteFrames = new LocalizedSpriteFrames();

    @property({ type: LocalizedSpriteFrames, tooltip: 'Note1 — PRIZES APPEAR ON (theo ngôn ngữ)' })
    prizesAppearFrames: LocalizedSpriteFrames = new LocalizedSpriteFrames();

    @property({ type: LocalizedSpriteFrames, tooltip: 'Note2 — MINOR OR MINI APPEAR ON (theo ngôn ngữ)' })
    minorMiniAppearFrames: LocalizedSpriteFrames = new LocalizedSpriteFrames();

    @property({ type: LocalizedSpriteFrames, tooltip: 'Nền panel Group (theo ngôn ngữ)' })
    panelBgFrames: LocalizedSpriteFrames = new LocalizedSpriteFrames();

    @property({ type: SpriteFrame, tooltip: 'Grid sprite — 5×3' })
    grid5x3Frame: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: 'Grid sprite — 5×4' })
    grid5x4Frame: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: 'Grid sprite — 5×5' })
    grid5x5Frame: SpriteFrame | null = null;

    private _isOpen = false;
    private _introDone = false;
    private _feature: CarnivalFeatureTrigger | null = null;
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

    showPopup(feature: CarnivalFeatureTrigger): void {
        if (this._isOpen) return;
        this._ensureRefs();
        this._feature = feature;
        this._isOpen = true;
        this._introDone = false;

        this._applySprites(feature);
        this._setPressInteractable(false);

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

        const rows = feature.matsuriRows || 3;
        Log.d(`[MatsuriStartPopup] show "${feature.featureName}" 5x${rows}`);
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

    private _introNodes(): Node[] {
        return [this.titleSprite?.node, this.gridSprite?.node, this.pressButton?.node]
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

    private _ensureRefs(): void {
        if (!this.overlayNode) {
            this.overlayNode = this.node.getChildByName('Overlay');
        }
        if (!this.popupNode) {
            this.popupNode = this.node.getChildByName('Panel');
        }

        const base = this.popupNode?.getChildByName('Base') ?? this.popupNode;
        if (base) {
            if (!this.titleSprite) {
                this.titleSprite = base.getChildByName('Title')?.getComponent(Sprite) ?? null;
            }
            if (!this.gridSprite) {
                this.gridSprite = base.getChildByName('Grid')?.getComponent(Sprite) ?? null;
            }
            if (!this.pressButton) {
                this.pressButton = base.getChildByName('Press')?.getComponent(Button) ?? null;
            }
            if (!this.note1Sprite) {
                this.note1Sprite = base.getChildByName('Note1')?.getComponent(Sprite) ?? null;
            }
            if (!this.note2Sprite) {
                this.note2Sprite = base.getChildByName('Note2')?.getComponent(Sprite) ?? null;
            }
            if (!this.panelBgSprite) {
                this.panelBgSprite = base.getComponent(Sprite) ?? null;
            }
        }

        this._bootstrapLocalizedFrame(this.prizesAppearFrames, this.note1Sprite);
        this._bootstrapLocalizedFrame(this.minorMiniAppearFrames, this.note2Sprite);
        this._bootstrapLocalizedFrame(this.panelBgFrames, this.panelBgSprite);
        this._bootstrapLocalizedFrame(this.mightyTitleFrames, this.titleSprite);
    }

    private _bootstrapLocalizedFrame(frames: LocalizedSpriteFrames, sprite: Sprite | null): void {
        if (frames.defaultFrame || !sprite?.spriteFrame) return;
        frames.defaultFrame = sprite.spriteFrame;
    }

    private _onLanguageChanged = (): void => {
        if (!this._isOpen || !this._feature) return;
        this._applyLocalizedArtwork(this._feature);
    };

    private _applySprites(feature: CarnivalFeatureTrigger): void {
        this._applyLocalizedArtwork(feature);
    }

    private _applyLocalizedArtwork(feature: CarnivalFeatureTrigger): void {
        const lang = LocalizationManager.instance.currentLanguage;
        applyLocalizedSprite(this.titleSprite, this._titleFramesForKind(feature.kind), lang);

        const gridFrame = this._resolveGridFrame(feature.matsuriRows || 3);
        if (this.gridSprite && gridFrame) {
            this.gridSprite.spriteFrame = gridFrame;
        }

        applyLocalizedSprite(this.note1Sprite, this.prizesAppearFrames, lang);
        applyLocalizedSprite(this.note2Sprite, this.minorMiniAppearFrames, lang);
        applyLocalizedSprite(this.panelBgSprite, this.panelBgFrames, lang);
    }

    private _titleFramesForKind(kind: CarnivalFeatureKind): LocalizedSpriteFrames | null {
        switch (kind) {
            case CarnivalFeatureKind.MIGHTY: return this.mightyTitleFrames;
            case CarnivalFeatureKind.MEGA: return this.megaTitleFrames;
            case CarnivalFeatureKind.SUPER: return this.superTitleFrames;
            case CarnivalFeatureKind.ULTRA: return this.ultraTitleFrames;
            case CarnivalFeatureKind.SUPREME: return this.supremeTitleFrames;
            case CarnivalFeatureKind.ULTIMATE: return this.ultimateTitleFrames;
            default: return null;
        }
    }

    private _resolveGridFrame(rows: number): SpriteFrame | null {
        switch (rows) {
            case 3: return this.grid5x3Frame;
            case 4: return this.grid5x4Frame;
            case 5: return this.grid5x5Frame;
            default: return this.grid5x3Frame;
        }
    }

    private _scheduleAutoClose(): void {
        this._cancelAutoClose();
        this.scheduleOnce(this._autoCloseCb, AUTO_CLOSE_SECONDS);
    }

    private _cancelAutoClose(): void {
        this.unschedule(this._autoCloseCb);
    }

    /** Title → Grid → Press: scale 0→1, node sau bắt đầu sớm hơn (stagger ngắn). */
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
        EventBus.instance.emit(GameEvents.MATSURI_START_POPUP_INTRO_DONE);
        Log.d('[MatsuriStartPopup] intro done');
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

        const feature = this._feature;
        this._feature = null;

        if (fromUserInput) {
            SoundManager.instance?.playButtonClick();
        }
        EventBus.instance.emit(GameEvents.POPUP_CLOSED);

        this._stopContentTweens();
        this._setPressInteractable(false);

        if (feature) {
            Log.e(`[MatsuriStartPopup] ${fromUserInput ? 'PRESS' : 'AUTO'} → enter "${feature.featureName}"`);
            EventBus.instance.emit(GameEvents.MATSURI_START_POPUP_CLOSED, feature);
        } else {
            Log.w('[MatsuriStartPopup] close nhưng feature=null');
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
