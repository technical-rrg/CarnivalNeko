/**
 * BuyBonusManager - Hệ thống "BUY BONUS SYSTEM" theo tài liệu thiết kế chuẩn quốc tế.
 *
 * ── KIẾN TRÚC ──
 *   - Component quản lý TOÀN BỘ flow mua/bật bonus item.
 *   - Tách biệt với BuyBonusPopup cũ (chỉ xử lý Free Spin ticket).
 *
 * ── NODE HIERARCHY ──
 *   popupRootNode               ← Node gốc chứa toàn bộ popup (active = false mặc định)
 *     ├── listPopupNode         ← Chỉ là panel danh sách item (không phải popup gốc)
 *     │     └── listContentNode ← Layout chứa các item row
 *     └── recheckPopupNode      ← Panel xác nhận mua
 *
 * ── MAPPING VỚI API SERVER ──
 *   IBonusItem.uniqueID        ← SlotFeatureItemInfo.Id
 *   IBonusItem.itemName        ← SlotFeatureItemInfo.Name
 *   IBonusItem.itemInfo        ← SlotFeatureItemInfo.Desc
 *   IBonusItem.applyType       ← Suy ra từ EffectType + TicketFeature
 *                                ("onceuse" = Ticket/AddSpins; "activate" = ExchangeReel/ProvideSymbol)
 *   IBonusItem.valueRatio      ← SlotFeatureItemInfo.PriceRatio
 *   IBonusItem.thumbnailImage  ← SlotFeatureItemInfo.ImgUrl
 *   Price (hiển thị)           = currentTotalBet × valueRatio
 *
 * ── FLOW USER ──
 *   1. User bấm mainBuyButton
 *       - Nếu đang có activeActivateItemId → CANCEL (tắt item đang bật).
 *       - Nếu không → Mở popupRootNode (toàn bộ popup hiện ra).
 *   2. Trong list, mỗi item hiển thị BUY (onceuse) hoặc ACTIVATE (activate).
 *       - Disable nút nếu Price > currentBalance.
 *   3. User bấm BUY/ACTIVATE → Mở recheckPopupNode xác nhận.
 *   4. Recheck CANCEL → Đóng recheck, giữ list.
 *   5. Recheck OK:
 *       - onceuse  → Gửi API mua Ticket /FeatureItemBuy.
 *       - activate → Set activeActivateItemId, đổi mainBuyButton thành CANCEL,
 *                    đổi màu Total Bet (cảnh báo user đang ở chế độ activate).
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo Node "BuyBonusManager" (root hoặc con Canvas).
 *   2. Gắn component BuyBonusManager.
 *   3. Kéo các tham chiếu vào Inspector:
 *      - mainBuyButton (nút đã có trong UIController)
 *      - popupRootNode (Node GỐC cha của toàn bộ popup, active=false)
 *        ├── popupCloseButton (nút X đóng popup, child của popupRootNode)
 *        ├── listPopupNode (chỉ là panel danh sách item bên trong popupRootNode)
 *        │     └── listContentNode (Layout chứa các item)
 *        │     ├── popupTotalBetLabel (hiển thị Total Bet)
 *        │     ├── popupBetIncreaseButton (nút +)
 *        │     └── popupBetDecreaseButton (nút -)
 *        └── recheckPopupNode (panel xác nhận, active=false)
 *              ├── recheckTitleLabel, recheckInfoLabel, recheckPriceLabel
 *              ├── recheckThumbnailSprite (hình item)
 *              └── recheckConfirmButton, recheckCancelButton
 *      - balanceLabel, totalBetLabel (optional, ngoài popup)
 *      - itemTemplate (Prefab/Node 1 row item)
 *      - buyBonusIcon, cancelIcon (2 SpriteFrame để đổi hình nút chính)
 *      - itemThumbnails (danh sách thumbnail)
 */

import {
    _decorator, Component, Node, Label, Button, Sprite,
    instantiate, Color, Layout, UITransform, screen, sp,
} from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { formatCurrency } from '../core/FormatUtils';
import { SpriteNumber } from '../core/SpriteNumber';
import { BetManager } from './BetManager';
import { BuyBonusItemUI, loadRemoteSprite } from '../data/BuyBonusItemUI';
import { FeatureItem } from '../data/SlotTypes';
import { WalletManager } from './WalletManager';
import { GameData } from '../data/GameData';
import { AutoSpinManager } from './AutoSpinManager';
import { Log } from '../core/Logger';

// ─── BONUS SYSTEM TYPES ───────────────────────────────────────────────────────
// Định nghĩa trực tiếp để tránh phụ thuộc vào cache của TS language server.
// Các type này cũng được export trong SlotTypes.ts và GameEvents.ts.

/** Loại áp dụng của BonusItem (mapping từ SlotPurchaseItemEffectType) */
export type BonusApplyType = 'onceuse' | 'activate';

/**
 * IBonusItem — Dữ liệu item bonus từ Server (SlotFeatureItemInfo).
 * - "onceuse": Mua đứt 1 lần → gọi API FeatureItemBuy (EffectType=1 Ticket / 4 AddSpins).
 * - "activate": Bật/Tắt → dùng OnOff trong FeatureItemBuy (EffectType=2 ExchangeReel / 3 ProvideSymbol).
 * - Price hiển thị = currentTotalBet × valueRatio (PriceRatio từ server).
 */
export interface IBonusItem {
    uniqueID: string;            // ← SlotFeatureItemInfo.Id (Int32 → string)
    itemName: string;            // ← SlotFeatureItemInfo.Name
    itemInfo: string;            // ← SlotFeatureItemInfo.Desc
    applyType: BonusApplyType;   // ← suy ra từ EffectType: "onceuse" hoặc "activate"
    valueRatio: number;          // ← SlotFeatureItemInfo.PriceRatio
    thumbnailImage: string;      // ← SlotFeatureItemInfo.ImgUrl
}

