/**
 * TopUpManager — Quản lý grid cell-spin (TopUp 5×3 / Matsuri Hold&Spin 5×3|4|5).
 *
 * ── LAYOUT ──
 *   Prefab StickyOverlay = 5 cột × 5 hàng (25 ô), column-major:
 *     idx = col * 5 + row  (row 0 = Top … trong pool prefab)
 *   ensureRowCount(3|4|5) chọn subset active (TopUp mặc định 3 hàng).
 *
 * ── Matsuri 5×4 / 5×5 ──
 *   Prefab đã có sẵn 25 ô — chỉ bật/ẩn hàng, không cần clone runtime.
 */

import { _decorator, Component, Node, Mask, instantiate } from 'cc';
import { TopUpReelController } from './TopUpReelController';
import { SlotMachineController } from './SlotMachineController';
import { SymbolView } from './SymbolView';
import { GameData } from '../data/GameData';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { Log } from '../core/Logger';
import { TopupReelType, SymbolId } from '../data/SlotTypes';
import { AutoSpinManager } from '../manager/AutoSpinManager';
import { MATSURI_COL_COUNT, MATSURI_MIN_ROWS, clampMatsuriRows } from '../data/MatsuriGridUtil';

const { ccclass, property } = _decorator;

const COLUMN_COUNT = MATSURI_COL_COUNT;

@ccclass('TopUpManager')
export class TopUpManager extends Component {

    @property({
        type: [TopUpReelController],
        tooltip:
            'ReelControllers 5×N (Prefab mặc định N=3 → 15 ô).\n' +
            'Thứ tự column-major: idx = col * N + row (row 0=Bottom).',
    })
    reels: TopUpReelController[] = [];

    @property({ tooltip: 'Delay giữa mỗi reel khi bắt đầu quay (giây)' })
    startStaggerDelay: number = 0.08;

    @property({ tooltip: 'Delay giữa mỗi cột khi dừng (giây)' })
    columnStopDelay: number = 0.2;

    @property({
        type: SlotMachineController,
        tooltip: 'Thường để trống trên Prefab — StickyOverlayLoader.bindSlotMachine() wire lúc runtime.',
    })
    slotMachine: SlotMachineController | null = null;

    /**
     * Wire SlotMachineController từ code (lazy Prefab không serialize cross-prefab refs).
     * Phân phối lại symbolFrames nếu đã có.
     */
    bindSlotMachine(smc: SlotMachineController | null): void {
        this.slotMachine = smc;
        this._distributeFramesFromSlotMachine();
    }

    @property({
        type: Node,
        tooltip: 'Node chứa Mask — bật khi reel đang quay, tắt khi reel dừng',
    })
    maskNode: Node | null = null;

    /** Số hàng active (3|4|5). Prefab gốc = 5×5 (25 ô); TopUp/Mighty dùng 3. */
    private _rowCount: number = MATSURI_MIN_ROWS;
    /** Pool đầy đủ từ Prefab (25 ô column-major 5 hàng) — không mất khi shrink. */
    private _poolReels: TopUpReelController[] = [];
    private static readonly POOL_ROWS = 5;

    get rowCount(): number { return this._rowCount; }
    get cellCount(): number { return COLUMN_COUNT * this._rowCount; }

    private _isSpinning: boolean = false;
    /** Thứ tự quay theo col-major index 0..cellCount-1 */
    private _seqOrder: number[] = [];
    private _seqIndex: number = 0;
    private _pendingResults: any[] = [];
    /** Số reel thực sự được spin trong lần này (không tính locked/auto-locked) */
    private _spunCount: number = 0;
    /** Số reel đã dừng xong */
    private _stoppedCount: number = 0;

    /** Hệ số tốc độ dựa trên speed mode (NORMAL=1, QUICK=0.8, TURBO=0.6) */
    private get _tm(): number {
        return AutoSpinManager.instance.getTimingMultiplier();
    }

    private _setMaskEnabled(enabled: boolean): void {
        if (!this.maskNode) return;
        const mask = this.maskNode.getComponent(Mask);
        if (mask) {
            mask.enabled = enabled;
        } else {
            this.maskNode.active = enabled;
        }
    }

    // ─── LIFECYCLE ───

