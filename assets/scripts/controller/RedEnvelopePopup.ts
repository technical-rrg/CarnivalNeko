/**
 * RedEnvelopePopup — notify Red Mystery Envelope (instant payout).
 *
 * API: RedEnvelopePay → SpinResponse.redEnvelopePay (NetworkManager đã parse).
 * Hierarchy (text LUÔN sibling trên Panel, không phải con của Graphics):
 *   Overlay (dim)
 *   Panel   (chỉ hình vuông đỏ)
 *   TextLayer (Title / Awarded / Amount)
 *
 * Đóng: tap hoặc auto 3s → CARNIVAL_RED_ENVELOPE_CLOSED.
 */

import {
    _decorator, Component, Node, Label, Color, Graphics, Canvas,
    UITransform, UIOpacity, BlockInputEvents, Widget, tween, Tween, Vec3,
    EventTouch, input, Input, EventMouse, view, LabelOutline,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { L } from '../core/LocalizationManager';
import { formatCurrencyFixed } from '../core/FormatUtils';
import { Log } from '../core/Logger';
import { SoundManager } from '../manager/SoundManager';

const { ccclass, property } = _decorator;

const AUTO_CLOSE_SEC = 3.0;
const PANEL_W = 520;
const PANEL_H = 640;

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

    @property({ type: Label })
    amountLabel: Label | null = null;

    @property({ type: Node })
    clickOverlay: Node | null = null;

    @property({ tooltip: 'Timeout tự đóng (giây)' })
    autoCloseTimeout: number = AUTO_CLOSE_SEC;

    private _isOpen = false;
    private _built = false;
    private _textLayer: Node | null = null;
    private _boundPress = () => this._closePopup();

    onLoad(): void {
        this._ensureUi();
        this.node.active = false;
    }

    onDestroy(): void {
        this._unbindInput();
        this.unschedule(this._boundPress);
        EventBus.instance.offTarget(this);
    }

    showPopup(amount: number): void {
        if (this._isOpen) return;
        this._ensureUi();
        this._isOpen = true;

        const pay = Number(amount) || 0;
        const symbol = L('CLIENT_CURRENENCY_SYMBOL');
        const cur = symbol.includes('[CLIENT_CURRENENCY_SYMBOL]') ? '$' : symbol;
        const title = L('red_mystery_envelope_title');
        const awarded = L('red_mystery_envelope_awarded');
        const amountStr = `${cur}${formatCurrencyFixed(pay)}`;

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
        if (this.amountLabel) {
            this.amountLabel.string = amountStr;
        }

        Log.e(`[RedEnvelopePopup] show API RedEnvelopePay=${pay} display="${amountStr}"`);

        // Thứ tự: Overlay → Panel(đỏ) → TextLayer (luôn trên cùng)
        this._orderLayers();

        this.node.setScale(1, 1, 1);
        if (this.overlayNode) {
            this.overlayNode.setScale(1, 1, 1);
            this.overlayNode.active = true;
        }
        if (this.clickOverlay && this.clickOverlay !== this.overlayNode) {
            this.clickOverlay.active = true;
        }
        if (this.popupNode) this.popupNode.active = true;
        if (this._textLayer) this._textLayer.active = true;
        this.node.active = true;
        this._fitOverlayFullscreen();
        this.scheduleOnce(() => this._fitOverlayFullscreen(), 0);
        EventBus.instance.emit(GameEvents.POPUP_OPENED);

        // Scale cả panel + text cùng nhau
        const animTargets = [this.popupNode, this._textLayer].filter((n): n is Node => !!n?.isValid);
        for (const n of animTargets) {
            n.setScale(0.15, 0.15, 1);
            const op = n.getComponent(UIOpacity) ?? n.addComponent(UIOpacity);
            op.opacity = 255;
            Tween.stopAllByTarget(n);
            tween(n)
                .to(0.32, { scale: new Vec3(1.08, 1.08, 1) }, { easing: 'backOut' })
                .to(0.12, { scale: new Vec3(1, 1, 1) }, { easing: 'sineOut' })
                .start();
        }

        this.scheduleOnce(() => this._bindInput(), 0.2);
        this.unschedule(this._boundPress);
        this.scheduleOnce(this._boundPress, Math.max(0.5, this.autoCloseTimeout));
    }

    private _closePopup(): void {
        if (!this._isOpen) return;
        this._isOpen = false;
        this.unschedule(this._boundPress);
        this._unbindInput();

        SoundManager.instance?.playButtonClick();
        EventBus.instance.emit(GameEvents.POPUP_CLOSED);
        EventBus.instance.emit(GameEvents.CARNIVAL_RED_ENVELOPE_CLOSED);

        const hide = () => {
            if (this.overlayNode) this.overlayNode.active = false;
            if (this.clickOverlay) this.clickOverlay.active = false;
            this.node.active = false;
        };

        const animTargets = [this.popupNode, this._textLayer].filter((n): n is Node => !!n?.isValid);
        if (animTargets.length) {
            let left = animTargets.length;
            for (const n of animTargets) {
                Tween.stopAllByTarget(n);
                tween(n)
                    .to(0.1, { scale: new Vec3(1.05, 1.05, 1) }, { easing: 'sineOut' })
                    .to(0.14, { scale: new Vec3(0.01, 0.01, 1) }, { easing: 'sineIn' })
                    .call(() => {
                        left--;
                        if (left <= 0) hide();
                    })
                    .start();
            }
        } else {
            hide();
        }
    }

    private _bindInput(): void {
        if (!this._isOpen) return;
        const targets = [
            this.clickOverlay, this.overlayNode, this.popupNode, this._textLayer, this.node,
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
            this.clickOverlay, this.overlayNode, this.popupNode, this._textLayer, this.node,
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
        if (this.clickOverlay && this.clickOverlay !== this.overlayNode) apply(this.clickOverlay);
    }

    private _orderLayers(): void {
        const root = this.node;
        if (this.overlayNode?.parent === root) this.overlayNode.setSiblingIndex(0);
        if (this.popupNode?.parent === root) this.popupNode.setSiblingIndex(1);
        if (this._textLayer?.parent === root) {
            this._textLayer.setSiblingIndex(root.children.length - 1);
        }
    }

    private _ensureUi(): void {
        if (this._built && this.popupNode?.isValid && this._textLayer?.isValid) return;
        this._built = true;

        if (this.overlayNode && this.popupNode) {
            if (!this.overlayNode.getComponent(BlockInputEvents)) {
                this.overlayNode.addComponent(BlockInputEvents);
            }
            if (!this.clickOverlay) this.clickOverlay = this.overlayNode;
            this._ensureDim(this.overlayNode);
            this._removeRays(this.overlayNode);
            this._paintRedPanelOnly(this.popupNode);
            this._ensureTextLayerFromExisting();
            this._orderLayers();
            return;
        }

        this._buildRuntimeUi();
    }

    private _ensureDim(overlay: Node): void {
        let g = overlay.getComponent(Graphics);
        if (!g) g = overlay.addComponent(Graphics);
        g.clear();
        g.fillColor = new Color(0, 0, 0, 170);
        g.rect(-1000, -1000, 2000, 2000);
        g.fill();
    }

    private _removeRays(overlay: Node): void {
        const rays = overlay.getChildByName('Rays');
        if (rays?.isValid) rays.destroy();
        const bg = overlay.getChildByName('Bg');
        if (bg?.isValid) bg.destroy();
    }

    /** Panel chỉ còn 1 hình vuông đỏ — không chứa Label. */
    private _paintRedPanelOnly(panel: Node): void {
        // Xóa mọi child cũ (Bg runtime, Awarded/Amount nếu còn) — text đã / sẽ chuyển sang TextLayer
        const toRemove = [...panel.children];
        for (const c of toRemove) {
            // Không destroy Label node nếu còn reference — reparent ở _ensureTextLayer
            if (c.getComponent(Label)) continue;
            c.destroy();
        }

        let g = panel.getComponent(Graphics);
        if (!g) g = panel.addComponent(Graphics);
        g.clear();
        g.fillColor = new Color(196, 30, 40, 255);
        g.rect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H);
        g.fill();

        const ut = panel.getComponent(UITransform) ?? panel.addComponent(UITransform);
        ut.setContentSize(PANEL_W, PANEL_H);
        if (!panel.getComponent(UIOpacity)) panel.addComponent(UIOpacity);
    }

    /** Gom Title/Awarded/Amount vào TextLayer (sibling trên Panel). */
    private _ensureTextLayerFromExisting(): void {
        let layer = this.node.getChildByName('TextLayer');
        if (!layer) {
            layer = new Node('TextLayer');
            layer.setParent(this.node);
            layer.addComponent(UITransform).setContentSize(PANEL_W, PANEL_H);
            layer.addComponent(UIOpacity);
            layer.setPosition(this.popupNode?.position ?? new Vec3(0, -20, 0));
        }
        this._textLayer = layer;

        const move = (lab: Label | null, y: number, fallbackName: string, fontSize: number, color: Color) => {
            if (lab?.node?.isValid) {
                if (lab.node.parent !== layer) lab.node.setParent(layer);
                lab.node.setPosition(0, y, 0);
                return lab;
            }
            return this._makeLabel(layer!, fallbackName, fontSize, y, color, fontSize + 24);
        };

        this.titleLabel = move(this.titleLabel, 280, 'Title', 46, new Color(255, 220, 90, 255));
        this.awardedLabel = move(this.awardedLabel, 120, 'Awarded', 28, new Color(255, 220, 100, 255));
        this.amountLabel = move(this.amountLabel, -20, 'Amount', 56, new Color(255, 250, 210, 255));

        // Prefab: Awarded/Amount có thể còn nằm trong Panel — kéo sang TextLayer
        if (this.popupNode) {
            for (const name of ['Awarded', 'Amount', 'Title']) {
                const child = this.popupNode.getChildByName(name);
                if (child) child.setParent(layer);
            }
        }
    }

    private _buildRuntimeUi(): void {
        const root = this.node;
        let utf = root.getComponent(UITransform);
        if (!utf) utf = root.addComponent(UITransform);
        utf.setContentSize(1920, 1080);
        if (!root.getComponent(Widget)) {
            const w = root.addComponent(Widget);
            w.isAlignTop = w.isAlignBottom = w.isAlignLeft = w.isAlignRight = true;
            w.top = w.bottom = w.left = w.right = 0;
            w.alignMode = Widget.AlignMode.ALWAYS;
        }
        if (!root.getComponent(BlockInputEvents)) root.addComponent(BlockInputEvents);

        const overlay = new Node('Overlay');
        overlay.setParent(root);
        overlay.addComponent(UITransform).setContentSize(2000, 2000);
        const oW = overlay.addComponent(Widget);
        oW.isAlignTop = oW.isAlignBottom = oW.isAlignLeft = oW.isAlignRight = true;
        oW.top = oW.bottom = oW.left = oW.right = 0;
        oW.alignMode = Widget.AlignMode.ALWAYS;
        overlay.addComponent(BlockInputEvents);
        this.overlayNode = overlay;
        this.clickOverlay = overlay;
        this._ensureDim(overlay);

        const panel = new Node('Panel');
        panel.setParent(root);
        panel.setPosition(0, -20, 0);
        this.popupNode = panel;
        this._paintRedPanelOnly(panel);

        const layer = new Node('TextLayer');
        layer.setParent(root);
        layer.setPosition(0, -20, 0);
        layer.addComponent(UITransform).setContentSize(PANEL_W, PANEL_H);
        layer.addComponent(UIOpacity);
        this._textLayer = layer;

        this.titleLabel = this._makeLabel(layer, 'Title', 46, 280, new Color(255, 220, 90, 255), 70);
        this.awardedLabel = this._makeLabel(layer, 'Awarded', 28, 120, new Color(255, 220, 100, 255), 40);
        this.amountLabel = this._makeLabel(layer, 'Amount', 56, -20, new Color(255, 250, 210, 255), 70);
        this._orderLayers();
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
        n.addComponent(UITransform).setContentSize(700, height);
        const lab = n.addComponent(Label);
        lab.string = '';
        lab.fontSize = fontSize;
        lab.lineHeight = fontSize + 8;
        lab.color = color;
        lab.horizontalAlign = Label.HorizontalAlign.CENTER;
        lab.verticalAlign = Label.VerticalAlign.CENTER;
        lab.overflow = Label.Overflow.SHRINK;
        lab.isBold = true;
        const ol = n.addComponent(LabelOutline);
        ol.color = new Color(60, 0, 0, 255);
        ol.width = 3;
        return lab;
    }
}
