/**
 * DebugLanguageSwitcher — overlay đổi ngôn ngữ lúc chơi (Preview / debug build).
 *
 * Không ghi ServerConfig.ts, không đụng logic spin/bet/reel.
 * Chỉ gọi LocalizationManager.setLanguage(..., persist=false) → UI Label/font
 * listen LANGUAGE_CHANGED tự refresh. Reload game thì về ngôn ngữ ban đầu
 * (DEV_FORCE_LANG / URL `gl` / en).
 *
 * Hiện khi ENABLE_DEBUG_TOOLS = true. Click chip góc trên-trái để mở list.
 */

import {
    _decorator, Component, Node, Label, Button, Color, Graphics,
    UITransform, Widget, BlockInputEvents, director, Canvas,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import {
    LocalizationManager,
    LanguageCode,
    SUPPORTED_LANGUAGES,
} from '../core/LocalizationManager';
import { isDebugToolsEnabled } from '../core/DebugEnv';
import { Log } from '../core/Logger';

const { ccclass } = _decorator;

const CHIP_W = 168;
const CHIP_H = 36;
const ROW_W = 200;
const ROW_H = 32;
const ACCENT = new Color(0, 200, 255, 255);
const BG = new Color(8, 12, 22, 210);
const BG_ACTIVE = new Color(0, 80, 110, 230);
const TEXT = new Color(230, 245, 255, 255);

@ccclass('DebugLanguageSwitcher')
export class DebugLanguageSwitcher extends Component {

    private static _mounted = false;

    private _built = false;
    private _open = false;
    private _chipLabel: Label | null = null;
    private _listNode: Node | null = null;
    private _rowLabels: Label[] = [];

    /** Gọi 1 lần từ GameManager — no-op nếu debug tools tắt. */
    static mount(): void {
        if (DebugLanguageSwitcher._mounted) return;
        if (!isDebugToolsEnabled()) return;
        DebugLanguageSwitcher._mounted = true;

        const host = new Node('DebugLanguageSwitcher');
        const scene = director.getScene();
        if (scene) scene.addChild(host);
        host.addComponent(DebugLanguageSwitcher);
    }

    onLoad(): void {
        EventBus.instance.on(GameEvents.GAME_READY, this._attachToCanvas, this);
        EventBus.instance.on(GameEvents.LANGUAGE_CHANGED, this._refreshLabels, this);
        this.scheduleOnce(() => this._attachToCanvas(), 0.2);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
        DebugLanguageSwitcher._mounted = false;
    }

    private _attachToCanvas(): void {
        if (!this.isValid) return;
        const canvas = director.getScene()?.getComponentInChildren(Canvas);
        if (!canvas?.node?.isValid) return;

        if (this.node.parent !== canvas.node) {
            canvas.node.addChild(this.node);
        }
        this.node.setSiblingIndex(canvas.node.children.length - 1);
        this._buildUi();
    }

    private _buildUi(): void {
        if (this._built) return;
        this._built = true;

        const rootUt = this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);
        rootUt.setAnchorPoint(0, 1);
        rootUt.setContentSize(CHIP_W, CHIP_H);

        const widget = this.node.getComponent(Widget) ?? this.node.addComponent(Widget);
        widget.isAlignTop = true;
        widget.isAlignLeft = true;
        widget.isAlignBottom = false;
        widget.isAlignRight = false;
        widget.top = 10;
        widget.left = 10;
        widget.alignMode = Widget.AlignMode.ALWAYS;

        const chip = this._makeBox(this.node, 'Chip', CHIP_W, CHIP_H, BG);
        chip.setPosition(CHIP_W / 2, -CHIP_H / 2, 0);
        this._chipLabel = this._makeLabel(chip, 'ChipLabel', this._chipText(), 16);
        this._bindClick(chip, () => this._toggleList());

        this._listNode = new Node('LangList');
        this._listNode.setParent(this.node);
        this._listNode.active = false;
        const listH = SUPPORTED_LANGUAGES.length * ROW_H + 8;
        const listUt = this._listNode.addComponent(UITransform);
        listUt.setAnchorPoint(0, 1);
        listUt.setContentSize(ROW_W, listH);
        this._listNode.setPosition(0, -CHIP_H - 4, 0);
        this._listNode.addComponent(BlockInputEvents);

        const listBg = this._makeBox(this._listNode, 'ListBg', ROW_W, listH, BG);
        listBg.setPosition(ROW_W / 2, -listH / 2, 0);

        this._rowLabels = [];
        SUPPORTED_LANGUAGES.forEach((lang, i) => {
            const row = this._makeBox(this._listNode!, `Lang_${lang.code}`, ROW_W - 8, ROW_H - 4, this._rowColor(lang.code));
            row.setPosition(ROW_W / 2, -6 - ROW_H * i - ROW_H / 2, 0);
            const label = this._makeLabel(row, 'Text', `${lang.code}  ${lang.nativeName}`, 14);
            this._rowLabels.push(label);
            this._bindClick(row, () => this._pick(lang.code));
        });

        Log.d('[DebugLanguageSwitcher] Overlay ready — click chip góc trên-trái để đổi ngôn ngữ (tạm, không ghi code)');
    }

    private _toggleList(): void {
        this._open = !this._open;
        if (this._listNode) this._listNode.active = this._open;
        this._refreshLabels();
    }

    private _pick(code: LanguageCode): void {
        LocalizationManager.instance.setLanguage(code, false);
        this._open = false;
        if (this._listNode) this._listNode.active = false;
        this._refreshLabels();
        Log.d(`%c[DebugLanguageSwitcher] Language → ${code} (session only)`, 'color:#0af;font-weight:bold');
    }

    private _refreshLabels(): void {
        if (this._chipLabel) this._chipLabel.string = this._chipText();
        SUPPORTED_LANGUAGES.forEach((lang, i) => {
            const row = this._listNode?.getChildByName(`Lang_${lang.code}`);
            const g = row?.getComponent(Graphics);
            if (g) this._fillRoundRect(g, ROW_W - 8, ROW_H - 4, this._rowColor(lang.code));
            if (this._rowLabels[i]) {
                this._rowLabels[i].color = lang.code === LocalizationManager.instance.currentLanguage
                    ? ACCENT
                    : TEXT;
            }
        });
    }

    private _chipText(): string {
        const code = LocalizationManager.instance.currentLanguage;
        const info = SUPPORTED_LANGUAGES.find(l => l.code === code);
        const arrow = this._open ? '▲' : '▼';
        return `LANG  ${info?.nativeName ?? code}  ${arrow}`;
    }

    private _rowColor(code: LanguageCode): Color {
        return code === LocalizationManager.instance.currentLanguage ? BG_ACTIVE : new Color(12, 18, 32, 220);
    }

    private _makeBox(parent: Node, name: string, w: number, h: number, color: Color): Node {
        const n = new Node(name);
        n.setParent(parent);
        const ut = n.addComponent(UITransform);
        ut.setContentSize(w, h);
        const g = n.addComponent(Graphics);
        this._fillRoundRect(g, w, h, color);
        return n;
    }

    private _fillRoundRect(g: Graphics, w: number, h: number, color: Color): void {
        g.clear();
        g.fillColor = color;
        g.roundRect(-w / 2, -h / 2, w, h, 8);
        g.fill();
        g.strokeColor = ACCENT;
        g.lineWidth = 1;
        g.roundRect(-w / 2, -h / 2, w, h, 8);
        g.stroke();
    }

    private _makeLabel(parent: Node, name: string, text: string, fontSize: number): Label {
        const n = new Node(name);
        n.setParent(parent);
        const ut = n.addComponent(UITransform);
        ut.setContentSize(parent.getComponent(UITransform)!.contentSize);
        const lab = n.addComponent(Label);
        lab.string = text;
        lab.fontSize = fontSize;
        lab.lineHeight = fontSize + 4;
        lab.color = TEXT;
        lab.horizontalAlign = Label.HorizontalAlign.CENTER;
        lab.verticalAlign = Label.VerticalAlign.CENTER;
        lab.overflow = Label.Overflow.SHRINK;
        lab.enableWrapText = false;
        lab.cacheMode = 2; // CHAR — tránh Label.CacheMode namespace issue trên CC3
        return lab;
    }

    private _bindClick(node: Node, handler: () => void): void {
        const btn = node.getComponent(Button) ?? node.addComponent(Button);
        btn.transition = Button.Transition.NONE;
        node.off(Button.EventType.CLICK);
        node.on(Button.EventType.CLICK, handler, this);
    }
}
