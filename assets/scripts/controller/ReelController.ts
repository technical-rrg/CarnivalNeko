/**
 * ReelController - Điều khiển 1 reel (1 cột slot machine).
 *
 * ── THIẾT KẾ: PER-NODE SCROLL ──
 *
 *   Mỗi node có Y riêng, được track trong _nodeY[].
 *   Mỗi frame (SPINNING): tất cả di chuyển xuống cùng tốc độ (spinSpeed * dt).
 *   Khi 1 node đi quá đáy (bottomEdge) → wrap riêng node đó lên đỉnh + đổi symbol.
 *   → Cuộn xuống mượt, không jitter, không jump toàn bộ.
 *
 *   Khi dừng (DECELERATING): gán đúng 5 symbol kết quả, đặt trên viewport,
 *   cubicOut scroll xuống về đúng rest positions.
 *
 * ── NODE LAYOUT ──
 *   [0] ExtraTop1  (buffer)  Y cao nhất
 *   [1] Top        (visible — display row 0)
 *   [2] Mid        (visible — payline center)
 *   [3] Bot        (visible — display row 2)
 *   [4] ExtraBot1  (buffer)  Y thấp nhất
 *
 *   Nodes 0,4 nằm ngoài Mask → invisible, dùng làm buffer khi wrap.
 *
 * ── SPIN FLOW ──
 *   startSpin()    → LAUNCHING: bounce up → SPINNING
 *   SPINNING       → update() cuộn tất cả nodes xuống, wrap từng node riêng
 *   stopAt(idx)    → delay → DECELERATING: gán symbols, cubicOut về rest
 *   _finishDecel() → SETTLING (stop bounce) → IDLE → onStopComplete()
 */

import { _decorator, Component, Node, tween, Vec3, Tween } from 'cc';
import { GameData } from '../data/GameData';
import { SymbolId } from '../data/SlotTypes';
import { Log } from '../core/Logger';
import { SymbolView } from './SymbolView';

const { ccclass, property } = _decorator;

enum ReelState { IDLE, LAUNCHING, SPINNING, DECELERATING, SETTLING }

@ccclass('ReelController')
export class ReelController extends Component {

    @property({
        type: [Node],
        tooltip: '5 Node symbol TOP→BOT:\n[0]=ExtraTop1 [1]=Top [2]=Mid [3]=Bot [4]=ExtraBot1',
    })
    symbolNodes: Node[] = [];

    @property({ tooltip: 'Index của reel (0, 1, 2)' })
    reelIndex: number = 0;

    @property({ tooltip: 'Khoảng cách Y giữa tâm các symbol (pixels)' })
    symbolHeight: number = 150;

    @property({ tooltip: 'Tốc độ cuộn xuống khi spin (pixels/sec)' })
    spinSpeed: number = 1500;

    @property({ tooltip: 'Delay trước khi giảm tốc (giây). Set bởi SlotMachineController.' })
    stopDelay: number = 0;

    @property({ tooltip: 'Thời gian quay tối thiểu (giây)' })
    minSpinDuration: number = 0.8;

    @property({ tooltip: 'Thời gian giảm tốc khi dừng (giây). Set bởi SlotMachineController theo SpeedMode.' })
    decelDuration: number = 0.45;

    @property({ tooltip: 'Khoảng cách từ đích (pixels) để bắt đầu spine effect sớm — 0 = chờ snap hẳn' })
    spineTriggerDistance: number = 120;

    @property({ tooltip: 'Delay thêm cho Long Spin (giây)' })
    longSpinDelay: number = 0;

    @property({ tooltip: 'Tốc độ cuộn khi Long Spin (pixels/sec). 0 = dùng spinSpeed mặc định' })
    longSpinSpeed: number = 0;

    @property({ tooltip: 'Auto-layout 5 nodes từ Mid (node[2]) — ExtraTop1/Top/Mid/Bot/ExtraBot1' })
    autoLayoutSymbols: boolean = false;

    /** Bỏ qua bounce lên khi bắt đầu spin (dùng cho Turbo). Set bởi SlotMachineController. */
    skipLaunchBounce: boolean = false;

    @property({ tooltip: 'Chiều cao nhảy lên khi bắt đầu spin (nhân với symbolHeight). Set bởi SlotMachineController.' })
    launchBounceHeightRatio: number = 0.5;

    @property({ tooltip: 'Thời gian nhảy lên trong launch bounce (giây). Set bởi SlotMachineController.' })
    launchBounceUpDuration: number = 0.12;

    @property({ tooltip: 'Thời gian rơi xuống trong launch bounce (giây). Set bởi SlotMachineController.' })
    launchBounceDownDuration: number = 0.25;

    @property({ tooltip: 'Chiều cao hạ thêm xuống khi reel dừng (nhân với symbolHeight). VD: 0.08 = hạ thêm 8% chiều cao symbol rồi snap về.' })
    stopBounceOvershootRatio: number = 0.08;

    @property({ tooltip: 'Thời gian snap lui về vị trí đích khi reel dừng (giây).' })
    stopBounceSettleDuration: number = 0.12;

    @property({ tooltip: 'Thời gian giảm tốc tối đa khi người chơi nhấn Stop lúc reel đang quay (giây).' })
    quickStopDecelDuration: number = 0.12;

