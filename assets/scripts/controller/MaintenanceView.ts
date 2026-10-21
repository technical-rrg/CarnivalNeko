/**
 * Server maintenance display — UI side of core/Maintenance.ts (PLATFORM_SPEC D12, user instruction
 * 2026-10-20). The original Cocos game had no maintenance UI; everything here is built in code.
 *
 *  - Band: one line scrolling right → left at the top of the screen, full screen width, clipped by
 *    a Mask, the same text following itself after a gap. Speed and gap follow the Unity original
 *    (NoticeScroller.prefab: 100 px/s, gap 50), in design pixels.
 *  - Popups: the system popup (PopupMessageController) with the server text, without any button —
 *    Block, Shutdown and 10015 cannot be closed by the player; maintenance code closes the Block
 *    one when maintenance is cancelled.
 *
 * installMaintenanceView() is called once from LoadingController (the loading scene stays for the
 * whole session), before login, so the reload-during-maintenance popup can show while loading.
 */

import { _decorator, Component, Node, UITransform, Widget, Graphics, Mask, Label, Color, Canvas, director } from 'cc';
import { maintenance } from '../core/Maintenance';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { PopupCase, SystemPopupPayload } from '../core/PopUpMessage';
import { LocalizationManager } from '../core/LocalizationManager';
import { FontManager } from '../manager/FontManager';
import { AutoSpinManager } from '../manager/AutoSpinManager';
import { PopupMessageController } from './PopupMessageController';

const { ccclass } = _decorator;

const SCROLL_SPEED = 100;
const GAP = 50;
const BAND_HEIGHT = 60;
const FONT_SIZE = 32;
const BAND_COLOR = new Color(0, 0, 0, 190);
const NODE_NAME = 'MaintenanceMarquee';

@ccclass('MaintenanceMarquee')
export class MaintenanceMarquee extends Component {
    private _viewport: Node | null = null;
    private _bg: Graphics | null = null;
    private _labels: Label[] = [];
    private _text = '';
    private _running = false;
    private _drawnW = -1;

    /** The band under the scene Canvas, created on first use. */
    static ensure(): MaintenanceMarquee | null {
        const existing = MaintenanceMarquee.find();
        if (existing) return existing;
        const scene = director.getScene();
        const canvas = scene?.getChildByName('Canvas') ?? scene?.getComponentInChildren(Canvas)?.node ?? null;
        if (!canvas) return null;
        const node = new Node(NODE_NAME);
        node.layer = canvas.layer;
        canvas.addChild(node);
        const band = node.addComponent(MaintenanceMarquee);
        band._build();
        return band;
    }

    static find(): MaintenanceMarquee | null {
        const scene = director.getScene();
        const canvas = scene?.getChildByName('Canvas') ?? scene?.getComponentInChildren(Canvas)?.node ?? null;
        return canvas?.getChildByName(NODE_NAME)?.getComponent(MaintenanceMarquee) ?? null;
    }

    show(text: string): void {
        this.node.active = true;
        this.node.setSiblingIndex(this.node.parent ? this.node.parent.children.length - 1 : 0);
        this._layout();
        const changed = text !== this._text;
        this._text = text;
        if (changed) {
            const font = FontManager.instance?.getFontForLanguage(LocalizationManager.instance.currentLanguage) ?? null;
            for (const l of this._labels) {
                if (font) { l.font = font; l.useSystemFont = false; }
                l.string = text;
                l.updateRenderData(true);
            }
        }
        const [a, b] = this._labels;
        if (!this._running) {
            // Start just outside the right edge; the copy follows after the gap.
            a.node.setPosition(this._halfWidth(), 0);
            b.node.setPosition(a.node.position.x + this._width(a) + GAP, 0);
            this._running = true;
        } else if (changed) {
            const lead = a.node.position.x <= b.node.position.x ? a : b;
            const follow = lead === a ? b : a;
            follow.node.setPosition(lead.node.position.x + this._width(lead) + GAP, 0);
        }
    }

    hide(): void {
        this._running = false;
        this.node.active = false;
    }

    update(dt: number): void {
        if (!this._running) return;
        // Loading and guide raise themselves (bringToFront) — the band stays above them.
        const parent = this.node.parent;
        if (parent && this.node.getSiblingIndex() !== parent.children.length - 1) {
            this.node.setSiblingIndex(parent.children.length - 1);
        }
        this._layout();
        const left = -this._halfWidth();
        for (const l of this._labels) l.node.setPosition(l.node.position.x - SCROLL_SPEED * dt, 0);
        const [a, b] = this._labels;
        for (const [l, other] of [[a, b], [b, a]] as const) {
            if (l.node.position.x + this._width(l) < left) {
                l.node.setPosition(other.node.position.x + this._width(other) + GAP, 0);
            }
        }
    }

