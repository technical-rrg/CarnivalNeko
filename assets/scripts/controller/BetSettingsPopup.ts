/**
 * BetSettingsPopup — Popup chọn mức cược (Bet Level + Coin Value).
 *
 * ── API MAPPING (từ tài liệu server) ──
 *
 *   SuperNova PS (parsheet):
 *     Bet:       Array<int32>   → mảng bet multiplier  (ví dụ [1,2,3,4,5,6,7,8,9,10])
 *     CoinValue: Array<decimal> → mảng giá trị coin    (ví dụ [0.1,0.3,0.5,1,2,5])
 *
 *   /Enter response (AckEnterSlot):
 *     BetIndex:       int → chỉ số mặc định trong mảng Bet
 *     CoinValueIndex: int → chỉ số mặc định trong mảng CoinValue
 *
 *   /Spin request (ReqSpin):
 *     BetIndex:       int → chỉ số bet được chọn
 *     BetLines:       int → số paylines (game này = 9, nhưng API nhận 0 → server tự dùng default)
 *     CoinValueIndex: int → chỉ số coin value được chọn
 *
 *   Công thức Total Bet:
 *     totalBet = Bet[BetIndex] × CoinValue[CoinValueIndex] × BetLines
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo Node "BetSettingsPopup" con của Canvas.
 *   2. Gắn component BetSettingsPopup.
 *   3. Kéo các Node/Label/Button vào đúng slot.
 *   4. Đặt popupNode.active = false trong Editor.
 *
 * ── CẤU TRÚC POPUP (gợi ý hierarchy) ──
 *   BetSettingsPopup (Node + component + BlockInputEvents)
 *   └── PopupRoot (popupNode, active=false)
 *       ├── Background
 *       ├── Title Label
 *       ├── BtnClose (closeButton)
 *       │
 *       ├── CoinValueSection
 *       │   ├── Label "COIN VALUE" (coinValueTitleLabel — localized)
 *       │   ├── BtnCoinMinus  → coinMinusButton
 *       │   ├── Label giá trị → coinValueLabel
 *       │   └── BtnCoinPlus   → coinPlusButton
 *       │
 *       ├── BetLevelSection
 *       │   ├── Label "BET LEVEL" / "MULTIPLIER BET" (betTitleLabel — localized)
 *       │   ├── BtnBetMinus   → betMinusButton
 *       │   ├── Label giá trị → betLevelLabel
 *       │   └── BtnBetPlus    → betPlusButton
 *       │
 *       ├── TotalBetSection
 *       │   ├── Label "TOTAL BET" (totalBetTitleLabel — localized)
 *       │   ├── BtnTotalMinus → totalMinusButton
 *       │   ├── Label giá trị → totalBetLabel
 *       │   └── BtnTotalPlus  → totalPlusButton
 *       │
 *       └── BtnMaxBet → maxBetButton
 */

import { _decorator, Component, Node, Label, Button, tween, Vec3 } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { BetManager } from '../manager/BetManager';
import { BuyBonusManager } from '../manager/BuyBonusManager';
import { GameData } from '../data/GameData';
import { SoundManager } from '../manager/SoundManager';
import { AutoSpinManager } from '../manager/AutoSpinManager';
import { formatCurrency2 } from '../core/FormatUtils';
import { L } from '../core/LocalizationManager';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

// ─── Default mock data (khớp SuperNova PS.json) ───
const MOCK_BET: number[]       = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const MOCK_COIN_VALUE: number[] = [0.1, 0.3, 0.5, 1, 2, 5];
const MOCK_BET_LINES: number    = 9;

@ccclass('BetSettingsPopup')
export class BetSettingsPopup extends Component {

    // ── SINGLETON ────────────────────────────────────────────────────────────
    private static _instance: BetSettingsPopup | null = null;
    static get instance(): BetSettingsPopup | null { return BetSettingsPopup._instance; }

    // ── POPUP ROOT ───────────────────────────────────────────────────────────

    @property({ type: Node, tooltip: 'Node bọc toàn bộ popup (đặt active=false ban đầu)' })
    popupNode: Node | null = null;

    @property({ type: Button, tooltip: 'Nút đóng popup (X)' })
    closeButton: Button | null = null;

    @property({ type: Label, tooltip: 'Label tiêu đề popup (ví dụ "MULTIPLIER BET")' })
    titleLabel: Label | null = null;