    @property({ tooltip: 'Thời gian snap về đích khi người chơi nhấn Stop (giây).' })
    quickStopBounceSettleDuration: number = 0.08;

    // ─── CALLBACK ───
    onStopComplete: (() => void) | null = null;
    /** Gọi ngay khi snap về rest (trước bounce) — dùng để bật spine effect tức thì tại điểm dừng */
    onSnapComplete: (() => void) | null = null;
    /** Gọi SAU KHI _finishDecel đã gán đúng symbol cho TẤT CẢ nodes — đảm bảo symbolId chính xác trên mọi node */
    onSymbolsSettled: (() => void) | null = null;
    /** Gọi ngay khi bắt đầu tween bounce-down (khựng lại) — đây là thời điểm chính xác nhất để phát âm thanh */
    onBounceStart: (() => void) | null = null;
    /** Gọi ngay khi bắt đầu giai đoạn giảm tốc (decel), mang theo decelDuration để tính lead time */
    onDecelStart: ((decelDuration: number) => void) | null = null;

    // ─── INTERNAL ───
    private _state: ReelState = ReelState.IDLE;
    private _restPositions: Vec3[] = [];    // rest positions gốc (từ editor/auto-layout)
    private _nodeY: number[] = [];          // Y hiện tại của mỗi node (owned by scroll system)
    private _topEdge: number = 0;           // Y cao nhất node có thể (ExtraTop rest + 0.5h)
    private _bottomEdge: number = 0;        // Y thấp nhất (ExtraBot rest - 0.5h) → wrap trigger
    private _totalSpan: number = 0;         // 5 * symbolHeight — wrap distance
    private _logPrefix: string = '';
    private _spinStartTime: number = 0;
    private _pendingStop: { centerIndex: number; longSpin: boolean } | null = null;
    private _scheduledStop: { centerIndex: number; triggerTime: number } | null = null;
    private _quickStopRequested: boolean = false;
    /** Đánh dấu đã nhấn quick stop khi reel đang LAUNCHING — check khi bounce xong để decel ngay */
    private _quickStopPending: boolean = false;
    /** Giữ cấu hình dừng nhanh xuyên suốt từ lúc nhấn Stop đến khi bounce hoàn tất. */
    private _isQuickStopping: boolean = false;
    private _isLongSpin: boolean = false;
    private _currentCenterIndex: number = 0;
    /** Center index của lần quay normal cuối cùng — dùng để restore đúng symbols khi feature end */
    private _lastNormalCenterIndex: number = 0;

    @property({
        tooltip: [
            'Fraction of decel progress (0–1) at which blur is removed from symbols.',
            'cubicOut: at t=0.65 speed ≈ 37% of initial — visually slow enough to show base frames.',
            'Lower value = blur disappears earlier. Higher = blur stays longer.',
            'Recommended: 0.6 – 0.75',
        ].join('\n'),
    })
    blurOffProgress: number = 0.65;

    // Deceleration state (velocity-based)
    private _decelElapsed: number = 0;
    private _decelLastUpdateTime: number = 0;
    private _decelTotalDist: number = 0;    // quãng đường Mid cần scroll đến rest
    private _decelScrolled: number = 0;    // đã scroll bao nhiêu trong decel
    private _decelCenterIdx: number = 0;   // target center strip index
    private _decelAdaptedDuration: number = 0; // duration tính từ speed để smooth
    private _snapFired: boolean = false;
    private _blurOffFired: boolean = false; // đã emit spin-blur-off trong decel lần này chưa
    private _stopCompleteFired: boolean = false;
    private _resultStripIndex: number | undefined = undefined;

    // ─── LIFECYCLE ───

    /** Strip dùng cho cả scroll lẫn kết quả dừng (decel/snap).
     *  TopUp mode: dùng raw respinReelStrips để GameManager có thể patch coin
     *  vào đúng vị trí stop trước khi reel dừng. */
    private get _strip(): number[] {
        const data = GameData.instance;
        if (data.currentMode === 'respin') {
            const strips = data.config.respinReelStrips;
            return strips[this.reelIndex] ?? strips[0] ?? data.config.reelStrips[this.reelIndex] ?? [];
        }

        const isFreeSpin = data.freeSpinRemaining > 0;
        const strips = data.getReelStrips(isFreeSpin, this._resultStripIndex);
        return strips[this.reelIndex] ?? strips[0] ?? data.config.reelStrips[this.reelIndex] ?? [];
    }

