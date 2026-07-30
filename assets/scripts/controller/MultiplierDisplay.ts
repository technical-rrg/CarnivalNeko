/**
 * MultiplierDisplay - Hiển thị hệ số nhân thưởng trong Free Spin.
 *
 * ─── FLOW ───
 * 1. FREE_SPIN_MULTIPLIER_SPIN  : Hủy clone cũ, bắt đầu cycle focus ngẫu nhiên.
 *    Cả 3 mode đều schedule timer tính CHÍNH XÁC từ lúc nhấn Spin:
 *    ├─ NORMAL : delay = cloneDelayNormal  (mặc định 1.5s)
 *    ├─ QUICK  : delay = cloneDelayQuick   (mặc định 0.2s)
 *    └─ TURBO  : delay = cloneDelayTurbo   (mặc định 0.1s)
 * 2. FREE_SPIN_MULTIPLIER_LOCK  : Nhận hệ số từ server.
 *    └─ Nếu timer đã fire → snap+clone ngay; chưa → chờ timer.
 * 3. Clone giữ nguyên cho đến FREE_SPIN_MULTIPLIER_SPIN tiếp theo (bị hủy lúc đó).
 * 4. FLY_DONE emit sau scale-in → GameManager tiếp tục auto-spin.
 * 5. REELS_STOPPED              : Fallback nếu không có LOCK → emit FLY_DONE.
 * 6. FREE_SPIN_END              : Hủy clone, ẩn display.
 */

import { _decorator, Component, Node, tween, Tween, Vec3, Mat4, instantiate, UIOpacity } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { AutoSpinManager, SpeedMode } from '../manager/AutoSpinManager';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

@ccclass('MultiplierDisplay')
export class MultiplierDisplay extends Component {

    @property({
        type: [Node],
        tooltip: '[0]=2x  [1]=3x  [2]=5x  [3]=7x  [4]=10x  [5]=20x\nMỗi node phải có 2 node con: "Base" và "Focus".',
    })
    multiplierNodes: Node[] = [];

    @property({
        type: Node,
        tooltip: 'Node giữa màn hình — clone xuất hiện ở đây',
    })
    winLabelTarget: Node | null = null;

    @property({ tooltip: 'Thời gian giữa 2 bước chuyển Focus ngẫu nhiên (giây)' })
    rollInterval: number = 0.25;

    // ─── CLONE TIMING (tính từ lúc nhấn Spin) ───
    @property({ tooltip: 'Delay (giây) từ SPIN START → show clone: chế độ NORMAL' })
    cloneDelayNormal: number = 1.5;

    @property({ tooltip: 'Delay (giây) từ SPIN START → show clone: chế độ QUICK' })
    cloneDelayQuick: number = 0.2;

    @property({ tooltip: 'Delay (giây) từ SPIN START → show clone: chế độ TURBO' })
    cloneDelayTurbo: number = 0.1;

    // ─── CLONE ANIMATION ZOOM EFFECT ───
    @property({ tooltip: 'Scale tối đa khi zoom ra (ban đầu)' })
    zoomMaxScale: number = 3.5;

    @property({ tooltip: 'Khoảng cách nhảy lên theo Y axis (pixel)' })
    jumpHeight: number = 100;

    @property({ tooltip: 'Thời gian zoom ra + nhảy lên (giây)' })
    zoomOutDuration: number = 0.15;

    @property({ tooltip: 'Thời gian scale xuống về bình thường (giây)' })
    scaleDownDuration: number = 0.15;

    // ─── CONSTANTS ───
    private readonly MULT_VALUES = [2, 3, 5, 7, 10, 20];

    // ─── STATE ───
    private _rolling = false;
    private _currentIdx = 0;
    private _pendingLockValue = -1;
    private _winnerIdx = -1;
    private _flyCloneNode: Node | null = null;
    private _cloneScheduled = false;
    private _spinTimerFired = false;

    // ─── LIFECYCLE ───

    onLoad(): void {
        const bus = EventBus.instance;
        bus.on(GameEvents.FREE_SPIN_MULTIPLIER_SPIN, this._onStartRolling, this);
        bus.on(GameEvents.FREE_SPIN_MULTIPLIER_LOCK, this._onReceiveLock,  this);
        bus.on(GameEvents.REELS_STOPPED,             this._onReelsStopped, this);
        bus.on(GameEvents.FREE_SPIN_END,             this._onFreeSpinEnd,  this);
        this.node.active = false;
    }

    onDestroy(): void {
        this.unscheduleAllCallbacks();
        EventBus.instance.offTarget(this);
    }

    // ─── PHASE 1: ROLLING ───