    // ── COIN VALUE ───────────────────────────────────────────────────────────

    @property({ type: Label, tooltip: 'Label tiêu đề "COIN VALUE"' })
    coinValueTitleLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label hiển thị giá trị Coin Value thực tế (ví dụ "0.50")' })
    coinValueLabel: Label | null = null;

    @property({ type: Button, tooltip: 'Nút giảm Coin Value (−)' })
    coinMinusButton: Button | null = null;

    @property({ type: Button, tooltip: 'Nút tăng Coin Value (+)' })
    coinPlusButton: Button | null = null;

    // ── BET LEVEL ────────────────────────────────────────────────────────────

    @property({ type: Label, tooltip: 'Label tiêu đề "BET LEVEL"' })
    betLevelTitleLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label hiển thị giá trị Bet Level thực tế (ví dụ "5")' })
    betLevelLabel: Label | null = null;

    @property({ type: Button, tooltip: 'Nút giảm Bet Level (−)' })
    betMinusButton: Button | null = null;

    @property({ type: Button, tooltip: 'Nút tăng Bet Level (+)' })
    betPlusButton: Button | null = null;

    // ── TOTAL BET ────────────────────────────────────────────────────────────

    @property({ type: Label, tooltip: 'Label tiêu đề "TOTAL BET"' })
    totalBetTitleLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label hiển thị Total Bet thực tế (ví dụ "4.50")' })
    totalBetLabel: Label | null = null;

    // ── TOTAL BET ± ──────────────────────────────────────────────────────────

    @property({ type: Button, tooltip: 'Nút giảm Total Bet (−) — tự động điều chỉnh BetIndex và CoinValueIndex' })
    totalMinusButton: Button | null = null;

    @property({ type: Button, tooltip: 'Nút tăng Total Bet (+) — tự động điều chỉnh BetIndex và CoinValueIndex' })
    totalPlusButton: Button | null = null;

    // ── MAX BET ──────────────────────────────────────────────────────────────

    @property({ type: Button, tooltip: 'Nút đặt cược tối đa (Max Bet)' })
    maxBetButton: Button | null = null;

    // ── OPEN TRIGGER ─────────────────────────────────────────────────────────

    @property({ type: Button, tooltip: 'Nút mở BetSettings popup (trên UI chính)' })
    openButton: Button | null = null;

    @property({ type: Node, tooltip: 'Node overlay phủ nền (active/inactive ngay cùng popupNode, không animation)' })
    fillOverlay: Node | null = null;

    // ── INTERNAL STATE ───────────────────────────────────────────────────────

    /** Mảng bet multiplier từ parsheet (PS.Bet) */
    private _bet: number[] = [];
    /** Mảng coin value từ parsheet (PS.CoinValue) */
    private _coinValue: number[] = [];
    /** Số paylines cố định (9 cho SuperNova) */
    private _betLines: number = 9;

    /** Chỉ số BET đang chọn — gửi server dưới dạng BetIndex */
    private _currentBetIndex: number = 0;
    /** Chỉ số COIN VALUE đang chọn — gửi server dưới dạng CoinValueIndex */
    private _currentCoinIndex: number = 0;

    /**
     * Danh sách tất cả tổ hợp (betIndex, coinIndex) hợp lệ, sắp xếp theo totalBet tăng dần.
     * Được build lại mỗi khi _bet / _coinValue thay đổi.
     */
    private _totalBetCombos: { betIndex: number; coinIndex: number; totalBet: number }[] = [];
    /** Chỉ số đang chọn trong _totalBetCombos */
    private _currentTotalBetComboIndex: number = 0;

    private _isOpen: boolean = false;
    private _isFreeSpinMode: boolean = false;
    private _isAutoSpinActive: boolean = false;

    /** PriceRatio của item activate đang bật (0 = không có item nào active) */
    private _activeBonusRatio: number = 0;

    // ── LIFECYCLE ────────────────────────────────────────────────────────────