    onLoad(): void {
        this._logPrefix = `[Reel ${this.reelIndex}]`;

        // Auto-layout: node[2] = Mid giữ Y, các node khác cách đều
        if (this.autoLayoutSymbols && this.symbolNodes.length === 5) {
            const midPos = this.symbolNodes[2].position;
            // Force Mid về y=0 để các reel có cùng baseline, không phụ thuộc vị trí lệch trong Editor
            const baseY = 0;
            const offsets = [2, 1, 0, -1, -2]; // ExtraTop1 cao nhất → ExtraBot1 thấp nhất
            for (let i = 0; i < 5; i++) {
                this.symbolNodes[i].setPosition(midPos.x, baseY + offsets[i] * this.symbolHeight, midPos.z);
            }
        }

        // Snapshot rest positions
        this._restPositions = this.symbolNodes.map(n => n.position.clone());
        this._nodeY = this._restPositions.map(p => p.y);

        // Auto-detect symbolHeight
        if (this._restPositions.length >= 3) {
            const gap1 = Math.abs(this._restPositions[1].y - this._restPositions[2].y);
            const gap2 = Math.abs(this._restPositions[2].y - this._restPositions[3].y);
            const avg  = (gap1 + gap2) / 2;
            if (avg > 1 && Math.abs(avg - this.symbolHeight) > 1) {
                Log.w(`${this._logPrefix} symbolHeight=${this.symbolHeight} → detected=${avg.toFixed(0)}, auto-correcting`);
                this.symbolHeight = avg;
            }
        }

        // Compute edges
        // ExtraTop = highest Y, ExtraBot = lowest Y
        const ys = this._restPositions.map(p => p.y);
        this._topEdge = Math.max(...ys) + this.symbolHeight * 0.5;
        this._bottomEdge = Math.min(...ys) - this.symbolHeight * 0.5;
        this._totalSpan = this.symbolNodes.length * this.symbolHeight; // 5h

        Log.d(`${this._logPrefix} h=${this.symbolHeight} restY=[${ys.map(y=>y.toFixed(0))}] top=${this._topEdge.toFixed(0)} bot=${this._bottomEdge.toFixed(0)}`);

    }

    // ─── UPDATE ───

    update(dt: number): void {
        this._processScheduledStop();

        if (this._state === ReelState.SPINNING) {
            const speed = (this._isLongSpin && this.longSpinSpeed > 0) ? this.longSpinSpeed : this.spinSpeed;
            this._scrollDown(speed * dt);
        } else if (this._state === ReelState.DECELERATING) {
            this._updateDecel(this._getDecelDelta(dt));
        }
    }

    // ─── PUBLIC API ───

    startSpin(): void {
        if (this._state !== ReelState.IDLE) return;
        this._state = ReelState.LAUNCHING;
        if (!this._pendingStop) {
            this._resultStripIndex = undefined;
        }

        // Kill tweens, snap to rest, ensure all nodes visible for next spin
        this._scheduledStop = null;
        this._quickStopPending = false;
        // Giữ _isQuickStopping/_quickStopRequested nếu đã nhấn Stop trước khi reel này start
        if (!this._quickStopRequested) {
            this._isQuickStopping = false;
        }
        for (let i = 0; i < this.symbolNodes.length; i++) {
            Tween.stopAllByTarget(this.symbolNodes[i]);
            this.symbolNodes[i].active = true;
            this.symbolNodes[i].setPosition(this._restPositions[i]);
            this._nodeY[i] = this._restPositions[i].y;
        }

        for (const n of this.symbolNodes) n.emit('spin-start');

        if (this.skipLaunchBounce) {
            this._state = ReelState.SPINNING;
            this._spinStartTime = Date.now();

            // Nếu đã nhận lệnh quick stop trước khi reel khởi động → decel ngay
            if (this._quickStopRequested) {
                this._quickStopRequested = false;
                for (const n of this.symbolNodes) n.emit('spin-fast');
                if (this._pendingStop) {
                    const ps = this._pendingStop;
                    this._pendingStop = null;
                    this._quickStopRequested = true;
                    this._scheduleStop(ps.centerIndex, ps.longSpin);
                } else {
                    this._quickStopRequested = true;
                }
                return;
            }

            for (const n of this.symbolNodes) n.emit('spin-fast');
            if (this._pendingStop) {
                // Kết quả đã có sẵn → dùng _scheduleStop để minSpinDuration được tôn trọng
                // (Turbo có minSpinDuration=0 nên vẫn decel ngay; QUICK sẽ chờ đủ thời gian)
                const ps = this._pendingStop;
                this._pendingStop = null;
                this._scheduleStop(ps.centerIndex, ps.longSpin);
            }
            // (nếu chưa có kết quả → cuộn, stopAt() sẽ gọi _scheduleStop khi đến)
            return;
        }

        // Nếu đã nhận lệnh quick stop trước khi reel khởi động → bounce xong decel ngay
        if (this._quickStopRequested) {
            this._quickStopRequested = false;
            this._quickStopPending = true;
        }

        // Bounce up then start spinning
        const bounceH = this.symbolHeight * this.launchBounceHeightRatio;
        const upDur   = this.launchBounceUpDuration;
        const downDur = this.launchBounceDownDuration;
        let done = 0;
        for (let i = 0; i < this.symbolNodes.length; i++) {
            const node = this.symbolNodes[i];
            const rest = this._restPositions[i];
            tween(node)
                .to(upDur,   { position: new Vec3(rest.x, rest.y + bounceH, rest.z) }, { easing: 'sineOut' })
                .to(downDur, { position: rest.clone() }, { easing: 'sineIn' })
                .call(() => {
                    if (++done >= this.symbolNodes.length) {
                        // Sync _nodeY sau bounce
                        for (let j = 0; j < this.symbolNodes.length; j++) {
                            this._nodeY[j] = this._restPositions[j].y;
                        }

                        // Nếu đã nhấn quick stop trong lúc bounce → decel ngay, không spin
                        if (this._quickStopPending) {
                            this._quickStopPending = false;
                            this._state = ReelState.SPINNING;
                            this._spinStartTime = Date.now();
                            for (const n of this.symbolNodes) n.emit('spin-fast');
                            if (this._pendingStop) {
                                const ps = this._pendingStop;
                                this._pendingStop = null;
                                this._quickStopRequested = true;
                                this._scheduleStop(ps.centerIndex, ps.longSpin);
                            } else {
                                this._quickStopRequested = true;
                            }
                            return;
                        }

                        this._state = ReelState.SPINNING;
                        this._spinStartTime = Date.now();
                        for (const n of this.symbolNodes) n.emit('spin-fast');
                        if (this._pendingStop) {
                            const ps = this._pendingStop;
                            this._pendingStop = null;
                            this._scheduleStop(ps.centerIndex, ps.longSpin);
                        }
                    }
                })
                .start();
        }
    }

