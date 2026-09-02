/**
 * AutoSpinManager - Quáº£n lÃ½ Auto Spin count vÃ  Speed Mode.
 *
 * â”€â”€ SINGLETON â”€â”€
 *   KhÃ´ng cáº§n gáº¯n vÃ o Node. Khá»Ÿi táº¡o qua AutoSpinManager.instance.
 *   Gá»i AutoSpinManager.instance trong GameManager.onLoad() Ä‘á»ƒ khá»Ÿi táº¡o sá»›m.
 *
 * â”€â”€ AUTO SPIN FLOW â”€â”€
 *   User chá»n count N â†’ Ä‘Ã³ng AutoSettingPopup â†’ spin thá»§ cÃ´ng láº§n Ä‘áº§u.
 *   Sau má»—i Normal Spin káº¿t thÃºc (NORMAL_SPIN_DONE):
 *     count > 0 â†’ decrement â†’ delay nhá» â†’ emit SPIN_REQUEST.
 *     count = 0 â†’ dá»«ng.
 *   Free Spin KHÃ”NG áº£nh hÆ°á»Ÿng count (chá»‰ Normal Spin má»›i decrement).
 *
 * â”€â”€ SPEED MODE â”€â”€
 *   Normal: tá»‘c Ä‘á»™ máº·c Ä‘á»‹nh.
 *   Quick: 2Ã— nhanh hÆ¡n.
 *   Turbo: gáº§n nhÆ° dá»«ng ngay khi cÃ³ káº¿t quáº£ tá»« server.
 *
 * â”€â”€ PERSIST â”€â”€
 *   LÆ°u vÃ o localStorage: count cÃ²n láº¡i + speed mode, key theo SLOT_ID + memberId
 *   Ä‘á»ƒ khÃ´ng leak Auto Spin giá»¯a cÃ¡c game (cÃ¹ng origin / cÃ¹ng player).
 *   Táº£i láº¡i khi khá»Ÿi Ä‘á»™ng â†’ tiáº¿p tá»¥c auto spin náº¿u cÃ²n count (cÃ¹ng game).
 */

import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { Log } from '../core/Logger';
import { GameData } from '../data/GameData';
import { ServerConfig } from '../data/ServerConfig';
import { SlotStageType } from '../data/SlotTypes';

// Fallback keys (for backward compatibility, will be migrated to session-specific keys)
const LS_AUTO_COUNT_LEGACY          = 'sn_auto_spin_count';
const LS_AUTO_ACTIVE_LEGACY         = 'sn_auto_spin_active';
const LS_SPEED_MODE_LEGACY          = 'sn_speed_mode';
const LS_AUTO_ORIGINAL_COUNT_LEGACY = 'sn_auto_spin_original_count';

export const AUTO_NEXT_SPIN_BASE_DELAY_MS = 200;
export const AUTO_SPIN_DELAY_MS = AUTO_NEXT_SPIN_BASE_DELAY_MS; // backward-compatible alias

export enum SpeedMode {
    NORMAL = 'normal',
    QUICK  = 'quick',
    TURBO  = 'turbo',
}

export class AutoSpinManager {
    private static _instance: AutoSpinManager | null = null;

    private _autoSpinCount: number = 0;
    private _originalAutoSpinCount: number = 0;
    private _isAutoSpinActive: boolean = false;
    private _speedMode: SpeedMode = SpeedMode.NORMAL;
    private _isFreeSpinMode: boolean = false;
    private _isPaused: boolean = false;
    /** Flag Ä‘á»ƒ chá»‰ trigger auto spin resume 1 láº§n duy nháº¥t sau khi game khá»Ÿi táº¡o */
    private _gameInitDone: boolean = false;
    /**
     * Set = true bá»Ÿi _onEnterSuccess() â†’ bÃ¡o cho _onGameReady() biáº¿t cáº§n check resume.
     * TÃ¡ch khá»i _gameInitDone Ä‘á»ƒ trÃ¡nh race condition trong two-scene flow:
     *   loading scene GAME_READY set _gameInitDone=true trÆ°á»›c khi game scene ENTER_SUCCESS.
     */
    private _pendingResumeAfterLoad: boolean = false;
    /** Member ID tá»« láº§n load trÆ°á»›c â€” dÃ¹ng Ä‘á»ƒ detect khi player thay Ä‘á»•i (undefined = chÆ°a init) */
    private _lastMemberId: number | null | undefined = undefined;

