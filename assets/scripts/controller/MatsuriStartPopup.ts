/**
 * MatsuriStartPopup — thông báo trước khi vào Matsuri / TopUp Hold&Spin.
 *
 * Prefab: assets/bundle/MatsuriStartPopup.prefab (load qua PopupLoader).
 * Tap anywhere / Press to Start → MATSURI_START_POPUP_CLOSED → GameManager enter.
 */

import {
    _decorator, Component, Node, Label, Button, Color, Graphics, Canvas,
    UITransform, UIOpacity, BlockInputEvents, Widget, tween, Tween, Vec3,
    EventTouch, input, Input, EventMouse, view,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { L } from '../core/LocalizationManager';
import { Log } from '../core/Logger';
import { CarnivalFeatureKind, CarnivalFeatureTrigger } from '../data/SlotTypes';
import { SoundManager } from '../manager/SoundManager';

const { ccclass, property } = _decorator;

function shortFeatureName(kind: CarnivalFeatureKind): string {
    switch (kind) {
        case CarnivalFeatureKind.MIGHTY: return 'Mighty';
        case CarnivalFeatureKind.MEGA: return 'Mega';
        case CarnivalFeatureKind.SUPER: return 'Super';
        case CarnivalFeatureKind.ULTRA: return 'Ultra';
        case CarnivalFeatureKind.SUPREME: return 'Supreme';
        case CarnivalFeatureKind.ULTIMATE: return 'Ultimate';
        default: return 'Matsuri';
    }
}

@ccclass('MatsuriStartPopup')
export class MatsuriStartPopup extends Component {

    @property({ type: Node, tooltip: 'Overlay tối' })
    overlayNode: Node | null = null;

    @property({ type: Node, tooltip: 'Panel content' })
    popupNode: Node | null = null;

    @property({ type: Label, tooltip: 'Dòng 1: Mega Feature Award' })
    titleLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Dòng 2: Matsuri Feature' })
    featureLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Dòng 3: with 5x4 Reel' })
    reelLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Hint: PRESS TO START' })
    hintLabel: Label | null = null;

    @property({ type: Button, tooltip: '(Tuỳ chọn) Nút Start riêng' })
    startButton: Button | null = null;

    @property({ type: Node, tooltip: 'Layer bắt tap full-screen (nếu trống → dùng root)' })
    clickOverlay: Node | null = null;

    private _isOpen = false;
    private _feature: CarnivalFeatureTrigger | null = null;
    private _built = false;
    private _boundPress = () => this._onPressStart();

    onLoad(): void {
        this._ensureUi();
        if (this.startButton) {
            this.startButton.node.on(Button.EventType.CLICK, this._boundPress, this);
        }
        // Không set active=false ở đây — tránh race với showPopup khi onLoad bị defer.
    }

    onDestroy(): void {
        this._unbindInput();
        EventBus.instance.offTarget(this);
    }

    showPopup(feature: CarnivalFeatureTrigger): void {
        if (this._isOpen) return;
        this._ensureUi();
        this._feature = feature;
        this._isOpen = true;

        const rows = feature.matsuriRows || 3;
        const short = shortFeatureName(feature.kind);
        const awardTpl = L('matsuri_feature_award');
        const award = awardTpl.includes('[matsuri_feature_award]')
            ? `${short.toUpperCase()} FEATURE AWARD`
            : awardTpl.replace('{name}', short.toUpperCase());

        if (this.titleLabel) this.titleLabel.string = award;
        if (this.featureLabel) {
            const feat = L('matsuri_feature_type');
            this.featureLabel.string = feat.includes('[matsuri_feature_type]')
                ? 'Matsuri Feature'
                : feat;
        }
        if (this.reelLabel) {
            const reel = L('matsuri_with_reel', { cols: 5, rows });
            this.reelLabel.string = reel.includes('[matsuri_with_reel]')
                ? `with 5x${rows} Reel`
                : reel;
        }
        if (this.hintLabel) {
            const hint = L('press_to_start');
            this.hintLabel.string = hint.includes('[press_to_start]')
                ? 'PRESS TO START'
                : hint;
        }

        // Overlay: hiện ngay, không scale — fit full Canvas (tránh Widget co theo parent PopupLoader)
        this.node.setScale(1, 1, 1);
        if (this.overlayNode) {
            this.overlayNode.setScale(1, 1, 1);
            this.overlayNode.active = true;
        }
        if (this.clickOverlay && this.clickOverlay !== this.overlayNode) {
            this.clickOverlay.setScale(1, 1, 1);
            this.clickOverlay.active = true;
        }
        this.node.active = true;
        this._fitOverlayFullscreen();
        EventBus.instance.emit(GameEvents.POPUP_OPENED);

        const panel = this.popupNode;
        if (panel) {
            panel.setScale(0.2, 0.2, 1);
            const op = panel.getComponent(UIOpacity) ?? panel.addComponent(UIOpacity);
            op.opacity = 255;
            Tween.stopAllByTarget(panel);
        }

        // Scale-in frame sau — tránh tween chạy cùng instantiate/layout
        this.scheduleOnce(() => {
            this._fitOverlayFullscreen();
            this._playPanelScaleIn();
        }, 0);

        if (this.hintLabel) {
            const hn = this.hintLabel.node;
            Tween.stopAllByTarget(hn);
            tween(hn)
                .repeatForever(
                    tween(hn)
                        .to(0.55, { scale: new Vec3(1.08, 1.08, 1) }, { easing: 'sineInOut' })
                        .to(0.55, { scale: new Vec3(1, 1, 1) }, { easing: 'sineInOut' }),
                )
                .start();
        }

        // Bind sau 1 frame — tránh tap “lọt” từ burst/pot
        this.scheduleOnce(() => this._bindInput(), 0.15);

        Log.d(`[MatsuriStartPopup] show "${feature.featureName}" 5x${rows}`);
    }

    private _playPanelScaleIn(): void {
        if (!this._isOpen) return;
        const panel = this.popupNode;
        if (panel?.isValid) {
            Tween.stopAllByTarget(panel);
            tween(panel)
                .to(0.28, { scale: new Vec3(1.06, 1.06, 1) }, { easing: 'backOut' })
                .to(0.12, { scale: new Vec3(1, 1, 1) }, { easing: 'sineOut' })
                .start();
        }
    }

    private _bindInput(): void {
        if (!this._isOpen) return;
        const targets = [
            this.clickOverlay,
            this.overlayNode,
            this.popupNode,
            this.node,
        ].filter((n): n is Node => !!n?.isValid);

        for (const n of targets) {
            n.off(Node.EventType.TOUCH_END, this._boundPress, this);
            n.off(Node.EventType.MOUSE_UP, this._boundPress, this);
            n.on(Node.EventType.TOUCH_END, this._boundPress, this);
            n.on(Node.EventType.MOUSE_UP, this._boundPress, this);
        }
        // Global fallback (desktop / miss hit-test)
        input.off(Input.EventType.TOUCH_END, this._onGlobalTouch, this);
        input.off(Input.EventType.MOUSE_UP, this._onGlobalMouse, this);
        input.on(Input.EventType.TOUCH_END, this._onGlobalTouch, this);
        input.on(Input.EventType.MOUSE_UP, this._onGlobalMouse, this);
    }

    private _unbindInput(): void {
        const targets = [
            this.clickOverlay,
            this.overlayNode,
            this.popupNode,
            this.node,
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
        this._onPressStart();
    };

    private _onGlobalMouse = (_e: EventMouse): void => {
        this._onPressStart();
    };

    private _onPressStart(): void {
        if (!this._isOpen) return;
        this._isOpen = false;
        this._unbindInput();

        const feature = this._feature;
        this._feature = null;

        SoundManager.instance?.playButtonClick();
        EventBus.instance.emit(GameEvents.POPUP_CLOSED);
        if (this.hintLabel) Tween.stopAllByTarget(this.hintLabel.node);

        // Emit ngay — không chờ tween (tránh miss enter TopUp)
        if (feature) {
            Log.e(`[MatsuriStartPopup] PRESS → enter "${feature.featureName}"`);
            EventBus.instance.emit(GameEvents.MATSURI_START_POPUP_CLOSED, feature);
        } else {
            Log.w('[MatsuriStartPopup] PRESS nhưng feature=null');
        }

        // Chỉ Panel scale-out → xong mới tắt Overlay
        const hideOverlay = () => {
            if (this.overlayNode) this.overlayNode.active = false;
            if (this.clickOverlay) this.clickOverlay.active = false;
            this.node.active = false;
        };

        const panel = this.popupNode;
        if (panel) {
            Tween.stopAllByTarget(panel);
            tween(panel)
                .to(0.12, { scale: new Vec3(1.05, 1.05, 1) }, { easing: 'sineOut' })
                .to(0.14, { scale: new Vec3(0.01, 0.01, 1) }, { easing: 'sineIn' })
                .call(hideOverlay)
                .start();
        } else {
            hideOverlay();
        }
    }

    /**
     * Root/Overlay Widget align parent = PopupLoader (thường nhỏ) → bị thu size.
     * Force target = Canvas + updateAlignment để giữ full màn (1920×1080 stretch).
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
        if (this.clickOverlay && this.clickOverlay !== this.overlayNode) {
            apply(this.clickOverlay);
        }
    }

    private _ensureUi(): void {
        if (this._built && this.popupNode?.isValid) return;
        this._built = true;

        if (this.overlayNode && this.popupNode && this.titleLabel) {
            if (!this.overlayNode.getComponent(BlockInputEvents)) {
                this.overlayNode.addComponent(BlockInputEvents);
            }
            // Không đụng contentSize prefab — chỉ bổ sung UITransform nếu thiếu
            if (!this.overlayNode.getComponent(UITransform)) {
                this.overlayNode.addComponent(UITransform);
            }
            if (!this.clickOverlay) this.clickOverlay = this.overlayNode;
            return;
        }

        // Runtime fallback UI
        const root = this.node;
        let utf = root.getComponent(UITransform);
        if (!utf) utf = root.addComponent(UITransform);
        utf.setContentSize(1080, 1920);
        if (!root.getComponent(Widget)) {
            const w = root.addComponent(Widget);
            w.isAlignTop = w.isAlignBottom = w.isAlignLeft = w.isAlignRight = true;
            w.top = w.bottom = w.left = w.right = 0;
            w.alignMode = Widget.AlignMode.ALWAYS;
        }
        if (!root.getComponent(BlockInputEvents)) {
            root.addComponent(BlockInputEvents);
        }

        const overlay = new Node('Overlay');
        overlay.setParent(root);
        const oUt = overlay.addComponent(UITransform);
        oUt.setContentSize(2000, 2000);
        const oW = overlay.addComponent(Widget);
        oW.isAlignTop = oW.isAlignBottom = oW.isAlignLeft = oW.isAlignRight = true;
        oW.top = oW.bottom = oW.left = oW.right = 0;
        oW.alignMode = Widget.AlignMode.ALWAYS;
        const g = overlay.addComponent(Graphics);
        g.fillColor = new Color(0, 0, 0, 180);
        g.rect(-1000, -1000, 2000, 2000);
        g.fill();
        overlay.addComponent(BlockInputEvents);
        this.overlayNode = overlay;
        this.clickOverlay = overlay;

        const panel = new Node('Panel');
        panel.setParent(root);
        const pUt = panel.addComponent(UITransform);
        pUt.setContentSize(720, 420);
        panel.addComponent(UIOpacity);
        const pg = panel.addComponent(Graphics);
        pg.fillColor = new Color(28, 18, 48, 245);
        pg.roundRect(-360, -210, 720, 420, 28);
        pg.fill();
        pg.strokeColor = new Color(255, 200, 80, 220);
        pg.lineWidth = 4;
        pg.roundRect(-360, -210, 720, 420, 28);
        pg.stroke();
        this.popupNode = panel;

        this.titleLabel = this._makeLabel(panel, 'Title', 42, 160, Color.WHITE, 110);
        this.featureLabel = this._makeLabel(panel, 'Feature', 34, 60, new Color(255, 220, 120, 255), 50);
        this.reelLabel = this._makeLabel(panel, 'Reel', 30, -20, new Color(220, 220, 230, 255), 50);
        this.hintLabel = this._makeLabel(panel, 'Hint', 28, -130, new Color(255, 240, 160, 255), 50);
    }

    private _makeLabel(
        parent: Node,
        name: string,
        fontSize: number,
        y: number,
        color: Color,
        height: number,
    ): Label {
        const n = new Node(name);
        n.setParent(parent);
        n.setPosition(0, y, 0);
        const ut = n.addComponent(UITransform);
        ut.setContentSize(680, height);
        const lab = n.addComponent(Label);
        lab.string = '';
        lab.fontSize = fontSize;
        lab.lineHeight = fontSize + 8;
        lab.color = color;
        lab.horizontalAlign = Label.HorizontalAlign.CENTER;
        lab.verticalAlign = Label.VerticalAlign.CENTER;
        lab.overflow = Label.Overflow.SHRINK;
        lab.enableWrapText = true;
        return lab;
    }
}