    private _onStartRolling(): void {
        this._destroyFlyClone();
        this.unscheduleAllCallbacks();

        this._rolling = true;
        this._pendingLockValue = -1;
        this._currentIdx = 0;
        this._winnerIdx = -1;
        this._cloneScheduled = false;
        this._spinTimerFired = false;
        this.node.active = true;

        // Reset tất cả về Base, node 0 = Focus
        for (const n of this.multiplierNodes) {
            if (n) { n.active = true; this._showBase(n); }
        }
        this._showFocus(this.multiplierNodes[0]);

        // Bắt đầu cycle Focus ngẫu nhiên mỗi rollInterval giây
        this.schedule(() => {
            if (!this._rolling) return;
            this._showBase(this.multiplierNodes[this._currentIdx]);
            let next: number;
            do { next = Math.floor(Math.random() * this.multiplierNodes.length); }
            while (next === this._currentIdx && this.multiplierNodes.length > 1);
            this._currentIdx = next;
            this._showFocus(this.multiplierNodes[this._currentIdx]);
        }, this.rollInterval);

        // Tất cả 3 mode đều dùng timer tính chính xác từ lúc nhấn Spin
        const mode = AutoSpinManager.instance.speedMode;
        const delay = mode === SpeedMode.TURBO ? this.cloneDelayTurbo
                    : mode === SpeedMode.QUICK  ? this.cloneDelayQuick
                    :                             this.cloneDelayNormal;
        const modeName = mode === SpeedMode.TURBO ? 'TURBO' : mode === SpeedMode.QUICK ? 'QUICK' : 'NORMAL';
        // Log.d(`%c[MultiplierDisplay] SPIN START — mode=${modeName}, delay=${delay}s`, 'color:#0af;font-weight:bold');
        this.scheduleOnce(() => {
            this._spinTimerFired = true;
            // Log.d(`%c[MultiplierDisplay] TIMER FIRED (${delay}s) — pendingLockValue=${this._pendingLockValue}, cloneScheduled=${this._cloneScheduled}`, 'color:#0af');
            if (this._pendingLockValue > 1) {
                // LOCK đã đến trước timer → snap ngay với giá trị đúng từ server
                this._cloneScheduled = true;
                // Log.d(`%c[MultiplierDisplay] LOCK đã có sẵn (${this._pendingLockValue}x) → snap ngay`, 'color:#0f0;font-weight:bold');
                this._snapAndClone();
            } else {
                // Log.d(`%c[MultiplierDisplay] LOCK chưa về → chờ LOCK emit`, 'color:#fa0');
            }
        }, delay);
    }

    // ─── LOCK → SCHEDULE SNAP + CLONE ───

    private _onReceiveLock(value: number): void {
        // Log.d(`%c[MultiplierDisplay] LOCK RECEIVED — featureMultiple=${value}x, spinTimerFired=${this._spinTimerFired}`, 'color:#0f0;font-weight:bold');
        this._pendingLockValue = value;
        this._cloneScheduled = true;

        if (this._spinTimerFired) {
            // Log.d(`%c[MultiplierDisplay] Timer đã fire → snap ngay với ${value}x`, 'color:#0f0;font-weight:bold');
            this._snapAndClone();
        } else {
            // Log.d(`%c[MultiplierDisplay] Timer chưa fire → chờ timer`, 'color:#fa0');
        }
    }

    /** Dừng rolling, snap winner, tạo clone. */
    private _snapAndClone(): void {
        this._rolling = false;

        let winnerIdx = this._currentIdx;
        const fm = this._pendingLockValue;
        this._pendingLockValue = -1;
        // Log.d(`%c[MultiplierDisplay] _snapAndClone — fm=${fm}, currentIdx=${winnerIdx}`, 'color:#0af;font-weight:bold');

        if (fm > 1) {
            // Hệ số nhân thực sự → highlight winner
            const t = this.MULT_VALUES.indexOf(fm);
            winnerIdx = t >= 0 ? t : 0;
            for (let i = 0; i < this.multiplierNodes.length; i++) {
                const n = this.multiplierNodes[i];
                if (!n) continue;
                n.active = true;
                if (i === winnerIdx) this._showFocus(n);
                else                 this._showBase(n);
            }
        } else {
            // fm <= 1: không có hệ số nhân → tất cả Base, clone node hiện tại
            for (const n of this.multiplierNodes) {
                if (n) { n.active = true; this._showBase(n); }
            }
        }
        this._winnerIdx = winnerIdx;

        this._flyClone(winnerIdx);
    }

    // ─── PHASE 2: SNAP + CLONE ───