// ─── BONUS SYSTEM EVENT KEYS ──────────────────────────────────────────────────
// Định nghĩa cục bộ để tránh phụ thuộc vào cache GameEvents.
// Các key này cũng được khai báo trong GameEvents.ts.
const BONUS_EVT = {
    ITEMS_LOADED:      'bonussystem:items:loaded',
    ITEM_SELECTED:     'bonussystem:item:selected',
    ITEM_CONFIRMED:    'bonussystem:item:confirmed',
    ACTIVATE_ON:       'bonussystem:activate:on',
    ACTIVATE_OFF:      'bonussystem:activate:off',
    ONCEUSE_SUCCESS:   'bonussystem:onceuse:success',
    PRICES_UPDATED:    'bonussystem:prices:updated',
} as const;

const { ccclass, property } = _decorator;



@ccclass('BuyBonusManager')
export class BuyBonusManager extends Component {

    // ══════════════════════════════════════════════════════════════
    //  1. UI PROPERTIES (@property)
    // ══════════════════════════════════════════════════════════════

    @property({ type: Button, tooltip: 'Nút chính trên UIController (đổi image thành BuyBonus hoặc Cancel)' })
    mainBuyButton: Button | null = null;

    // ─── Popup root ───
    @property({
        type: Node,
        tooltip: 'Node GỐC chứa toàn bộ popup Buy Bonus (active=false mặc định).\nBật node này lên để hiển thị toàn bộ popup.',
    })
    popupRootNode: Node | null = null;

    @property({
        type: Node,
        tooltip: 'Panel danh sách item BÊN TRONG popupRootNode.\nKhông phải popup gốc — chỉ là con của popupRootNode.',
    })
    listPopupNode: Node | null = null;

    @property({
        type: Node,
        tooltip: 'ScrollView con của listPopupNode — để resize cùng lúc với listPopupNode',
    })
    scrollViewNode: Node | null = null;

    @property({ type: Node, tooltip: 'Panel xác nhận mua (recheck) — con của popupRootNode, active=false mặc định' })
    recheckPopupNode: Node | null = null;

    @property({ type: Label, tooltip: 'Label hiển thị Balance (optional)' })
    balanceLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label hiển thị Total Bet (dùng để đổi màu cảnh báo khi activate)' })
    totalBetLabel: Label | null = null;

    // ─── Spine nút chính (BuyBonus ↔ Cancel) ───
    @property({ type: sp.Skeleton, tooltip: 'Spine skeleton nút Buy Bonus / Cancel\nAnimation \'BUYBONUS\' khi chưa có item activate, \'CANCEL\' khi đang có\n→ Kéo sp.Skeleton node vào đây' })
    spineBuyBonus: sp.Skeleton | null = null;

    // ─── Item row template + container ───
    // ─── Recheck popup UI ───
    @property({ type: Label, tooltip: 'Label tiêu đề recheck popup (hiển thị itemName)' })
    recheckTitleLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label mô tả recheck popup (hiển thị itemInfo)' })
    recheckInfoLabel: Label | null = null;

    @property({ type: SpriteNumber, tooltip: 'SpriteNumber giá tiền recheck popup (hiển thị với sprite số)' })
    recheckPriceLabel: SpriteNumber | null = null;
    
    @property({ type: Node, tooltip: 'Parent chứa các item row (thường có Layout component)' })
    listContentNode: Node | null = null;
    
    
    @property({ type: Node, tooltip: 'Template 1 item (có cấu trúc con: NameLabel/InfoLabel/PriceLabel/ActionButton[/Label]/Thumbnail)' })
itemTemplate: Node | null = null;

    @property({ type: Button, tooltip: 'Nút OK trong recheck popup' })
    recheckConfirmButton: Button | null = null;

    @property({ type: Button, tooltip: 'Nút CANCEL trong recheck popup' })
    recheckCancelButton: Button | null = null;

    @property({ type: Button, tooltip: 'Nút đóng popup (X) — đặt trong popupRootNode' })
    popupCloseButton: Button | null = null;

    @property({ type: Sprite, tooltip: 'Sprite thumbnail trong recheck popup (hiển thị hình item đang xác nhận)' })
    recheckThumbnailSprite: Sprite | null = null;

    // ─── Total Bet UI trong popup (Spec slide 30) ───
    @property({ type: Label, tooltip: 'Label hiển thị giá trị Total Bet bên trong popup (cập nhật real-time)' })
    popupTotalBetLabel: Label | null = null;

    @property({ type: Button, tooltip: 'Nút tăng mức cược (+) trong popup' })
    popupBetIncreaseButton: Button | null = null;

    @property({ type: Button, tooltip: 'Nút giảm mức cược (-) trong popup' })
    popupBetDecreaseButton: Button | null = null;

    // ─── Màu cảnh báo Total Bet khi activate ───
    @property({ tooltip: 'Màu mặc định của totalBetLabel' })
    totalBetNormalColor: Color = new Color(255, 255, 255, 255);

    @property({ tooltip: 'Màu cảnh báo totalBetLabel khi đang có item activate bật' })
    totalBetWarningColor: Color = new Color(255, 80, 80, 255);

    // ─── Mock data (chỉ dùng khi API chưa có) ───
    @property({ tooltip: '[DEV] Tự động load mock data khi onLoad (tắt khi API thật có dữ liệu)' })
    useMockData: boolean = true;

    // ══════════════════════════════════════════════════════════════
    //  2. STATE VARIABLES
    // ══════════════════════════════════════════════════════════════

    /** Danh sách item lấy từ Server */
    private availableItems: IBonusItem[] = [];

    /** Tổng cược hiện tại — dùng để tính giá item real-time */
    private currentTotalBet: number = 0;

    /** Số dư hiện tại — dùng để disable nút nếu không đủ tiền */
    private currentBalance: number = 0;

    /**
     * Lưu uniqueID của item "activate" ĐANG ĐƯỢC BẬT.
     * Luật: Chỉ được dùng TỐI ĐA 1 item activate tại 1 thời điểm!
     */
    private activeActivateItemId: string | null = null;

    /** Item đang chờ xác nhận trong recheck popup */
    private _pendingRecheckItem: IBonusItem | null = null;