    onLoad(): void {
        this._poolReels = this.reels.slice();
        this._isSpinning = false;
        this._seqIndex = 0;
        this._pendingResults = [];

        if (this._poolReels.length >= COLUMN_COUNT * TopUpManager.POOL_ROWS) {
            // Prefab 5×5 — mặc định active 5×3 (TopUp / Mighty)
            this._rowCount = TopUpManager.POOL_ROWS;
            this.ensureRowCount(MATSURI_MIN_ROWS);
        } else if (this._poolReels.length >= 20) {
            this._rowCount = 4;
            this._seqOrder = Array.from({ length: this.cellCount }, (_, i) => i);
        } else {
            this._rowCount = 3;
            this._seqOrder = Array.from({ length: this.cellCount }, (_, i) => i);
            if (this.reels.length < this.cellCount) {
                Log.w(`[TopUpManager] reels.length=${this.reels.length} (expected ≥${this.cellCount}). Kiểm tra Prefab.`);
            }
        }

        this._distributeFramesFromSlotMachine();

        EventBus.instance.on(GameEvents.REELS_START_SPIN, this._onReelsStartSpin, this);
        EventBus.instance.on(GameEvents.SPIN_RESPONSE,     this._onSpinResponse,     this);
        EventBus.instance.on(GameEvents.TOPUP_START,     this._onTopUpStart,       this);
        EventBus.instance.on(GameEvents.TOPUP_END,       this._onTopUpEnd,         this);
        EventBus.instance.on(GameEvents.FREE_SPIN_GOLD_END, this._onTopUpEnd,    this);
        EventBus.instance.on(GameEvents.FREE_SPIN_END,       this._onTopUpEnd,    this);

        const mode = GameData.instance.currentMode;
        if (mode === 'respin' || mode === 'matsuri') {
            Log.d(`[TopUpManager] onLoad — mode=${mode}, init ngay`);
            this._onTopUpStart();
        }
    }

    /**
     * Chọn số hàng active 3|4|5.
     * Prefab 5×5: remap từ pool (không clone). Prefab cũ 5×3: clone fallback.
     */
    ensureRowCount(rows: number): void {
        const target = clampMatsuriRows(rows);

        if (this._poolReels.length >= COLUMN_COUNT * TopUpManager.POOL_ROWS) {
            const fullRows = TopUpManager.POOL_ROWS;
            const next: TopUpReelController[] = [];
            for (let col = 0; col < COLUMN_COUNT; col++) {
                for (let row = 0; row < target; row++) {
                    const reel = this._poolReels[col * fullRows + row];
                    if (!reel) continue;
                    reel.node.active = true;
                    next.push(reel);
                }
                for (let row = target; row < fullRows; row++) {
                    const reel = this._poolReels[col * fullRows + row];
                    if (reel?.node) reel.node.active = false;
                }
            }
            this.reels = next;
            this._rowCount = target;
            this._seqOrder = Array.from({ length: this.cellCount }, (_, i) => i);
            this._distributeFramesFromSlotMachine();
            Log.d(`[TopUpManager] ensureRowCount pool → 5×${target} (${this.reels.length} active / ${this._poolReels.length} pool)`);
            return;
        }

        const oldRows = this._rowCount;
        const oldReels = this.reels.slice();

        if (target === oldRows && oldReels.length >= COLUMN_COUNT * target) {
            this._rowCount = target;
            this._seqOrder = Array.from({ length: this.cellCount }, (_, i) => i);
            this._applyCellVisibility();
            return;
        }

        if (target < oldRows) {
            const kept: TopUpReelController[] = [];
            for (let col = 0; col < COLUMN_COUNT; col++) {
                for (let row = 0; row < target; row++) {
                    const reel = oldReels[col * oldRows + row];
                    if (reel) kept.push(reel);
                }
                for (let row = target; row < oldRows; row++) {
                    const reel = oldReels[col * oldRows + row];
                    if (reel?.node) reel.node.active = false;
                }
            }
            this.reels = kept;
            this._rowCount = target;
            this._seqOrder = Array.from({ length: this.cellCount }, (_, i) => i);
            this._distributeFramesFromSlotMachine();
            this._applyCellVisibility();
            Log.d(`[TopUpManager] ensureRowCount shrink → 5×${target} (${this.reels.length} cells)`);
            return;
        }

        const spacingY = (oldReels[0] && oldReels[1])
            ? oldReels[1].node.position.y - oldReels[0].node.position.y
            : 120;
        const parent = oldReels[0]?.node?.parent;
        if (!parent) {
            Log.e('[TopUpManager] ensureRowCount: thiếu parent — không clone được');
            return;
        }

        const newReels: TopUpReelController[] = [];
        for (let col = 0; col < COLUMN_COUNT; col++) {
            for (let row = 0; row < target; row++) {
                if (row < oldRows) {
                    const existing = oldReels[col * oldRows + row];
                    if (existing) {
                        existing.node.active = true;
                        newReels.push(existing);
                    }
                    continue;
                }
                const template = oldReels[col * oldRows + (oldRows - 1)];
                if (!template) {
                    Log.e(`[TopUpManager] ensureRowCount: thiếu template col=${col}`);
                    continue;
                }
                const node = instantiate(template.node);
                node.name = `TopUpCell_${col}_${row}`;
                parent.addChild(node);
                const base = template.node.position;
                const extra = row - (oldRows - 1);
                node.setPosition(base.x, base.y + spacingY * extra, base.z);
                const ctrl = node.getComponent(TopUpReelController);
                if (ctrl) {
                    ctrl.reset();
                    newReels.push(ctrl);
                } else {
                    Log.e(`[TopUpManager] clone thiếu TopUpReelController col=${col} row=${row}`);
                }
            }
        }

        this.reels = newReels;
        this._rowCount = target;
        this._seqOrder = Array.from({ length: this.cellCount }, (_, i) => i);
        this._distributeFramesFromSlotMachine();
        this._applyCellVisibility();
        Log.e(`[TopUpManager] ensureRowCount expand → 5×${target} (${this.reels.length} cells) spacingY=${spacingY}`);
    }