    private constructor() {
        Log.d('[AutoSpinManager] ðŸ”§ constructor() â€” báº¯t Ä‘áº§u khá»Ÿi táº¡o');
        // KHÃ”NG gá»i _load() á»Ÿ Ä‘Ã¢y â€” session/memberIdx chÆ°a cÃ³ táº¡i thá»i Ä‘iá»ƒm constructor.
        // _load() sáº½ Ä‘Æ°á»£c gá»i láº§n Ä‘áº§u trong _onSpinButtonState khi session Ä‘Ã£ sáºµn sÃ ng.
        this._bindEvents();
    }

    static get instance(): AutoSpinManager {
        if (!AutoSpinManager._instance) {
            AutoSpinManager._instance = new AutoSpinManager();
        }
        return AutoSpinManager._instance;
    }

    /**
     * Láº¥y member ID tá»« GameData Ä‘á»ƒ táº¡o unique keys cho má»—i player.
     * Tráº£ vá» null náº¿u chÆ°a login hoáº·c memberIdx <= 0 (mock mode).
     */
    private _getMemberId(): number | null {
        try {
            const session = GameData.instance.serverSession;
            if (session && session.memberIdx > 0) {
                return session.memberIdx;
            }
        } catch (_) {}
        return null;
    }

    /**
     * Táº¡o unique storage key theo game + player.
     * Format: {baseKey}_{slotId}_{memberId}  (hoáº·c {baseKey}_{slotId} náº¿u chÆ°a login).
     */
    private _getStorageKey(baseKey: string): string {
        const slotId = ServerConfig.SLOT_ID;
        const memberId = this._getMemberId();
        const key = memberId !== null ? `${baseKey}_${slotId}_${memberId}` : `${baseKey}_${slotId}`;
        Log.d(`[AutoSpinManager] _getStorageKey("${baseKey}") â†’ ${key}`);
        return key;
    }

    /**
     * Kiá»ƒm tra xem player cÃ³ thay Ä‘á»•i khÃ´ng (e.g. login khÃ¡c account).
     * Gá»i tá»« _save() má»—i láº§n lÆ°u Ä‘á»ƒ detect switch account vÃ  reset state.
     */
    private _onPlayerChanged(): void {
        const currentMemberId = this._getMemberId();

        // Náº¿u memberIdx thay Ä‘á»•i tá»« má»™t giÃ¡ trá»‹ há»£p lá»‡ sang giÃ¡ trá»‹ khÃ¡c â†’ Ä‘ang switch account
        if (this._lastMemberId !== null &&
            this._lastMemberId !== undefined &&
            currentMemberId !== null &&
            this._lastMemberId !== currentMemberId) {
            Log.d(`[AutoSpinManager] ðŸ”„ Player thay Ä‘á»•i tá»« ${this._lastMemberId} â†’ ${currentMemberId} â€” reset Auto Spin state`);
            this._autoSpinCount = 0;
            this._isAutoSpinActive = false;
            this._speedMode = SpeedMode.NORMAL;
            this._isPaused = false;
            this._gameInitDone = false;
            EventBus.instance.emit(GameEvents.AUTO_SPIN_CHANGED, 0);
        }

        if (currentMemberId !== null) this._lastMemberId = currentMemberId;
    }

    // â”€â”€â”€ GETTERS â”€â”€â”€

    get autoSpinCount(): number { return this._autoSpinCount; }
    get originalAutoSpinCount(): number { return this._originalAutoSpinCount; }
    get isAutoSpinActive(): boolean { return this._isAutoSpinActive; }
    get speedMode(): SpeedMode { return this._speedMode; }
    get isFreeSpinMode(): boolean { return this._isFreeSpinMode; }
    get isPaused(): boolean { return this._isPaused; }