    onLoad(): void {
        BetSettingsPopup._instance = this;

        if (this.popupNode) this.popupNode.active = false;
        if (this.fillOverlay) {
            this.fillOverlay.active = false;
            this.fillOverlay.on(Node.EventType.TOUCH_END, this._close, this);
        }

        // Button handlers
        if (this.coinMinusButton)  this.coinMinusButton.node.on('click',  () => this.onChangeCoin(-1),       this);
        if (this.coinPlusButton)   this.coinPlusButton.node.on('click',   () => this.onChangeCoin(+1),       this);
        if (this.betMinusButton)   this.betMinusButton.node.on('click',   () => this.onChangeBet(-1),        this);
        if (this.betPlusButton)    this.betPlusButton.node.on('click',    () => this.onChangeBet(+1),        this);
        if (this.totalMinusButton) this.totalMinusButton.node.on('click', () => this.onChangeTotalBet(-1),   this);
        if (this.totalPlusButton)  this.totalPlusButton.node.on('click',  () => this.onChangeTotalBet(+1),   this);
        if (this.maxBetButton)     this.maxBetButton.node.on('click',     this.onMaxBetClick,                this);
        if (this.closeButton)     this.closeButton.node.on('click',     this._close,                 this);
        // openButton không còn dùng — popup được mở qua event BET_SETTING_OPEN

        // Lắng nghe BET_CHANGED từ bên ngoài (ví dụ BetManager)
        EventBus.instance.on(GameEvents.BET_CHANGED, this._onExternalBetChanged, this);

        // Localize title labels
        this._setTitleLabels();

        // Lắng nghe thay đổi ngôn ngữ
        EventBus.instance.on(GameEvents.LANGUAGE_CHANGED, this._setTitleLabels, this);

        // Lắng nghe event mở popup
        EventBus.instance.on(GameEvents.BET_SETTING_OPEN, this._open, this);

        // Lock openButton khi đang quay hoặc trong free spin
        EventBus.instance.on(GameEvents.UI_SPIN_BUTTON_STATE, this._onSpinButtonState, this);
        EventBus.instance.on(GameEvents.FREE_SPIN_START, this._onFreeSpinStart, this);
        EventBus.instance.on(GameEvents.FREE_SPIN_END, this._onFreeSpinEnd, this);
        EventBus.instance.on(GameEvents.AUTO_SPIN_CHANGED, this._onAutoSpinChanged, this);

        // Theo dõi trạng thái active bonus item để hiển thị đúng Total Bet
        EventBus.instance.on(GameEvents.BUY_BONUS_ACTIVATE_SUCCESS, this._onBonusActivated, this);
        EventBus.instance.on(GameEvents.BUY_BONUS_DEACTIVATE_SUCCESS, this._onBonusDeactivated, this);

        // Init từ GameData (runtime)
        this._initFromGameData();
    }

    private _onSpinButtonState(enabled: boolean): void {
        if (this.openButton) this.openButton.interactable = enabled && !this._isFreeSpinMode && !this._isAutoSpinActive;
    }

    private _onFreeSpinStart(): void {
        this._isFreeSpinMode = true;
        if (this.openButton) this.openButton.interactable = false;
    }

    private _onFreeSpinEnd(): void {
        this._isFreeSpinMode = false;
        if (this.openButton) this.openButton.interactable = !this._isAutoSpinActive;
    }

    private _onAutoSpinChanged(count: number): void {
        this._isAutoSpinActive = AutoSpinManager.instance.isAutoSpinActive;
        if (this.openButton) this.openButton.interactable = !this._isAutoSpinActive && !this._isFreeSpinMode;
    }

    private _onBonusActivated(data: { itemId: number; priceRatio: number }): void {
        this._activeBonusRatio = (data && data.priceRatio > 0) ? data.priceRatio : 0;
        this.updateUI();
    }

    private _onBonusDeactivated(): void {
        this._activeBonusRatio = 0;
        this.updateUI();
    }

    onDestroy(): void {
        if (BetSettingsPopup._instance === this) BetSettingsPopup._instance = null;
        EventBus.instance.offTarget(this);
    }

    // ── INIT ─────────────────────────────────────────────────────────────────

