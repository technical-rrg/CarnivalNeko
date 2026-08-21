/**
 * PayTablePopUp — 10 trang Game Info (Carnival Neko).
 *
 * RichText `<img src="PS_ID">` lấy frame từ SymbolPack (1–6, 11–15, 21, 41–46, 81–86).
 * Trail Normal = 46. Sticky vàng/xanh = 45/44.
 */

import {
    _decorator, Component, Node, Label, Button, RichText, Widget, view, screen,
    tween, Vec3, SpriteAtlas, Sprite, instantiate, assetManager,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { L } from '../core/LocalizationManager';
import { Log } from '../core/Logger';
import { RichTextShrink } from '../core/RichTextShrink';
import { CLIENT_TO_PS, SymbolId } from '../data/SlotTypes';
import { OrientationLayout } from './OrientationLayout';

const { ccclass, property } = _decorator;

const SYMBOL_ATLAS_UUID = '8dbe097e-d812-4920-ac55-b5f62456e3b2';
const SYMBOL_ATLAS_PATH = 'newTextures/symbols/SymbolPack';
const BUNDLE_NAME = 'MainBundle';

function imgTag(psId: number | string, width: number, height: number, offset: number): string {
    return `<img src="${psId}" width=${width} height=${height} offset=${offset}/>`;
}

@ccclass('PayTablePopUp')
export class PayTablePopUp extends Component {

    private static _instance: PayTablePopUp | null = null;
    static get instance(): PayTablePopUp | null { return PayTablePopUp._instance; }

    @property({ type: Node, tooltip: 'Node bọc toàn bộ popup (đặt active=false ban đầu)' })
    popupNode: Node | null = null;

    @property({ type: Button, tooltip: 'Nút đóng popup' })
    closeButton: Button | null = null;

    @property({ type: Button, tooltip: 'Nút chuyển sang trang trước (Left)' })
    btnLeft: Button | null = null;

    @property({ type: Button, tooltip: 'Nút chuyển sang trang kế (Right)' })
    btnRight: Button | null = null;

    @property({ type: Label, tooltip: 'Label hiển thị số trang hiện tại (vd: 1/10)' })
    pageIndicatorLabel: Label | null = null;

    @property({ type: SpriteAtlas, tooltip: 'SymbolPack — frame name = PS ID (1, 21, 45, 46, 82, …)' })
    symbolAtlas: SpriteAtlas | null = null;

    @property({ type: Node }) page1Node: Node | null = null;
    @property({ type: Node }) page2Node: Node | null = null;
    @property({ type: Node }) page3Node: Node | null = null;
    @property({ type: Node }) page4Node: Node | null = null;
    @property({ type: Node }) page5Node: Node | null = null;
    @property({ type: Node }) page6Node: Node | null = null;
    @property({ type: Node }) page7Node: Node | null = null;
    @property({ type: Node }) page8Node: Node | null = null;
    @property({ type: Node }) page9Node: Node | null = null;
    @property({ type: Node }) page10Node: Node | null = null;

    @property({ type: RichText }) page1TitleLabel: RichText | null = null;
    @property() Page1Title: string = 'UI_POPUP_PAY_PAGE1_TITLE1';
    @property({ type: RichText }) page1Content1Label: RichText | null = null;
    @property() Page1Content1: string = 'UI_POPUP_PAY_PAGE1_CONTENTS1';

    @property({ type: RichText }) page2Title1Label: RichText | null = null;
    @property() Page2Title1: string = 'UI_POPUP_PAY_PAGE2_TITLE1';
    @property({ type: RichText }) page2Title2Label: RichText | null = null;
    @property() Page2Title2: string = '';
    @property({ type: RichText }) page2Content1Label: RichText | null = null;
    @property() Page2Content1: string = 'UI_POPUP_PAY_PAGE2_CONTENTS1';
    @property({ type: RichText }) page2Content2Label: RichText | null = null;
    @property() Page2Content2: string = '';

    @property({ type: RichText }) page3Title1Label: RichText | null = null;
    @property() Page3Title1: string = 'UI_POPUP_PAY_PAGE3_TITLE1';
    @property({ type: RichText }) page3Content1Label: RichText | null = null;
    @property() Page3Content1: string = 'UI_POPUP_PAY_PAGE3_CONTENTS1';

    @property({ type: RichText }) page4Title1Label: RichText | null = null;
    @property() Page4Title1: string = 'UI_POPUP_PAY_PAGE4_TITLE1';
    @property({ type: RichText }) page4Content1Label: RichText | null = null;
    @property() Page4Content1: string = 'UI_POPUP_PAY_PAGE4_CONTENTS1';
    @property({ type: RichText }) page4Content2Label: RichText | null = null;
    @property() Page4Content2: string = 'UI_POPUP_PAY_PAGE4_CONTENTS2';
    @property({ type: RichText }) page4Content3Label: RichText | null = null;
    @property() Page4Content3: string = 'UI_POPUP_PAY_PAGE4_CONTENTS3';

    @property({ type: RichText }) page5Title1Label: RichText | null = null;
    @property() Page5Title1: string = 'UI_POPUP_PAY_PAGE5_TITLE1';
    @property({ type: RichText }) page5Content1Label: RichText | null = null;
    @property() Page5Content1: string = 'UI_POPUP_PAY_PAGE5_CONTENTS1';

    @property({ type: RichText }) page6Title1Label: RichText | null = null;
    @property() Page6Title1: string = 'UI_POPUP_PAY_PAGE6_TITLE1';
    @property({ type: RichText }) page6Content1Label: RichText | null = null;
    @property() Page6Content1: string = 'UI_POPUP_PAY_PAGE6_CONTENTS1';
    @property({ type: RichText }) page6Content2Label: RichText | null = null;
    @property() Page6Content2: string = 'UI_POPUP_PAY_PAGE6_CONTENTS2';

    @property({ type: RichText }) page7Title1Label: RichText | null = null;
    @property() Page7Title1: string = 'UI_POPUP_PAY_PAGE7_TITLE1';
    @property({ type: RichText }) page7Content1Label: RichText | null = null;
    @property() Page7Content1: string = 'UI_POPUP_PAY_PAGE7_CONTENTS1';
    @property({ type: RichText }) page7Content2Label: RichText | null = null;
    @property() Page7Content2: string = 'UI_POPUP_PAY_PAGE7_CONTENTS2';

    @property({ type: RichText }) page8Title1Label: RichText | null = null;
    @property() Page8Title1: string = 'UI_POPUP_PAY_PAGE8_TITLE1';
    @property({ type: RichText }) page8Content1Label: RichText | null = null;
    @property() Page8Content1: string = 'UI_POPUP_PAY_PAGE8_CONTENTS1';
    @property({ type: RichText }) page8Content2Label: RichText | null = null;
    @property() Page8Content2: string = 'UI_POPUP_PAY_PAGE8_CONTENTS2';

    @property({ type: RichText }) page9Title1Label: RichText | null = null;
    @property() Page9Title1: string = 'UI_POPUP_PAY_PAGE9_TITLE1';
    @property({ type: RichText }) page9Content1Label: RichText | null = null;
    @property() Page9Content1: string = 'UI_POPUP_PAY_PAGE9_CONTENTS1';

    @property({ type: RichText }) page10Title1Label: RichText | null = null;
    @property() Page10Title1: string = 'UI_POPUP_PAY_PAGE10_TITLE1';
    @property({ type: RichText }) page10Content1Label: RichText | null = null;
    @property() Page10Content1: string = 'UI_POPUP_PAY_PAGE10_CONTENTS1';

    private readonly _ARROW_OFFSET: number = 8;
    private readonly _ARROW_DURATION: number = 0.35;
    private _btnLeftOriginPos: Vec3 = new Vec3(0, 0, 0);
    private _btnRightOriginPos: Vec3 = new Vec3(0, 0, 0);
    private _arrowBasesReady: boolean = false;

    private _currentPage: number = 1;
    private readonly _totalPages: number = 10;
    private _isOpen: boolean = false;
    private _pagesReady = false;

    onLoad(): void {
        PayTablePopUp._instance = this;
        this.node.active = false;

        this.closeButton?.node.on('click', this._onClose, this);
        this.btnLeft?.node.on('click', this._onLeft, this);
        this.btnRight?.node.on('click', this._onRight, this);

        EventBus.instance.on(GameEvents.PAY_TABLE_OPEN, this.open, this);
        view.on('canvas-resize', this._onScreenChange, this);
        screen.on('window-resize', this._onScreenChange, this);
        screen.on('orientation-change', this._onScreenChange, this);
    }

    onDestroy(): void {
        if (PayTablePopUp._instance === this) PayTablePopUp._instance = null;

        this.closeButton?.node?.off('click', this._onClose, this);
        this.btnLeft?.node?.off('click', this._onLeft, this);
        this.btnRight?.node?.off('click', this._onRight, this);

        view.off('canvas-resize', this._onScreenChange, this);
        screen.off('window-resize', this._onScreenChange, this);
        screen.off('orientation-change', this._onScreenChange, this);
        this.unschedule(this._resyncArrowBases);
        EventBus.instance?.off(GameEvents.PAY_TABLE_OPEN, this.open, this);
    }

    open(): void {
        if (this._isOpen) return;
        this._isOpen = true;
        EventBus.instance.emit(GameEvents.POPUP_OPENED);

        const ws = screen.windowSize;
        const ds = view.getDesignResolutionSize();
        Log.w(`[PayTable][open] windowSize=${ws.width}x${ws.height} | designSize=${ds.width}x${ds.height}`);

        this._ensurePages();
        this._applySymbolAtlas();
        this._bindPage1Icons();
        this._remapFeatureIcons();
        this._hideLegacyBlocks();

        this._currentPage = 1;
        this._refreshLocalization();
        this._showPage(this._currentPage);

        this.node.active = true;

        this.unschedule(this._resyncArrowBases);
        this.scheduleOnce(this._resyncArrowBases, 0);
    }

    close(): void {
        if (!this._isOpen) return;
        this._isOpen = false;
        this._arrowBasesReady = false;
        this._stopArrowAnimations();
        this.unschedule(this._resyncArrowBases);
        EventBus.instance.emit(GameEvents.POPUP_CLOSED);
        this.node.active = false;
    }

    private _onLeft(): void {
        this._currentPage--;
        if (this._currentPage < 1) this._currentPage = this._totalPages;
        this._showPage(this._currentPage);
    }

    private _onRight(): void {
        this._currentPage++;
        if (this._currentPage > this._totalPages) this._currentPage = 1;
        this._showPage(this._currentPage);
    }

    private _pageNodes(): (Node | null)[] {
        return [
            this.page1Node, this.page2Node, this.page3Node, this.page4Node, this.page5Node,
            this.page6Node, this.page7Node, this.page8Node, this.page9Node, this.page10Node,
        ];
    }

    private _showPage(page: number): void {
        const nodes = this._pageNodes();
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i]) nodes[i]!.active = page === i + 1;
        }

        if (this.pageIndicatorLabel) {
            this.pageIndicatorLabel.string = `${page} / ${this._totalPages}`;
        }

        if (!this._arrowBasesReady) return;

        this.scheduleOnce(() => {
            this._resetButtonPositions();
            this._restartArrowAnimations();
        }, 0);
    }

    private _restartArrowAnimations(): void {
        this._playArrowAnimation(this.btnLeft?.node ?? null, -this._ARROW_OFFSET, this._btnLeftOriginPos);
        this._playArrowAnimation(this.btnRight?.node ?? null, this._ARROW_OFFSET, this._btnRightOriginPos);
    }

    private _onScreenChange(): void {
        if (!this._isOpen) return;
        this._stopArrowAnimations();
        this.unschedule(this._resyncArrowBases);
        this.scheduleOnce(this._resyncArrowBases, 0);
    }

    private _resyncArrowBases(): void {
        if (!this._isOpen) return;
        this._captureOriginPositions();
        this._resetButtonPositions();
        this._restartArrowAnimations();
    }

    private _captureOriginPositions(): void {
        this._stopArrowAnimations();
        this._applyArrowOrientation();
        this.node.getComponentsInChildren(Widget).forEach(w => w.updateAlignment());

        if (this.btnLeft?.node) this._btnLeftOriginPos = this.btnLeft.node.position.clone();
        if (this.btnRight?.node) this._btnRightOriginPos = this.btnRight.node.position.clone();
        this._arrowBasesReady = true;
    }

    private _applyArrowOrientation(): void {
        this.btnLeft?.node?.getComponent(OrientationLayout)?.applyOrientation();
        this.btnRight?.node?.getComponent(OrientationLayout)?.applyOrientation();
    }

    private _resetButtonPositions(): void {
        if (this.btnLeft?.node) this.btnLeft.node.setPosition(this._btnLeftOriginPos);
        if (this.btnRight?.node) this.btnRight.node.setPosition(this._btnRightOriginPos);
    }

    private _playArrowAnimation(node: Node | null, offsetX: number, originPos: Vec3): void {
        if (!node) return;
        tween(node).stop();
        if (!node.active) return;

        const shifted = new Vec3(originPos.x + offsetX, originPos.y, originPos.z);
        tween(node)
            .to(this._ARROW_DURATION, { position: shifted }, { easing: 'sineOut' })
            .to(this._ARROW_DURATION, { position: originPos.clone() }, { easing: 'sineIn' })
            .union()
            .repeatForever()
            .start();
    }

    private _stopArrowAnimations(): void {
        if (this.btnLeft?.node) tween(this.btnLeft.node).stop();
        if (this.btnRight?.node) tween(this.btnRight.node).stop();
    }

    private _onClose(): void {
        this._stopArrowAnimations();
        this.close();
    }

    // ── Pages 9–10 + Content2 ────────────────────────────────────────────────

    private _ensurePages(): void {
        if (this._pagesReady) return;
        this._pagesReady = true;

        if (!this.page9Node) {
            this.page9Node = this._cloneTextPage(this.page8Node, '8');
            this.page9Title1Label = this._rich(this.page9Node, 'Title1');
            this.page9Content1Label = this._rich(this.page9Node, 'Content1');
        }
        if (!this.page10Node) {
            this.page10Node = this._cloneTextPage(this.page8Node, '9');
            this.page10Title1Label = this._rich(this.page10Node, 'Title1');
            this.page10Content1Label = this._rich(this.page10Node, 'Content1');
        }

        this.page6Content2Label = this._ensureContent2(this.page6Node, this.page6Content2Label, -240);
        this.page7Content2Label = this._ensureContent2(this.page7Node, this.page7Content2Label, -260);
        this.page8Content2Label = this._ensureContent2(this.page8Node, this.page8Content2Label, -240);
    }

    private _cloneTextPage(src: Node | null, name: string): Node | null {
        if (!src?.isValid || !src.parent) return null;
        const clone = instantiate(src);
        clone.name = name;
        clone.setParent(src.parent);
        clone.setSiblingIndex(src.getSiblingIndex() + 1);
        clone.active = false;
        clone.getChildByName('Content2')?.destroy();
        clone.getChildByName('Icon')?.destroy();
        return clone;
    }

    private _rich(page: Node | null, child: string): RichText | null {
        return page?.getChildByName(child)?.getComponent(RichText) ?? null;
    }

    private _ensureContent2(page: Node | null, existing: RichText | null, dy: number): RichText | null {
        if (existing?.isValid) return existing;
        if (!page?.isValid) return null;
        let node = page.getChildByName('Content2');
        const src = page.getChildByName('Content1');
        if (!node && src) {
            node = instantiate(src);
            node.name = 'Content2';
            node.setParent(page);
            const p = src.position.clone();
            src.setPosition(p.x, p.y - dy * 0.35, p.z);
            node.setPosition(p.x, p.y + dy, p.z);
        }
        return node?.getComponent(RichText) ?? null;
    }

    private _hideLegacyBlocks(): void {
        this.page2Title2Label?.node && (this.page2Title2Label.node.active = false);
        this.page2Content2Label?.node && (this.page2Content2Label.node.active = false);
        for (const page of [this.page6Node, this.page7Node, this.page8Node, this.page9Node, this.page10Node]) {
            page?.getChildByName('Icon') && (page.getChildByName('Icon')!.active = false);
        }
    }

    // ── Atlas + pays ─────────────────────────────────────────────────────────

    private _applySymbolAtlas(): void {
        if (this.symbolAtlas?.isValid) {
            this._bindAtlasToRichTexts();
            return;
        }
        const bundle = assetManager.getBundle(BUNDLE_NAME);
        const cached = bundle?.get(SYMBOL_ATLAS_PATH, SpriteAtlas)
            ?? (assetManager.assets.get(SYMBOL_ATLAS_UUID) as SpriteAtlas | null);
        if (cached?.isValid) {
            this.symbolAtlas = cached;
            this._bindAtlasToRichTexts();
            return;
        }
        bundle?.load(SYMBOL_ATLAS_PATH, SpriteAtlas, (err, atlas) => {
            if (err || !atlas?.isValid) {
                Log.w('[PayTable] load SymbolPack failed', err);
                return;
            }
            this.symbolAtlas = atlas;
            this._bindAtlasToRichTexts();
            this._bindPage1Icons();
            this._remapFeatureIcons();
            this._refreshLocalization();
        });
    }

    private _bindAtlasToRichTexts(): void {
        if (!this.symbolAtlas) return;
        for (const rt of this.node.getComponentsInChildren(RichText)) {
            rt.imageAtlas = this.symbolAtlas;
        }
    }

    /** Page 1 icons are null in prefab — assign SymbolPack frames only; keep Value labels as authored. */
    private _bindPage1Icons(): void {
        const page = this.page1Node;
        if (!page || !this.symbolAtlas) return;
        const highs: SymbolId[] = [
            SymbolId.MAJOR_CLEOPATRA, SymbolId.MAJOR_RAMSES, SymbolId.MAJOR_SOBEK,
            SymbolId.MAJOR_ANUBIS, SymbolId.MAJOR_HORUS,
        ];
        const lows: SymbolId[] = [
            SymbolId.MINOR_A, SymbolId.MINOR_K, SymbolId.MINOR_Q,
            SymbolId.MINOR_J, SymbolId.MINOR_10, SymbolId.MINOR_9,
        ];
        this._applyPage1IconRow(page.getChildByName('IconRow1'), highs);
        this._applyPage1IconRow(page.getChildByName('IconRow2'), lows);
    }

    private _applyPage1IconRow(row: Node | null, symbols: SymbolId[]): void {
        if (!row || !this.symbolAtlas) return;
        const cells = row.children.filter(c => c.isValid);
        for (let i = 0; i < cells.length && i < symbols.length; i++) {
            const ps = CLIENT_TO_PS[symbols[i]];
            if (ps == null) continue;
            const frame = this.symbolAtlas.getSpriteFrame(String(ps));
            if (!frame) continue;
            const icon = cells[i].getChildByName('Icon') ?? cells[i];
            const sprite = icon.getComponent(Sprite) ?? icon.getComponentInChildren(Sprite);
            if (sprite) sprite.spriteFrame = frame;
        }
    }

    private _remapFeatureIcons(): void {
        this._remapChildSprites(this.page3Node, ['41', '43', '42']);
        this._remapChildSprites(this.page2Node, ['21']);
    }

    private _remapChildSprites(root: Node | null, ids: string[]): void {
        if (!root || !this.symbolAtlas) return;
        const sprites: Sprite[] = [];
        const named = root.getChildByName('Icon') ?? root.getChildByName('Icons');
        const scan = named ?? root;
        for (const child of scan.children) {
            const sp = child.getComponent(Sprite) ?? child.getComponentInChildren(Sprite);
            if (sp && child.name !== 'Title1' && child.name !== 'Title' && !child.name.startsWith('Content')) {
                sprites.push(sp);
            }
        }
        for (let i = 0; i < sprites.length && i < ids.length; i++) {
            const frame = this.symbolAtlas.getSpriteFrame(ids[i]);
            if (frame) sprites[i].spriteFrame = frame;
        }
    }

    // ── Localization ─────────────────────────────────────────────────────────

    private _refreshLocalization(): void {
        this._setRichText(this.page1TitleLabel, this.Page1Title);
        this._setRichText(this.page1Content1Label, this.Page1Content1);

        this._setRichText(this.page2Title1Label, this.Page2Title1);
        this._setRichText(this.page2Content1Label, this.Page2Content1);

        this._setRichText(this.page3Title1Label, this.Page3Title1);
        this._setRichText(this.page3Content1Label, this.Page3Content1);

        this._setRichText(this.page4Title1Label, this.Page4Title1);
        this._setRichText(this.page4Content1Label, this.Page4Content1);
        this._setRichText(this.page4Content2Label, this.Page4Content2);
        this._setRichText(this.page4Content3Label, this.Page4Content3);

        this._setRichText(this.page5Title1Label, this.Page5Title1);
        this._setRichText(this.page5Content1Label, this.Page5Content1);

        this._setRichText(this.page6Title1Label, this.Page6Title1);
        this._setRichText(this.page6Content1Label, this.Page6Content1);
        this._setRichText(this.page6Content2Label, this.Page6Content2);

        this._setRichText(this.page7Title1Label, this.Page7Title1);
        this._setRichText(this.page7Content1Label, this.Page7Content1);
        this._setRichText(this.page7Content2Label, this.Page7Content2);

        this._setRichText(this.page8Title1Label, this.Page8Title1);
        this._setRichText(this.page8Content1Label, this.Page8Content1);
        this._setRichText(this.page8Content2Label, this.Page8Content2);

        this._setRichText(this.page9Title1Label, this.Page9Title1);
        this._setRichText(this.page9Content1Label, this.Page9Content1);

        this._setRichText(this.page10Title1Label, this.Page10Title1);
        this._setRichText(this.page10Content1Label, this.Page10Content1);
    }

    private _setRichText(label: RichText | null, key: string): void {
        if (!label || !key) return;
        if (this.symbolAtlas) label.imageAtlas = this.symbolAtlas;
        label.string = this._toPaytableRichText(L(key), key);
        label.node.getComponent(RichTextShrink)?.startShrink();
    }

    private _toPaytableRichText(raw: string, _key: string): string {
        if (!raw) return '';
        // Only convert leftover Unity tags; never insert extra <img> that is not in the locale string.
        return raw
            .replace(/<Sprite=0>/g, imgTag(45, 90, 90, 14))
            .replace(/<Sprite=1>/g, imgTag(44, 90, 90, 14))
            .replace(/\r\n|\n/g, '<br/>');
    }
}