    /** Item đang chờ server xác nhận activate */
    private _pendingActivateItem: IBonusItem | null = null;

    /** PriceRatio của item activate đang bật (để tính extra bet) */
    private _activeItemPriceRatio: number = 0;

    /** Mảng các BuyBonusItemUI đã tạo trong list popup (để update khi bet/balance đổi) */
    private _itemRows: BuyBonusItemUI[] = [];

    /** Label của mainBuyButton (nếu có) — để đổi text BUY BONUS ↔ CANCEL */
    private _mainBuyButtonLabel: Label | null = null;

    // ── SINGLETON ─────────────────────────────────────────────────────────────
    private static _instance: BuyBonusManager | null = null;
    static get instance(): BuyBonusManager | null { return BuyBonusManager._instance; }

    /** PriceRatio của item activate đang bật (0 = không có) */
    get activeItemPriceRatio(): number { return this._activeItemPriceRatio; }
    /** ID của item activate đang bật (null = không có) */
    get hasActiveItem(): boolean { return this.activeActivateItemId !== null; }

    // ─── Game state tracking ───
    /** Spin cycle đang chạy (tính cả win presentation) → khóa nút BUY BONUS */
    private _isSpinCycleActive: boolean = false;
    /** Đang trong Feature/Bonus game → mờ nút */
    private _isInFeatureGame: boolean = false;
    /** Đang trong AutoSpin → mờ nút */
    private _isAutoSpinActive: boolean = false;

    // ══════════════════════════════════════════════════════════════
    //  LIFECYCLE
    // ══════════════════════════════════════════════════════════════

    onLoad(): void {
        BuyBonusManager._instance = this;
        Log.d('[BuyBonusManager] onLoad() START');
        Log.d(`  ├─ useMockData=${this.useMockData}`);
        Log.d(`  ├─ mainBuyButton=${!!this.mainBuyButton}`);
        Log.d(`  ├─ popupRootNode=${!!this.popupRootNode}`);
        Log.d(`  └─ recheckPopupNode=${!!this.recheckPopupNode}`);

        // Đảm bảo popup tắt mặc định
        if (this.popupRootNode) this.popupRootNode.active = false;
        if (this.recheckPopupNode) this.recheckPopupNode.active = false;
        if (this.itemTemplate) this.itemTemplate.active = false; // template chỉ dùng để clone

        // Cache label của mainBuyButton
        if (this.mainBuyButton) {
            this._mainBuyButtonLabel = this.mainBuyButton.getComponentInChildren(Label);
            Log.d(`  └─ mainBuyButton components: label=${!!this._mainBuyButtonLabel}`);
        }

        // Khởi tạo spine: để spine tự play theo default animation đã set trong Editor
        // KHÔNG gọi setAnimation() ở đây để tránh gây giật khi scene transition

        screen.on('orientation-change', this._onOrientationChange, this);

        this._bindButtons();
        this._bindEvents();
        
        // Load mock data nếu đang ở chế độ dev
        if (this.useMockData) {
            Log.d('[BuyBonusManager] [DEV] Loading mock data...');
            this._loadMockData();
        } else {
            Log.d('[BuyBonusManager] [PROD] Sẽ dùng real API — chờ user nhấn nút');
        }
        Log.d('[BuyBonusManager] onLoad() DONE\n');
    }

    onDestroy(): void {
        screen.off('orientation-change', this._onOrientationChange, this);
        EventBus.instance.offTarget(this);
        if (BuyBonusManager._instance === this) BuyBonusManager._instance = null;
    }

    // ══════════════════════════════════════════════════════════════
    //  BINDINGS
    // ══════════════════════════════════════════════════════════════

    private _bindButtons(): void {
        Log.d('[BuyBonusManager] _bindButtons() START');
        if (this.mainBuyButton) {
            this.mainBuyButton.node.on(Button.EventType.CLICK, this.onMainButtonClick, this);
            Log.d('  ├─ mainBuyButton: listener gắn ✓');
        } else {
            Log.w('  ├─ mainBuyButton: CHƯA GÁN');
        }
        if (this.recheckConfirmButton) {
            this.recheckConfirmButton.node.on(Button.EventType.CLICK, this._onRecheckConfirm, this);
            Log.d('  ├─ recheckConfirmButton: listener gắn ✓');
        }
        if (this.recheckCancelButton) {
            this.recheckCancelButton.node.on(Button.EventType.CLICK, this._onRecheckCancel, this);
            Log.d('  ├─ recheckCancelButton: listener gắn ✓');
        }
        // Nút đóng popup (X)
        if (this.popupCloseButton) {
            this.popupCloseButton.node.on(Button.EventType.CLICK, this._closePopup, this);
            Log.d('  ├─ popupCloseButton: listener gắn ✓');
        }
        // Spec slide 30: nút +/- cược trong popup
        if (this.popupBetIncreaseButton) {
            this.popupBetIncreaseButton.node.on(Button.EventType.CLICK, this._onPopupBetIncrease, this);
            Log.d('  ├─ popupBetIncreaseButton: listener gắn ✓');
        }
        if (this.popupBetDecreaseButton) {
            this.popupBetDecreaseButton.node.on(Button.EventType.CLICK, this._onPopupBetDecrease, this);
            Log.d('  └─ popupBetDecreaseButton: listener gắn ✓');
        }
        Log.d('[BuyBonusManager] _bindButtons() DONE\n');
    }

