/**
 * DebugManager - Quản lý debug shortcuts và DEBUG_RANDS runtime.
 *
 * ⚠️ Chỉ hoạt động khi ENABLE_DEBUG_TOOLS + (Editor / Web preview / debug build).
 *
 * [TEST CASH RACE SCENARIO]
 *   7 → MockScenario: RANDOM
 *   8 → MockScenario: TOP3 (mình lọt top 3)
 *   9 → MockScenario: NEARBY (mình ở rank 4+)
 *
 * Cơ chế: Khi nhấn 7/8/9, set pendingDebugRands.
 * Spin request sẽ dùng pendingDebugRands nếu có.
 * Sau khi spin response nhận được, getPendingDebugRands() sẽ trả về giá trị rồi reset.
 */

import { _decorator, input, Input, EventKeyboard, KeyCode } from 'cc';
import { isDebugToolsEnabled } from '../core/DebugEnv';
import { DEBUG_RANDS_PRESET } from '../data/ServerConfig';
import { LocalizationManager, LanguageCode } from '../core/LocalizationManager';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { PopupCase } from '../core/PopUpMessage';
import { ProgressiveWinTier } from '../controller/ProgressiveWinPopup';
import { ServerWinBroadcast, JackpotType } from '../data/SlotTypes';
import { BetManager } from './BetManager';
import { setMockScenario, MockScenario } from '../data/CashRaceMockAPI';
import { Log } from '../core/Logger';

const { ccclass } = _decorator;

/**
 * Keyboard shortcuts:
 *   1 → Jackpot: MINI
 *   2 → Jackpot: MINOR
 *   3 → Jackpot: MAJOR
 *   4 → Jackpot: GRAND
 *
 *   7 → MockScenario: RANDOM
 *   8 → MockScenario: TOP3
 *   9 → MockScenario: NEARBY
 *
 * [TEST FONT/LANGUAGE]
 *   F1 → English (en)
 *   F2 → Korean (ko)
 *   F3 → Simplified Chinese (zh-cn)
 *   F4 → Traditional Chinese (zh-tw)
 *   F5 → Filipino (fil)
 *   F6 → Japanese (ja)
 *   F7 → Thai (th)
 *
 * [TEST SYSTEM POPUP]
 *   P → DISCONNECTED
 *   Q → RELOGIN
 *   W → INSUFFICIENT_BALANCE
 *   E → EXPIRED_LINK
 *   R → WRONG_PARSHEET
 *   I → INVALID_REQUEST
 *   (T reserved — legacy wild trail mouse-follow test removed)
 *
 * [TEST PROGRESSIVE WIN]
 *   B → BIG WIN
 *   M → MEGA WIN
 *   J → MAJOR WIN
 *   S → SUPER WIN
 *   E → EPIC WIN
 *   U → ULTRA WIN
 *   O → MONSTER WIN
 *   X → MAX WIN
 *
 * [TEST TOPUP END POPUP]
 *   Y → TopUpEndPopup (CONGRATS)
 *
 */

const LANG_SHORTCUTS: { key: KeyCode; lang: LanguageCode; label: string }[] = [
    { key: KeyCode.F1, lang: 'en',    label: 'English' }, 
    { key: KeyCode.F2, lang: 'ko',    label: 'Korean' },
    { key: KeyCode.F3, lang: 'zh-cn', label: 'Simplified Chinese' },
    { key: KeyCode.F4, lang: 'zh-tw', label: 'Traditional Chinese' },
    { key: KeyCode.F5, lang: 'fil',   label: 'Filipino' },
    { key: KeyCode.F6, lang: 'ja',    label: 'Japanese' },
    { key: KeyCode.F7, lang: 'th',    label: 'Thai' },
];

@ccclass('DebugManager')
export class DebugManager {
    private static _instance: DebugManager;
    
    /** ⚡ ENABLE/DISABLE TẤT CẢ KEYBOARD SHORTCUTS — Set false để disable nhanh */
    private static _shortcutsEnabled: boolean = true;