    /**
     * Khởi tạo popup với dữ liệu từ server / parsheet.
     * @param bet       Mảng bet multiplier (PS.Bet — ví dụ [1,2,...,10])
     * @param coinValue Mảng coin value     (PS.CoinValue — ví dụ [0.1,0.3,...,5])
     * @param betLines  Số paylines (mặc định 9)
     * @param initialBetIndex   Chỉ số bet ban đầu (từ AckEnterSlot.BetIndex)
     * @param initialCoinIndex  Chỉ số coin ban đầu (từ AckEnterSlot.CoinValueIndex)
     */
    public init(
        bet: number[],
        coinValue: number[],
        betLines: number,
        initialBetIndex: number = 0,
        initialCoinIndex: number = 0,
    ): void {
        this._bet = bet;
        this._coinValue = coinValue;
        this._betLines = betLines;
        this._currentBetIndex = this._clampIndex(initialBetIndex, bet.length);
        this._currentCoinIndex = this._clampIndex(initialCoinIndex, coinValue.length);
        this._buildTotalBetCombos();
        this.updateUI();
    }

    /**
     * Init mock data — dùng khi chưa có API thật.
     * Dữ liệu khớp SuperNova PS.json.
     */
    public initMock(): void {
        this.init(MOCK_BET, MOCK_COIN_VALUE, MOCK_BET_LINES, 0, 0);
        Log.d('[BetSettingsPopup] Initialized with MOCK data');
    }

    /** Init từ GameData hiện tại (đã parse từ server hoặc mock config) */
    private _initFromGameData(): void {
        const data = GameData.instance;
        const config = data.config;
        this._bet = config.betOptions;
        this._coinValue = config.coinValues;
        this._betLines = config.paylines.length;
        this._currentBetIndex = data.player.betIndex;
        // CoinValueIndex = index trong mảng coinValues
        const coinIdx = config.coinValues.indexOf(data.player.coinValue);
        this._currentCoinIndex = coinIdx >= 0 ? coinIdx : 0;
        this._buildTotalBetCombos();
        this.updateUI();
    }

    // ── UI UPDATE ────────────────────────────────────────────────────────────

    /** Cập nhật tất cả labels dựa trên state hiện tại */
    public updateUI(): void {
        // Giá trị thực
        const coinVal = this._coinValue[this._currentCoinIndex] ?? 0;
        const betVal  = this._bet[this._currentBetIndex] ?? 0;
        // Total Bet = Bet × CoinValue (không nhân BetLines — khớp GameData.totalBet)
        const baseTotalBet = betVal * coinVal;
        // Nếu đang có bonus activate bật, nhân thêm ratio để hiển thị đúng chi phí thực
        const mgr = BuyBonusManager.instance;
        const ratioFromMgr = mgr?.activeItemPriceRatio ?? 0;
        const bonusRatio = ratioFromMgr > 0 ? ratioFromMgr : this._activeBonusRatio;
        Log.d(`[BetSettingsPopup] updateUI: base=${baseTotalBet}, mgrRatio=${ratioFromMgr}, fallbackRatio=${this._activeBonusRatio}, bonusRatio=${bonusRatio}`);
        const totalBet = bonusRatio > 0
            ? baseTotalBet * bonusRatio
            : baseTotalBet;

        if (this.coinValueLabel) this.coinValueLabel.string = L('CLIENT_CURRENENCY_SYMBOL') + formatCurrency2(coinVal);
        if (this.betLevelLabel)  this.betLevelLabel.string  = String(betVal);
        if (this.totalBetLabel)  this.totalBetLabel.string  = L('CLIENT_CURRENENCY_SYMBOL') + formatCurrency2(totalBet);

        // Sync _currentTotalBetComboIndex với betIndex/coinIndex hiện tại
        const comboIdx = this._totalBetCombos.findIndex(
            c => c.betIndex === this._currentBetIndex && c.coinIndex === this._currentCoinIndex
        );
        if (comboIdx >= 0) this._currentTotalBetComboIndex = comboIdx;

        // Enable/disable nút dựa trên giới hạn
        if (this.coinMinusButton)  this.coinMinusButton.interactable  = this._currentCoinIndex > 0;
        if (this.coinPlusButton)   this.coinPlusButton.interactable   = this._currentCoinIndex < this._coinValue.length - 1;
        if (this.betMinusButton)   this.betMinusButton.interactable   = this._currentBetIndex > 0;
        if (this.betPlusButton)    this.betPlusButton.interactable    = this._currentBetIndex < this._bet.length - 1;
        if (this.totalMinusButton) this.totalMinusButton.interactable = this._currentTotalBetComboIndex > 0;
        if (this.totalPlusButton)  this.totalPlusButton.interactable  = this._currentTotalBetComboIndex < this._totalBetCombos.length - 1;
    }