    private _build(): void {
        const layer = this.node.layer;
        const ut = this.node.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 1);
        ut.setContentSize(1920, BAND_HEIGHT);
        const w = this.node.addComponent(Widget);
        w.isAlignTop = w.isAlignLeft = w.isAlignRight = true;
        w.top = w.left = w.right = 0;
        w.alignMode = Widget.AlignMode.ALWAYS;
        this._bg = this.node.addComponent(Graphics);

        const vp = new Node('Viewport');
        vp.layer = layer;
        this.node.addChild(vp);
        vp.addComponent(UITransform).setAnchorPoint(0.5, 0.5);
        const vw = vp.addComponent(Widget);
        vw.isAlignTop = vw.isAlignBottom = vw.isAlignLeft = vw.isAlignRight = true;
        vw.top = vw.bottom = vw.left = vw.right = 0;
        vw.alignMode = Widget.AlignMode.ALWAYS;
        vp.addComponent(Mask).type = Mask.Type.GRAPHICS_RECT;
        this._viewport = vp;

        for (let i = 0; i < 2; i++) {
            const n = new Node(`Text${i + 1}`);
            n.layer = layer;
            vp.addChild(n);
            n.addComponent(UITransform).setAnchorPoint(0, 0.5);
            const l = n.addComponent(Label);
            l.fontSize = FONT_SIZE;
            l.lineHeight = FONT_SIZE + 8;
            l.overflow = Label.Overflow.NONE;
            l.enableWrapText = false;
            l.cacheMode = Label.CacheMode.NONE;
            l.horizontalAlign = Label.HorizontalAlign.LEFT;
            l.verticalAlign = Label.VerticalAlign.CENTER;
            l.color = Color.WHITE;
            this._labels.push(l);
        }
        this.node.active = false;
    }

    /** Follow the screen width (rotation / resize) and redraw the background when it changes. */
    private _layout(): void {
        this.getComponent(Widget)?.updateAlignment();
        this._viewport?.getComponent(Widget)?.updateAlignment();
        const ut = this.getComponent(UITransform)!;
        if (ut.width === this._drawnW || !this._bg) return;
        this._drawnW = ut.width;
        this._bg.clear();
        this._bg.fillColor = BAND_COLOR;
        this._bg.rect(-ut.width / 2, -ut.height, ut.width, ut.height);
        this._bg.fill();
    }

    private _halfWidth(): number {
        return (this._viewport?.getComponent(UITransform)?.width ?? 1920) / 2;
    }

    private _width(l: Label): number {
        return l.node.getComponent(UITransform)?.width ?? 0;
    }
}

let _installed = false;
let _pendingLocked: SystemPopupPayload | null = null;
let _retryTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Show a maintenance popup (no button). With the guide-first boot nothing listens to
 * SHOW_SYSTEM_POPUP yet at login (reload during maintenance, 10015), so keep asking until the popup
 * is really up, then send the latest text once more (an older one may have been shown first).
 */
function showLocked(title: string, body: string): void {
    _pendingLocked = { popupCase: PopupCase.MAINTENANCE, title, message: body, locked: true };
    EventBus.instance.emit(GameEvents.SHOW_SYSTEM_POPUP, _pendingLocked);
    if (_retryTimer || PopupMessageController.isLockedOpen()) return;
    _retryTimer = setInterval(() => {
        if (_pendingLocked) EventBus.instance.emit(GameEvents.SHOW_SYSTEM_POPUP, _pendingLocked);
        if (!_pendingLocked || PopupMessageController.isLockedOpen()) {
            clearInterval(_retryTimer!);
            _retryTimer = null;
        }
    }, 500);
}

/** Wire the maintenance state to the band, the system popup and auto spin (once per page). */
export function installMaintenanceView(): void {
    if (_installed) return;
    _installed = true;
    maintenance.setHandlers({
        noticeOpen: (text) => MaintenanceMarquee.ensure()?.show(text),
        noticeClose: () => MaintenanceMarquee.find()?.hide(),
        // Block and Shutdown popups have no button; only maintenance code closes the Block one.
        openBlockPopup: showLocked,
        closeBlockPopup: () => {
            _pendingLocked = null;
            PopupMessageController.closeLocked();
        },
        openLockedPopup: showLocked,
        stopAutoSpin: () => AutoSpinManager.instance?.stopAutoSpin(),
        // A refused spin / pick / claim left the game mid-action: reload the page (same as F5). The
        // original disconnect popup's OK (resetSession + loadScene('loading')) does not come back in
        // these builds — the scene stays empty — so it is not reused here.
        reloadGame: () => window.location.reload(),
    });
}