    /**
     * Tráº£ vá» multiplier Ä‘á»ƒ Ä‘iá»u chá»‰nh thá»i gian animation theo speed mode.
     * NORMAL: 1.0 (khÃ´ng thay Ä‘á»•i)
     * QUICK: 0.5 (2x nhanh hÆ¡n - táº¥t cáº£ thá»i gian giáº£m 50%)
     * TURBO: 0.33 (3x nhanh hÆ¡n - táº¥t cáº£ thá»i gian giáº£m 67%)
     */
    getTimingMultiplier(): number {
        switch (this._speedMode) {
            case SpeedMode.QUICK: return 0.8;
            case SpeedMode.TURBO: return 0.6;
            default: return 1.0;
        }
    }

    getNextSpinDelayMs(): number {
        return AUTO_NEXT_SPIN_BASE_DELAY_MS;
    }

    // â”€â”€â”€ SETTERS (gá»i tá»« AutoSettingPopup) â”€â”€â”€

    setAutoSpinCount(count: number): void {
        this._isPaused = false;
        const rounded = Math.max(0, Math.round(count));
        this._autoSpinCount = rounded;
        // LÆ°u giÃ¡ trá»‹ gá»‘c user Ä‘Ã£ chá»n; reset khi count vá» 0
        this._originalAutoSpinCount = rounded > 0 ? rounded : 0;
        // KHÃ”NG set _isAutoSpinActive á»Ÿ Ä‘Ã¢y â€” chá»‰ lÆ°u sá»‘ Ä‘áº¿m.
        // _isAutoSpinActive chá»‰ Ä‘Æ°á»£c báº­t khi resumeAutoSpin() (tá»©c lÃ  nháº¥n Confirm).
        if (this._autoSpinCount === 0) this._isAutoSpinActive = false;
        this._save();
        EventBus.instance.emit(GameEvents.AUTO_SPIN_CHANGED, this._autoSpinCount);
    }

    setSpeedMode(mode: SpeedMode): void {
        this._speedMode = mode;
        this._save();
        EventBus.instance.emit(GameEvents.SPEED_MODE_CHANGED, mode);
    }

    stopAutoSpin(): void {
        this.setAutoSpinCount(0);
    }

    /**
     * Táº¡m dá»«ng auto spin nhÆ°ng giá»¯ nguyÃªn count (cho popup hiá»ƒn thá»‹ láº¡i).
     * _isAutoSpinActive = false Ä‘Æ°á»£c save â†’ reload game sáº½ khÃ´ng tá»± resume.
     */
    pauseAutoSpin(): void {
        if (this._autoSpinCount <= 0) return;
        this._isPaused = true;
        this._isAutoSpinActive = false;
        this._save();
        EventBus.instance.emit(GameEvents.AUTO_SPIN_CHANGED, 0);
    }

    resumeAutoSpin(): void {
        this._isPaused = false;
        this._isAutoSpinActive = this._autoSpinCount > 0;
        this._save();
        // ThÃ´ng bÃ¡o UI biáº¿t autoSpin vá»«a ACTIVE (setAutoSpinCount Ä‘Ã£ emit vá»›i _isAutoSpinActive=false)
        EventBus.instance.emit(GameEvents.AUTO_SPIN_CHANGED, this._autoSpinCount);
    }

    // â”€â”€â”€ EVENTS â”€â”€â”€

    private _bindEvents(): void {
        const bus = EventBus.instance;
        Log.d('[AutoSpinManager] ðŸ“¡ _bindEvents() â€” Ä‘Äƒng kÃ½ ENTER_SUCCESS, GAME_READY, UI_SPIN_BUTTON_STATE, NORMAL_SPIN_DONE, FREE_SPIN_*');
        bus.on(GameEvents.ENTER_SUCCESS,        this._onEnterSuccess,     this);
        bus.on(GameEvents.FREE_SPIN_START,      this._onFreeSpinStart,    this);
        bus.on(GameEvents.FREE_SPIN_END,        this._onFreeSpinEnd,      this);
        bus.on(GameEvents.TOPUP_END,            this._onTopUpEnd,         this);
        bus.on(GameEvents.NORMAL_SPIN_DONE,     this._onNormalSpinDone,   this);
        bus.on(GameEvents.GAME_READY,           this._onGameReady,        this);
        bus.on(GameEvents.UI_SPIN_BUTTON_STATE, this._onSpinButtonState,  this);
    }

