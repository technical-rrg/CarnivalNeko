/**
 * AutoSpinManager - Quản lý Auto Spin count và Speed Mode.
 *
 * ── SINGLETON ──
 *   Không cần gắn vào Node. Khởi tạo qua AutoSpinManager.instance.
 *   Gọi AutoSpinManager.instance trong GameManager.onLoad() để khởi tạo sớm.
 *
 * ── AUTO SPIN FLOW ──
 *   User chọn count N → đóng AutoSettingPopup → spin thủ công lần đầu.
 *   Sau mỗi Normal Spin kết thúc (NORMAL_SPIN_DONE):
 *     count > 0 → decrement → delay nhỏ → emit SPIN_REQUEST.
 *     count = 0 → dừng.
 *   Free Spin KHÔNG ảnh hưởng count (chỉ Normal Spin mới decrement).
 *
 * ── SPEED MODE ──
 *   Normal: tốc độ mặc định.
 *   Quick: 2× nhanh hơn.
 *   Turbo: gần như dừng ngay khi có kết quả từ server.
 *
 * ── PERSIST ──
 *   Lưu vào localStorage: count còn lại + speed mode, key theo SLOT_ID + memberId
 *   để không leak Auto Spin giữa các game (cùng origin / cùng player).
 *   Tải lại khi khởi động → tiếp tục auto spin nếu còn count (cùng game).
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
    /** Flag để chỉ trigger auto spin resume 1 lần duy nhất sau khi game khởi tạo */
    private _gameInitDone: boolean = false;
    /**
     * Set = true bởi _onEnterSuccess() → báo cho _onGameReady() biết cần check resume.
     * Tách khỏi _gameInitDone để tránh race condition trong two-scene flow:
     *   loading scene GAME_READY set _gameInitDone=true trước khi game scene ENTER_SUCCESS.
     */
    private _pendingResumeAfterLoad: boolean = false;
    /** Member ID từ lần load trước — dùng để detect khi player thay đổi (undefined = chưa init) */
    private _lastMemberId: number | null | undefined = undefined;

    private constructor() {
        console.log('[AutoSpinManager] 🔧 constructor() — singleton created');
        Log.d('[AutoSpinManager] 🔧 constructor() — bắt đầu khởi tạo');
        // KHÔNG gọi _load() ở đây — session/memberIdx chưa có tại thời điểm constructor.
        // _load() sẽ được gọi lần đầu trong _onSpinButtonState khi session đã sẵn sàng.
        this._bindEvents();
    }

    static get instance(): AutoSpinManager {
        if (!AutoSpinManager._instance) {
            AutoSpinManager._instance = new AutoSpinManager();
        }
        return AutoSpinManager._instance;
    }

    /**
     * Lấy member ID từ GameData để tạo unique keys cho mỗi player.
     * Trả về null nếu chưa login hoặc memberIdx <= 0 (mock mode).
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
     * Tạo unique storage key theo game + player.
     * Format: {baseKey}_{slotId}_{memberId}  (hoặc {baseKey}_{slotId} nếu chưa login).
     */
    private _getStorageKey(baseKey: string): string {
        const slotId = ServerConfig.SLOT_ID;
        const memberId = this._getMemberId();
        const key = memberId !== null ? `${baseKey}_${slotId}_${memberId}` : `${baseKey}_${slotId}`;
        Log.d(`[AutoSpinManager] _getStorageKey("${baseKey}") → ${key}`);
        return key;
    }

    /**
     * Kiểm tra xem player có thay đổi không (e.g. login khác account).
     * Gọi từ _save() mỗi lần lưu để detect switch account và reset state.
     */
    private _onPlayerChanged(): void {
        const currentMemberId = this._getMemberId();

        // Nếu memberIdx thay đổi từ một giá trị hợp lệ sang giá trị khác → đang switch account
        if (this._lastMemberId !== null &&
            this._lastMemberId !== undefined &&
            currentMemberId !== null &&
            this._lastMemberId !== currentMemberId) {
            Log.d(`[AutoSpinManager] 🔄 Player thay đổi từ ${this._lastMemberId} → ${currentMemberId} — reset Auto Spin state`);
            this._autoSpinCount = 0;
            this._isAutoSpinActive = false;
            this._speedMode = SpeedMode.NORMAL;
            this._isPaused = false;
            this._gameInitDone = false;
            EventBus.instance.emit(GameEvents.AUTO_SPIN_CHANGED, 0);
        }

        if (currentMemberId !== null) this._lastMemberId = currentMemberId;
    }

    // ─── GETTERS ───

    get autoSpinCount(): number { return this._autoSpinCount; }
    get originalAutoSpinCount(): number { return this._originalAutoSpinCount; }
    get isAutoSpinActive(): boolean { return this._isAutoSpinActive; }
    get speedMode(): SpeedMode { return this._speedMode; }
    get isFreeSpinMode(): boolean { return this._isFreeSpinMode; }
    get isPaused(): boolean { return this._isPaused; }

    /**
     * Trả về multiplier để điều chỉnh thời gian animation theo speed mode.
     * NORMAL: 1.0 (không thay đổi)
     * QUICK: 0.5 (2x nhanh hơn - tất cả thời gian giảm 50%)
     * TURBO: 0.33 (3x nhanh hơn - tất cả thời gian giảm 67%)
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

    // ─── SETTERS (gọi từ AutoSettingPopup) ───

    setAutoSpinCount(count: number): void {
        this._isPaused = false;
        const rounded = Math.max(0, Math.round(count));
        this._autoSpinCount = rounded;
        // Lưu giá trị gốc user đã chọn; reset khi count về 0
        this._originalAutoSpinCount = rounded > 0 ? rounded : 0;
        // KHÔNG set _isAutoSpinActive ở đây — chỉ lưu số đếm.
        // _isAutoSpinActive chỉ được bật khi resumeAutoSpin() (tức là nhấn Confirm).
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
     * Tạm dừng auto spin nhưng giữ nguyên count (cho popup hiển thị lại).
     * _isAutoSpinActive = false được save → reload game sẽ không tự resume.
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
        // Thông báo UI biết autoSpin vừa ACTIVE (setAutoSpinCount đã emit với _isAutoSpinActive=false)
        EventBus.instance.emit(GameEvents.AUTO_SPIN_CHANGED, this._autoSpinCount);
    }

    // ─── EVENTS ───

    private _bindEvents(): void {
        const bus = EventBus.instance;
        console.log('[AutoSpinManager] 📡 _bindEvents() — registering events');
        Log.d('[AutoSpinManager] 📡 _bindEvents() — đăng ký ENTER_SUCCESS, GAME_READY, UI_SPIN_BUTTON_STATE, NORMAL_SPIN_DONE, FREE_SPIN_*');
        bus.on(GameEvents.ENTER_SUCCESS,        this._onEnterSuccess,     this);
        bus.on(GameEvents.FREE_SPIN_START,      this._onFreeSpinStart,    this);
        bus.on(GameEvents.FREE_SPIN_END,        this._onFreeSpinEnd,      this);
        bus.on(GameEvents.TOPUP_END,            this._onTopUpEnd,         this);
        bus.on(GameEvents.NORMAL_SPIN_DONE,     this._onNormalSpinDone,   this);
        bus.on(GameEvents.GAME_READY,           this._onGameReady,        this);
        bus.on(GameEvents.UI_SPIN_BUTTON_STATE, this._onSpinButtonState,  this);
    }

    /**
     * ENTER_SUCCESS — session/memberIdx đã sẵn sàng → load state từ localStorage ngay.
     * Payload có thể chứa memberIdx trực tiếp nhưng ta dùng GameData để nhất quán.
     */
    private _onEnterSuccess(): void {
        const mid = this._getMemberId();
        console.log(`[AutoSpinManager] 🔑 ENTER_SUCCESS fired — memberId=${mid ?? 'null (chưa login / mock mode)'}`);
        Log.d(`[AutoSpinManager] 🔑 _onEnterSuccess — memberId=${mid ?? 'null'} → load from localStorage`);
        this._load();
        // Đánh dấu cần check resume ở GAME_READY tiếp theo.
        // KHÔNG reset _gameInitDone vì loading scene GAME_READY đã chạy rồi.
        // _pendingResumeAfterLoad chỉ được set SAU _load() nên GAME_READY loading scene KHÔNG ảnh hưởng.
        this._pendingResumeAfterLoad = true;
        console.log(`[AutoSpinManager] 🔑 _onEnterSuccess → _pendingResumeAfterLoad=true, chờ GAME_READY của game scene`);

        // ── FALLBACK: nếu GAME_READY không fire (hoặc đã fire trước ENTER_SUCCESS)
        // → tự resume sau 3 giây nếu isActive=true và chưa có gì trigger spin
        setTimeout(() => {
            if (this._pendingResumeAfterLoad) {
                console.log(`[AutoSpinManager] ⏰ FALLBACK: GAME_READY chưa fire sau 3s — tự kiểm tra resume (isActive=${this._isAutoSpinActive}, count=${this._autoSpinCount})`);
                this._pendingResumeAfterLoad = false;
                if (this._isAutoSpinActive && this._autoSpinCount > 0 && !this._isFreeSpinMode) {
                    console.log(`[AutoSpinManager] ▶️ FALLBACK → emit SPIN_REQUEST (count=${this._autoSpinCount})`);
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
        // Tiếp tục normal spin nếu đang active và còn count
        if (this._isAutoSpinActive && this._autoSpinCount > 0) {
            setTimeout(() => {
                this._emitSpinRequestIfAllowed();
            }, this.getNextSpinDelayMs());
        }
    }

    private _onTopUpEnd(): void {
        // Tiếp tục normal spin nếu đang active và còn count
        if (this._isAutoSpinActive && this._autoSpinCount > 0) {
            setTimeout(() => {
                this._emitSpinRequestIfAllowed();
            }, this.getNextSpinDelayMs());
        }
    }

    private _onGameReady(): void {
        console.log(`[AutoSpinManager] 🎟️ GAME_READY fired — count=${this._autoSpinCount}, isActive=${this._isAutoSpinActive}, pendingResume=${this._pendingResumeAfterLoad}, gameInitDone=${this._gameInitDone}, isFreeSpinMode=${this._isFreeSpinMode}`);
        Log.d(`[AutoSpinManager] 🎟️ _onGameReady — autoSpinCount=${this._autoSpinCount}, isAutoSpinActive=${this._isAutoSpinActive}, pendingResume=${this._pendingResumeAfterLoad}, gameInitDone=${this._gameInitDone}`);

        // KHÔNG set _gameInitDone ở đây — để _onSpinButtonState có thể xử lý tiếp nếu cần.
        // Chỉ resume nếu ENTER_SUCCESS đã fire trước GAME_READY này (_pendingResumeAfterLoad=true).
        if (!this._pendingResumeAfterLoad) {
            console.log(`[AutoSpinManager] ⚠️ GAME_READY: pendingResume=false → loading scene GAME_READY, bỏ qua`);
            return;
        }
        this._pendingResumeAfterLoad = false;
        this._gameInitDone = true;

        if (this._isAutoSpinActive && this._autoSpinCount > 0 && !this._isFreeSpinMode) {
            const delayMs = this.getNextSpinDelayMs();
            console.log(`[AutoSpinManager] ▶️ GAME_READY → sẽ emit SPIN_REQUEST sau ${delayMs}ms (count=${this._autoSpinCount})`);
            Log.d(`[AutoSpinManager] ▶️ _onGameReady → Resume auto spin — count=${this._autoSpinCount}, emit SPIN_REQUEST sau ${delayMs}ms`);
            setTimeout(() => {
                console.log(`[AutoSpinManager] 🟢 emit SPIN_REQUEST (auto spin resume from GAME_READY)`);
                Log.d(`[AutoSpinManager] 🟢 emit SPIN_REQUEST (auto spin resume from GAME_READY)`);
                this._emitSpinRequestIfAllowed();
            }, delayMs);
        } else {
            console.log(`[AutoSpinManager] ⏹️ GAME_READY: không resume — isActive=${this._isAutoSpinActive}, count=${this._autoSpinCount}, isFreeSpinMode=${this._isFreeSpinMode}`);
        }
    }

    /**
     * UI_SPIN_BUTTON_STATE(true) — signal chắc chắn nhất "game sẵn sàng spin".
     * Dùng làm fallback resume nếu GAME_READY không có _pendingResumeAfterLoad
     * (xảy ra khi GAME_READY game scene fire trước ENTER_SUCCESS re-emit).
     */
    private _onSpinButtonState(enabled: boolean): void {
        if (!enabled) return;
        console.log(`[AutoSpinManager] 🔘 UI_SPIN_BUTTON_STATE(true) — pendingResume=${this._pendingResumeAfterLoad}, gameInitDone=${this._gameInitDone}, isActive=${this._isAutoSpinActive}, count=${this._autoSpinCount}`);

        // Fallback: ENTER_SUCCESS đã set pendingResume=true nhưng GAME_READY đã bỏ qua
        // → dùng UI_SPIN_BUTTON_STATE lần đầu để trigger resume
        if (this._pendingResumeAfterLoad && !this._gameInitDone) {
            this._pendingResumeAfterLoad = false;
            this._gameInitDone = true;
            console.log(`[AutoSpinManager] ▶️ UI_SPIN_BUTTON_STATE fallback resume — isActive=${this._isAutoSpinActive}, count=${this._autoSpinCount}`);
            if (this._isAutoSpinActive && this._autoSpinCount > 0 && !this._isFreeSpinMode) {
                setTimeout(() => {
                    console.log(`[AutoSpinManager] 🟢 emit SPIN_REQUEST (fallback from UI_SPIN_BUTTON_STATE)`);
                    this._emitSpinRequestIfAllowed();
                }, this.getNextSpinDelayMs());
            }
            return;
        }

        if (this._gameInitDone) return;
        this._gameInitDone = true;
        Log.d(`[AutoSpinManager] 🔘 _onSpinButtonState(true) lần đầu — gameInitDone=true set`);
    }

    private _onNormalSpinDone(): void {
        // Log.e(`[SPIN-HANG][AUTO] NORMAL_SPIN_DONE received | freeSpinMode=${this._isFreeSpinMode} active=${this._isAutoSpinActive} count=${this._autoSpinCount} paused=${this._isPaused} speed=${this._speedMode}`);
        // Chỉ trigger khi đang active và đang Normal spin
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

    /** Không /Spin khi server/client còn trong Pick Game (CurrentStage=PICK). */
    private _emitSpinRequestIfAllowed(): void {
        if (this._isPickGameBlockingSpin()) {
            Log.w('[AutoSpinManager] skip SPIN_REQUEST — Pick Game in progress');
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

    // ─── PERSIST ───

    private _save(): void {
        try {
            // Kiểm tra switch account trước khi lưu
            this._onPlayerChanged();

            // Cập nhật _lastMemberId để _getStorageKey() dùng đúng key
            const memberId = this._getMemberId();
            if (memberId !== null) this._lastMemberId = memberId;

            // Tạo storage keys (có memberIdx hoặc legacy nếu chưa login)
            const keyCount    = this._getStorageKey(LS_AUTO_COUNT_LEGACY);
            const keyActive   = this._getStorageKey(LS_AUTO_ACTIVE_LEGACY);
            const keyMode     = this._getStorageKey(LS_SPEED_MODE_LEGACY);
            const keyOriginal = this._getStorageKey(LS_AUTO_ORIGINAL_COUNT_LEGACY);

            console.log(`[AutoSpinManager] 💾 _save() — key=${keyCount}, active=${this._isAutoSpinActive}, count=${this._autoSpinCount}, original=${this._originalAutoSpinCount}, mode=${this._speedMode}`);
            Log.d(`[AutoSpinManager] 💾 _save() — memberId=${this._lastMemberId ?? 'null'}, keys: ${keyCount}, active=${this._isAutoSpinActive}, count=${this._autoSpinCount}`);
            localStorage.setItem(keyCount,    String(this._autoSpinCount));
            localStorage.setItem(keyActive,   String(this._isAutoSpinActive));
            localStorage.setItem(keyMode,     this._speedMode);
            localStorage.setItem(keyOriginal, String(this._originalAutoSpinCount));
            // Verify
            console.log(`[AutoSpinManager] ✅ _save() verify — read back: count=${localStorage.getItem(keyCount)}, active=${localStorage.getItem(keyActive)}, mode=${localStorage.getItem(keyMode)}`);
        } catch (err) {
            console.error(`[AutoSpinManager] ❌ _save() FAILED — localStorage error:`, err);
        }
    }

    private _load(): void {
        try {
            // Lấy memberIdx tại thời điểm load (session đã sẵn sàng khi gọi từ _onEnterSuccess)
            const memberId = this._getMemberId();
            if (memberId !== null) this._lastMemberId = memberId;

            // Tạo storage keys (có memberIdx hoặc legacy nếu chưa login)
            const keyCount    = this._getStorageKey(LS_AUTO_COUNT_LEGACY);
            const keyActive   = this._getStorageKey(LS_AUTO_ACTIVE_LEGACY);
            const keyMode     = this._getStorageKey(LS_SPEED_MODE_LEGACY);
            const keyOriginal = this._getStorageKey(LS_AUTO_ORIGINAL_COUNT_LEGACY);

            const count    = localStorage.getItem(keyCount);
            const active   = localStorage.getItem(keyActive);
            const mode     = localStorage.getItem(keyMode);
            const original = localStorage.getItem(keyOriginal);
            console.log(`[AutoSpinManager] 💾 _load() — key=${keyCount}, raw values: count=${count ?? 'null'}, active=${active ?? 'null'}, mode=${mode ?? 'null'}`);
            Log.d(`[AutoSpinManager] 💾 _load() — memberId=${this._lastMemberId ?? 'null'}, keys: ${keyCount}, count=${count ?? 'null'}, active=${active ?? 'null'}, mode=${mode ?? 'null'}`);

            if (count !== null) {
                this._autoSpinCount = Math.max(0, Math.min(1000, parseInt(count, 10) || 0));
            }
            if (original !== null) {
                this._originalAutoSpinCount = Math.max(0, parseInt(original, 10) || 0);
            } else if (this._autoSpinCount > 0) {
                // Fallback: nếu chưa có key original thì dùng count hiện tại
                this._originalAutoSpinCount = this._autoSpinCount;
            }
            if (active !== null) {
                this._isAutoSpinActive = active === 'true';
            }
            if (mode !== null && Object.values(SpeedMode).includes(mode as SpeedMode)) {
                this._speedMode = mode as SpeedMode;
            }
            console.log(`[AutoSpinManager] ✅ _load() done — autoSpinCount=${this._autoSpinCount}, original=${this._originalAutoSpinCount}, isActive=${this._isAutoSpinActive}, speedMode=${this._speedMode}`);
            Log.d(`[AutoSpinManager] ✅ _load() done — autoSpinCount=${this._autoSpinCount}, isActive=${this._isAutoSpinActive}, speedMode=${this._speedMode}`);
        } catch (_) {}
    }
}
