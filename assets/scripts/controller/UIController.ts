/**
 * UIController - Xử lý tương tác UI cơ bản.
 * Bind nút Spin, label Balance/Bet/Win, nút +/- Bet.
 * - Balance count-up/down animation khi thay đổi
 * - Spin button mờ đi khi không thể spin
 */

import { _decorator, Component, Node, Label, Button, tween, Vec3, Color, Tween, Sprite, SpriteFrame, RichText, sp, input, Input, KeyCode, EventKeyboard, UITransform, EventTouch, screen } from 'cc';
import { formatCurrencyFixed } from '../core/FormatUtils';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { BetManager } from '../manager/BetManager';
import { BuyBonusManager } from '../manager/BuyBonusManager';
import { WalletManager } from '../manager/WalletManager';
import { SoundManager } from '../manager/SoundManager';
import { GameData } from '../data/GameData';
import { JackpotDisplay } from './JackpotDisplay';
import { OrientationLayout } from './OrientationLayout';
import { L } from '../core/LocalizationManager';
import { AutoSpinManager, SpeedMode } from '../manager/AutoSpinManager';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

@ccclass('UIController')
export class UIController extends Component {

    @property({ type: Label, tooltip: 'Label hiển thị Balance' })
    balanceLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label hiển thị Total Bet' })
    betLabel: Label | null = null;

    @property({ type: RichText, tooltip: 'Label hiển thị Win' })
    winLabel: RichText | null = null;

    @property({ type: Label, tooltip: 'Label hiển thị base win (trước hệ số)' })
    baseWinLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label hiển thị hệ số nhân (2x, 3x, 5x...)' })
    multiplierLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Label hiển thị số tiền thắng của vòng reel hiện tại' })
    roundWinLabel: Label | null = null;

    @property({ type: Button, tooltip: 'Nút Spin' })
    spinButton: Button | null = null;

    @property({ type: Button, tooltip: 'Nút tăng Bet' })
    betUpButton: Button | null = null;

    @property({ type: Button, tooltip: 'Nút giảm Bet' })
    betDownButton: Button | null = null;

    @property({ type: Button, tooltip: 'Nút Auto Spin Free — mở AutoSettingPopup để cài đặt auto spin' })
    autoSpinFreeButton: Button | null = null;

    @property({ type: Button, tooltip: 'Nút mở BetSettingsPopup để chọn mức cược' })
    betSettingButton: Button | null = null;

    @property({ type: Button, tooltip: "Nút toggle hiển thị currency symbol" })
    toggleCurrencyButton: Button | null = null;

    @property({ type: Node, tooltip: 'Node hiển thị khi đang Auto Spin (active=true khi auto, false khi idle)' })
    autoOnNode: Node | null = null;

    @property({ type: Label, tooltip: 'Label hiển thị số lượt Auto Spin còn lại' })
    autoCountLabel: Label | null = null;

    @property({ type: sp.Skeleton, tooltip: 'Spine skeleton nút Buy Bonus — kéo sp.Skeleton node vào đây' })
    spineBuyBonus: sp.Skeleton | null = null;

    @property({ type: Label, tooltip: 'Label hiển thị mode quay: NORMAL SPIN / FREE SPIN x10' })
    spinModeLabel: Label | null = null;