    stopAt(centerIndex: number, longSpin: boolean = false): void {
        if (this._state === ReelState.IDLE || this._state === ReelState.LAUNCHING) {
            this._pendingStop = { centerIndex, longSpin };
            return;
        }
        if (this._state !== ReelState.SPINNING) return;
        this._scheduleStop(centerIndex, longSpin);
    }

    /**
     * Đóng băng reel đang quay — snap ngay về rest positions, chuyển về IDLE.
     * Dùng bởi SlotMachineController để giữ các reel sau longspin boundary đứng yên
     * trong khi reel longspin đang chạy. Sau khi freeze, gọi stopAt() để lưu kết quả
     * (pendingStop), rồi gọi startSpin() khi đến lượt reel này quay.
     */
    freezeSpin(): void {
        if (this._state !== ReelState.SPINNING && this._state !== ReelState.LAUNCHING) return;
        this._scheduledStop = null;
        this._quickStopRequested = false;
        this._isLongSpin = false;
        this._state = ReelState.IDLE;
        for (let i = 0; i < this.symbolNodes.length; i++) {
            Tween.stopAllByTarget(this.symbolNodes[i]);
            this.symbolNodes[i].active = true;
            this.symbolNodes[i].setPosition(this._restPositions[i]);
            this._nodeY[i] = this._restPositions[i].y;
            this.symbolNodes[i].emit('spin-stop');
        }
    }

    /**
     * Quick stop — hủy delay scheduled stop và bắt đầu decel ngay lập tức.
     * Dùng khi người chơi nhấn Spin lại trong khi reel đang quay.
     */
    forceQuickStop(): void {
        this._isQuickStopping = true;

        // Nếu reel đã bắt đầu giảm tốc trước lúc người chơi nhấn Stop,
        // rút ngắn ngay phần thời gian còn lại thay vì bỏ qua thao tác.
        if (this._state === ReelState.DECELERATING) {
            const quickRemaining = Math.max(0.02, this.quickStopDecelDuration);
            this._decelAdaptedDuration = Math.min(
                this._decelAdaptedDuration,
                this._decelElapsed + quickRemaining,
            );
            return;
        }

        // Nếu đang LAUNCHING, chờ bounce hoàn tất rồi decel nhanh.
        // Không hủy launch ngay để người chơi vẫn kịp nhìn thấy reel bắt đầu quay.
        if (this._state === ReelState.LAUNCHING) {
            this._quickStopPending = true;
            return;
        }

        // Nếu đã có lịch dừng → kéo triggerTime về hiện tại,
        // _processScheduledStop() sẽ gọi _beginDecel trong frame tiếp theo.
        if (this._scheduledStop) {
            this._scheduledStop.triggerTime = Date.now();
            return;
        }

        // Chưa có lịch dừng (reel đang SPINNING/IDLE mà kết quả chưa đến)
        // → đánh dấu để _scheduleStop bỏ qua delay khi kết quả đến.
        this._quickStopRequested = true;

        if (this._state === ReelState.SPINNING && this._pendingStop) {
            const ps = this._pendingStop;
            this._pendingStop = null;
            this._scheduleStop(ps.centerIndex, ps.longSpin);
        }
        // Nếu đang IDLE: flag sẽ được pick up khi reel bắt đầu quay và stopAt/_scheduleStop chạy
    }

    setSymbols(centerIndex: number): void {
        this._currentCenterIndex = centerIndex;
        const data = GameData.instance;
        if (data.freeSpinRemaining <= 0 && data.currentMode === 'normal') {
            this._lastNormalCenterIndex = centerIndex;
        }
        const syms = this._getSymbols5(centerIndex);
        for (let i = 0; i < this.symbolNodes.length && i < syms.length; i++) {
            this.symbolNodes[i].active = true;
            this.symbolNodes[i].setPosition(this._restPositions[i]);
            this._nodeY[i] = this._restPositions[i].y;
            this.symbolNodes[i].emit('spin-stop');
            this.symbolNodes[i].emit('symbol-changed', syms[i]);
        }
    }