    private _bindEvents(): void {
        const bus = EventBus.instance;
        // Tự động update giá khi user đổi bet
        bus.on(GameEvents.BET_CHANGED, this._onBetChangedExternal, this);
        // Tự động update balance
        bus.on(GameEvents.BALANCE_UPDATED, this._onBalanceUpdatedExternal, this);
        // Nhận danh sách item sau khi GameManager gọi FeatureItemGet thành công
        bus.on(GameEvents.BUY_BONUS_ITEMS_LOADED, this._onItemsLoadedExternal, this);
        // Activate/Deactivate success/fail
        bus.on(GameEvents.BUY_BONUS_ACTIVATE_SUCCESS, this._onActivateSuccess, this);
        bus.on(GameEvents.BUY_BONUS_DEACTIVATE_SUCCESS, this._onDeactivateSuccess, this);
        bus.on(GameEvents.BUY_BONUS_FAILED, this._onActivateFailed, this);
        // Khóa nút trong suốt spin cycle (bao gồm cả win presentation).
        // Dùng UI_SPIN_BUTTON_STATE thay vì REELS_STOPPED/WIN_PRESENT_END để tránh race condition
        // khi WinPresenter emit WIN_PRESENT_END đồng bộ trong lúc xử lý WIN_PRESENT_START.
        bus.on(GameEvents.REELS_START_SPIN,       this._onReelsStartSpin,    this);
        bus.on(GameEvents.UI_SPIN_BUTTON_STATE,   this._onSpinButtonState,   this);
        // Spec slide 24 + 46: ẩn nút trong Feature game
        bus.on(GameEvents.FREE_SPIN_START, this._onFeatureGameStart, this);
        bus.on(GameEvents.FREE_SPIN_END,   this._onFeatureGameEnd,   this);
        // Ẩn nút trong AutoSpin
        bus.on(GameEvents.AUTO_SPIN_CHANGED, this._onAutoSpinChanged, this);
    }

    // ══════════════════════════════════════════════════════════════
    //  3. CORE LOGIC & METHODS (BẮT BUỘC THEO SPEC)
    // ══════════════════════════════════════════════════════════════

    /**
     * Khởi tạo hệ thống với dữ liệu từ Server.
     * @param items    Danh sách IBonusItem nhận từ API FeatureItemGet
     * @param balance  Số dư hiện tại
     * @param totalBet Tổng cược hiện tại
     */
    public initSystem(items: IBonusItem[], balance: number, totalBet: number): void {
        Log.d(`[BuyBonusManager] initSystem — items=${items.length}, balance=${balance}, totalBet=${totalBet}`);
        this.availableItems = items.slice();
        this.currentBalance = balance;
        this.currentTotalBet = totalBet;
        // Reset trạng thái activate khi khởi tạo lại
        this.activeActivateItemId = null;
        this._activeItemPriceRatio = 0;
        // Không gọi _updateMainButtonAppearance() khi reset về default
        // để tránh gọi setAnimation() và làm giật spine
        this._updateTotalBetDisplay();
    }

    /**
     * Gọi khi user đổi mức cược.
     * BẮT BUỘC tính lại giá của tất cả item: Price = newBet * item.valueRatio.
     */
    public updateTotalBet(newBet: number): void {
        this.currentTotalBet = newBet;
        Log.d(`[BuyBonusManager] updateTotalBet → ${newBet}, cập nhật lại giá của ${this.availableItems.length} item`);

        // Re-render giá + trạng thái disable của các row đang hiển thị (nếu list popup đang mở)
        for (const row of this._itemRows) {
            const item = row.item;
            if (!item) continue;
            const price = this.currentTotalBet * item.valueRatio;
            row.refresh(price, price <= this.currentBalance);
        }

        EventBus.instance.emit(BONUS_EVT.PRICES_UPDATED);
    }