    // ── COIN VALUE ±  ────────────────────────────────────────────────────────

    /**
     * Tăng/giảm Coin Value index.
     * @param dir +1 tăng, -1 giảm
     */
    public onChangeCoin(dir: number): void {
        SoundManager.instance?.playButtonClick();
        const newIdx = this._currentCoinIndex + dir;
        this._currentCoinIndex = this._clampIndex(newIdx, this._coinValue.length);
        this._syncToBetManager();
        this.updateUI();
    }

    // ── BET LEVEL ±  ─────────────────────────────────────────────────────────

    /**
     * Tăng/giảm Bet Level index.
     * @param dir +1 tăng, -1 giảm
     */
    public onChangeBet(dir: number): void {
        SoundManager.instance?.playButtonClick();
        const newIdx = this._currentBetIndex + dir;
        this._currentBetIndex = this._clampIndex(newIdx, this._bet.length);
        this._syncToBetManager();
        this.updateUI();
    }

    // ── TOTAL BET ± ──────────────────────────────────────────────────────────

    /**
     * Tăng/giảm Total Bet bằng cách cycle qua danh sách tổ hợp đã sắp xếp.
     * BetIndex và CoinValueIndex tự động cập nhật theo combo được chọn.
     * @param dir +1 tăng, -1 giảm
     */
    public onChangeTotalBet(dir: number): void {
        SoundManager.instance?.playButtonClick();
        const newIdx = this._currentTotalBetComboIndex + dir;
        this._currentTotalBetComboIndex = this._clampIndex(newIdx, this._totalBetCombos.length);
        const combo = this._totalBetCombos[this._currentTotalBetComboIndex];
        if (!combo) return;
        this._currentBetIndex  = combo.betIndex;
        this._currentCoinIndex = combo.coinIndex;
        this._syncToBetManager();
        this.updateUI();
    }

    // ── MAX BET ──────────────────────────────────────────────────────────────

    /** Đặt cả BetIndex và CoinValueIndex lên max */
    public onMaxBetClick(): void {
        SoundManager.instance?.playButtonClick();
        const mgr = BuyBonusManager.instance;
        Log.d(`[BetSettingsPopup] onMaxBetClick: mgrExists=${!!mgr}, activeRatio=${mgr?.activeItemPriceRatio}, _activeBonusRatio=${this._activeBonusRatio}`);
        this._currentBetIndex = this._bet.length - 1;
        this._currentCoinIndex = this._coinValue.length - 1;
        this._syncToBetManager();
        this.updateUI();
    }

    // ── SPIN PAYLOAD (PUBLIC) ────────────────────────────────────────────────

    /**
     * Trả về object payload sẵn sàng gửi cho API /Spin.
     * Tên field chính xác theo API docs: BetIndex, BetLines, CoinValueIndex.
     *
     * ⚠ File này KHÔNG gọi API — chỉ chuẩn bị payload.
     *    NetworkManager sẽ lấy giá trị từ GameData (đã được sync bởi BetManager).
     */
    public getSpinPayload(): { BetIndex: number; BetLines: number; CoinValueIndex: number } {
        return {
            BetIndex: this._currentBetIndex,
            BetLines: this._betLines,
            CoinValueIndex: this._currentCoinIndex,
        };
    }

    // ── GETTERS (PUBLIC) ─────────────────────────────────────────────────────

    get currentBetIndex(): number { return this._currentBetIndex; }
    get currentCoinIndex(): number { return this._currentCoinIndex; }
    get betLines(): number { return this._betLines; }
    get currentTotalBet(): number {
        const coinVal = this._coinValue[this._currentCoinIndex] ?? 0;
        const betVal  = this._bet[this._currentBetIndex] ?? 0;
        return coinVal * betVal * this._betLines;
    }

    // ── OPEN / CLOSE ─────────────────────────────────────────────────────────

    public open(): void { this._open(); }

    private _open(): void {
        if (this._isOpen || !this.popupNode) return;
        this._isOpen = true;
        EventBus.instance.emit(GameEvents.POPUP_OPENED);
        SoundManager.instance?.playButtonClick();

        // Sync state từ GameData trước khi hiện
        this._initFromGameData();

        if (this.fillOverlay) this.fillOverlay.active = true;
        this.popupNode.active = true;
        this.popupNode.setScale(new Vec3(0.1, 0.1, 1));
        tween(this.popupNode)
            .to(0.25, { scale: new Vec3(1.05, 1.05, 1) }, { easing: 'backOut' })
            .to(0.10, { scale: new Vec3(1, 1, 1) },        { easing: 'sineOut' })
            .start();
    }