    /**
     * Redraw symbols từ normal strip tại _lastNormalCenterIndex.
     * Dùng khi feature end để restore đúng symbols normal, không phụ thuộc _strip getter.
     */
    refreshSymbols(): void {
        if (this._state !== ReelState.IDLE) return;
        const strips = GameData.instance.config.reelStrips;
        const strip = strips[this.reelIndex] ?? strips[0] ?? [];
        const L = strip.length;
        if (L === 0) return;
        const centerIdx = this._lastNormalCenterIndex;
        const syms = this._getSymbols5FromStrip(strip, centerIdx);
        for (let i = 0; i < this.symbolNodes.length && i < syms.length; i++) {
            this.symbolNodes[i].emit('symbol-changed', syms[i]);
        }
    }

    get isIdle(): boolean { return this._state === ReelState.IDLE; }

    /** True khi stop-bounce xong (IDLE sau SETTLING). Dùng để gate trail / recover. */
    get isFullyStopped(): boolean { return this._state === ReelState.IDLE && this._stopCompleteFired; }

    /** onLoad đã snapshot đủ vị trí; setSymbols() từ đây mới an toàn và đồng bộ. */
    get isInitialized(): boolean {
        return this.symbolNodes.length > 0
            && this._restPositions.length === this.symbolNodes.length
            && this._nodeY.length === this.symbolNodes.length;
    }

    /** Xác nhận SymbolView đã nhận đúng symbol của center index hiện tại. */
    get areSymbolsAssigned(): boolean {
        if (!this.isInitialized) return false;
        const expected = this._getSymbols5(this._currentCenterIndex);
        return this.symbolNodes.every((node, index) => {
            const view = node.getComponent(SymbolView);
            return !!view && view.symbolId === expected[index];
        });
    }

    get debugState(): string {
        const state = ReelState[this._state] ?? String(this._state);
        const pending = this._pendingStop ? 'P' : '-';
        const scheduled = this._scheduledStop ? Math.max(0, this._scheduledStop.triggerTime - Date.now()) : 0;
        const quick = this._quickStopRequested || this._quickStopPending ? 'Q' : '-';
        const long = this._isLongSpin ? 'L' : '-';
        return `${state}{p=${pending},s=${scheduled},q=${quick},l=${long}}`;
    }

    /** Khóa bộ strip dùng để render kết quả dừng theo ReelIndex server trả về. */
    setResultStripIndex(stripIndex?: number): void {
        this._resultStripIndex = stripIndex;
    }

    /** Trả về rest position gốc của node theo index (dùng cho bounce hint). */
    getRestPosition(nodeIndex: number): Vec3 {
        return this._restPositions[nodeIndex]?.clone() ?? Vec3.ZERO.clone();
    }

    // ─── SPINNING: cuộn xuống liên tục ──────────────────────────────────────

    /**
     * Di chuyển TẤT CẢ nodes xuống delta pixels.
     * Node nào rơi dưới bottomEdge → wrap lên topEdge + gán random symbol mới.
     *
     * Mỗi node wrap RIÊNG → chỉ 1 node nhảy lên đầu mỗi lần, không jitter toàn bộ.
     */
    private _scrollDown(delta: number): void {
        const stripLen = this._strip.length;

        for (let i = 0; i < this.symbolNodes.length; i++) {
            this._nodeY[i] -= delta;  // di chuyển xuống

            // Wrap: node xuống quá bottom → nhảy lên top
            while (this._nodeY[i] < this._bottomEdge) {
                this._nodeY[i] += this._totalSpan;

                // Random symbol khi wrap (tạo cảm giác slot machine)
                if (stripLen > 0) {
                    const randIdx = Math.floor(Math.random() * stripLen);
                    const symId = this._strip[randIdx];
                    this.symbolNodes[i].emit('symbol-changed', symId);
                }
            }

            this.symbolNodes[i].setPosition(this._restPositions[i].x, this._nodeY[i], 0);
        }
    }

    // ─── STOP / DECELERATE (VELOCITY-BASED) ──────────────────────────────────────────────

    private _scheduleStop(centerIndex: number, longSpin: boolean): void {
        // Dừng nhanh: bỏ mọi delay (stopDelay / minSpin / longSpin) → decel ngay
        if (this._quickStopRequested || this._isQuickStopping) {
            this._quickStopRequested = false;
            this._beginDecel(centerIndex);
            return;
        }

        const elapsed   = (Date.now() - this._spinStartTime) / 1000;
        const minWait   = Math.max(0, this.minSpinDuration - elapsed);
        const longExtra = longSpin ? this.longSpinDelay : 0;
        const delay     = this.stopDelay + minWait + longExtra;

        if (longSpin) {
            this._isLongSpin = true;
        }

        if (delay <= 0) {
            this._beginDecel(centerIndex);
        } else {
            this._scheduledStop = {
                centerIndex,
                triggerTime: Date.now() + delay * 1000,
            };
        }
    }

    private _processScheduledStop(): void {
        if (!this._scheduledStop || this._state !== ReelState.SPINNING) return;

        const now = Date.now();
        if (now < this._scheduledStop.triggerTime) return;

        const scheduledStop = this._scheduledStop;
        this._scheduledStop = null;
        const overdueSeconds = Math.max(0, (now - scheduledStop.triggerTime) / 1000);
        this._beginDecel(scheduledStop.centerIndex, overdueSeconds);
    }