    /** DEBUG_RANDS runtime — có thể thay đổi qua keyboard shortcuts */
    private _pendingDebugRands: readonly number[] | null = null;
    private _initialized: boolean = false;

    /** Đếm số popup đang mở — debug keys bị vô hiệu khi > 0 */
    private _openPopupCount: number = 0;

    private constructor() {}

    static get instance(): DebugManager {
        if (!this._instance) {
            this._instance = new DebugManager();
        }
        if (!this._instance._initialized) {
            this._instance._setupKeyboardShortcuts();
            this._instance._initialized = true;
        }
        return this._instance;
    }

    /** ⚡ Disable/Enable tất cả debug shortcuts nhanh */
    static setShortcutsEnabled(enabled: boolean): void {
        this._shortcutsEnabled = enabled;
        Log.d(
            `%c[DebugManager] DEBUG SHORTCUTS ${enabled ? 'ENABLED ✅' : 'DISABLED 🔒'}`,
            enabled ? 'color:#0f0;font-weight:bold' : 'color:#f00;font-weight:bold'
        );
    }

    static isShortcutsEnabled(): boolean {
        return this._shortcutsEnabled;
    }

    /** Lấy DEBUG_RANDS hiện tại (pending) — reset sau khi lấy */
    getPendingDebugRands(): readonly number[] | null {
        const result = this._pendingDebugRands;
        this._pendingDebugRands = null;
        return result;
    }

    /**
     * Set debugRands từ bên ngoài (UI Debug Panel, test script, v.v.)
     * Giá trị sẽ được dùng cho lần Spin tiếp theo rồi tự reset.
     */
    setDebugRands(rands: readonly number[] | null): void {
        this._pendingDebugRands = rands;
        if (rands) {
            Log.d(
                `%c[DebugManager] setDebugRands = [${rands.join(',')}]`,
                'color:#f90;font-weight:bold'
            );
        } else {
            Log.d('[DebugManager] debugRands cleared');
        }
    }

    private _setupKeyboardShortcuts(): void {
        if (!isDebugToolsEnabled()) {
            return;
        }

        try {
            input.on(Input.EventType.KEY_DOWN, this._onKeyDown, this);

            // Theo dõi trạng thái popup — khoá phím khi popup đang mở
            const bus = EventBus.instance;
            bus.on(GameEvents.JACKPOT_TRIGGER,          () => this._openPopupCount++, this);
            bus.on(GameEvents.JACKPOT_END,              () => this._openPopupCount = Math.max(0, this._openPopupCount - 1), this);
            bus.on(GameEvents.PROGRESSIVE_WIN_SHOW,     () => this._openPopupCount++, this);
            bus.on(GameEvents.PROGRESSIVE_WIN_END,      () => this._openPopupCount = Math.max(0, this._openPopupCount - 1), this);
            bus.on(GameEvents.FREE_SPIN_END_POPUP,      () => this._openPopupCount++, this);
            bus.on(GameEvents.FREE_SPIN_END_POPUP_CLOSED, () => this._openPopupCount = Math.max(0, this._openPopupCount - 1), this);
            bus.on(GameEvents.TOPUP_END_POPUP,          () => this._openPopupCount++, this);
            bus.on(GameEvents.TOPUP_END_POPUP_CLOSED,   () => this._openPopupCount = Math.max(0, this._openPopupCount - 1), this);
            bus.on(GameEvents.SHOW_SYSTEM_POPUP,        () => this._openPopupCount++, this);

            Log.d(
                '[DebugManager] 🔧 DEBUG SHORTCUTS ENABLED:' +
                ' 1=MINI_JACKPOT | 2=MINOR_JACKPOT | 3=MAJOR_JACKPOT | 4=GRAND_JACKPOT' +
                ' | 7=SCENARIO:RANDOM | 8=SCENARIO:TOP3 | 9=SCENARIO:NEARBY' +
                ' | F1=en | F2=ko | F3=zh-cn | F4=zh-tw | F5=fil | F6=ja | F7=th' +
                ' | P=DISCONNECTED | Q=RELOGIN | W=INSUFFICIENT_BALANCE | E=EXPIRED | R=WRONG_PARSHEET | I=INVALID_REQUEST' +
                ' | (T=legacy wild trail mouse-follow removed)' +
                ' | B=BIG_WIN | M=MEGA_WIN | J=MAJOR_WIN | S=SUPER_WIN | E=EPIC_WIN | U=ULTRA_WIN | O=MONSTER_WIN | X=MAX_WIN' +
                ' | Y=TOPUP_END_POPUP | V=BROADCAST_MOCK (cycle)'
            );
        } catch (err) {
            Log.w('[DebugManager] Failed to setup keyboard shortcuts:', err);
        }
    }

