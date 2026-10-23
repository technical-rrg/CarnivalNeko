/**
 * Server maintenance display — UI side of core/Maintenance.ts (PLATFORM_SPEC D12, user instruction
 * 2026-10-20). The original Cocos game had no maintenance UI; everything here is built in code.
 *
 *  - Band: one line scrolling right → left near the top of the screen, full screen width, clipped
 *    by a Mask, the same text following itself after a gap. Same shape in every game — the
 *    Carnival Neko port band (PLATFORM_SPEC D12 ①, user decision 2026-10-22): for a 1080 high
 *    design screen the band starts 80 below the top of the visible screen, is 150 high, text 32
 *    white (current language font, no outline or shadow) centred vertically, black at 0.65
 *    opacity, 100 px/s, gap 50 — scaled to the design screen height (landscape 1920×1080, portrait
 *    1080×1920). Drawn above loading, guide and popups; takes no input (buttons under it still get
 *    the touch).
 *  - Popups: the system popup (PopupMessageController) with the server text, without any button —
 *    Block, Shutdown and 10015 cannot be closed by the player; maintenance code closes the Block
 *    one when maintenance is cancelled.
 *
 * installMaintenanceView() is called once from LoadingController (the loading scene stays for the
 * whole session), before login, so the reload-during-maintenance popup can show while loading.
 */

import { _decorator, Component, Node, UITransform, Widget, Graphics, Mask, Label, Color, Canvas, director, view, TTFFont } from 'cc';
import { maintenance } from '../core/Maintenance';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { PopupCase, SystemPopupPayload } from '../core/PopUpMessage';
import { LocalizationManager } from '../core/LocalizationManager';
import { FontManager } from '../manager/FontManager';
import { AutoSpinManager } from '../manager/AutoSpinManager';
import { PopupMessageController } from './PopupMessageController';

const { ccclass } = _decorator;

/** Band shape for a REF_HEIGHT high design screen (Carnival Neko port `MARQUEE`), scaled by _scale(). */
const REF_HEIGHT = 1080;
const BAND_TOP = 80;
const BAND_HEIGHT = 150;
const FONT_SIZE = 32;
const SCROLL_SPEED = 100;
const GAP = 50;
const BAND_COLOR = new Color(0, 0, 0, 166);   // opacity 0.65
const NODE_NAME = 'MaintenanceMarquee';
/**
 * Widest text one Label may hold, in design units. The engine draws a TTF label into a canvas of
 * at most 2048 px and stretches it over the label box, so a longer line came out stretched (2× in
 * portrait, where the text is 57 high). Longer text is split into pieces placed one after another.
 */
const PIECE_MAX_WIDTH = 1600;

@ccclass('MaintenanceMarquee')
export class MaintenanceMarquee extends Component {
    private _viewport: Node | null = null;
    private _bg: Graphics | null = null;
    /** Copy i, piece j is _labels[i * _pieceX.length + j]. */
    private _labels: Label[] = [];
    private _text = '';
    private _running = false;
    /** Left edge of the first copy, from the band's left edge (starts at the right edge). */
    private _headX = 0;
    /** Text width + gap — one copy and the space after it. */
    private _period = 0;
    /** Left edge of each piece of the text, from the start of the copy. */
    private _pieceX: number[] = [0];
    private _layoutKey = '';

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

    /** Open the band (it enters from the right edge) or only change its text (the flow goes on). */
    show(text: string): void {
        this.node.active = true;
        this.node.setSiblingIndex(this.node.parent ? this.node.parent.children.length - 1 : 0);
        this._text = text;
        this._layout();
        if (!this._running) {
            this._headX = this._bandWidth();
            this._running = true;
        }
        this._place();
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
        if (this._period > 0) {
            this._headX -= SCROLL_SPEED * this._scale() * Math.min(dt, 0.25);
            // Once the first copy is a whole period out on the left, move it back: the same text
            // keeps following itself after the gap.
            while (this._headX <= -this._period) this._headX += this._period;
        }
        this._place();
    }

    private _build(): void {
        const layer = this.node.layer;
        const ut = this.node.addComponent(UITransform);
        ut.setAnchorPoint(0.5, 1);
        ut.setContentSize(1920, BAND_HEIGHT);
        const w = this.node.addComponent(Widget);
        w.isAlignTop = w.isAlignLeft = w.isAlignRight = true;
        w.top = BAND_TOP;
        w.left = w.right = 0;
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
        this.node.active = false;
    }