    /**
     * Giảm tốc velocity-based: tiếp tục scroll nhưng tốc độ giảm dần (cubicOut).
     *
     * Khác hoàn toàn cách cũ (teleport + ease position):
     *   — Không teleport nodes. Nodes tiếp tục ở đúng vị trí hiện tại.
     *   — _scrollDownDecel() chạy mỗi frame, giảm delta theo cubicOut.
     *   — Khi node wrap (qua _bottomEdge), được gán symbol kết quả đúng.
     *   — decelDuration được tính sào cho velocity tại t=0 khớp đúng currentSpeed.
     *
     * Kết quả: người chơi thấy symbol đang hiện chậm lại tự nhiên, thoát ra đáy,
     * symbol kết quả xuất hiện từ trên đi xuống với đúng tốc độ đó, rồi dừng lại.
     */
    private _beginDecel(centerIndex: number, catchUpSeconds: number = 0): void {
        if (this._state !== ReelState.SPINNING) return;

        const currentSpeed = (this._isLongSpin && this.longSpinSpeed > 0)
            ? this.longSpinSpeed
            : this.spinSpeed;
        this._isLongSpin = false;

        this._decelCenterIdx = centerIndex;

        const midRest    = this._restPositions[2].y;
        const midCurrent = this._nodeY[2];

        // Quãng đường Mid cần scroll xuống (Y giảm) để đến midRest (có thể có wrap).
        let dist = midCurrent - midRest;

        // ── CRITICAL: đảm bảo MỌI node đều wrap ít nhất 1 lần trong decel ──────
        //
        // Khi dist < (topEdge - bottomEdge), không có node nào pass qua
        // bottomEdge → không wrap → symbol random giữ nguyên → _finishDecel snap
        // đột ngột → "đổi hình đột ngột" (xảy ra ở cả Normal, Quick, Turbo).
        //
        // Fix: minDist = topEdge - bottomEdge + 1 cho MỌI mode.
        // Tốc độ stop nhanh/chậm do currentSpeed (6000 Turbo/Quick vs 4000 Normal)
        // → _decelAdaptedDuration ngắn hơn tự động, không cần giảm dist.
        const minDist = this._topEdge - this._bottomEdge + 1;
        while (dist < minDist) {
            dist += this._totalSpan;
        }

        // Dùng trực tiếp decelDuration (được set từ SpeedModeSettings theo Normal/Quick/Turbo).
        // Mỗi mode có duration khác nhau → tốc độ chậm dần khác nhau rõ rệt.
        const targetDecelDuration = this._isQuickStopping
            ? Math.min(this.decelDuration, this.quickStopDecelDuration)
            : this.decelDuration;
        this._decelAdaptedDuration = Math.max(0.02, targetDecelDuration);

        const overshoot = this.symbolHeight * this.stopBounceOvershootRatio;
        this._decelTotalDist       = dist + overshoot;
        this._decelScrolled        = 0;
        this._decelElapsed         = 0;
        this._decelLastUpdateTime  = Date.now();
        this._snapFired            = false;
        this._blurOffFired         = false;
        this._stopCompleteFired    = false;

        // Emit 'spin-stop' khi decel đạt ngưỡng blurOffProgress (không phải ngay đầu decel):
        // → _isSpinning vẫn true cho đến khi tốc độ giảm đủ chậm
        // → SymbolView giữ blur cho đến lúc đó, sau đó mới hiện ảnh thật.
        this._state = ReelState.DECELERATING;

        // NOTE: buffer nodes hidden during decel for visual clarity — uncomment when ready
        // const bufferIndices = [0, 4];
        // for (const idx of bufferIndices) {
        //     if (this.symbolNodes[idx]) this.symbolNodes[idx].active = false;
        // }

        Log.d(`${this._logPrefix} velocityDecel center=${centerIndex} midY=${midCurrent.toFixed(0)} dist=${dist.toFixed(0)} spd=${currentSpeed} dur=${this._decelAdaptedDuration.toFixed(3)}s`);

        this.onDecelStart?.(this._decelAdaptedDuration);

        // Giới hạn catch-up để tránh decel hoàn thành ngay lập tức
        // khi overdue lớn → visible nodes bị wrap + gán symbol trong 1 frame.
        if (catchUpSeconds > 0) {
            const maxCatchUp = this._decelAdaptedDuration * 0.9;
            this._updateDecel(Math.min(catchUpSeconds, maxCatchUp));
        }
    }

    private _getDecelDelta(dt: number): number {
        const now = Date.now();
        if (this._decelLastUpdateTime <= 0) {
            this._decelLastUpdateTime = now;
            return dt;
        }

        const wallClockDt = Math.max(0, (now - this._decelLastUpdateTime) / 1000);
        this._decelLastUpdateTime = now;
        return Math.max(dt, wallClockDt);
    }