    private _applyCellVisibility(): void {
        for (let i = 0; i < this.reels.length; i++) {
            const reel = this.reels[i];
            if (reel?.node) reel.node.active = i < this.cellCount;
        }
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    /** Phân phối symbolFrames / blurFrames / reelIndex / rowIndex từ SlotMachineController. */
    private _distributeFramesFromSlotMachine(): void {
        if (this.slotMachine && this.slotMachine.symbolFrames.length > 0) {
            for (let i = 0; i < this.reels.length; i++) {
                const reel = this.reels[i];
                if (!reel) continue;
                reel.symbolFrames = this.slotMachine.symbolFrames;

                const col = Math.floor(i / this._rowCount);
                // TopUpReelController.symbolNodes: [0]=Top [1]=Mid [2]=Bot
                // rowIndex convention: 0=top, 1=mid, 2=bot
                for (let ni = 0; ni < reel.symbolNodes.length; ni++) {
                    const node = reel.symbolNodes[ni];
                    if (!node) continue;
                    const view = node.getComponent(SymbolView);
                    if (view) {
                        view.symbolFrames = this.slotMachine.symbolFrames;
                        view.blurFrames   = this.slotMachine.blurFrames;
                        view.reelIndex    = col;
                        view.rowIndex     = ni;
                    }
                }
            }
            Log.d(`[TopUpManager] phân phối ${this.slotMachine.symbolFrames.length} symbolFrames + ${this.slotMachine.blurFrames.length} blurFrames cho ${this.reels.length} reels.`);
        } else {
            Log.w(`[TopUpManager] slotMachine=${this.slotMachine ? 'OK' : 'NULL'} symbolFrames=${this.slotMachine?.symbolFrames.length ?? 'N/A'}`);
        }
    }

    private _onReelsStartSpin(): void {
        this.spinAll();
    }

    private _onSpinResponse(response: any): void {
        this.stopReels(response);
    }

    /** Reset reels khi kết thúc TopUp / FreeSpin — clear stickyCells để session sau không bị dính data cũ */
    private _onTopUpEnd(): void {
        Log.d('[TopUpManager] _onTopUpEnd — RESET all reels + clear stickyCells');
        this.unscheduleAllCallbacks();
        for (const reel of this.reels) {
            if (reel) reel.reset();
        }
        GameData.instance.stickyCells.clear();
        this._isSpinning = false;
        this._seqIndex = 0;
        this._spunCount = 0;
        this._stoppedCount = 0;
        this._pendingResults = [];
        this._setMaskEnabled(false);
    }

    /** Init ngay khi vào TopUp — reset sạch + gán strip + lock reels từ stickyCells, set symbols cho reels trống */
    private _onTopUpStart(): void {
        Log.d('[TopUpManager] _onTopUpStart — BẮT ĐẦU');
        this.unscheduleAllCallbacks();
        // ★ Reset toàn bộ reel trước khi init — đề phòng _onTopUpEnd bị miss (transition FreeSpin → TopUp)
        for (const reel of this.reels) {
            if (reel) reel.reset();
        }
        this.initFromGameData();

        const lastResp = GameData.instance.lastSpinResponse;
        const lockedIndices = new Set<number>();

        // Lock reels có coin từ stickyCells.
        // TopUp reels trong Editor sắp xếp 1:1 với StickyOverlay: idx = reel*3+row.
        const cells = GameData.instance.stickyCells;
        for (const [key, cell] of cells) {
            const [reelStr, rowStr] = key.split('-');
            const reel = parseInt(reelStr);
            const row = parseInt(rowStr);
            const idx = reel * this._rowCount + row;
            const topUpReel = this.reels[idx];
            if (!topUpReel) continue;

            const type = this._symbolIdToTopupType(cell.symbolId);
            if (idx < 3 || cell.symbolId !== SymbolId.STICKY_RED) {
                Log.e(
                    `[TOPUP-ENTER-CHECK][TOPUP-REEL] key=${key} idx=${idx}` +
                    ` symbol=${SymbolId[cell.symbolId] ?? cell.symbolId} type=${type}` +
                    ` credit=${cell.credit ?? 0}`
                );
            }
            if (type !== TopupReelType.NONE) {
                topUpReel.applyStickyResult(type, cell.credit ?? 0);
                lockedIndices.add(idx);
            }
        }

        // Set symbols cho các reel trống
        for (let i = 0; i < this.cellCount; i++) {
            if (lockedIndices.has(i)) continue;
            const reel = this.reels[i];
            if (!reel) continue;
            const serverIdx = this._topUpIdxToServerIdx(i);
            const slot = lastResp?.topupReel?.[serverIdx];
            const idx = slot?.index ?? Math.floor(Math.random() * (reel['_strip'].length || 1));
            const stripMidSymbol = reel.getSymbolAtIndex(idx);
            const forcedMidSymbol = this._isTopUpSpecialSymbol(stripMidSymbol)
                ? this._fallbackNonBonusSymbol(reel)
                : undefined;
            if (i < 3) {
                Log.e(
                    `[TOPUP-ENTER-CHECK][TOPUP-REEL] free idx=${i}` +
                    ` serverIdx=${serverIdx} slotType=${slot?.type ?? 'n/a'}` +
                    ` slotIndex=${slot?.index ?? 'n/a'} setIndex=${idx}` +
                    ` stripMid=${stripMidSymbol == null ? 'none' : (SymbolId[stripMidSymbol] ?? stripMidSymbol)}` +
                    ` forcedMid=${forcedMidSymbol == null ? 'none' : (SymbolId[forcedMidSymbol] ?? forcedMidSymbol)}`
                );
            }
            reel.setSymbols(idx, forcedMidSymbol, false);
            if (i < 3) {
                const childStates = reel.symbolNodes.map((node, childIdx) => `${childIdx}:${node ? (node.active ? 1 : 0) : 'null'}`).join(',');
                Log.e(`[TOPUP-ENTER-CHECK][TOPUP-REEL] active idx=${i} node=${reel.node.active ? 1 : 0} symbols=${childStates}`);
            }
        }

        Log.d(`[TopUpManager] _onTopUpStart — ${lockedIndices.size} reels locked (coins), ${this.cellCount - lockedIndices.size} reels free`);
    }

    /** Map SymbolId (STICKY_RED/YELLOW/GREEN/JP_GRAND) → TopupReelType */
    private _symbolIdToTopupType(symbolId: number): number {
        if (symbolId === SymbolId.STICKY_RED) return TopupReelType.RED;
        if (symbolId === SymbolId.STICKY_YELLOW) return TopupReelType.YELLOW;
        if (symbolId === SymbolId.STICKY_GREEN) return TopupReelType.GREEN;
        if (symbolId === SymbolId.JP_GRAND) return TopupReelType.GRAND;
        return TopupReelType.NONE;
    }

    lockCellAt(reel: number, row: number, symbolId: number, credit: number = 0): void {
        const idx = reel * this._rowCount + row;
        const topUpReel = this.reels[idx];
        if (!topUpReel) return;

        // ★ PLUS_ONE_SPIN KHÔNG lock reel — chỉ hiển thị tạm thời trên overlay
        //    Reel vẫn phải quay được ở lượt tiếp theo
        if (symbolId === SymbolId.PLUS_ONE_SPIN) {
            return;
        }

        const type = this._symbolIdToTopupType(symbolId);
        if (type !== TopupReelType.NONE) {
            topUpReel.applyStickyResult(type, credit);
        }
    }

    /**
     * Map TopUp reel index (column-major: 0,1,2=C0, 3,4,5=C1...)
     * → server topupReel index (row-major: 0-4=top, 5-9=mid, 10-14=bot).
     */
    private _topUpIdxToServerIdx(idx: number): number {
        const col = Math.floor(idx / this._rowCount);     // 0-4
        const offset = idx % this._rowCount;              // TopUp/StickyOverlay visual row
        const apiRow = this._rowCount - 1 - offset;       // Server row order is inverted vertically.
        return apiRow * COLUMN_COUNT + col;
    }

    // ─── PUBLIC API ───

    /**
     * Nhận cục PS từ API /Enter.
     * Đọc PS.TopUpGameReels.Strips và gán Symbols cho cả 15 ReelController.
     * Cột 0→Strips[0], Cột 1→Strips[1], ... Cột 4→Strips[4].
     */
    initReelStrips(PS: any): void {
        const strips = PS?.TopUpGameReels?.Strips ?? [];
        Log.d(`[TopUpManager] initReelStrips — PS.TopUpGameReels.Strips length=${strips.length}`);
        this._applyStrips(strips);
    }

    /**
     * Lấy strip từ GameData.config.respinReelStrips (đã parse từ PS).
     * Dùng khi PS object không sẵn.
     */
    initFromGameData(): void {
        const strips = GameData.instance?.config?.respinReelStrips ?? [];
        // Log.d(`[TopUpManager] initFromGameData — respinReelStrips length=${strips.length}`);
        this._applyStrips(strips);
    }

    private _applyStrips(strips: any[]): void {
        const reelCount = this.reels.length;
        // Log.d(`[TopUpManager] _applyStrips — ${strips.length} strip sources...`);

        for (let i = 0; i < reelCount; i++) {
            const col = Math.floor(i / this._rowCount); // 0,1,2→strip[0], 3,4,5→strip[1]...
            const stripSrc = strips[col];
            const symbols = stripSrc?.Symbols ?? stripSrc ?? [];
            const reel = this.reels[i];
            if (reel) {
                const arr = Array.isArray(symbols) ? symbols : [];
                reel.setStripData(arr);
            }
        }
    }

    /** Bắt đầu sequence spin: tất cả reel bắt đầu quay cách nhau startStaggerDelay */
    spinAll(): void {
        if (this._isSpinning) {
            Log.w('[TopUpManager] spinAll — đang spin, bỏ qua.');
            return;
        }
        this.unscheduleAllCallbacks();
        this._isSpinning = true;
        this._seqIndex = 0;
        this._spunCount = 0;
        this._stoppedCount = 0;
        this._pendingResults = new Array(this.cellCount);

        // ★ Xóa PLUS_ONE_SPIN khỏi stickyCells — chúng đã tiêu thụ ở spin trước
        //    và unlock các reel bị lock bởi PLUS_ONE_SPIN
        const cells = GameData.instance.stickyCells;
        for (const [key, cell] of cells) {
            if (cell.symbolId === SymbolId.PLUS_ONE_SPIN) {
                cells.delete(key);
                // Unlock reel tại vị trí này để nó có thể quay ở lượt tiếp theo
                const [reelStr, rowStr] = key.split('-');
                const reel = parseInt(reelStr);
                const row = parseInt(rowStr);
                const idx = reel * this._rowCount + row;
                const topUpReel = this.reels[idx];
                if (topUpReel) {
                    topUpReel.isLocked = false;
                    Log.d(`[TopUpManager] spinAll — unlock reel ${idx} tại ${key} (PLUS_ONE_SPIN đã xóa)`);
                }
                Log.d(`[TopUpManager] spinAll — xóa PLUS_ONE_SPIN tại ${key}`);
            }
        }

        Log.d(`[TopUpManager] spinAll — bắt đầu sequence spin stagger.`);
        this._setMaskEnabled(true);
        for (let i = 0; i < this.cellCount; i++) {
            const col = Math.floor(i / this._rowCount);
            const row = i % this._rowCount;
            const key = `${col}-${row}`;
            const cell = cells.get(key);
            const reel = this.reels[i];
            if (!reel) continue;
            if (!cell || cell.symbolId === SymbolId.PLUS_ONE_SPIN) {
                const wasLocked = reel.isLocked;
                reel.prepareFreeCellForSpin();
                if (i < 3 || wasLocked) {
                    const childStates = reel.symbolNodes.map((node, childIdx) => `${childIdx}:${node ? (node.active ? 1 : 0) : 'null'}`).join(',');
                    Log.e(`[TOPUP-ENTER-CHECK][TOPUP-REEL] prepareFree idx=${i} key=${key} wasLocked=${wasLocked ? 1 : 0} node=${reel.node.active ? 1 : 0} symbols=${childStates}`);
                }
            }
        }

        this._spinNext();
    }

    /** Schedule start spin cho reel tiếp theo với stagger delay. Tất cả reel chạy song song. */
    private _spinNext(): void {
        while (this._seqIndex < this._seqOrder.length) {
            const reelIdx = this._seqOrder[this._seqIndex];
            const reel = this.reels[reelIdx];
            if (reel && !reel.isLocked) {
                // ★ Check stickyCells: nếu vừa có coin mới (per-reel land) → lock ngay, skip
                //    BUT: PLUS_ONE_SPIN KHÔNG lock — đã bị xóa trong spinAll()
                const col = Math.floor(reelIdx / this._rowCount);
                const row = reelIdx % this._rowCount;
                const key = `${col}-${row}`;
                const cell = GameData.instance.stickyCells.get(key);
                if (cell) {
                    const type = this._symbolIdToTopupType(cell.symbolId);
                    // ★ Bỏ qua PLUS_ONE_SPIN — không lock reel
                    if (cell.symbolId !== SymbolId.PLUS_ONE_SPIN && type !== TopupReelType.NONE) {
                        Log.d(`[TopUp-SPIN] reelIdx=${reelIdx} auto-locked from stickyCells ${key} ${SymbolId[cell.symbolId]}`);
                        reel.applyStickyResult(type, cell.credit ?? 0);
                        this._seqIndex++;
                        continue;
                    }
                }

                const resultData = this._pendingResults[reelIdx];
                const hasResult = resultData != null;
                Log.d(`[TopUp-SPIN] seq=${this._seqIndex} reelIdx=${reelIdx} type=${resultData?.type} sym=${SymbolId[resultData?._symbolId] ?? resultData?._symbolId} index=${resultData?.index} win=${resultData?.win}`);

                reel.onStopComplete = (r) => {
                    const res = this._pendingResults[reelIdx];
                    Log.d(`[TopUp-SPIN] reelIdx=${reelIdx} STOPPED type=${res?.type} sym=${SymbolId[res?._symbolId] ?? res?._symbolId} index=${res?.index} win=${res?.win}`);
                    EventBus.instance.emit(GameEvents.REEL_STOPPED, { reelIndex: reelIdx, result: res });
                    this._stoppedCount++;
                    if (this._stoppedCount >= this._spunCount) {
                        this._isSpinning = false;
                        this._setMaskEnabled(false);
                        // Log.e(`[SPIN-HANG][TopUpManager] emit REELS_STOPPED all reels stopped | stopped=${this._stoppedCount}/${this._spunCount} active=${this.node?.active ?? false}`);
                        EventBus.instance.emit(GameEvents.REELS_STOPPED);
                        Log.d('[TopUpManager] All reels stopped → emit REELS_STOPPED');
                    }
                };
                reel.spin();
                this._spunCount++;
                this._seqIndex++;

                if (hasResult) {
                    this.scheduleOnce(() => {
                        const st = (reel as any)['_state'];
                        if (st === 1 || st === 2) { // LAUNCHING or SPINNING
                            reel.stop(resultData);
                        }
                    }, reel.minSpinDuration * this._tm);
                }
                // ★ Schedule reel tiếp theo start sau stagger delay (song song, không đợi reel trước dừng)
                this.scheduleOnce(() => this._spinNext(), this.startStaggerDelay * this._tm);
                return;
            }
            this._seqIndex++;
        }

        // Đã schedule hết tất cả reel. Nếu không có reel nào spin → emit ngay.
        if (this._spunCount === 0) {
            this._isSpinning = false;
            this._setMaskEnabled(false);
            // Log.e(`[SPIN-HANG][TopUpManager] emit REELS_STOPPED no reels to spin | stopped=${this._stoppedCount}/${this._spunCount} active=${this.node?.active ?? false}`);
            EventBus.instance.emit(GameEvents.REELS_STOPPED);
            Log.d('[TopUpManager] No reels to spin → emit REELS_STOPPED');
        }
    }

    /**
     * Nhận kết quả từ API /Spin.
     * Lưu result data, dừng reel HIỆN TẠI đang quay với result tương ứng.
     * Reel đang quay sẽ dừng → callback → spin reel tiếp theo.
     */
    stopReels(GFSpinResponse: any): void {
        // SpinResponse interface dùng 'topupReel' (lowercase)
        const topupReel = GFSpinResponse?.topupReel
            ?? GFSpinResponse?.TopupReel
            ?? [];
        const resultSlots = topupReel.slice(0, this.cellCount);

        if (resultSlots.length < this.cellCount) {
            Log.e(`[TopUpManager] TopupReel không đủ ${this.cellCount} phần tử: ${resultSlots.length}`);
            return;
        }

        // Remap server row-major → TopUp column-major indices
        this._pendingResults = new Array(this.cellCount);
        const serverRemain = GFSpinResponse?.remainRespinCount ?? GFSpinResponse?.RemainFeatureSpinCount ?? GFSpinResponse?.RemainReSpinCount;
        const afterLocalConsume = GameData.instance.respinRemaining;
        const plusOneCount = serverRemain != null ? Math.max(0, serverRemain - afterLocalConsume) : 0;
        let plusOneUsed = 0;
        for (let i = 0; i < this.cellCount; i++) {
            const serverIdx = this._topUpIdxToServerIdx(i);
            const slot = resultSlots[serverIdx];
            const index = slot?.Index ?? slot?.index ?? 0;
            const stripSymbolId = this.reels[i]?.getSymbolAtIndex(index);
            const slotType = slot?.Type ?? slot?.type ?? TopupReelType.NONE;
            const isPlusOneResult = slotType === TopupReelType.NONE
                && stripSymbolId === SymbolId.PLUS_ONE_SPIN;
            const allowPlusOne = isPlusOneResult && plusOneUsed < plusOneCount;
            if (allowPlusOne) plusOneUsed++;
            this._pendingResults[i] = this._enrichResultForTopUpIndex(slot, i, serverIdx, allowPlusOne);
        }
        Log.e(`[TOPUP-PLUS] TopUpManager stopReels serverRemain=${serverRemain ?? 'n/a'} afterLocalConsume=${afterLocalConsume} plusOneCount=${plusOneCount} visualAllowed=${plusOneUsed}`);
        if (plusOneCount > 0 && plusOneUsed < plusOneCount) {
            const dump = [];
            for (let i = 0; i < this.cellCount; i++) {
                const serverIdx = this._topUpIdxToServerIdx(i);
                const slot = resultSlots[serverIdx];
                const index = slot?.Index ?? slot?.index ?? 0;
                const type = slot?.Type ?? slot?.type ?? TopupReelType.NONE;
                const symbol = this.reels[i]?.getSymbolAtIndex(index);
                dump.push(`${i}>${serverIdx}:t${type}:idx${index}:${symbol == null ? 'none' : (SymbolId[symbol] ?? symbol)}`);
            }
            Log.e(`[TOPUP-PLUS] visual miss detail ${dump.join('|')}`);
        }

        // Dừng TẤT CẢ reel đang quay (parallel spin: nhiều reel quay cùng lúc)
        for (let i = 0; i < this.cellCount; i++) {
            const reel = this.reels[i];
            const data = this._pendingResults[i];
            const st = (reel as any)['_state'];
            if (reel && data != null && (st === 1 || st === 2)) { // LAUNCHING or SPINNING
                reel.stop(data);
            }
        }
    }

    public getDebugClientGrid(): number[][] {
        const grid: number[][] = Array.from({ length: this._rowCount }, () => Array(COLUMN_COUNT).fill(-1));
        const sticky = GameData.instance.stickyCells;
        for (let i = 0; i < this.cellCount; i++) {
            const reel = Math.floor(i / this._rowCount);
            const row = i % this._rowCount;
            const key = `${reel}-${row}`;
            const result = this._pendingResults[i];
            const stickyCell = sticky.get(key);
            const reelController = this.reels[i];
            let symbolId = result?._symbolId;
            if (symbolId == null && stickyCell) symbolId = stickyCell.symbolId;
            if (symbolId == null && reelController) symbolId = reelController.getDebugMidSymbolId();
            grid[row][reel] = symbolId ?? -1;
        }
        return grid;
    }

    private _enrichResultForTopUpIndex(resultData: any, topUpIdx: number, serverIdx: number = -1, allowPlusOne: boolean = false): any {
        const source = resultData ?? {};
        const index = resultData?.Index ?? resultData?.index ?? 0;
        const win = resultData?.Win ?? resultData?.win ?? 0;
        const reel = this.reels[topUpIdx];
        const stripSymbolId = reel?.getSymbolAtIndex(index);
        const rawType = source?.Type ?? source?.type ?? TopupReelType.NONE;
        let type = rawType;
        let symbolId = this._topupTypeToSymbolId(rawType);

        // Only trust server Type for coins. Do NOT promote strip specials into coins.
        if (symbolId == null) {
            if (stripSymbolId === SymbolId.PLUS_ONE_SPIN) {
                // PLUS_ONE visual only if allowed, otherwise replace with non-bonus
                type = TopupReelType.NONE;
                symbolId = allowPlusOne ? SymbolId.PLUS_ONE_SPIN : this._fallbackNonBonusSymbol(reel);
            } else if (this._isTopUpSpecialSymbol(stripSymbolId)) {
                // Strip shows a special (RED/YELLOW/GREEN/GRAND) but server Type says NONE → force non-bonus visual
                type = TopupReelType.NONE;
                symbolId = this._fallbackNonBonusSymbol(reel);
            } else {
                // Normal symbol from strip
                symbolId = stripSymbolId;
            }
        }

        Log.e(
            `[TOPUP-PLUS] stopData topUpIdx=${topUpIdx} serverIdx=${serverIdx}` +
            ` type=${type} index=${index} win=${win}` +
            ` forced=${symbolId == null ? 'none' : (SymbolId[symbolId] ?? symbolId)}` +
            ` strip=${stripSymbolId == null ? 'none' : (SymbolId[stripSymbolId] ?? stripSymbolId)}` +
            ` allowPlusOne=${allowPlusOne ? 1 : 0}`
        );

        return {
            ...source,
            Type: type,
            type,
            Win: win,
            win,
            Index: index,
            index,
            _symbolId: symbolId,
            _stripSymbolId: stripSymbolId,
            _allowPlusOneVisual: allowPlusOne,
            _topUpIdx: topUpIdx,
        };
    }

    private _topupTypeToSymbolId(type: number): number | null {
        if (type === TopupReelType.RED) return SymbolId.STICKY_RED;
        if (type === TopupReelType.YELLOW) return SymbolId.STICKY_YELLOW;
        if (type === TopupReelType.GREEN) return SymbolId.STICKY_GREEN;
        if (type === TopupReelType.GRAND) return SymbolId.JP_GRAND;
        return null;
    }

    private _isTopUpSpecialSymbol(symbolId: number | undefined): boolean {
        return symbolId === SymbolId.STICKY_RED ||
            symbolId === SymbolId.STICKY_YELLOW ||
            symbolId === SymbolId.STICKY_GREEN ||
            symbolId === SymbolId.JP_GRAND ||
            symbolId === SymbolId.PLUS_ONE_SPIN;
    }

    private _fallbackNonBonusSymbol(reel: TopUpReelController | undefined): number | undefined {
        if (!reel) return undefined;
        for (let i = 0; i < 200; i++) {
            const symbolId = reel.getSymbolAtIndex(i);
            if (
                symbolId != null &&
                symbolId !== SymbolId.STICKY_RED &&
                symbolId !== SymbolId.STICKY_YELLOW &&
                symbolId !== SymbolId.STICKY_GREEN &&
                symbolId !== SymbolId.JP_GRAND &&
                symbolId !== SymbolId.PLUS_ONE_SPIN
            ) {
                return symbolId;
            }
        }
        return undefined;
    }
}