    /**
     * Design screen height / 1080 — 1 in landscape (1920×1080), 1920/1080 in portrait (1080×1920,
     * see ResponsiveController). A tall phone shows more than the design height (fixed width); the
     * band keeps the design screen's on-screen size there, like the Carnival Neko port whose canvas
     * is the 9:16 design screen.
     */
    private _scale(): number {
        const h = view.getDesignResolutionSize().height;
        return h > 0 ? h / REF_HEIGHT : 1;
    }

    private _bandWidth(): number {
        return this.getComponent(UITransform)?.width ?? 0;
    }

    /**
     * Band position and size, background, text size and font, number of copies — redone only when
     * the screen (rotation / resize), the text or the language font changes.
     */
    private _layout(): void {
        const k = this._scale();
        const ut = this.getComponent(UITransform)!;
        const widget = this.getComponent(Widget)!;
        const top = Math.round(BAND_TOP * k);
        const h = Math.max(1, Math.round(BAND_HEIGHT * k));
        if (widget.top !== top) widget.top = top;
        if (ut.height !== h) ut.height = h;
        widget.updateAlignment();
        this._viewport?.getComponent(Widget)?.updateAlignment();
        const width = ut.width;
        const fontSize = Math.max(1, Math.round(FONT_SIZE * k));
        const font = FontManager.instance?.getFontForLanguage(LocalizationManager.instance.currentLanguage) ?? null;
        const key = `${width}|${h}|${fontSize}|${font?.uuid ?? ''}|${this._text}`;
        if (key === this._layoutKey || !this._bg || !this._viewport) return;
        this._layoutKey = key;

        this._bg.clear();
        this._bg.fillColor = BAND_COLOR;
        this._bg.rect(-width / 2, -h, width, h);
        this._bg.fill();

        // Pieces of the text, each narrow enough for one Label (measured with the first Label).
        const measure = (s: string): number => this._label(0, fontSize, font, s).node.getComponent(UITransform)!.width;
        const pieces: { text: string; w: number }[] = [];
        this._split(Array.from(this._text), measure, pieces);
        this._pieceX = [];
        let x = 0;
        for (const p of pieces) { this._pieceX.push(x); x += p.w; }
        this._period = x > 0 ? x + Math.round(GAP * k) : 0;
        // Enough copies to fill the band at any point of the flow.
        const copies = this._period > 0 ? Math.ceil(width / this._period) + 2 : 1;
        const count = copies * pieces.length;
        for (let i = 0; i < count; i++) this._label(i, fontSize, font, pieces[i % pieces.length].text);
        while (this._labels.length > count) this._labels.pop()!.node.destroy();
    }

    /** Split the text in two near the middle (after a space if there is one) until each piece fits one Label. */
    private _split(chars: string[], measure: (s: string) => number, out: { text: string; w: number }[]): void {
        const text = chars.join('');
        const w = measure(text);
        if (w <= PIECE_MAX_WIDTH || chars.length < 2) {
            out.push({ text, w });
            return;
        }
        const mid = Math.floor(chars.length / 2);
        let cut = chars.lastIndexOf(' ', mid);
        if (cut <= 0) cut = chars.indexOf(' ', mid);
        cut = cut > 0 && cut < chars.length - 1 ? cut + 1 : mid;   // the space stays with the left piece
        this._split(chars.slice(0, cut), measure, out);
        this._split(chars.slice(cut), measure, out);
    }

    /** Label i (created on first use) set to the given text and the current size and font. */
    private _label(i: number, fontSize: number, font: TTFFont | null, text: string): Label {
        let l = this._labels[i];
        if (!l) {
            const n = new Node(`Text${i + 1}`);
            n.layer = this.node.layer;
            this._viewport!.addChild(n);
            n.addComponent(UITransform).setAnchorPoint(0, 0.5);
            l = n.addComponent(Label);
            l.overflow = Label.Overflow.NONE;
            l.enableWrapText = false;
            l.cacheMode = Label.CacheMode.NONE;
            l.horizontalAlign = Label.HorizontalAlign.LEFT;
            l.verticalAlign = Label.VerticalAlign.CENTER;
            l.color = Color.WHITE;
            this._labels[i] = l;
        }
        l.fontSize = fontSize;
        l.lineHeight = fontSize;
        if (font) { l.font = font; l.useSystemFont = false; }
        l.string = text;
        l.updateRenderData(true);
        return l;
    }

    /** Copies one period apart from the first one, pieces one after another, in the viewport (centre origin). */
    private _place(): void {
        const left = -this._bandWidth() / 2;
        const n = this._pieceX.length;
        this._labels.forEach((l, i) => {
            const x = left + this._headX + Math.floor(i / n) * this._period + this._pieceX[i % n];
            l.node.setPosition(Math.round(x), 0);
        });
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