    /**
     * Update velocity decel mỗi frame.
     * Delta được thoát ra từ cubicOut progress — đây là tốc độ giảm tự nhiên từ
     * currentSpeed → 0 không có bước nhảy nào.
     */
    private _updateDecel(dt: number): void {
        this._decelElapsed += dt;
        const t     = Math.min(this._decelElapsed / this._decelAdaptedDuration, 1.0);
        const eased = 1 - Math.pow(1 - t, 3); // cubicOut 0→1

        const targetScrolled = eased * this._decelTotalDist;
        const delta          = targetScrolled - this._decelScrolled;
        this._decelScrolled  = targetScrolled;

        if (delta > 0) {
            this._scrollDownDecel(delta);
        }

        // spin-stop trigger: emit khi tốc độ giảm đủ để hiện ảnh thật thay blur
        if (!this._blurOffFired && t >= this.blurOffProgress) {
            this._blurOffFired = true;
            for (const n of this.symbolNodes) n.emit('spin-stop');
        }

        // Spine trigger khi Mid gần rest
        if (!this._snapFired && this.spineTriggerDistance > 0) {
            const midRemaining = Math.abs(this._nodeY[2] - this._restPositions[2].y);
            if (midRemaining <= this.spineTriggerDistance) {
                this._snapFired = true;
                this.onSnapComplete?.();
            }
        }

        if (t >= 1.0) this._finishDecel();
    }

    /**
     * Scroll xuống trong decel phase.
     * Giống _scrollDown nhưng phân biệt 2 loại wrap:
     *   - Wrap TRUNG GIAN (node còn >1 totalSpan trước rest): gán random symbol như khi spinning.
     *   - Wrap CUỐI (node cách rest < totalSpan): gán symbol kết quả đúng.
     *
     * Lý do: nếu luôn gán symbol kết quả ở mọi lần wrap → khi reel decel dài
     * (reel 3 long spin), nodes wrap nhiều lần và symbol kết quả bị lộ sớm ở vị
     * trí trung gian → trông không tự nhiên. Reels 1 và 2 decel nhanh (≤1 wrap)
     * nên không bị ảnh hưởng.
     */
    private _scrollDownDecel(delta: number): void {
        const strip = this._strip;
        const L     = strip.length;

        for (let i = 0; i < this.symbolNodes.length; i++) {
            this._nodeY[i] -= delta;

            while (this._nodeY[i] < this._bottomEdge) {
                this._nodeY[i] += this._totalSpan;

                // Kiểm tra đây có phải wrap cuối không:
                // Nếu khoảng cách từ vị trí hiện tại đến rest < totalSpan
                // → wrap này là wrap cuối → gán đúng symbol kết quả.
                // Ngược lại → còn nhiều wrap nữa → gán random như khi spinning.
                const distToRest = this._nodeY[i] - this._restPositions[i].y;
                const isFinalResultWrap = distToRest < this._totalSpan;
                let symId: number;
                if (isFinalResultWrap) {
                    // Wrap cuối: gán symbol kết quả đúng cho vị trí này
                    const isTopUp = GameData.instance.currentMode === 'respin';
                    const offset = isTopUp ? (i - 2) : (2 - i); // TopUp: logic order; Normal: reversed display
                    symId = strip[((this._decelCenterIdx + offset) % L + L) % L];
                } else {
                    // Wrap trung gian: random, giống spinning thường
                    symId = strip[Math.floor(Math.random() * L)];
                }
                this.symbolNodes[i].emit('symbol-changed', symId);
                if (isFinalResultWrap) {
                    this._prefillStickyCreditForNode(i, symId);
                }
            }

            this.symbolNodes[i].setPosition(this._restPositions[i].x, this._nodeY[i], 0);
        }
    }

    private _prefillStickyCreditForNode(nodeIndex: number, symbolId: number): void {
        const rowIndex = this._getVisibleRowIndex(nodeIndex);
        if (rowIndex < 0) return;

        const isSticky = symbolId === SymbolId.STICKY_RED
            || symbolId === SymbolId.STICKY_YELLOW
            || symbolId === SymbolId.STICKY_GREEN;
        if (!isSticky) return;

        this.symbolNodes[nodeIndex]?.getComponent(SymbolView)?.prefillStickyCredit(symbolId, rowIndex);
    }

    private _emitStickyResultLanded(nodeIndex: number, symbolId: number): void {
        const rowIndex = this._getVisibleRowIndex(nodeIndex);
        if (rowIndex < 0) return;

        const isSticky = symbolId === SymbolId.STICKY_RED
            || symbolId === SymbolId.STICKY_YELLOW
            || symbolId === SymbolId.STICKY_GREEN;
        if (!isSticky) return;

        this.symbolNodes[nodeIndex]?.emit('sticky-result-landed', symbolId);
    }

    private _getVisibleRowIndex(nodeIndex: number): number {
        // Visible: [1]=Top(row2), [2]=Mid(row1), [3]=Bot(row0)  → stickyCells row
        return nodeIndex >= 1 && nodeIndex <= 3 ? 3 - nodeIndex : -1;
    }