    /**
     * Handler cho mainBuyButton.
     * - Nếu đang có activeActivateItemId → đóng vai trò CANCEL, tắt item đang bật.
     * - Nếu không → mở popupRootNode (toàn bộ popup hiện ra).
     */
    public onMainButtonClick(): void {
        if (this.activeActivateItemId !== null) {
            // Đang có item activate BẬT → Nút này là CANCEL
            Log.d(`[BuyBonusManager] mainButton CLICK as CANCEL → tắt item activate id=${this.activeActivateItemId}`);
            this._deactivateItem();
            return;
        }

        Log.d('[BuyBonusManager] mainButton CLICK as BUY BONUS');

        if (this.useMockData) {
            // Dev mode: dùng mock data đã có, mở popup ngay
            Log.d('[BuyBonusManager] [DEV] useMockData=true → mở popup ngay với mock data');
            this._openPopup();
        } else {
            // Real API mode: emit BUY_BONUS_REQUEST → GameManager gọi FeatureItemGet
            // Popup sẽ mở sau khi nhận BUY_BONUS_ITEMS_LOADED
            Log.d('[BuyBonusManager] Emit BUY_BONUS_REQUEST → GameManager sẽ gọi FeatureItemGet...');
            EventBus.instance.emit(GameEvents.BUY_BONUS_REQUEST);
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  4. POPUP LOGIC
    // ══════════════════════════════════════════════════════════════

    /** Mở toàn bộ popup (bật popupRootNode, hiển thị listPopupNode, ẩn recheck) */
    private _openPopup(): void {
        Log.d('[BuyBonusManager] _openPopup()');
        if (!this.popupRootNode) {
            Log.w('[BuyBonusManager] popupRootNode chưa gán — không thể mở popup');
            return;
        }
        this.popupRootNode.active = true;
        if (this.listPopupNode) this.listPopupNode.active = true;
        if (this.recheckPopupNode) this.recheckPopupNode.active = false;
        Log.d('  ├─ popupRootNode.active = true');
        Log.d('  └─ Render item list...');
        this._refreshPopupTotalBetLabel();
        this._renderItemList();
    }

    /** Đóng toàn bộ popup (tắt popupRootNode) */
    private _closePopup(): void {
        if (this.popupRootNode) this.popupRootNode.active = false;
        if (this.recheckPopupNode) this.recheckPopupNode.active = false;
    }

    /** Gen UI cho danh sách item */
    private _renderItemList(): void {
        Log.d(`[BuyBonusManager] _renderItemList() — rendering ${this.availableItems.length} item(s)`);
        if (!this.listContentNode) {
            Log.w('[BuyBonusManager] listContentNode chưa gán');
            return;
        }

        // Xóa row cũ
        this.listContentNode.removeAllChildren();
        this._itemRows = [];

        // Reset position về gốc để tránh content node bị lệch khi mở popup lần 2+
        this.listContentNode.setPosition(0, 0, 0);

        if (!this.itemTemplate) {
            Log.w('[BuyBonusManager] itemTemplate chưa gán');
            return;
        }

        // Clone template, lấy BuyBonusItemUI và gọi setup()
        for (let i = 0; i < this.availableItems.length; i++) {
            const item = this.availableItems[i];
            const rowNode = instantiate(this.itemTemplate);
            rowNode.active = true;
            rowNode.parent = this.listContentNode;

            const itemUI = rowNode.getComponent(BuyBonusItemUI);
            if (!itemUI) {
                Log.w('[BuyBonusManager] BuyBonusItemUI không tìm thấy trên itemTemplate — kiểm tra lại prefab');
                continue;
            }

            const price = this._calcPrice(item);
            const canAfford = price <= this.currentBalance;
            itemUI.setup(item, price, canAfford, this._onItemActionClick.bind(this));
            this._itemRows.push(itemUI);
            Log.d(`  [${i}] ${item.itemName} — price=${price}, canAfford=${canAfford}`);
        }

        // Force layout recalculate để item list luôn nằm đúng vị trí (fix issue item bị lệch sang trái khi open popup lần 2)
        const layout = this.listContentNode.getComponent(Layout);
        if (layout) {
            layout.updateLayout();
        }
        // Đảm bảo content node luôn canh giữa (x = 0) bất kể ScrollView đã dịch vị trí
        const pos = this.listContentNode.position;
        this.listContentNode.setPosition(0, pos.y, pos.z);
        this._resizeListPopup();
        Log.d(`✓ Done rendering ${this._itemRows.length} item row(s)\n`);
    }

    /** Tính giá 1 item theo công thức Price = currentTotalBet × valueRatio */
    private _calcPrice(item: IBonusItem): number {
        return this.currentTotalBet * item.valueRatio;
    }

    /**
     * Resize listPopupNode.width và scrollViewNode.width theo listContentNode.width + 20,
     * giới hạn max theo orientation:
     *   - Landscape : max = 4 × (single-item width + 20)
     *   - Portrait  : max = 2 × (single-item width + 20)
     */
    private _resizeListPopup(): void {
        if (!this.listPopupNode || !this.listContentNode) return;

        const popupUI   = this.listPopupNode.getComponent(UITransform);
        const contentUI = this.listContentNode.getComponent(UITransform);
        if (!popupUI || !contentUI) return;

        // Chiều rộng của 1 item (dùng từ template hoặc row đầu tiên đã render)
        let itemW = 0;
        if (this.itemTemplate) {
            const t = this.itemTemplate.getComponent(UITransform);
            if (t) itemW = t.width;
        }
        if (itemW <= 0 && this._itemRows.length > 0) {
            const t = this._itemRows[0].node.getComponent(UITransform);
            if (t) itemW = t.width;
        }
        if (itemW <= 0) itemW = contentUI.width; // fallback

        const unit       = itemW + 20;
        const isLandscape = screen.windowSize.width >= screen.windowSize.height;
        const maxCols    = isLandscape ? 4 : 2;
        const maxW       = maxCols * unit;
        const finalW     = Math.min(contentUI.width + 20, maxW);

        popupUI.width = finalW;

        // Resize scrollViewNode cùng width
        if (this.scrollViewNode) {
            const scrollUI = this.scrollViewNode.getComponent(UITransform);
            if (scrollUI) {
                scrollUI.width = finalW;
            }
        }

        Log.d(`[BuyBonusManager] _resizeListPopup: itemW=${itemW}, unit=${unit}, maxCols=${maxCols}, maxW=${maxW}, result=${finalW}`);
    }

    private _onOrientationChange(): void {
        this._resizeListPopup();
    }

    /**
     * User bấm BUY/ACTIVATE trên 1 item → KHÔNG mua ngay, mở recheck popup.
     */
    private _onItemActionClick(item: IBonusItem): void {
        // Double-check đủ tiền (phòng trường hợp user vừa bấm xong thì balance thay đổi)
        const price = this._calcPrice(item);
        if (price > this.currentBalance) {
            Log.w(`[BuyBonusManager] Không đủ tiền mua item ${item.uniqueID}: price=${price}, balance=${this.currentBalance}`);
            return;
        }

        Log.d(`[BuyBonusManager] User chọn item ${item.uniqueID} (${item.applyType}) → mở recheck popup`);
        this._pendingRecheckItem = item;
        this._openRecheckPopup(item);

        EventBus.instance.emit(BONUS_EVT.ITEM_SELECTED, item);
    }

    // ══════════════════════════════════════════════════════════════
    //  5. RECHECK POPUP LOGIC
    // ══════════════════════════════════════════════════════════════

    /** Mở recheck popup và truyền dữ liệu item */
    private _openRecheckPopup(item: IBonusItem): void {
        if (!this.recheckPopupNode) {
            Log.w('[BuyBonusManager] recheckPopupNode chưa gán');
            return;
        }
        this.recheckPopupNode.active = true;

        if (this.recheckTitleLabel) this.recheckTitleLabel.string = item.itemName;
        if (this.recheckInfoLabel)  this.recheckInfoLabel.string  = item.itemInfo;
        if (this.recheckPriceLabel) this.recheckPriceLabel.setData(this._calcPrice(item), 0, 0);

        // Spec slide 31: hiển thị thumbnail trong recheck popup
        if (this.recheckThumbnailSprite && item.thumbnailImage) {
            loadRemoteSprite(item.thumbnailImage, (frame) => {
                if (this.recheckThumbnailSprite && frame) this.recheckThumbnailSprite.spriteFrame = frame;
            });
        }
    }

    /** Đóng recheck popup (không đóng list) */
    private _closeRecheckPopup(): void {
        if (this.recheckPopupNode) this.recheckPopupNode.active = false;
        this._pendingRecheckItem = null;
    }

    /** Recheck CANCEL: đóng recheck, giữ list popup mở */
    private _onRecheckCancel(): void {
        Log.d('[BuyBonusManager] Recheck CANCEL — giữ nguyên list popup');
        this._closeRecheckPopup();
    }

    /** Recheck OK: đóng toàn bộ popup, xử lý theo applyType */
    private _onRecheckConfirm(): void {
        const item = this._pendingRecheckItem;
        if (!item) {
            Log.w('[BuyBonusManager] Recheck OK nhưng không có pending item');
            this._closeRecheckPopup();
            return;
        }

        Log.d(`[BuyBonusManager] Recheck OK — confirm item ${item.uniqueID} (${item.applyType})`);

        // Đóng toàn bộ popup
        this._closeRecheckPopup();
        this._closePopup();

        EventBus.instance.emit(BONUS_EVT.ITEM_CONFIRMED, item);

        if (item.applyType === 'onceuse') {
            this._confirmOnceUse(item);
        } else {
            this._confirmActivate(item);
        }
    }

    /** Xử lý xác nhận item loại ONCEUSE (mua đứt) */
    private _confirmOnceUse(item: IBonusItem): void {
        const price = this._calcPrice(item);
        Log.d(`[BuyBonusManager] Gửi BUY_BONUS_CONFIRM | itemId=${item.uniqueID} | price=${price}`);

        // Map IBonusItem → FeatureItem để GameManager._onBuyBonusConfirm xử lý:
        //   - Gọi NetworkManager.sendFeatureItemBuy (mock hoặc real)
        //   - Cập nhật balance
        //   - Gọi _enterFreeSpin → hiện FreeSpinPopup → bắt đầu vòng quay miễn phí
        const featureItem: FeatureItem = {
            itemId:       parseInt(item.uniqueID, 10) || 0,
            name:         item.itemName,
            title:        item.itemName,
            desc:         item.itemInfo,
            priceRatio:   item.valueRatio,
            effectType:   item.applyType === 'activate' ? 2 : 1,
            imgUrl:       item.thumbnailImage || '',
            addSpinValue: undefined,
        };

        // GameManager lắng nghe BUY_BONUS_CONFIRM → sendFeatureItemBuy → _enterFreeSpin
        EventBus.instance.emit(GameEvents.BUY_BONUS_CONFIRM, featureItem);
        // Giữ lại ONCEUSE_SUCCESS để các module khác (Analytics,...) có thể lắng nghe nếu cần
        EventBus.instance.emit(BONUS_EVT.ONCEUSE_SUCCESS, item);
    }

    /** Xử lý xác nhận item loại ACTIVATE (bật) — gọi server API */
    private _confirmActivate(item: IBonusItem): void {
        Log.d(`[BuyBonusManager] Confirm ACTIVATE: ${item.uniqueID} — gọi server...`);

        const featureItem: FeatureItem = {
            itemId:       parseInt(item.uniqueID, 10) || 0,
            name:         item.itemName,
            title:        item.itemName,
            desc:         item.itemInfo,
            priceRatio:   item.valueRatio,
            effectType:   2,
            imgUrl:       item.thumbnailImage || '',
            addSpinValue: undefined,
        };

        // Lưu item đang chờ activate để set state khi nhận SUCCESS
        this._pendingActivateItem = item;
        EventBus.instance.emit(GameEvents.BUY_BONUS_ACTIVATE, featureItem);
    }

    /** Server activate thành công — set local state */
    private _onActivateSuccess(data: { itemId: number, priceRatio: number }): void {
        const item = this._pendingActivateItem;
        this._pendingActivateItem = null;

        if (!item) {
            Log.w('[BuyBonusManager] Activate SUCCESS nhưng không có pending item');
            return;
        }

        // Luật: chỉ 1 activate tại 1 thời điểm
        if (this.activeActivateItemId !== null && this.activeActivateItemId !== item.uniqueID) {
            Log.d(`[BuyBonusManager] Override activate: cũ=${this.activeActivateItemId} → mới=${item.uniqueID}`);
        }

        this.activeActivateItemId = item.uniqueID;
        this._activeItemPriceRatio = item.valueRatio;
        Log.d(`[BuyBonusManager] Item ACTIVATE BẬT: ${item.uniqueID}, priceRatio=${item.valueRatio}`);

        this._updateMainButtonAppearance();
        this._updateTotalBetDisplay();

        EventBus.instance.emit(BONUS_EVT.ACTIVATE_ON, { itemId: item.uniqueID });
    }

    /** Server activate/deactivate thất bại — reset pending */
    private _onActivateFailed(_msg: string): void {
        this._pendingActivateItem = null;
    }

    /** Tắt item activate đang bật — gọi server API (ItemId=0) */
    private _deactivateItem(): void {
        const prevId = this.activeActivateItemId;
        Log.d(`[BuyBonusManager] Deactivate request: itemId=${prevId}`);

        // Gọi server để hủy — chờ SUCCESS mới clear local state
        EventBus.instance.emit(GameEvents.BUY_BONUS_DEACTIVATE);
    }

    /** Server deactivate thành công — clear local state */
    private _onDeactivateSuccess(): void {
        const prevId = this.activeActivateItemId;
        this.activeActivateItemId = null;
        this._activeItemPriceRatio = 0;
        Log.d(`[BuyBonusManager] Item ACTIVATE TẮT: ${prevId}`);

        this._updateMainButtonAppearance();
        this._updateTotalBetDisplay();

        if (prevId !== null) {
            EventBus.instance.emit(BONUS_EVT.ACTIVATE_OFF, { itemId: prevId });
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  UI HELPERS
    // ══════════════════════════════════════════════════════════════

    /** Đổi animation spine + label của mainBuyButton theo trạng thái activeActivateItemId */
    private _updateMainButtonAppearance(): void {
        if (!this.mainBuyButton) return;

        const isCancelMode = this.activeActivateItemId !== null;

        // Đổi label text (nếu có)
        if (this._mainBuyButtonLabel) {
            this._mainBuyButtonLabel.string = isCancelMode ? 'CANCEL' : 'BUY BONUS';
        }

        // Đổi animation spine (cùng 1 node, đổi animation)
        if (this.spineBuyBonus) {
            this.spineBuyBonus.setAnimation(0, isCancelMode ? 'CANCEL' : 'BUYBONUS', true);
        }
    }

    /** Đổi màu totalBetLabel: warning khi có activate bật, normal khi không */
    private _updateTotalBetLabelColor(): void {
        if (!this.totalBetLabel) return;
        this.totalBetLabel.color = this.activeActivateItemId !== null
            ? this.totalBetWarningColor
            : this.totalBetNormalColor;
    }

    /**
     * Cập nhật hiển thị Total Bet:
     *   - Khi activate ON:  displayBet = baseBet × (1 + priceRatio), đổi màu cảnh báo
     *   - Khi activate OFF: displayBet = baseBet, màu bình thường
     */
    private _updateTotalBetDisplay(): void {
        const baseBet = BetManager.instance.totalBet;
        const isActive = this.activeActivateItemId !== null;
        const displayBet = isActive
            ? baseBet * this._activeItemPriceRatio
            : baseBet;

        if (this.totalBetLabel) {
            this.totalBetLabel.string = formatCurrency(displayBet);
            this.totalBetLabel.color = isActive
                ? this.totalBetWarningColor
                : this.totalBetNormalColor;
        }
        Log.d(`[BuyBonusManager] _updateTotalBetDisplay: base=${baseBet}, ratio=${this._activeItemPriceRatio}, display=${displayBet}, active=${isActive}`);
    }

    // ══════════════════════════════════════════════════════════════
    //  EXTERNAL EVENT HANDLERS (tự đồng bộ với game)
    // ══════════════════════════════════════════════════════════════

    /** Khi BetManager emit BET_CHANGED → cập nhật totalBet */
    private _onBetChangedExternal(info: { totalBet: number }): void {
        if (info && typeof info.totalBet === 'number') {
            this.updateTotalBet(info.totalBet);
        }
        // Spec slide 30: cập nhật label Total Bet trong popup
        this._refreshPopupTotalBetLabel();
        // Cập nhật hiển thị Total Bet (có thể thay đổi khi activate item ON)
        this._updateTotalBetDisplay();
    }

    /** Khi WalletManager emit BALANCE_UPDATED → cập nhật balance và re-check disable */
    private _onBalanceUpdatedExternal(balance: number): void {
        this.currentBalance = balance;
        for (const row of this._itemRows) {
            const item = row.item;
            if (!item) continue;
            const price = this._calcPrice(item);
            row.refresh(price, price <= balance);
        }
        // Spec slide 45: tự động tắt item activate nếu balance không đủ cho lượt spin tiếp theo
        if (this.activeActivateItemId !== null) {
            const activeItem = this.availableItems.find(i => i.uniqueID === this.activeActivateItemId);
            if (activeItem) {
                const cost = this._calcPrice(activeItem);
                if (balance < cost) {
                    Log.d(`[BuyBonusManager] Balance (${balance}) < cost (${cost}) → auto-deactivate item ${this.activeActivateItemId}`);
                    this._deactivateItem();
                }
            }
        }
    }

    /** Nhận kết quả FeatureItemGet từ GameManager (emit GameEvents.BUY_BONUS_ITEMS_LOADED với FeatureItem[]) */
    private _onItemsLoadedExternal(serverItems: FeatureItem[]): void {
        if (!Array.isArray(serverItems)) {
            Log.w('[BuyBonusManager] BUY_BONUS_ITEMS_LOADED: payload không phải array, bỏ qua.');
            return;
        }

        Log.d(`[BuyBonusManager] ✅ FeatureItemGet → nhận ${serverItems.length} item(s):`);
        serverItems.forEach((it, i) => {
            Log.d(`  [${i}] itemId=${it.itemId}  name="${it.name}"  priceRatio=${it.priceRatio}  effectType=${it.effectType}  desc="${it.desc}"`);
        });

        const currentBet = BetManager.instance.totalBet;
        const balance    = WalletManager.instance.balance;

        // EffectType: 1=Ticket, 4=AddSpins → onceuse; 2=ExchangeReel, 3=ProvideSymbol → activate
        const getApplyType = (effectType: number): BonusApplyType =>
            (effectType === 2 || effectType === 3) ? 'activate' : 'onceuse';

        // Convert FeatureItem[] → IBonusItem[]
        // priceRatio đã là bội số × totalBet → dùng trực tiếp làm valueRatio
        const bonusItems: IBonusItem[] = serverItems.map(it => ({
            uniqueID:       String(it.itemId),
            itemName:       it.title || it.name,
            itemInfo:       it.desc,
            applyType:      getApplyType(it.effectType),
            valueRatio:     it.priceRatio,
            thumbnailImage: it.imgUrl,
        }));

        Log.d(`[BuyBonusManager] Đã convert → ${bonusItems.length} IBonusItem, currentBet=${currentBet}, balance=${balance}`);

        this.initSystem(bonusItems, balance, currentBet);
        this._openPopup();
    }

    // ══════════════════════════════════════════════════════════════
    //  [DEV] MOCK DATA — xoá / tắt khi API thật hoạt động
    // ══════════════════════════════════════════════════════════════

    /**
     * Tạo 3 item giả để test toàn bộ flow Buy Bonus:
     *   - Item 0: activate — "Symbol Booster"  (tăng xác suất symbol đặc biệt)
     *   - Item 1: activate — "Double Reel"     (đổi reel strip tăng multiplier)
     *   - Item 2: onceuse  — "10 Free Spins"   (mua vé vào Free Spin)
     */
    private _loadMockData(): void {
        const mockItems: IBonusItem[] = [
            {
                uniqueID:       'mock_activate_01',
                itemName:       'Symbol Booster',
                itemInfo:       'Tăng xác suất xuất hiện của Wild symbol trong Base Game.',
                applyType:      'activate',
                valueRatio:     5,      // Price = TotalBet × 5
                thumbnailImage: '',
            },
            {
                uniqueID:       'mock_activate_02',
                itemName:       'Double Reel',
                itemInfo:       'Thay thế reel strip để tăng tần suất symbol cao điểm.',
                applyType:      'activate',
                valueRatio:     10,     // Price = TotalBet × 10
                thumbnailImage: '',
            },
            {
                uniqueID:       'mock_onceuse_01',
                itemName:       '10 Free Spins',
                itemInfo:       'Mua ngay 10 lượt quay miễn phí, vào Free Bonus Game ngay lập tức.',
                applyType:      'onceuse',
                valueRatio:     100,    // Price = TotalBet × 100
                thumbnailImage: '',
            },
        ];

        const mockBalance  = 50_000_000;
        const mockTotalBet = BetManager.instance.totalBet > 0
            ? BetManager.instance.totalBet
            : 1000;

        Log.d('[BuyBonusManager] [DEV] Load mock data — 3 items, balance=', mockBalance, ', totalBet=', mockTotalBet);
        this.initSystem(mockItems, mockBalance, mockTotalBet);
    }

    // ══════════════════════════════════════════════════════════════
    //  SPIN / WIN / FEATURE GAME STATE HANDLERS
    // ══════════════════════════════════════════════════════════════

    /** Khóa nút ngay khi reel bắt đầu quay */
    private _onReelsStartSpin(): void {
        this._isSpinCycleActive = true;
        this._updateButtonStates();
    }

    /**
     * UI_SPIN_BUTTON_STATE(true) → toàn bộ spin cycle (bao gồm win presentation) đã xong.
     * UI_SPIN_BUTTON_STATE(false) → GameManager đang trong POPUP hoặc jackpot, giữ dim.
     */
    private _onSpinButtonState(enabled: boolean): void {
        this._isSpinCycleActive = !enabled;
        this._updateButtonStates();
    }

    /** Spec slide 24 + 46: ẩn nút khi vào Feature game */
    private _onFeatureGameStart(): void {
        this._isInFeatureGame = true;
        this._updateButtonStates();
    }

    /** Spec slide 46: hiện lại nút (và CANCEL nếu còn activate item) khi thoát Feature game */
    private _onFeatureGameEnd(): void {
        this._isInFeatureGame = false;
        this._updateButtonStates();
    }

    /** Ẩn nút Buy Bonus khi AutoSpin đang chạy (isAutoSpinActive), hiện lại khi dừng */
    private _onAutoSpinChanged(_count: number): void {
        this._isAutoSpinActive = AutoSpinManager.instance.isAutoSpinActive;
        Log.d(`[BuyBonusManager] _onAutoSpinChanged: autoSpin=${this._isAutoSpinActive} (count=${_count})`);
        this._updateButtonStates();
    }

    /**
     * Cập nhật trạng thái hiển thị / tương tác của mainBuyButton theo game state.
     * - Feature game đang chạy  → ẩn hoàn toàn (active = false)
     * - AutoSpin đang chạy      → giữ visible, tắt interactable, alpha = 128 (50%)
     * - Reel đang quay hoặc win đang diễn → dim (interactable = false)
     * - Idle bình thường         → hiển thị và enable, alpha = 255
     */
    private _updateButtonStates(): void {
        if (!this.mainBuyButton) return;
        const node = this.mainBuyButton.node;
        const isLocked = this._isSpinCycleActive;

      //  Log.d(`[BuyBonusManager] _updateButtonStates: isFeature=${this._isInFeatureGame}, isAutoSpin=${this._isAutoSpinActive}, isSpin=${this._isSpinActive}, isWin=${this._isWinPresenting}, hasSpine=${!!this.spineBuyBonus?.node}`);

        if (this._isInFeatureGame) {
            // Free Spin: mờ alpha=50%, không cho tương tác (giống autoSpin, không ẩn hừn)
            node.active = true;
            this.mainBuyButton.interactable = false;
            if (this.spineBuyBonus?.node) {
                this.spineBuyBonus.node.active = true;
                this.spineBuyBonus.color = new Color(255, 255, 255, 128);
            }
        } else {
            node.active = true;
            // Dim khi: autoSpin đang chạy, reel đang quay, hoặc win đang diễn
            const shouldDim = this._isAutoSpinActive || isLocked;
            if (this.spineBuyBonus?.node) {
                this.spineBuyBonus.node.active = true;
                this.spineBuyBonus.color = shouldDim
                    ? new Color(255, 255, 255, 128)   // 50% dim
                    : new Color(255, 255, 255, 255);  // 100%
            }
            if (shouldDim) {
                this.mainBuyButton.interactable = false;
            } else {
                this.mainBuyButton.interactable = true;
            }
        }
    }

    // ─── Popup Total Bet UI handlers (Spec slide 30) ───

    /** Nút (+) tăng mức cược — gọi BetManager rồi cập nhật price */
    private _onPopupBetIncrease(): void {
        BetManager.instance.changeBetIndex(1);
        // BET_CHANGED event sẽ tự cập nhật giá qua _onBetChangedExternal
    }

    /** Nút (-) giảm mức cược — gọi BetManager rồi cập nhật price */
    private _onPopupBetDecrease(): void {
        BetManager.instance.changeBetIndex(-1);
    }

    /** Cập nhật text của popupTotalBetLabel theo giá trị Total Bet hiện tại */
    private _refreshPopupTotalBetLabel(): void {
        if (this.popupTotalBetLabel) {
            this.popupTotalBetLabel.string = formatCurrency(BetManager.instance.totalBet);
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  PUBLIC GETTERS (để module khác check state)
    // ══════════════════════════════════════════════════════════════

    /** Trả về ID của item activate đang bật, hoặc null nếu không có */
    public getActiveActivateItemId(): string | null {
        return this.activeActivateItemId;
    }

    /** Có item activate đang bật không */
    public hasActiveActivateItem(): boolean {
        return this.activeActivateItemId !== null;
    }

    /** Lấy snapshot danh sách item hiện tại */
    public getAvailableItems(): ReadonlyArray<IBonusItem> {
        return this.availableItems;
    }
    
}