    /**
     * ENTER_SUCCESS â€” session/memberIdx Ä‘Ã£ sáºµn sÃ ng â†’ load state tá»« localStorage ngay.
     * Payload cÃ³ thá»ƒ chá»©a memberIdx trá»±c tiáº¿p nhÆ°ng ta dÃ¹ng GameData Ä‘á»ƒ nháº¥t quÃ¡n.
     */
    private _onEnterSuccess(): void {
        const mid = this._getMemberId();
        Log.d(`[AutoSpinManager] ðŸ”‘ _onEnterSuccess â€” memberId=${mid ?? 'null'} â†’ load from localStorage`);
        this._load();
        // ÄÃ¡nh dáº¥u cáº§n check resume á»Ÿ GAME_READY tiáº¿p theo.
        // KHÃ”NG reset _gameInitDone vÃ¬ loading scene GAME_READY Ä‘Ã£ cháº¡y rá»“i.
        // _pendingResumeAfterLoad chá»‰ Ä‘Æ°á»£c set SAU _load() nÃªn GAME_READY loading scene KHÃ”NG áº£nh hÆ°á»Ÿng.
        this._pendingResumeAfterLoad = true;

        // â”€â”€ FALLBACK: náº¿u GAME_READY khÃ´ng fire (hoáº·c Ä‘Ã£ fire trÆ°á»›c ENTER_SUCCESS)
        // â†’ tá»± resume sau 3 giÃ¢y náº¿u isActive=true vÃ  chÆ°a cÃ³ gÃ¬ trigger spin
        setTimeout(() => {
            if (this._pendingResumeAfterLoad) {
                this._pendingResumeAfterLoad = false;
                if (this._isAutoSpinActive && this._autoSpinCount > 0 && !this._isFreeSpinMode) {
                    this._emitSpinRequestIfAllowed();
                }
            }
        }, 3000);
    }

    private _onFreeSpinStart(): void {
        this._isFreeSpinMode = true;
    }

    private _onFreeSpinEnd(): void {
        this._isFreeSpinMode = false;
        // Tiáº¿p tá»¥c normal spin náº¿u Ä‘ang active vÃ  cÃ²n count
        if (this._isAutoSpinActive && this._autoSpinCount > 0) {
            setTimeout(() => {
                this._emitSpinRequestIfAllowed();
            }, this.getNextSpinDelayMs());
        }
    }

    private _onTopUpEnd(): void {
        // Tiáº¿p tá»¥c normal spin náº¿u Ä‘ang active vÃ  cÃ²n count
        if (this._isAutoSpinActive && this._autoSpinCount > 0) {
            setTimeout(() => {
                this._emitSpinRequestIfAllowed();
            }, this.getNextSpinDelayMs());
        }
    }

    private _onGameReady(): void {
        Log.d(`[AutoSpinManager] ðŸŽŸï¸ _onGameReady â€” autoSpinCount=${this._autoSpinCount}, isAutoSpinActive=${this._isAutoSpinActive}, pendingResume=${this._pendingResumeAfterLoad}, gameInitDone=${this._gameInitDone}`);

        // KHÃ”NG set _gameInitDone á»Ÿ Ä‘Ã¢y â€” Ä‘á»ƒ _onSpinButtonState cÃ³ thá»ƒ xá»­ lÃ½ tiáº¿p náº¿u cáº§n.
        // Chá»‰ resume náº¿u ENTER_SUCCESS Ä‘Ã£ fire trÆ°á»›c GAME_READY nÃ y (_pendingResumeAfterLoad=true).
        if (!this._pendingResumeAfterLoad) {
            return;
        }
        this._pendingResumeAfterLoad = false;
        this._gameInitDone = true;

        if (this._isAutoSpinActive && this._autoSpinCount > 0 && !this._isFreeSpinMode) {
            const delayMs = this.getNextSpinDelayMs();
            Log.d(`[AutoSpinManager] â–¶ï¸ _onGameReady â†’ Resume auto spin â€” count=${this._autoSpinCount}, emit SPIN_REQUEST sau ${delayMs}ms`);
            setTimeout(() => {
                Log.d(`[AutoSpinManager] ðŸŸ¢ emit SPIN_REQUEST (auto spin resume from GAME_READY)`);
                this._emitSpinRequestIfAllowed();
            }, delayMs);
        } else {
        }
    }