    @property({ type: SpriteFrame, tooltip: 'Sprite bình thường của nút Spin (idle)' })
    spinButtonNormalSprite: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: 'Sprite khi đang quay của nút Spin (spinning)' })
    spinButtonSpinningSprite: SpriteFrame | null = null;

    @property({ type: sp.Skeleton, tooltip: 'Spine child của spinButton — active khi KHÔNG spin được, inactive khi spin được' })
    spinButtonSpine: sp.Skeleton | null = null;

    @property({ type: JackpotDisplay, tooltip: 'Component JackpotDisplay để update khi bet thay đổi' })
    jackpotDisplay: JackpotDisplay | null = null;

    @property({ tooltip: 'Thời gian count-up balance (giây)' })
    balanceCountDuration: number = 0.6;

    @property({ tooltip: 'Màu betLabel bình thường (không có activate item)' })
    betLabelNormalColor: Color = new Color(255, 255, 255, 255);

    @property({ tooltip: 'Màu betLabel cảnh báo khi activate item đang bật' })
    betLabelWarningColor: Color = new Color(255, 220, 50, 255);

    // ─── INTERNAL ───
    private _displayedBalance: number = 0;
    private _balanceCountCb: (() => void) | null = null;
    private _balanceCoinLoopActive: boolean = false;
    private _targetBalance: number = 0;
    private _isFreeSpinMode: boolean = false;
    private _freeSpinRemaining: number = 0;
    private _freeSpinTotal: number = 0;
    private _isTopUpMode: boolean = false;
    private _topUpRemaining: number = 0;
    /** Tổng tiền thắng tích lũy trong free spin session — dùng cho hiển thị UI */
    private _freeSpinAccumulatedWin: number = 0;
    /** Giá trị đang hiển thị trên baseWinLabel (dùng cho count-up animation) */
    private _displayedFreeSpinWin: number = 0;
    /** Tiền thắng của lượt quay hiện tại trong free spin (reset khi spin mới bắt đầu) */
    private _currentRoundWin: number = 0;
    private _showFreeSpinRoundWinLine: boolean = false;
    /** Callback count-up animation cho freeSpinWin */
    private _freeSpinWinCountCb: (() => void) | null = null;
    private _freeSpinCoinLoopActive: boolean = false;
    /** Flag để tracking xem rotation animation đang chạy hay đã dừng */
    private _spinButtonAnimationRunning: boolean = false;
    /** Trạng thái enabled cuối cùng của spin button (từ UI_SPIN_BUTTON_STATE) */
    private _spinEnabled: boolean = true;
    /** Reel đang quay — cho phép nhấn Spin lại để quick stop */
    private _isSpinning: boolean = false;
    /** Số popup đang mở — phím Space bị khoá khi > 0 */
    private _openPopupCount: number = 0;
    private _showCurrencySymbol: boolean = true;
    private _currencyChildHideCb: (() => void) | null = null;
    private _currencyOutsideTouchHandler: ((e: EventTouch) => void) | null = null;

    // ─── LIFECYCLE ───

    onLoad(): void {
        // Khởi tạo balance trước khi bind events để tránh count-up animation khi vào game
        const initialBalance = WalletManager.instance.balance;
        this._displayedBalance = initialBalance;
        this._targetBalance = initialBalance;

        this._bindUI();
        this._bindEvents();
        this._setupKeyboardInput();
    }

    start(): void {
        // Hiển thị balance ngay khi vào game
        const initialBalance = WalletManager.instance.balance;
        if (this.balanceLabel) {
            const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';
            this.balanceLabel.string = symbol + formatCurrencyFixed(initialBalance);
        }

        // Khởi tạo winLabel ngay khi vào game (tránh null/empty khi GAME_READY event chậm emit)
        if (this.winLabel) {
            this.winLabel.string = L('UI_CONTROL_PANEL_GUIDE_3');
        }

        // Cập nhật betLabel ngay khi onLoad hoàn thành
        EventBus.instance.emit(GameEvents.BET_CHANGED, {
            betIndex: BetManager.instance.betIndex,
            currentBet: BetManager.instance.currentBet,
            coinValue: BetManager.instance.coinValue,
            totalBet: BetManager.instance.totalBet,
        });

        // Init trạng thái autoOnNode / autoCountLabel
        if (this.autoOnNode) this.autoOnNode.active = false;
        if (this.autoCountLabel) this.autoCountLabel.string = '';

        // Bắt đầu spin button rotation animation
        this._startSpinButtonRotationLoop();
    }

    private _abandonCoinLoopOwnership(): void {
        const hadBalance = this._balanceCoinLoopActive;
        const hadFreeSpin = this._freeSpinCoinLoopActive;
        Log.d(`[coinloop][UIController._abandonCoinLoopOwnership] hadBalance=${hadBalance} hadFreeSpin=${hadFreeSpin}`);
        if (this._balanceCountCb) {
            this.unschedule(this._balanceCountCb);
            this._balanceCountCb = null;
        }
        if (this._freeSpinWinCountCb) {
            this.unschedule(this._freeSpinWinCountCb);
            this._freeSpinWinCountCb = null;
        }
        this._balanceCoinLoopActive = false;
        this._freeSpinCoinLoopActive = false;

        // Claim đã sync Wallet trước khi hiện end popup. Snap label ngay để
        // không kẹt số cũ đến lúc Normal spin kế tiếp (animation bị hủy giữa chừng).
        const balance = WalletManager.instance.balance;
        if (this._displayedBalance !== balance || this._targetBalance !== balance) {
            this._displayedBalance = balance;
            this._targetBalance = balance;
            this._refreshBalanceLabel();
        }
    }

    onDestroy(): void {
        if (this._freeSpinCoinLoopActive || this._balanceCoinLoopActive) {
            SoundManager.instance?.stopCoinLoop();
        }
        EventBus.instance.offTarget(this);
        this._spinButtonAnimationRunning = false;
        this._stopSpinButtonRotation();
        if (this.spinButton) {
            Tween.stopAllByTarget(this.spinButton.node);
        }
        input.off(Input.EventType.KEY_DOWN, this._onKeyDown, this);
        if (this._currencyOutsideTouchHandler) {
            input.off(Input.EventType.TOUCH_START, this._currencyOutsideTouchHandler, this);
            this._currencyOutsideTouchHandler = null;
        }
        if (this._currencyChildHideCb) {
            this.unschedule(this._currencyChildHideCb);
            this._currencyChildHideCb = null;
        }
    }

    // ─── UI BINDING ───

    private _bindUI(): void {
        if (this.spinButton) {
            // Giữ SCALE press feedback trên BtnSpin; tween xoay chạy trên spine child
            // để Tween.stopAllByTarget không cắt zoom và làm scale phình dần.
            this.spinButton.transition = Button.Transition.SCALE;
            this.spinButton.zoomScale = 1.05;
            this.spinButton.node.on('click', this._onSpinClick, this);
        }
        if (this.betUpButton) {
            this.betUpButton.node.on('click', this._onBetUp, this);
        }
        if (this.betDownButton) {
            this.betDownButton.node.on('click', this._onBetDown, this);
        }
        if (this.autoSpinFreeButton) {
            this.autoSpinFreeButton.node.on('click', this._onAutoSpinFreeClick, this);
        }
        if (this.betSettingButton) {
            this.betSettingButton.node.on('click', this._onBetSettingClick, this);
        }
        if (this.toggleCurrencyButton) {
            this.toggleCurrencyButton.node.on('click', this._onToggleCurrencyClick, this);
        }
    }

    private _bindEvents(): void {
        const bus = EventBus.instance;
        bus.on(GameEvents.BALANCE_UPDATED, this._onBalanceUpdated, this);
        bus.on(GameEvents.BET_CHANGED, this._onBetChanged, this);
        bus.on(GameEvents.UI_SPIN_BUTTON_STATE, this._onSpinButtonState, this);
        bus.on(GameEvents.WIN_COUNTUP_DONE, this._onWinCountDone, this);
        bus.on(GameEvents.WIN_PRESENT_START, this._onWinPresentStart, this);
        bus.on(GameEvents.FREE_SPIN_START, this._onFreeSpinStart, this);
        bus.on(GameEvents.FREE_SPIN_COUNT_UPDATED, this._onFreeSpinCountUpdated, this);
        bus.on(GameEvents.FREE_SPIN_END, this._onFreeSpinEnd, this);
        bus.on(GameEvents.TOPUP_START, this._onTopUpStart, this);
        bus.on(GameEvents.TOPUP_COUNT_UPDATED, this._onTopUpCountUpdated, this);
        bus.on(GameEvents.TOPUP_END, this._onTopUpEnd, this);
        bus.on(GameEvents.TOPUP_END_POPUP, this._abandonCoinLoopOwnership, this);
        bus.on(GameEvents.FREE_SPIN_END_POPUP, this._abandonCoinLoopOwnership, this);
        bus.on(GameEvents.REELS_START_SPIN, this._onReelsStartSpin, this);
        bus.on(GameEvents.REELS_STOPPED, this._onReelsStopped, this);
        bus.on(GameEvents.AUTO_SPIN_CHANGED, this._onAutoSpinChanged, this);
        bus.on(GameEvents.BUY_BONUS_SUCCESS, this._onBuyBonusSuccess, this);
        bus.on(GameEvents.BUY_BONUS_FAILED, this._onBuyBonusFailed, this);
        bus.on(GameEvents.BUY_BONUS_TOTAL_BET_CHANGED, this._onBuyBonusTotalBetChanged, this);
        bus.on(GameEvents.HIDE_BOTTOM_UI, this._onHideBottomUI, this);
        bus.on(GameEvents.SHOW_BOTTOM_UI, this._onShowBottomUI, this);
        bus.on(GameEvents.GAME_READY, () => {
            this._isTopUpMode = false;
            this._topUpRemaining = 0;
            if (this.spinModeLabel) this.spinModeLabel.string = L('normal_spin');
            // Reset labels khi game ready
            if (this.winLabel) this.winLabel.string = L('UI_CONTROL_PANEL_GUIDE_3');
            if (this.roundWinLabel) this.roundWinLabel.string = '';
            if (this.baseWinLabel) this.baseWinLabel.string = '';
            if (this.multiplierLabel) this.multiplierLabel.string = '';
        }, this);
    }

    // ─── KEYBOARD INPUT ───

    /**
     * Thiết lập keyboard input handler cho phím Space.
     * Khi nhấn Space → gọi _onSpinClick (tương tự click nút Spin).
     */
    private _setupKeyboardInput(): void {
        try {
            input.on(Input.EventType.KEY_DOWN, this._onKeyDown, this);
            const bus = EventBus.instance;
            bus.on(GameEvents.POPUP_OPENED, () => { this._openPopupCount++; }, this);
            bus.on(GameEvents.POPUP_CLOSED, () => { this._openPopupCount = Math.max(0, this._openPopupCount - 1); }, this);
        } catch (err) {
            console.warn('[UIController] Failed to setup keyboard input:', err);
        }
    }

    /**
     * Xử lý keyboard input — Space / Enter để trigger Spin.
     */
    private _onKeyDown(event: EventKeyboard): void {
        if (this._openPopupCount > 0) return;
        if (event.keyCode === KeyCode.SPACE
            || event.keyCode === KeyCode.ENTER
            || event.keyCode === KeyCode.NUM_ENTER) {
            // Gọi spin click handler
            this._onSpinClick();
        }
    }

    // ─── BUTTON HANDLERS ───

    private _onSpinClick(): void {
        // Log.e(`[SPIN-HANG][UI] spin click | spinEnabled=${this._spinEnabled} uiSpinning=${this._isSpinning} freeSpin=${this._isFreeSpinMode} autoActive=${AutoSpinManager.instance.isAutoSpinActive} autoCount=${AutoSpinManager.instance.autoSpinCount} interactable=${this.spinButton?.interactable ?? false}`);
        // Trong freeSpin: không cho hủy auto spin
        if (this._isFeatureMode()) return;
        // Nếu đang auto spin active → pause
        if (AutoSpinManager.instance.isAutoSpinActive) {
            // Log.e('[SPIN-HANG][UI] spin click pauses auto spin');
            AutoSpinManager.instance.pauseAutoSpin();
            return;
        }
        // Nếu reel đang quay (normal spin) → quick stop ngay lập tức
        if (this._isSpinning) {
            // Log.e('[SPIN-HANG][UI] spin click emits REELS_QUICK_STOP');
            EventBus.instance.emit(GameEvents.REELS_QUICK_STOP);
            return;
        }
        // Log.e('[SPIN-HANG][UI] spin click emits SPIN_REQUEST');
        EventBus.instance.emit(GameEvents.SPIN_REQUEST);
    }

    private _onReelsStartSpin(): void {
        // Log.e(`[SPIN-HANG][UI] REELS_START_SPIN received | before uiSpinning=${this._isSpinning} spinEnabled=${this._spinEnabled} interactable=${this.spinButton?.interactable ?? false}`);
        this._isSpinning = true;
        // Mở khóa nút Spin ngay — _onSpinButtonState(false) chạy trước nên có thể đã khóa nút
        if (this.spinButton && !this._isFeatureMode()) {
            this.spinButton.interactable = true;
        }
        if (this._isFreeSpinMode) {
            // FreeSpin mode: line 1 hiển thị guide text khi đang quay, line 2 giữ total win
            this._showFreeSpinRoundWinLine = false;
            this._updateFreeSpinWinLabel();
        } else if (this._isTopUpMode) {
            this._updateTopUpWinLabel(0);
        } else {
            this._updateNormalWinLabel(0);
            if (this.baseWinLabel) this.baseWinLabel.string = '';
        }
        if (this.roundWinLabel) this.roundWinLabel.string = '';
        if (this.multiplierLabel) this.multiplierLabel.string = '';
        this._setSpinButtonSprite(false);
        // Log.e(`[SPIN-HANG][UI] REELS_START_SPIN applied | uiSpinning=${this._isSpinning} spinEnabled=${this._spinEnabled} interactable=${this.spinButton?.interactable ?? false}`);
    }

    private _onReelsStopped(): void {
        // Log.e(`[SPIN-HANG][UI] REELS_STOPPED received | before uiSpinning=${this._isSpinning} spinEnabled=${this._spinEnabled} interactable=${this.spinButton?.interactable ?? false}`);
        this._isSpinning = false;
        // Log.e(`[SPIN-HANG][UI] REELS_STOPPED applied | uiSpinning=${this._isSpinning} spinEnabled=${this._spinEnabled} interactable=${this.spinButton?.interactable ?? false}`);
    }

    private _onAutoSpinChanged(count: number): void {
        const isAutoSpinActive = AutoSpinManager.instance.isAutoSpinActive;
        // Ẩn/hiện autoOnNode
        if (this.autoOnNode) this.autoOnNode.active = this._isFeatureMode() || isAutoSpinActive;
        // Cập nhật autoCountLabel
        this._refreshAutoCountLabel(count);
        // Ẩn/hiện autoSpinFreeButton theo trạng thái auto spin
        if (this.autoSpinFreeButton) {
            this.autoSpinFreeButton.interactable = !isAutoSpinActive && !this._isFeatureMode();
        }
        // Ẩn/hiện betSettingButton theo trạng thái auto spin
        if (this.betSettingButton) {
            this.betSettingButton.interactable = !isAutoSpinActive && !this._isFeatureMode();
        }
        // Buy Bonus: mờ alpha=1/2 + block click khi autoSpin, sáng alpha=1 + cho click khi idle
        if (this.spineBuyBonus && this.spineBuyBonus.node) {
            const targetColor = isAutoSpinActive
                ? new Color(255, 255, 255, 128)   // 50% dim
                : new Color(255, 255, 255, 255);  // 100%
            this.spineBuyBonus.color = targetColor;
        }
        // Cập nhật sprite button Spin: autoSpin → spinning sprite, ngược lại → normal sprite
        if (this.spinButton && this._spinEnabled) {
            if (isAutoSpinActive) {
                this._setSpinButtonSprite(false);
            } else {
                this._setSpinButtonSprite(true);
            }
        }
        // Reset winLabel về mặc định khi auto spin dừng
        if (!isAutoSpinActive && !this._isFeatureMode() && this.winLabel) {
            this.winLabel.string = L('UI_CONTROL_PANEL_GUIDE_3');
        }
    }

    private _onBetUp(): void {
        BetManager.instance.changeBetIndex(1);
    }

    private _onBetDown(): void {
        BetManager.instance.changeBetIndex(-1);
    }

    private _onAutoSpinFreeClick(): void {
        // 🎯 Bấm nút Auto Spin Free → mở AutoSettingPopup để cài đặt số lượt & tốc độ
        EventBus.instance.emit(GameEvents.AUTO_SETTING_OPEN);
    }

    private _onBetSettingClick(): void {
        // 🎯 Bấm nút BetSetting → mở BetSettingsPopup để chọn mức cược
        EventBus.instance.emit(GameEvents.BET_SETTING_OPEN);
    }

    private _onToggleCurrencyClick(): void {
        this._showCurrencySymbol = !this._showCurrencySymbol;
        this._refreshBalanceLabel();
        this._refreshBetLabel();
        const btn = this.toggleCurrencyButton;
        if (!btn) return;
        const node = btn.node;
        if (!node || node.children.length === 0) return;
        const child = node.children[0];
        child.active = true;
        if (this._currencyChildHideCb) {
            this.unschedule(this._currencyChildHideCb);
            this._currencyChildHideCb = null;
        }
        this._currencyChildHideCb = () => {
            const n = this.toggleCurrencyButton?.node;
            const c = n && n.children.length > 0 ? n.children[0] : null;
            if (c) c.active = false;
            if (this._currencyOutsideTouchHandler) {
                input.off(Input.EventType.TOUCH_START, this._currencyOutsideTouchHandler, this);
                this._currencyOutsideTouchHandler = null;
            }
            if (this._currencyChildHideCb) {
                this.unschedule(this._currencyChildHideCb);
                this._currencyChildHideCb = null;
            }
        };
        this.scheduleOnce(this._currencyChildHideCb, 3);
        if (this._currencyOutsideTouchHandler) {
            input.off(Input.EventType.TOUCH_START, this._currencyOutsideTouchHandler, this);
            this._currencyOutsideTouchHandler = null;
        }
        this._currencyOutsideTouchHandler = (event: EventTouch) => {
            const n = this.toggleCurrencyButton?.node;
            const c = n && n.children.length > 0 ? n.children[0] : null;
            if (!n || !c || !c.active) return;
            const uiC = c.getComponent(UITransform);
            if (uiC && uiC.hitTest(event.getUILocation())) {
                return;
            }
            const uiBtn = n.getComponent(UITransform);
            if (uiBtn && uiBtn.hitTest(event.getUILocation())) {
                return;
            }
            this._currencyChildHideCb && this._currencyChildHideCb();
        };
        this.scheduleOnce(() => {
            if (this._currencyOutsideTouchHandler) {
                input.on(Input.EventType.TOUCH_START, this._currencyOutsideTouchHandler, this);
            }
        }, 0);
    }

    // ─── EVENT HANDLERS ───

    private _onBalanceUpdated(balance: number): void {
        const isActuallyIncreasing = balance > this._targetBalance;
        this._targetBalance = balance;
        this._animateBalance(this._displayedBalance, balance, isActuallyIncreasing);
    }

    private _refreshBalanceLabel(): void {
        if (this.balanceLabel) {
            const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';
            this.balanceLabel.string = symbol + formatCurrencyFixed(this._displayedBalance);
        }
    }

    private _refreshBetLabel(): void {
        const bonusMgr = BuyBonusManager.instance;
        const ratio = bonusMgr?.activeItemPriceRatio ?? 0;
        const totalBet = BetManager.instance.totalBet;
        const displayBet = ratio > 0 ? totalBet * ratio : totalBet;
        if (this.betLabel) {
            const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';
            this.betLabel.string = symbol + formatCurrencyFixed(displayBet);
            this.betLabel.color = ratio > 0 ? this.betLabelWarningColor : this.betLabelNormalColor;
        }
    }

    private _onBetChanged(info: { totalBet: number }): void {
        const bonusMgr = BuyBonusManager.instance;
        const ratio = bonusMgr?.activeItemPriceRatio ?? 0;
        const displayBet = ratio > 0 ? info.totalBet * ratio : info.totalBet;
        if (this.betLabel) {
            const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';
            this.betLabel.string = symbol + formatCurrencyFixed(displayBet);
            this.betLabel.color = ratio > 0 ? this.betLabelWarningColor : this.betLabelNormalColor;
        }
        if (this.jackpotDisplay) {
            this.jackpotDisplay.refresh();
        }
    }

    private _onBuyBonusTotalBetChanged(info: { displayBet: number; isActive: boolean }): void {
        if (this.betLabel) {
            const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';
            this.betLabel.string = symbol + formatCurrencyFixed(info.displayBet);
            this.betLabel.color = info.isActive ? this.betLabelWarningColor : this.betLabelNormalColor;
        }
    }

    private _onSpinButtonState(enabled: boolean): void {
        // Log.e(`[SPIN-HANG][UI] UI_SPIN_BUTTON_STATE received | enabled=${enabled} spinEnabled=${this._spinEnabled} uiSpinning=${this._isSpinning} freeSpin=${this._isFreeSpinMode} autoActive=${AutoSpinManager.instance.isAutoSpinActive} autoCount=${AutoSpinManager.instance.autoSpinCount} interactable=${this.spinButton?.interactable ?? false}`);
        this._spinEnabled = enabled;
        const isAutoSpinActive = AutoSpinManager.instance.isAutoSpinActive;
        if (this.spinButton) {
            // Khi đang auto spin hoặc đang spin normal: giữ button interactable để player nhấn cancel / quick stop
            this.spinButton.interactable = enabled || (isAutoSpinActive && !this._isFeatureMode()) || (this._isSpinning && !this._isFeatureMode());
            if (enabled) {
                // Khi autoSpin active: luôn hiển thị spinning sprite, ngược lại hiển thị normal sprite
                if (isAutoSpinActive) {
                    this._setSpinButtonSprite(false);
                } else {
                    this._setSpinButtonSprite(true);
                }
            }
        }
        if (this.betUpButton) this.betUpButton.interactable = enabled;
        if (this.betDownButton) this.betDownButton.interactable = enabled;
        // autoSpinFreeButton: chỉ enabled khi idle, không auto spin, không free spin
        if (this.autoSpinFreeButton) this.autoSpinFreeButton.interactable = enabled && !this._isFeatureMode() && !isAutoSpinActive;
        // betSettingButton: chỉ enabled khi idle, không auto spin, không free spin
        if (this.betSettingButton) this.betSettingButton.interactable = enabled && !this._isFeatureMode() && !isAutoSpinActive;
        // Log.e(`[SPIN-HANG][UI] UI_SPIN_BUTTON_STATE applied | enabled=${enabled} spinEnabled=${this._spinEnabled} uiSpinning=${this._isSpinning} freeSpin=${this._isFreeSpinMode} autoActive=${isAutoSpinActive} interactable=${this.spinButton?.interactable ?? false}`);
    }

    private _onWinPresentStart(resp: { totalWin: number; featureMultiple?: number; matchedLinePays?: { payLineIndex: number; payout: number }[]; waysPayWins?: { payout: number; ways: number }[]; totalBet?: number }): void {
        const lineCount = resp.matchedLinePays?.length ?? 0;
        const wayCount = resp.waysPayWins?.length ?? 0;
        const sumLine = (resp.matchedLinePays ?? []).reduce((s, l) => s + (l.payout ?? 0), 0);
        Log.e(
            `[MULTI-LINE-WIN] UI winLabel totalWin=${resp.totalWin} totalBet=${resp.totalBet ?? GameData.instance.totalBet}` +
            ` lines=${lineCount} ways=${wayCount} sumLinePayout=${sumLine}` +
            ` roundWinLabel=${resp.totalWin > 0 ? formatCurrencyFixed(resp.totalWin) : '(empty)'}`
        );
        if (this._isFreeSpinMode) {
            // FreeSpin: lưu win của lượt này để hiển thị ở line 1
            this._currentRoundWin = resp.totalWin;
            this._showFreeSpinRoundWinLine = true;
            // Đọc tổng thực tế từ GameData (GameManager đã cộng trước khi emit)
            // và animate count-up liên tục trên winLabel — KHÔNG reset số về 0
            this._freeSpinAccumulatedWin = GameData.instance.freeSpinTotalWin;
            this._animateFreeSpinWin(this._displayedFreeSpinWin, this._freeSpinAccumulatedWin);

            if (resp.totalWin > 0) {
                this._playWinLabelZoomEffect();
            }

            if (this.roundWinLabel) {
                this.roundWinLabel.string = resp.totalWin > 0 ? formatCurrencyFixed(resp.totalWin) : '';
            }
            if (resp.featureMultiple && resp.featureMultiple > 1) {
                if (this.multiplierLabel) this.multiplierLabel.string = `×${resp.featureMultiple.toFixed(1)}x`;
            } else {
                if (this.multiplierLabel) this.multiplierLabel.string = '';
            }
            return;
        }

        if (this._isTopUpMode) {
            this._updateTopUpWinLabel(resp.totalWin);
            if (resp.totalWin > 0) {
                this._playWinLabelZoomEffect();
            }
            if (this.roundWinLabel) {
                this.roundWinLabel.string = resp.totalWin > 0 ? formatCurrencyFixed(resp.totalWin) : '';
            }
            if (this.multiplierLabel) this.multiplierLabel.string = '';
            if (this.baseWinLabel) this.baseWinLabel.string = '';
            return;
        }

        // Normal spin
        this._updateNormalWinLabel(resp.totalWin);
        if (resp.totalWin > 0) {
            this._playWinLabelZoomEffect();
        }
        if (this.roundWinLabel) {
            this.roundWinLabel.string = resp.totalWin > 0 ? formatCurrencyFixed(resp.totalWin) : '0.000';
        }
        if (resp.featureMultiple && resp.featureMultiple > 1) {
            const baseWin = resp.totalWin / resp.featureMultiple;
            if (this.baseWinLabel) this.baseWinLabel.string = formatCurrencyFixed(baseWin);
            if (this.multiplierLabel) this.multiplierLabel.string = `×${resp.featureMultiple.toFixed(1)}x`;
        } else {
            if (this.baseWinLabel) this.baseWinLabel.string = '';
            if (this.multiplierLabel) this.multiplierLabel.string = '';
        }
    }

    private _onWinCountDone(_totalWin: number): void {
        // winLabel now shows "WIN X" text set in _onWinPresentStart — no override needed
    }

    private _onFreeSpinStart(): void {
        // Retrigger case: nếu _isFreeSpinMode đã là true thì đây là retrigger trong session,
        // KHÔNG reset accumulated win về 0 — giữ nguyên số tiền đang hiển thị.
        const isRetrigger = this._isFreeSpinMode;
        this._isFreeSpinMode = true;
        this._isTopUpMode = false;
        this._freeSpinTotal = this._freeSpinRemaining;
        // Resume case: nếu server đã khôi phục tổng win (stage 4/9 mid-session),
        // dùng giá trị đó thay vì reset về 0
        const data = GameData.instance;
        if (isRetrigger) {
            // Retrigger: giữ nguyên _freeSpinAccumulatedWin và _displayedFreeSpinWin
            // (không reset, không animate — số tiền tích lũy vẫn đúng)
        } else if (data.freeSpinTotalWinRestoredFromServer && data.freeSpinTotalWin > 0) {
            this._freeSpinAccumulatedWin = data.freeSpinTotalWin;
            this._displayedFreeSpinWin = data.freeSpinTotalWin;  // snap ngay, không animate
        } else {
            this._freeSpinAccumulatedWin = 0;
            this._displayedFreeSpinWin = 0;
        }
        this._currentRoundWin = 0;
        this._showFreeSpinRoundWinLine = false;
        if (this._freeSpinWinCountCb) {
            this.unschedule(this._freeSpinWinCountCb);
            this._freeSpinWinCountCb = null;
        }
        // Lock autoSpinFreeButton và betSettingButton trong suốt session free spin
        if (this.autoSpinFreeButton) this.autoSpinFreeButton.interactable = false;
        if (this.betSettingButton) this.betSettingButton.interactable = false;
        this._updateFreeSpinWinLabel();
        this._refreshAutoCountLabel();
    }

    private _onFreeSpinCountUpdated(remaining: number): void {
        this._freeSpinRemaining = remaining;
        this._isFreeSpinMode = true;
        this._showFreeSpinRoundWinLine = false;
        if (this._freeSpinTotal === 0) this._freeSpinTotal = remaining;
        if (this.spinModeLabel) {
            this.spinModeLabel.string = L('free_spin_mode', { count: remaining });
        }
        this._updateFreeSpinWinLabel();
        this._refreshAutoCountLabel();
    }

    private _onFreeSpinEnd(_totalWin: number): void {
        this._isFreeSpinMode = false;
        this._freeSpinRemaining = 0;
        this._freeSpinTotal = 0;
        this._freeSpinAccumulatedWin = 0;
        this._displayedFreeSpinWin = 0;
        this._currentRoundWin = 0;
        this._showFreeSpinRoundWinLine = false;
        if (this._freeSpinWinCountCb) {
            this.unschedule(this._freeSpinWinCountCb);
            this._freeSpinWinCountCb = null;
        }
        // autoOnNode: reset theo trạng thái auto spin thực tế
        const isAutoSpinActive = AutoSpinManager.instance.isAutoSpinActive;
        this._refreshAutoCountLabel();
        // autoSpinFreeButton và betSettingButton: chỉ hiện khi không còn auto spin active
        if (this.autoSpinFreeButton) this.autoSpinFreeButton.interactable = !isAutoSpinActive;
        if (this.betSettingButton) this.betSettingButton.interactable = !isAutoSpinActive;
        if (this.spinModeLabel) {
            this.spinModeLabel.string = L('normal_spin');
        }
        if (this.winLabel) this.winLabel.string = L('UI_CONTROL_PANEL_GUIDE_3');
    }

    private _onTopUpStart(payload: { spinsRemaining: number }): void {
        this._isTopUpMode = true;
        this._isFreeSpinMode = false;
        this._topUpRemaining = Math.max(0, payload?.spinsRemaining ?? GameData.instance.respinRemaining ?? 0);
        if (this.autoSpinFreeButton) this.autoSpinFreeButton.interactable = false;
        if (this.betSettingButton) this.betSettingButton.interactable = false;
        this._updateTopUpWinLabel(0);
        this._refreshAutoCountLabel();
    }

    private _onTopUpCountUpdated(remaining: number): void {
        this._isTopUpMode = true;
        this._topUpRemaining = Math.max(0, remaining);
        this._updateTopUpWinLabel(0);
        this._refreshAutoCountLabel();
    }

    private _onTopUpEnd(_totalWin: number): void {
        this._isTopUpMode = false;
        this._topUpRemaining = 0;
        const isAutoSpinActive = AutoSpinManager.instance.isAutoSpinActive;
        this._refreshAutoCountLabel();
        if (this.autoSpinFreeButton) this.autoSpinFreeButton.interactable = !isAutoSpinActive;
        if (this.betSettingButton) this.betSettingButton.interactable = !isAutoSpinActive;
        if (this.spinModeLabel) this.spinModeLabel.string = L('normal_spin');
        if (this.winLabel) this.winLabel.string = L('UI_CONTROL_PANEL_GUIDE_3');
    }

    private _onBuyBonusSuccess(): void {
        // 🎯 Mua bonus thành công → button sẽ được enable lại sau khi free spin kết thúc
        // Có thể thêm feedback về thành công tại đây nếu cần
    }

    private _onBuyBonusFailed(): void {
        // 🎯 Mua bonus thất bại → button vẫn enabled để user thử lại
        // Có thể hiển thị error message tại đây
    }

    /** HIDE_BOTTOM_UI: ẩn toàn bộ bottom controls khi Pick Game bắt đầu gameplay. */
    private _onHideBottomUI(): void {
        if (this.spinButton)       this.spinButton.node.active        = false;
        if (this.betUpButton)      this.betUpButton.node.active       = false;
        if (this.betDownButton)    this.betDownButton.node.active     = false;
        if (this.betSettingButton) this.betSettingButton.node.active  = false;
        if (this.autoSpinFreeButton) this.autoSpinFreeButton.node.active = false;
    }

    /** SHOW_BOTTOM_UI: hiện lại bottom controls sau khi Pick Game kết thúc. */
    private _onShowBottomUI(): void {
        if (this.spinButton)       this.spinButton.node.active        = true;
        if (this.betUpButton)      this.betUpButton.node.active       = true;
        if (this.betDownButton)    this.betDownButton.node.active     = true;
        if (this.betSettingButton) this.betSettingButton.node.active  = true;
        if (this.autoSpinFreeButton) this.autoSpinFreeButton.node.active = true;
    }

    /** Node dùng cho tween xoay — tách khỏi BtnSpin để không đụng Button SCALE. */
    private _getSpinButtonRotationNode(): Node | null {
        return this.spinButtonSpine?.node ?? null;
    }

    private _stopSpinButtonRotation(): void {
        const rotNode = this._getSpinButtonRotationNode();
        if (!rotNode) return;
        Tween.stopAllByTarget(rotNode);
        rotNode.setRotationFromEuler(0, 0, 0);
    }

    /** Snap scale BtnSpin về giá trị OrientationLayout (sau khi cắt Button zoom tween). */
    private _snapSpinButtonScaleToLayout(): void {
        if (!this.spinButton) return;
        const node = this.spinButton.node;
        Tween.stopAllByTarget(node);
        const layout = node.getComponent(OrientationLayout);
        if (layout) {
            const size = screen.windowSize;
            const data = size.height > size.width ? layout.portrait : layout.landscape;
            node.setScale(data.scaleX, data.scaleY, data.scaleZ);
        }
    }

    private _startSpinButtonRotationLoop(): void {
        const node = this._getSpinButtonRotationNode();
        if (!node) return;

        this._stopSpinButtonRotation();
        this._spinButtonAnimationRunning = true;
        const animationLoop = () => {
            if (!this._spinButtonAnimationRunning) return;
            tween(node)
                .to(0.25, { eulerAngles: new Vec3(0, 0, -30) }, { easing: 'quadOut' })
                .to(0.6, { eulerAngles: new Vec3(0, 0, 0) }, { easing: 'sineOut' })
                .call(animationLoop)
                .start();
        };
        animationLoop();
    }

    private _setSpinButtonSprite(normal: boolean): void {
        Log.e(`[SPIN-BTN] _setSpinButtonSprite(normal=${normal}) | hasButton=${!!this.spinButton} | hasSpine=${!!this.spinButtonSpine}`);
        if (!this.spinButton) return;
        const sprite = this.spinButton.node.getComponentInChildren(Sprite);
        if (!sprite) return;

        this._spinButtonAnimationRunning = false;
        this._stopSpinButtonRotation();
        // Cắt Button zoom giữa chừng (nếu đang hold) rồi snap về scale layout — không để phình dần.
        this._snapSpinButtonScaleToLayout();

        if (normal) {
            // Spin được: hiện spine, ẩn sprite → bắt đầu xoay
            if (sprite.node) sprite.node.active = false;
            if (this.spinButtonSpine) this.spinButtonSpine.node.active = true;
            this._startSpinButtonRotationLoop();
        } else {
            // Không spin được: hiện sprite, ẩn spine → dừng xoay
            if (sprite.node) sprite.node.active = true;
            if (this.spinButtonSpine) this.spinButtonSpine.node.active = false;
        }
    }

    // ─── FREE SPIN WIN DISPLAY ───

    /**
     * Cập nhật winLabel cho Normal Spin (có hoặc không có auto spin).
     * Dòng 1: kết quả tiền thắng (hoặc guide text nếu chưa có).
     * Dòng 2 (chỉ khi auto spin đang chạy): số lượt còn lại (giới hạn hiển thị ≤1000).
     */
    private _isFeatureMode(): boolean {
        return this._isFreeSpinMode || this._isTopUpMode;
    }

    private _getFeatureSpinCount(): number {
        if (this._isTopUpMode) return this._topUpRemaining;
        if (this._isFreeSpinMode) return this._freeSpinRemaining;
        return 0;
    }

    private _refreshAutoCountLabel(autoCount: number = AutoSpinManager.instance.autoSpinCount): void {
        const isFeatureMode = this._isFeatureMode();
        const isAutoSpinActive = AutoSpinManager.instance.isAutoSpinActive;
        if (this.autoOnNode) this.autoOnNode.active = isFeatureMode || isAutoSpinActive;
        if (!this.autoCountLabel) return;
        if (isFeatureMode) {
            this.autoCountLabel.string = String(this._getFeatureSpinCount());
            return;
        }
        this.autoCountLabel.string = isAutoSpinActive ? String(autoCount) : '';
    }

    private _getFeatureSpinRemainLine(): string {
        const label = this._isTopUpMode ? 'TOP UP SPINS LEFT' : L('UI_CONTROL_PANEL_TEXT_FREE_SPIN');
        return "<size=30>" + label + ": " + this._getFeatureSpinCount() + "</size>";
    }

    private _updateNormalWinLabel(totalWin: number): void {
        if (!this.winLabel) return;
        const autoCount = AutoSpinManager.instance.autoSpinCount;
        const isAutoSpinActive = AutoSpinManager.instance.isAutoSpinActive;
        const currencySymbol = L('CLIENT_CURRENENCY_SYMBOL');
        // Chỉ hiển thị tối đa 1000 (không can thiệp vào giá trị thực autoSpinCount)
        const displayAutoCount = autoCount;// Math.min(autoCount, 1000);

        let line1: string;
        if (totalWin > 0) {
            line1 = "<color=#ffa351>" + L('UI_CONTROL_PANEL_TEXT_PAY_WIN') + "</color> " + currencySymbol + formatCurrencyFixed(totalWin);
        } else {
            line1 = isAutoSpinActive ? L('UI_CONTROL_PANEL_GUIDE_1') : L('UI_CONTROL_PANEL_GUIDE_3');
        }

        if (isAutoSpinActive) {
            const line2 = "<size=30>" + L('UI_CONTROL_PANEL_TEXT_AUTO_SPIN') + ": " + displayAutoCount + "</size>";
            this.winLabel.string = line1 + "\n" + line2;
        } else {
            this.winLabel.string = line1;
        }
    }

    /** Cập nhật winLabel: WIN {round win} / Total win: {accumulated} */
    private _updateFreeSpinWinLabel(): void {
        if (!this.winLabel) return;
        const currencySymbol = L('CLIENT_CURRENENCY_SYMBOL');
        let line1: string;
        if (this._showFreeSpinRoundWinLine) {
            const roundWinStr = this._currentRoundWin === 0 ? '0' : formatCurrencyFixed(this._currentRoundWin);
            line1 = "<color=#ffa351>" + L('UI_CONTROL_PANEL_TEXT_PAY_WIN') + "</color> " + currencySymbol + roundWinStr;
        } else {
            line1 = this._getFeatureSpinRemainLine();
        }
        const totalStr = this._displayedFreeSpinWin === 0 ? '0' : formatCurrencyFixed(this._displayedFreeSpinWin);
        const line2 = "<size=30>Total win: " + currencySymbol + totalStr + "</size>";
        this.winLabel.string = line1 + "\n" + line2;
    }

    private _updateTopUpWinLabel(totalWin: number): void {
        if (!this.winLabel) return;
        const currencySymbol = L('CLIENT_CURRENENCY_SYMBOL');
        const line1 = totalWin > 0
            ? "<color=#ffa351>" + L('UI_CONTROL_PANEL_TEXT_PAY_WIN') + "</color> " + currencySymbol + formatCurrencyFixed(totalWin)
            : L('UI_CONTROL_PANEL_GUIDE_1');
        this.winLabel.string = line1 + "\n" + this._getFeatureSpinRemainLine();
    }

    /**
     * Animate count-up từ from → to trên winLabel.
     * Luôn bắt đầu từ _displayedFreeSpinWin hiện tại để đảm bảo số tăng liên tục,
     * không bao giờ giật về giá trị cũ hay 0 trong cùng 1 session.
     */
    private _animateFreeSpinWin(from: number, to: number): void {
        if (!this.winLabel) {
            this._displayedFreeSpinWin = to;
            return;
        }

        // Hủy animation cũ (tiếp tục từ giá trị đang hiển thị, không reset)
        if (this._freeSpinWinCountCb) {
            this.unschedule(this._freeSpinWinCountCb);
            this._freeSpinWinCountCb = null;
            // Nếu animation cũ đang tăng tiền và bị interrupt → stop coin loop
            if (this._freeSpinCoinLoopActive) {
                this._freeSpinCoinLoopActive = false;
                SoundManager.instance?.stopCoinLoop();
            }
        }

        // Không có thay đổi: chỉ refresh spin count
        if (from === to) {
            this._updateFreeSpinWinLabel();
            return;
        }

        const speedMode = AutoSpinManager.instance.speedMode;
        const isQuickOrTurbo = speedMode === SpeedMode.QUICK || speedMode === SpeedMode.TURBO;
        const isIncreasing = to > from;
        const delta = Math.abs(to - from);
        const COIN_LOOP_MIN_DELTA = 0.01;

        // Quick/Turbo: chỉ snap ngay khi đếm XUỐNG, còn đếm LÊN vẫn animate
        if (isQuickOrTurbo && !isIncreasing) {
            this._displayedFreeSpinWin = to;
            this._updateFreeSpinWinLabel();
            return;
        }

        const duration = 0.6;
        let elapsed = 0;
        const interval = 1 / 30;
        const startVal = from;

        // Chỉ phát coin loop khi số tiền tăng và delta đủ lớn
        if (isIncreasing && delta >= COIN_LOOP_MIN_DELTA) {
            this._freeSpinCoinLoopActive = true;
            SoundManager.instance?.playCoinLoop();
        }

        this._freeSpinWinCountCb = () => {
            elapsed += interval;
            const t = Math.min(elapsed / duration, 1);
            const eased = 1 - (1 - t) * (1 - t); // ease-out quad
            this._displayedFreeSpinWin = startVal + (to - startVal) * eased;
            this._updateFreeSpinWinLabel();

            if (t >= 1) {
                this._displayedFreeSpinWin = to;
                this._updateFreeSpinWinLabel();
                if (this._freeSpinCoinLoopActive) {
                    this._freeSpinCoinLoopActive = false;
                    SoundManager.instance?.stopCoinLoop();
                }
                this.unschedule(this._freeSpinWinCountCb!);
                this._freeSpinWinCountCb = null;
            }
        };

        this.schedule(this._freeSpinWinCountCb, interval);
    }

    private _animateBalance(from: number, to: number, isActuallyIncreasing?: boolean): void {
        if (!this.balanceLabel) {
            this._displayedBalance = to;
            return;
        }

        // Hủy animation cũ
        if (this._balanceCountCb) {
            this.unschedule(this._balanceCountCb);
            this._balanceCountCb = null;
            // Nếu animation cũ đang tăng tiền và bị interrupt → stop coin loop
            if (this._balanceCoinLoopActive) {
                this._balanceCoinLoopActive = false;
                SoundManager.instance?.stopCoinLoop();
            }
        }

        // Không có thay đổi: cập nhật label ngay, không animate → không play coin loop
        if (from === to) {
            this._displayedBalance = to;
            const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';
            this.balanceLabel.string = symbol + formatCurrencyFixed(to);
            return;
        }

        const speedMode = AutoSpinManager.instance.speedMode;
        const isQuickOrTurbo = speedMode === SpeedMode.QUICK || speedMode === SpeedMode.TURBO;
        const isIncreasing = isActuallyIncreasing ?? (to > from);
        const delta = Math.abs(to - from);
        const COIN_LOOP_MIN_DELTA = 0.01;

        // Quick/Turbo: chỉ snap ngay khi đếm XUỐNG, còn đếm LÊN vẫn animate
        if (isQuickOrTurbo && !isIncreasing) {
            this._displayedBalance = to;
            const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';
            this.balanceLabel.string = symbol + formatCurrencyFixed(to);
            return;
        }

        const duration = this.balanceCountDuration;
        let elapsed = 0;
        const interval = 1 / 30;
        const startVal = from;

        // Chỉ phát coin loop khi balance tăng và delta đủ lớn
        if (isIncreasing && delta >= COIN_LOOP_MIN_DELTA) {
            this._balanceCoinLoopActive = true;
            SoundManager.instance?.playCoinLoop();
        }

        this._balanceCountCb = () => {
            elapsed += interval;
            const t = Math.min(elapsed / duration, 1);

            const eased = 1 - (1 - t) * (1 - t); // ease-out quad
            const cur = startVal + (to - startVal) * eased;
            this._displayedBalance = cur;
            const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';
            this.balanceLabel!.string = symbol + formatCurrencyFixed(cur);

            if (t >= 1) {
                this._displayedBalance = to;
                const symbol = this._showCurrencySymbol ? L('CLIENT_CURRENENCY_SYMBOL') : '';
            this.balanceLabel!.string = symbol + formatCurrencyFixed(to);
                if (this._balanceCoinLoopActive) {
                    this._balanceCoinLoopActive = false;
                    SoundManager.instance?.stopCoinLoop();
                }
                this.unschedule(this._balanceCountCb!);
                this._balanceCountCb = null;
            }
        };

        this.schedule(this._balanceCountCb, interval);
    }

    /** 🎨 Hiệu ứng zoom nhẹ cho winLabel khi có tiền thắng */
    private _playWinLabelZoomEffect(): void {
        if (!this.winLabel) return;

        const node = this.winLabel.node;
        // Reset scale trước khi play animation
        node.setScale(new Vec3(1, 1, 1));

        tween(node)
            .to(0.15, { scale: new Vec3(1.12, 1.12, 1) }, { easing: 'backOut' })
            .to(0.15, { scale: new Vec3(1, 1, 1) }, { easing: 'sineOut' })
            .start();
    }
}
