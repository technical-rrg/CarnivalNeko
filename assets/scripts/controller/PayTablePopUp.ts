/**
 * PayTablePopUp - Popup bảng trả thưởng (Pay Table) gồm 8 trang.
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Prefab `PayTablePopUp` nằm trong MainBundle (assets/bundle/PayTablePopUp.prefab).
 *   2. PopupLoader lazy-load prefab khi nhận PAY_TABLE_OPEN — không embed trong Base.
 *   3. Kéo popupNode vào slot (đặt active=false ban đầu).
 *   4. Kéo các Node/Label/Button vào đúng slot bên dưới.
 *
 * ── MỞ POPUP ──
 *   EventBus.instance.emit(GameEvents.PAY_TABLE_OPEN);
 *   PopupLoader.instance?.openPayTable();
 *   Sau khi đã instantiate: PayTablePopUp.instance?.open();
 */

import { _decorator, Component, Node, Label, Button, RichText, Widget, view, screen, tween, Vec3 } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { L } from '../core/LocalizationManager';
import { Log } from '../core/Logger';
import { OrientationLayout } from './OrientationLayout';

const { ccclass, property } = _decorator;

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

    @property({ type: Label, tooltip: 'Label hiển thị số trang hiện tại (vd: 1/8)' })
    pageIndicatorLabel: Label | null = null;

    // ─── PAGE NODES ───

    @property({ type: Node, tooltip: 'Node chứa nội dung Trang 1' })
    page1Node: Node | null = null;

    @property({ type: Node, tooltip: 'Node chứa nội dung Trang 2' })
    page2Node: Node | null = null;

    @property({ type: Node, tooltip: 'Node chứa nội dung Trang 3' })
    page3Node: Node | null = null;

    @property({ type: Node, tooltip: 'Node chứa nội dung Trang 4' })
    page4Node: Node | null = null;

    @property({ type: Node, tooltip: 'Node chứa nội dung Trang 5' })
    page5Node: Node | null = null;

    @property({ type: Node, tooltip: 'Node chứa nội dung Trang 6' })
    page6Node: Node | null = null;

    @property({ type: Node, tooltip: 'Node chứa nội dung Trang 7' })
    page7Node: Node | null = null;

    @property({ type: Node, tooltip: 'Node chứa nội dung Trang 8' })
    page8Node: Node | null = null;

    // ─── PAGE 1 LABELS ───

    @property({ type: RichText, tooltip: 'Label tiêu đề Trang 1' })
    page1TitleLabel: RichText | null = null;

    @property({ tooltip: 'Localization key cho tiêu đề Trang 1' })
    Page1Title: string = '';

    @property({ type: RichText, tooltip: 'Label nội dung 1 Trang 1' })
    page1Content1Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho nội dung 1 Trang 1' })
    Page1Content1: string = '';

    // ─── PAGE 2 LABELS ───

    @property({ type: RichText, tooltip: 'Label tiêu đề 1 Trang 2' })
    page2Title1Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho tiêu đề 1 Trang 2' })
    Page2Title1: string = '';

    @property({ type: RichText, tooltip: 'Label tiêu đề 2 Trang 2' })
    page2Title2Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho tiêu đề 2 Trang 2' })
    Page2Title2: string = '';

    @property({ type: RichText, tooltip: 'Label nội dung 1 Trang 2' })
    page2Content1Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho nội dung 1 Trang 2' })
    Page2Content1: string = '';

    @property({ type: RichText, tooltip: 'Label nội dung 2 Trang 2' })
    page2Content2Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho nội dung 2 Trang 2' })
    Page2Content2: string = '';

    // ─── PAGE 3 LABELS ───

    @property({ type: RichText, tooltip: 'Label tiêu đề 1 Trang 3' })
    page3Title1Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho tiêu đề 1 Trang 3' })
    Page3Title1: string = '';

    @property({ type: RichText, tooltip: 'Label nội dung 1 Trang 3' })
    page3Content1Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho nội dung 1 Trang 3' })
    Page3Content1: string = '';

    // ─── PAGE 4 LABELS ───

    @property({ type: RichText, tooltip: 'Label tiêu đề 1 Trang 4' })
    page4Title1Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho tiêu đề 1 Trang 4' })
    Page4Title1: string = '';

    @property({ type: RichText, tooltip: 'Label nội dung 1 Trang 4' })
    page4Content1Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho nội dung 1 Trang 4' })
    Page4Content1: string = '';

    @property({ type: RichText, tooltip: 'Label nội dung 2 Trang 4' })
    page4Content2Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho nội dung 2 Trang 4' })
    Page4Content2: string = '';

    @property({ type: RichText, tooltip: 'Label nội dung 3 Trang 4' })
    page4Content3Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho nội dung 3 Trang 4' })
    Page4Content3: string = '';

    // ─── PAGE 5 LABELS ───

    @property({ type: RichText, tooltip: 'Label tiêu đề 1 Trang 5' })
    page5Title1Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho tiêu đề 1 Trang 5' })
    Page5Title1: string = '';

    @property({ type: RichText, tooltip: 'Label nội dung 1 Trang 5' })
    page5Content1Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho nội dung 1 Trang 5' })
    Page5Content1: string = '';

    // ─── PAGE 6 LABELS ───

    @property({ type: RichText, tooltip: 'Label tiêu đề 1 Trang 6' })
    page6Title1Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho tiêu đề 1 Trang 6' })
    Page6Title1: string = '';

    @property({ type: RichText, tooltip: 'Label nội dung 1 Trang 6' })
    page6Content1Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho nội dung 1 Trang 6' })
    Page6Content1: string = '';

    // ─── PAGE 7 LABELS ───

    @property({ type: RichText, tooltip: 'Label tiêu đề 1 Trang 7' })
    page7Title1Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho tiêu đề 1 Trang 7' })
    Page7Title1: string = '';

    @property({ type: RichText, tooltip: 'Label nội dung 1 Trang 7' })
    page7Content1Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho nội dung 1 Trang 7' })
    Page7Content1: string = '';

    // ─── PAGE 8 LABELS ───

    @property({ type: RichText, tooltip: 'Label tiêu đề 1 Trang 8' })
    page8Title1Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho tiêu đề 1 Trang 8' })
    Page8Title1: string = '';

    @property({ type: RichText, tooltip: 'Label nội dung 1 Trang 8' })
    page8Content1Label: RichText | null = null;

    @property({ tooltip: 'Localization key cho nội dung 1 Trang 8' })
    Page8Content1: string = '';

    private readonly _ARROW_OFFSET: number = 8;
    private readonly _ARROW_DURATION: number = 0.35;
    private _btnLeftOriginPos: Vec3 = new Vec3(0, 0, 0);
    private _btnRightOriginPos: Vec3 = new Vec3(0, 0, 0);
    private _arrowBasesReady: boolean = false;

    private _currentPage: number = 1;
    private readonly _totalPages: number = 8;
    private _isOpen: boolean = false;

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

        this._currentPage = 1;
        this._refreshLocalization();
        this._showPage(this._currentPage);

        this.node.active = true;

        // Delay 0: chạy sau OrientationLayout._applyOrientation (cùng frame schedule).
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

    private _showPage(page: number): void {
        if (this.page1Node) this.page1Node.active = page === 1;
        if (this.page2Node) this.page2Node.active = page === 2;
        if (this.page3Node) this.page3Node.active = page === 3;
        if (this.page4Node) this.page4Node.active = page === 4;
        if (this.page5Node) this.page5Node.active = page === 5;
        if (this.page6Node) this.page6Node.active = page === 6;
        if (this.page7Node) this.page7Node.active = page === 7;
        if (this.page8Node) this.page8Node.active = page === 8;

        if (this.pageIndicatorLabel) {
            this.pageIndicatorLabel.string = `${page} / ${this._totalPages}`;
        }

        // Chờ base từ OrientationLayout sẵn sàng (tránh reset về 0,0 lúc vừa open).
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

    /** Đồng bộ lại base mũi tên theo OrientationLayout sau khi xoay / resize. */
    private _onScreenChange(): void {
        if (!this._isOpen) return;
        this._stopArrowAnimations();
        this.unschedule(this._resyncArrowBases);
        // Delay 0 để chạy sau OrientationLayout._applyOrientation (cùng frame schedule).
        this.scheduleOnce(this._resyncArrowBases, 0);
    }

    private _resyncArrowBases(): void {
        if (!this._isOpen) return;
        this._captureOriginPositions();
        this._resetButtonPositions();
        this._restartArrowAnimations();
    }

    /** Apply OL + Widget rồi lấy vị trí base thực tế (không lấy lúc đang tween). */
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

    private _refreshLocalization(): void {
        this._setRichText(this.page1TitleLabel, this.Page1Title);
        this._setRichText(this.page1Content1Label, this.Page1Content1);

        this._setRichText(this.page2Title1Label, this.Page2Title1);
        this._setRichText(this.page2Title2Label, this.Page2Title2);
        this._setRichText(this.page2Content1Label, this.Page2Content1);
        this._setRichText(this.page2Content2Label, this.Page2Content2);

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

        this._setRichText(this.page7Title1Label, this.Page7Title1);
        this._setRichText(this.page7Content1Label, this.Page7Content1);

        this._setRichText(this.page8Title1Label, this.Page8Title1);
        this._setRichText(this.page8Content1Label, this.Page8Content1);
    }

    private _setRichText(label: RichText | null, key: string): void {
        if (!label || !key) return;
        label.string = L(key);
    }
}