    private _finishDecel(): void {
        // IDLE = bounce xong; SETTLING = đang stop-bounce — không re-enter.
        if (this._state === ReelState.IDLE || this._state === ReelState.SETTLING) return;

        // Snap chính xác và gán symbol kết quả đúng (khắc phục floating-point drift)
        const data = GameData.instance;
        if (data.freeSpinRemaining <= 0 && data.currentMode === 'normal') {
            this._lastNormalCenterIndex = this._decelCenterIdx;
        }
        const syms = this._getSymbols5(this._decelCenterIdx);

        // Decel đã scroll quá đích (overshoot), node đang ở dưới rest.
        // Chỉ emit symbol-changed để đảm bảo symbol đúng, không snap position.
        for (let i = 0; i < this.symbolNodes.length; i++) {
            const n = this.symbolNodes[i];
            if (!n?.isValid) continue;
            n.emit('symbol-changed', syms[i]);
        }

        // Giữ SETTLING suốt stop-bounce — isIdle=false → không recover/bắn trail sớm.
        this._state = ReelState.SETTLING;
        this._quickStopRequested = false;

        // onSymbolsSettled: luôn gọi TRONG _finishDecel sau khi symbols đã được gán đúng,
        // bất kể onSnapComplete đã bắn sớm hay chưa (spineTriggerDistance).
        this.onSymbolsSettled?.();

        if (!this._snapFired) {
            this._snapFired = true;
            this.onSnapComplete?.();
        }

        // Bounce nhỏ — snap từ dưới quá khứ về rest
        // Chỉ tween 3 visible nodes (1,2,3). Buffer nodes (0,4) → snap ngay lập tức.
        const setDur = Math.max(
            0.01,
            this._isQuickStopping
                ? Math.min(this.stopBounceSettleDuration, this.quickStopBounceSettleDuration)
                : this.stopBounceSettleDuration,
        );
        this._isQuickStopping = false;
        this.onBounceStart?.();
        let done = 0;
        const visibleIndices = [1, 2, 3];
        for (const i of visibleIndices) {
            this._emitStickyResultLanded(i, syms[i]);
        }

        // Snap buffer nodes instantly
        const bufferIndices = [0, 4];
        for (const idx of bufferIndices) {
            const buf = this.symbolNodes[idx];
            if (buf?.isValid && this._restPositions[idx]) {
                buf.setPosition(this._restPositions[idx]);
                this._nodeY[idx] = this._restPositions[idx].y;
                buf.emit('reel-settled');
            }
        }

        const validVisible = visibleIndices.filter((i) => this.symbolNodes[i]?.isValid && this._restPositions[i]);
        const fireStopComplete = () => {
            if (this._stopCompleteFired) return;
            this._stopCompleteFired = true;
            this.unschedule(fireStopComplete);
            // Sync Y + IDLE chỉ sau bounce — REEL_STOPPED / trail lấy đúng vị trí rest.
            // Kill stop-bounce tween trước khi snap (safety timeout có thể fire khi tween còn chạy).
            for (let i = 0; i < this.symbolNodes.length; i++) {
                const rest = this._restPositions[i];
                const node = this.symbolNodes[i];
                if (!rest || !node?.isValid) continue;
                Tween.stopAllByTarget(node);
                node.setPosition(rest);
                this._nodeY[i] = rest.y;
            }
            // reel-settled SAU stop tween — sticky land-bounce / trail mới được phép chạy.
            for (const i of visibleIndices) {
                const node = this.symbolNodes[i];
                if (node?.isValid) node.emit('reel-settled');
            }
            this._state = ReelState.IDLE;
            this.onStopComplete?.();
        };

        // Safety: nếu stop-bounce tween bị kill (highlight/spine/land-bounce) → vẫn fire onStopComplete
        this.unschedule(fireStopComplete);
        this.scheduleOnce(fireStopComplete, setDur + 0.08);

        if (validVisible.length === 0) {
            fireStopComplete();
            return;
        }

        for (const i of validVisible) {
            const node = this.symbolNodes[i];
            const rest = this._restPositions[i];
            tween(node)
                .to(setDur, { position: rest.clone() }, { easing: 'backOut' })
                .call(() => {
                    if (!this._stopCompleteFired && ++done >= validVisible.length) {
                        fireStopComplete();
                    }
                })
                .start();
        }
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────────

    /**
     * 5 symbol IDs quanh centerIndex trên strip, theo thứ tự hiển thị đã đảo dọc:
     *   [center+2, center+1, center, center-1, center-2]
     *   → map vào [ExtraTop1, Top, Mid, Bot, ExtraBot1]
     * Server/logical row vẫn là [center-1, center, center+1]; chỉ visual Top/Bot được đảo.
     */
    private _getSymbols5(centerIndex: number): number[] {
        const isTopUp = GameData.instance.currentMode === 'respin';
        return this._getSymbols5FromStrip(this._strip, centerIndex, !isTopUp);
    }

    private _getSymbols5FromStrip(strip: number[], centerIndex: number, reverse: boolean = true): number[] {
        const L = strip.length;
        if (L === 0) return [0, 0, 0, 0, 0];
        const c = ((centerIndex % L) + L) % L;
        const result: number[] = [];
        if (reverse) {
            for (let off = 2; off >= -2; off--) {
                result.push(strip[((c + off) % L + L) % L]);
            }
        } else {
            for (let off = -2; off <= 2; off++) {
                result.push(strip[((c + off) % L + L) % L]);
            }
        }
        return result;
    }
}