    private _onKeyDown(event: EventKeyboard): void {
        // ⚡ Nhanh chóng disable tất cả shortcuts
        if (!DebugManager._shortcutsEnabled) return;
        if (!isDebugToolsEnabled()) return;

        if (this._openPopupCount > 0) return;

        switch (event.keyCode) {
            // ─── Jackpot test ───
            case KeyCode.DIGIT_1:
            case KeyCode.NUM_1:
                this._triggerJackpotTest(JackpotType.MINI, 'MINI JACKPOT');
                break;
            case KeyCode.DIGIT_2:
            case KeyCode.NUM_2:
                this._triggerJackpotTest(JackpotType.MINOR, 'MINOR JACKPOT');
                break;
            case KeyCode.DIGIT_3:
            case KeyCode.NUM_3:
                this._triggerJackpotTest(JackpotType.MAJOR, 'MAJOR JACKPOT');
                break;
            case KeyCode.DIGIT_4:
            case KeyCode.NUM_4:
                this._triggerJackpotTest(JackpotType.GRAND, 'GRAND JACKPOT');
                break;

            // ─── Cash Race MockScenario ───
            case KeyCode.DIGIT_7:
            case KeyCode.NUM_7:
                this._setCashRaceScenario('RANDOM');
                break;
            case KeyCode.DIGIT_8:
            case KeyCode.NUM_8:
                this._setCashRaceScenario('TOP3');
                break;
            case KeyCode.DIGIT_9:
            case KeyCode.NUM_9:
                this._setCashRaceScenario('NEARBY');
                break;

            // ─── Language / font test ───
            default: {
                const shortcut = LANG_SHORTCUTS.find(s => s.key === event.keyCode);
                if (shortcut) {
                    this._switchLanguage(shortcut.lang, shortcut.label);
                    break;
                }
                if (this._triggerProgressiveWinTest(event.keyCode)) break;
                if (this._triggerTopUpEndPopupTest(event.keyCode)) break;
                if (this._triggerBroadcastTest(event.keyCode)) break;
                this._triggerPopupTest(event.keyCode);
                break;
            }
        }
    }

    private _setCashRaceScenario(scenario: MockScenario): void {
        setMockScenario(scenario);
        Log.d(
            `%c[DEBUG] CashRace MockScenario → ${scenario}`,
            'color:#0f0;font-weight:bold'
        );
    }

    private _switchLanguage(lang: LanguageCode, label: string): void {
        LocalizationManager.instance.setLanguage(lang);
        Log.d(`%c[DEBUG] Language → ${label} (${lang})`, 'color:#0af;font-weight:bold');
    }