    private _onReelsStopped(): void {
        if (!this.node.active) return;

        this._rolling = false;
        // Log.d(`[MultiplierDisplay] REELS_STOPPED — flyClone=${!!this._flyCloneNode}, cloneScheduled=${this._cloneScheduled}, spinTimerFired=${this._spinTimerFired}, pendingLock=${this._pendingLockValue}`);

        // Clone đã tạo hoặc đã schedule (từ LOCK) → không can thiệp
        if (this._flyCloneNode !== null || this._cloneScheduled) {
            return;
        }

        // Không có LOCK: dừng rolling UI.
        // KHÔNG unschedule timer ở đây — spin timer vẫn cần chạy để _spinTimerFired = true,
        // đảm bảo khi LOCK đến muộn (server chậm, Turbo mode) vẫn snap được đúng số.
        // GameManager có fallback 2.5s nếu FLY_DONE không đến.
        this._winnerIdx = this._currentIdx;
        for (const n of this.multiplierNodes) {
            if (n) { n.active = true; this._showBase(n); }
        }
    }

    // ─── PHASE 3: CLONE ───

    private _flyClone(idx: number): void {
        this._destroyFlyClone();

        // Dừng rolling effect và reset tất cả node về Base
        this._rolling = false;
        this.unscheduleAllCallbacks();
        
        // Reset state và stop tất cả tweens trên nodes
        this._currentIdx = 0;
        this._winnerIdx = -1;
        for (const n of this.multiplierNodes) {
            if (n) {
                Tween.stopAllByTarget(n);
                this._showBase(n);
            }
        }

        const original = this.multiplierNodes[idx];
        if (!original || !this.winLabelTarget) {
            // Log.e(`[MultiplierDisplay] _flyClone ABORT — original=${!!original}, winLabelTarget=${!!this.winLabelTarget} → emit FLY_DONE không có animation!`);
            EventBus.instance.emit(GameEvents.FREE_SPIN_MULTIPLIER_FLY_DONE);
            return;
        }
        // Log.d(`%c[MultiplierDisplay] _flyClone idx=${idx} (${this.MULT_VALUES[idx]}x) — tạo clone tại winLabelTarget`, 'color:#f0f;font-weight:bold');

        const clone = instantiate(original);
        clone.active = true;
        this._showFocus(clone);

        this.node.addChild(clone);

        const wPos = new Vec3();
        this.winLabelTarget.getWorldPosition(wPos);
        const inv = new Mat4();
        Mat4.invert(inv, this.node.worldMatrix);
        const local = new Vec3();
        Vec3.transformMat4(local, wPos, inv);
        clone.setPosition(local);
        clone.setScale(0, 0, 1);

        const uiOp = clone.getComponent(UIOpacity) ?? clone.addComponent(UIOpacity);
        uiOp.opacity = 255;

        this._flyCloneNode = clone;

        // Thông báo clone vừa xuất hiện (dùng để phát SFX sx_bonus_start)
        EventBus.instance.emit(GameEvents.FREE_SPIN_MULTIPLIER_CLONE_SHOW);

        // ─── ZOOM + JUMP + SCALE DOWN EFFECT ───
        // Phase 1: Zoom ra to + nhảy lên (backOut easing)
        // Phase 2: Scale xuống nhanh mạnh về size bình thường (backIn easing)
        tween(clone)
            .to(this.zoomOutDuration, {
                scale: new Vec3(this.zoomMaxScale, this.zoomMaxScale, 1),
                position: new Vec3(local.x, local.y + this.jumpHeight, local.z)
            }, { easing: 'backOut' })
            .to(this.scaleDownDuration, {
                scale: new Vec3(2, 2, 1),
                position: local
            }, { easing: 'backIn' })
            .call(() => {
                EventBus.instance.emit(GameEvents.FREE_SPIN_MULTIPLIER_FLY_DONE);
            })
            .start();
    }

    // ─── PHASE 4: FREE SPIN KẾT THÚC ───

    private _onFreeSpinEnd(): void {
        this._rolling = false;
        this.unscheduleAllCallbacks();
        Tween.stopAllByTarget(this.node);
        for (const n of this.multiplierNodes) {
            if (n) Tween.stopAllByTarget(n);
        }
        this._pendingLockValue = -1;
        this._currentIdx = 0;
        this._cloneScheduled = false;
        this._spinTimerFired = false;
        this._destroyFlyClone();
        this.node.active = false;
    }

    private _destroyFlyClone(): void {
        if (this._flyCloneNode) {
            Tween.stopAllByTarget(this._flyCloneNode);
            const uiOp = this._flyCloneNode.getComponent(UIOpacity);
            if (uiOp) Tween.stopAllByTarget(uiOp);
            if (this._flyCloneNode.isValid) this._flyCloneNode.destroy();
            this._flyCloneNode = null;
        }
    }

    // ─── SPRITE HELPERS ───

    private _showBase(n: Node | undefined): void {
        if (!n) return;
        const base  = n.getChildByName('Base');
        const focus = n.getChildByName('Focus');
        if (base)  base.active  = true;
        if (focus) focus.active = false;
    }

    private _showFocus(n: Node | undefined): void {
        if (!n) return;
        const base  = n.getChildByName('Base');
        const focus = n.getChildByName('Focus');
        if (base)  base.active  = false;
        if (focus) focus.active = true;
    }
}