    /**
     * UI_SPIN_BUTTON_STATE(true) â€” signal cháº¯c cháº¯n nháº¥t "game sáºµn sÃ ng spin".
     * DÃ¹ng lÃ m fallback resume náº¿u GAME_READY khÃ´ng cÃ³ _pendingResumeAfterLoad
     * (xáº£y ra khi GAME_READY game scene fire trÆ°á»›c ENTER_SUCCESS re-emit).
     */
    private _onSpinButtonState(enabled: boolean): void {
        if (!enabled) return;

        // Fallback: ENTER_SUCCESS Ä‘Ã£ set pendingResume=true nhÆ°ng GAME_READY Ä‘Ã£ bá» qua
        // â†’ dÃ¹ng UI_SPIN_BUTTON_STATE láº§n Ä‘áº§u Ä‘á»ƒ trigger resume
        if (this._pendingResumeAfterLoad && !this._gameInitDone) {
            this._pendingResumeAfterLoad = false;
            this._gameInitDone = true;
            if (this._isAutoSpinActive && this._autoSpinCount > 0 && !this._isFreeSpinMode) {
                setTimeout(() => {
                    this._emitSpinRequestIfAllowed();
                }, this.getNextSpinDelayMs());
            }
            return;
        }

        if (this._gameInitDone) return;
        this._gameInitDone = true;
        Log.d(`[AutoSpinManager] ðŸ”˜ _onSpinButtonState(true) láº§n Ä‘áº§u â€” gameInitDone=true set`);
    }

    private _onNormalSpinDone(): void {
        // Log.e(`[SPIN-HANG][AUTO] NORMAL_SPIN_DONE received | freeSpinMode=${this._isFreeSpinMode} active=${this._isAutoSpinActive} count=${this._autoSpinCount} paused=${this._isPaused} speed=${this._speedMode}`);
        // Chá»‰ trigger khi Ä‘ang active vÃ  Ä‘ang Normal spin
        if (this._isFreeSpinMode) return;
        if (!this._isAutoSpinActive) return;
        if (this._autoSpinCount <= 0) return;

        this._autoSpinCount--;
        if (this._autoSpinCount === 0) {
            this._isAutoSpinActive = false;
            this._originalAutoSpinCount = 0;
        }
        this._save();
        EventBus.instance.emit(GameEvents.AUTO_SPIN_CHANGED, this._autoSpinCount);
        // Log.e(`[SPIN-HANG][AUTO] NORMAL_SPIN_DONE applied | active=${this._isAutoSpinActive} count=${this._autoSpinCount}`);

        if (this._autoSpinCount > 0) {
            setTimeout(() => {
                // Log.e(`[SPIN-HANG][AUTO] emit SPIN_REQUEST after NORMAL_SPIN_DONE | active=${this._isAutoSpinActive} count=${this._autoSpinCount}`);
                this._emitSpinRequestIfAllowed();
            }, this.getNextSpinDelayMs());
        }
    }

    /** KhÃ´ng /Spin khi server/client cÃ²n trong Pick Game (CurrentStage=PICK). */
    private _emitSpinRequestIfAllowed(): void {
        if (this._isPickGameBlockingSpin()) {
            Log.w('[AutoSpinManager] skip SPIN_REQUEST â€” Pick Game in progress');
            return;
        }
        EventBus.instance.emit(GameEvents.SPIN_REQUEST);
    }

    private _isPickGameBlockingSpin(): boolean {
        const data = GameData.instance;
        if (data.pickGameWinAmount > 0 || data.pickGameState?.wonTier) return false;
        if (data.pickGameState) return true;
        const liveNs = Number(data.lastSpinResponse?.nextStage);
        if (Number.isFinite(liveNs)) {
            return liveNs === SlotStageType.PICK
                || liveNs === SlotStageType.PICK_START
                || liveNs === SlotStageType.PICK_GAME
                || liveNs === SlotStageType.POT_WIN;
        }
        const raw = data.rawEnterLastSpinResponse as { NextStage?: number; nextStage?: number } | null;
        const ns = Number(raw?.NextStage ?? raw?.nextStage ?? NaN);
        return ns === SlotStageType.PICK
            || ns === SlotStageType.PICK_START
            || ns === SlotStageType.PICK_GAME
            || ns === SlotStageType.POT_WIN;
    }