    private _triggerProgressiveWinTest(keyCode: KeyCode): boolean {
        // Amounts = totalBet × tier multiplier, đảm bảo luôn đúng ngưỡng
        const bet = BetManager.instance.totalBet || 1;
        const PROGRESSIVE_SHORTCUTS: { key: KeyCode; tier: ProgressiveWinTier; label: string; mul: number }[] = [
            { key: KeyCode.KEY_B, tier: ProgressiveWinTier.BIG,     label: 'BIG WIN',     mul: 30 },
            { key: KeyCode.KEY_M, tier: ProgressiveWinTier.MEGA,    label: 'MEGA WIN',    mul: 70 },
            { key: KeyCode.KEY_J, tier: ProgressiveWinTier.MAJOR,   label: 'MAJOR WIN',   mul: 150 },
            { key: KeyCode.KEY_S, tier: ProgressiveWinTier.SUPER,   label: 'SUPER WIN',   mul: 250 },
            { key: KeyCode.KEY_E, tier: ProgressiveWinTier.EPIC,    label: 'EPIC WIN',    mul: 500 },
            { key: KeyCode.KEY_U, tier: ProgressiveWinTier.ULTRA,   label: 'ULTRA WIN',   mul: 1000 },
            { key: KeyCode.KEY_O, tier: ProgressiveWinTier.MONSTER, label: 'MONSTER WIN', mul: 2000 },
            { key: KeyCode.KEY_X, tier: ProgressiveWinTier.MAX,     label: 'MAX WIN',     mul: 4000 },
        ];

        const found = PROGRESSIVE_SHORTCUTS.find(s => s.key === keyCode);
        if (!found) return false;

        const amount = bet * found.mul;
        Log.d(
            `%c[DEBUG] Progressive Win test → ${found.label} | bet=${bet} amount=${amount}`,
            'color:#ff0;font-weight:bold'
        );

        EventBus.instance.emit(GameEvents.PROGRESSIVE_WIN_SHOW, found.tier, amount);
        return true;
    }

    /** Y — Show TopUpEndPopup với amount test (count-up + spine) */
    private _triggerTopUpEndPopupTest(keyCode: KeyCode): boolean {
        if (keyCode !== KeyCode.KEY_Y) return false;

        // Hardcoded decimal để verify truncate 3 chữ số thập phân
        const amount = 999999.448;
        Log.d(
            `%c[DEBUG] TopUpEndPopup test → amount=${amount}`,
            'color:#fa0;font-weight:bold'
        );
        EventBus.instance.emit(GameEvents.TOPUP_END_POPUP, amount);
        return true;
    }

    // ─── Broadcast mock data ───
    private _broadcastMockIndex = 0;

    private readonly _BROADCAST_MOCK_DATA: ServerWinBroadcast[] = [
        {
            Seq: '1001', Slot: 'SuperNova', MX: 500,
            Nick: 'user_uuid_001', DisplayName: 'LuckyKing88', Feature: 'GRAND',
            LangID: 'ko', WinPopupUrl: '', SlotIcon: '', CountryFlagIcon: '', CTime: '',
        },
        {
            Seq: '1002', Slot: 'SuperNova', MX: 250,
            Nick: 'user_uuid_002', DisplayName: 'MegaWinner', Feature: 'MEGA_WIN',
            LangID: 'en', WinPopupUrl: '', SlotIcon: '', CountryFlagIcon: '', CTime: '',
        },
        {
            Seq: '1003', Slot: 'SuperNova', MX: 120,
            Nick: 'user_uuid_003', DisplayName: 'SuperPro', Feature: 'SUPER_WIN',
            LangID: 'th', WinPopupUrl: '', SlotIcon: '', CountryFlagIcon: '', CTime: '',
        },
        {
            Seq: '1004', Slot: 'SuperNova', MX: 200,
            Nick: 'user_uuid_004', DisplayName: 'MajorHunter', Feature: 'MAJOR',
            LangID: 'fil', WinPopupUrl: '', SlotIcon: '', CountryFlagIcon: '', CTime: '',
        },
        {
            Seq: '1005', Slot: 'SuperNova', MX: 35,
            Nick: 'user_uuid_005', DisplayName: 'FreeSpinFan', Feature: 'FREE_SPIN',
            LangID: 'zh-cn', WinPopupUrl: '', SlotIcon: '', CountryFlagIcon: '', CTime: '',
        },
        {
            Seq: '1006', Slot: 'SuperNova', MX: 10,
            Nick: 'user_uuid_006', DisplayName: 'MiniWin', Feature: 'MINI',
            LangID: 'ja', WinPopupUrl: '', SlotIcon: '', CountryFlagIcon: '', CTime: '',
        },
    ];