    private _close(): void {
        if (!this._isOpen || !this.popupNode) return;
        this._isOpen = false;
        EventBus.instance.emit(GameEvents.POPUP_CLOSED);
        SoundManager.instance?.playButtonClick();

        tween(this.popupNode)
            .to(0.12, { scale: new Vec3(1.05, 1.05, 1) }, { easing: 'sineOut' })
            .to(0.15, { scale: new Vec3(0.01, 0.01, 1) }, { easing: 'sineIn'  })
            .call(() => {
                if (this.popupNode) this.popupNode.active = false;
                if (this.fillOverlay) this.fillOverlay.active = false;
            })
            .start();
    }

    // ── SYNC TO BETMANAGER ───────────────────────────────────────────────────

    /** Đồng bộ index hiện tại xuống GameData + BetManager (source of truth cho spin) */
    private _syncToBetManager(): void {
        const data = GameData.instance;

        // Set coinValue TRƯỚC khi gọi setBetIndex() vì setBetIndex() emit BET_CHANGED
        // synchronously → _onExternalBetChanged → _initFromGameData() đọc lại coinValue.
        // Nếu set sau, _initFromGameData() đọc giá trị cũ và reset _currentCoinIndex về 0.
        const coinVal = this._coinValue[this._currentCoinIndex];
        if (coinVal != null) {
            data.player.coinValue = coinVal;
        }

        BetManager.instance.setBetIndex(this._currentBetIndex);
        // BetManager._emitChange đã emit BET_CHANGED; Spin/Jackpot request tự gửi bet hiện tại lên server.
    }

    /** Nhận event BET_CHANGED từ bên ngoài (ví dụ UIController thay đổi) */
    private _onExternalBetChanged(_payload: any): void {
        if (!this._isOpen) return; // Chỉ update UI khi popup đang mở
        this._initFromGameData();
    }

    // ── TITLE LABELS ─────────────────────────────────────────────────────────

    private _setTitleLabels(): void {
        if (this.titleLabel)         this.titleLabel.string         = L('UI_POPUP_BET_TITLE');
        if (this.coinValueTitleLabel) this.coinValueTitleLabel.string = L('UI_POPUP_BET_COIN_VALUE');
        if (this.betLevelTitleLabel)  this.betLevelTitleLabel.string  = L('UI_POPUP_BET_COIN_LINE');
        if (this.totalBetTitleLabel)  this.totalBetTitleLabel.string  = L('UI_POPUP_BET_TOTAL_BET');
    }

    // ── HELPERS ──────────────────────────────────────────────────────────────

    /**
     * Build danh sách tất cả tổ hợp (betIndex, coinIndex) hợp lệ,
     * sắp xếp theo totalBet tăng dần. Loại bỏ trùng lặp về giá trị totalBet.
     */
    private _buildTotalBetCombos(): void {
        const seen = new Set<number>();
        const combos: { betIndex: number; coinIndex: number; totalBet: number }[] = [];

        for (let bi = 0; bi < this._bet.length; bi++) {
            for (let ci = 0; ci < this._coinValue.length; ci++) {
                // Total Bet = Coin per Line × Coin Value (không nhân BetLines)
                const total = this._bet[bi] * this._coinValue[ci];
                // Round to avoid floating point duplicates (ví dụ 0.9000000001 vs 0.9)
                const key = Math.round(total * 1e6);
                if (!seen.has(key)) {
                    seen.add(key);
                    combos.push({ betIndex: bi, coinIndex: ci, totalBet: total });
                }
            }
        }

        combos.sort((a, b) => a.totalBet - b.totalBet);
        this._totalBetCombos = combos;

        // Tìm combo khớp state hiện tại
        const idx = combos.findIndex(
            c => c.betIndex === this._currentBetIndex && c.coinIndex === this._currentCoinIndex
        );
        this._currentTotalBetComboIndex = idx >= 0 ? idx : 0;
    }

    private _clampIndex(index: number, length: number): number {
        if (length <= 0) return 0;
        return Math.max(0, Math.min(index, length - 1));
    }
}