    // â”€â”€â”€ PERSIST â”€â”€â”€

    private _save(): void {
        try {
            // Kiá»ƒm tra switch account trÆ°á»›c khi lÆ°u
            this._onPlayerChanged();

            // Cáº­p nháº­t _lastMemberId Ä‘á»ƒ _getStorageKey() dÃ¹ng Ä‘Ãºng key
            const memberId = this._getMemberId();
            if (memberId !== null) this._lastMemberId = memberId;

            // Táº¡o storage keys (cÃ³ memberIdx hoáº·c legacy náº¿u chÆ°a login)
            const keyCount    = this._getStorageKey(LS_AUTO_COUNT_LEGACY);
            const keyActive   = this._getStorageKey(LS_AUTO_ACTIVE_LEGACY);
            const keyMode     = this._getStorageKey(LS_SPEED_MODE_LEGACY);
            const keyOriginal = this._getStorageKey(LS_AUTO_ORIGINAL_COUNT_LEGACY);

            Log.d(`[AutoSpinManager] ðŸ’¾ _save() â€” memberId=${this._lastMemberId ?? 'null'}, keys: ${keyCount}, active=${this._isAutoSpinActive}, count=${this._autoSpinCount}`);
            localStorage.setItem(keyCount,    String(this._autoSpinCount));
            localStorage.setItem(keyActive,   String(this._isAutoSpinActive));
            localStorage.setItem(keyMode,     this._speedMode);
            localStorage.setItem(keyOriginal, String(this._originalAutoSpinCount));
            // Verify
        } catch (err) {
            Log.err(`[AutoSpinManager] _save() FAILED â€” localStorage error:`, err);
        }
    }

    private _load(): void {
        try {
            // Láº¥y memberIdx táº¡i thá»i Ä‘iá»ƒm load (session Ä‘Ã£ sáºµn sÃ ng khi gá»i tá»« _onEnterSuccess)
            const memberId = this._getMemberId();
            if (memberId !== null) this._lastMemberId = memberId;

            // Táº¡o storage keys (cÃ³ memberIdx hoáº·c legacy náº¿u chÆ°a login)
            const keyCount    = this._getStorageKey(LS_AUTO_COUNT_LEGACY);
            const keyActive   = this._getStorageKey(LS_AUTO_ACTIVE_LEGACY);
            const keyMode     = this._getStorageKey(LS_SPEED_MODE_LEGACY);
            const keyOriginal = this._getStorageKey(LS_AUTO_ORIGINAL_COUNT_LEGACY);

            const count    = localStorage.getItem(keyCount);
            const active   = localStorage.getItem(keyActive);
            const mode     = localStorage.getItem(keyMode);
            const original = localStorage.getItem(keyOriginal);
            Log.d(`[AutoSpinManager] ðŸ’¾ _load() â€” memberId=${this._lastMemberId ?? 'null'}, keys: ${keyCount}, count=${count ?? 'null'}, active=${active ?? 'null'}, mode=${mode ?? 'null'}`);

            if (count !== null) {
                this._autoSpinCount = Math.max(0, Math.min(1000, parseInt(count, 10) || 0));
            }
            if (original !== null) {
                this._originalAutoSpinCount = Math.max(0, parseInt(original, 10) || 0);
            } else if (this._autoSpinCount > 0) {
                // Fallback: náº¿u chÆ°a cÃ³ key original thÃ¬ dÃ¹ng count hiá»‡n táº¡i
                this._originalAutoSpinCount = this._autoSpinCount;
            }
            if (active !== null) {
                this._isAutoSpinActive = active === 'true';
            }
            if (mode !== null && Object.values(SpeedMode).includes(mode as SpeedMode)) {
                this._speedMode = mode as SpeedMode;
            }
            Log.d(`[AutoSpinManager] âœ… _load() done â€” autoSpinCount=${this._autoSpinCount}, isActive=${this._isAutoSpinActive}, speedMode=${this._speedMode}`);
        } catch (_) {}
    }
}