    /** V — Trigger mock broadcast popup (cycle qua các mock entry) */
    private _triggerJackpotTest(jackpotType: JackpotType, label: string): void {
        // Hardcoded decimal amounts to verify truncation/no rounding in popups
        const hardcoded: Record<number, number> = {
            [JackpotType.MINI]:  99.44815,
            [JackpotType.MINOR]: 94909.999,
            [JackpotType.MAJOR]: 12.34567,
            [JackpotType.GRAND]: 0.99999,
        };
        const fallback = (BetManager.instance.totalBet || 1) * 100;
        const amount = hardcoded[jackpotType] ?? fallback;
        Log.d(
            `%c[DEBUG] Jackpot test → ${label} | amount=${amount}`,
            'color:#f90;font-weight:bold'
        );
        EventBus.instance.emit(GameEvents.JACKPOT_TRIGGER, jackpotType, amount);
    }

    private _triggerBroadcastTest(keyCode: KeyCode): boolean {
        if (keyCode !== KeyCode.KEY_V) return false;
        const mock = this._BROADCAST_MOCK_DATA[this._broadcastMockIndex % this._BROADCAST_MOCK_DATA.length];
        this._broadcastMockIndex++;
        Log.d(
            `%c[DEBUG] Broadcast mock #${this._broadcastMockIndex} → Seq=${mock.Seq} DisplayName="${mock.DisplayName || mock.Nick}" Feature="${mock.Feature}" MX=${mock.MX}`,
            'color:#0ff;font-weight:bold'
        );
        EventBus.instance.emit(GameEvents.BROADCAST_WIN_MESSAGE, mock);
        return true;
    }

    private _triggerPopupTest(keyCode: KeyCode): void {
        const POPUP_SHORTCUTS: { key: KeyCode; popupCase: PopupCase; label: string }[] = [
            { key: KeyCode.KEY_P, popupCase: PopupCase.DISCONNECTED,        label: 'DISCONNECTED' },
            { key: KeyCode.KEY_Q, popupCase: PopupCase.RELOGIN,             label: 'RELOGIN' },
            { key: KeyCode.KEY_W, popupCase: PopupCase.INSUFFICIENT_BALANCE, label: 'INSUFFICIENT_BALANCE' },
            { key: KeyCode.KEY_E, popupCase: PopupCase.EXPIRED_LINK,        label: 'EXPIRED_LINK' },
            { key: KeyCode.KEY_R, popupCase: PopupCase.WRONG_PARSHEET,      label: 'WRONG_PARSHEET' },
            { key: KeyCode.KEY_I, popupCase: PopupCase.INVALID_REQUEST,     label: 'INVALID_REQUEST' },
        ];

        const found = POPUP_SHORTCUTS.find(s => s.key === keyCode);
        if (!found) return;

        Log.d(
            `%c[DEBUG] Popup test → ${found.label}`,
            'color:#f0f;font-weight:bold'
        );

        EventBus.instance.emit(GameEvents.SHOW_SYSTEM_POPUP, {
            popupCase: found.popupCase,
            onConfirm: found.popupCase === PopupCase.INSUFFICIENT_BALANCE
                ? () => Log.d('[DEBUG] INSUFFICIENT_BALANCE → onConfirm (mock refresh)')
                : undefined,
            onCancel: found.popupCase === PopupCase.INSUFFICIENT_BALANCE
                ? () => Log.d('[DEBUG] INSUFFICIENT_BALANCE → onCancel')
                : undefined,
        });
    }
}
