/**
 * TopUpReelController — Điều khiển 1 lồng xoay đơn (1 cell trong grid 5×3 TopUp).
 *
 * ── NODE LAYOUT ──
 *   [0] Top   (visible — row 2)
 *   [1] Mid   (visible — row 1, payline center)
 *   [2] Bot   (visible — row 0)
 *
 * ── SPIN FLOW ──
 *   spin()     → bắt đầu cuộn xuống liên tục, random symbol khi wrap
 *   stop()     → tween về rest positions, gán đúng symbol tại Index, xử lý Lock
 */

import { _decorator, Color, Component, Node, Size, Sprite, SpriteFrame, tween, Vec3, Tween, Label, UIOpacity, UITransform } from 'cc';
import { Log } from '../core/Logger';
import { AutoSpinManager } from '../manager/AutoSpinManager';
import { SpriteNumber } from '../core/SpriteNumber';
import { SymbolId, TopupReelType } from '../data/SlotTypes';
import { GameData } from '../data/GameData';
import { MATSURI_CELL_SIZE } from '../data/MatsuriGridUtil';
import { SymbolView } from './SymbolView';

const { ccclass, property } = _decorator;

enum ReelState { IDLE, LAUNCHING, SPINNING, STOPPING }

/** Scale sticky vàng/xanh trên TopUpReel — StickyOverlay bắt đầu bounce từ giá trị này. */
export const TOPUP_STICKY_SYMBOL_SCALE = 0.85;

/** Ô reel = 130; symbol thường gói gọn trong 127×127. */
export const GRID_MINI_SYMBOL_SIZE = 127;
/** Đồng vàng / xanh — size cứng, khác symbol thường. */
export const GRID_MINI_COIN_SIZE = 200;
export const GRID_MINI_SYMBOL_SCALE = 1;

export function isGridMiniCoinSymbol(symbolId: number): boolean {
    return symbolId === SymbolId.STICKY_YELLOW || symbolId === SymbolId.STICKY_GREEN;
}

/** Fit sprite trong hình vuông max×max — giữ tỉ lệ, không ép vuông. */
export function fitSpriteFrameInSquare(frame: SpriteFrame, maxSize: number): Size {
    const ow = Math.max(1, frame.originalSize?.width ?? frame.width ?? maxSize);
    const oh = Math.max(1, frame.originalSize?.height ?? frame.height ?? maxSize);
    const scale = Math.min(maxSize / ow, maxSize / oh);
    return new Size(ow * scale, oh * scale);
}

/** Màu symbol thường khi reel đang quay (tối hơn để nổi bật sticky vàng/xanh). */
const DIM_SYMBOL_COLOR = new Color(0x40, 0x40, 0x40, 255);
const LIT_SYMBOL_COLOR = new Color(255, 255, 255, 255);

@ccclass('TopUpReelController')
export class TopUpReelController extends Component {

    @property({
        type: [Node],
        tooltip: '3 Node symbol: [0]=Top [1]=Mid [2]=Bot',
    })
    symbolNodes: Node[] = [];

    @property({ tooltip: 'Khoảng cách Y giữa tâm các symbol (pixels)' })
    symbolHeight: number = 150;

    @property({ tooltip: 'Auto-layout 3 nodes từ Mid (node[1])' })
    autoLayoutSymbols: boolean = false;

    @property({ tooltip: 'Tốc độ cuộn xuống khi spin (pixels/sec)' })
    spinSpeed: number = 1500;

    @property({ tooltip: 'Thời gian tween dừng về rest positions (giây)' })
    stopDuration: number = 0.4;

    @property({ tooltip: 'Thời gian quay tối thiểu trước khi bắt đầu dừng (giây). 0 = dừng ngay khi nhận lệnh.' })
    minSpinDuration: number = 0.5;

    @property({ tooltip: 'Chiều cao hạ thêm xuống khi reel dừng (nhân với symbolHeight). VD: 0.08 = hạ thêm 8% chiều cao symbol rồi snap về.' })
    stopBounceOvershootRatio: number = 0.08;

    @property({ tooltip: 'Thời gian snap lui về vị trí đích khi reel dừng (giây).' })
    stopBounceSettleDuration: number = 0.12;

    @property({ tooltip: 'Chiều cao nhảy lên khi bắt đầu spin (nhân với symbolHeight)' })
    launchBounceHeightRatio: number = 0.5;

    @property({ tooltip: 'Thời gian nhảy lên trong launch bounce (giây)' })
    launchBounceUpDuration: number = 0.12;

    @property({ tooltip: 'Thời gian rơi xuống trong launch bounce (giây)' })
    launchBounceDownDuration: number = 0.25;

    private _gridCellSize = MATSURI_CELL_SIZE;

    /** Được inject từ TopUpManager (lấy từ SlotMachineController) */
    symbolFrames: SpriteFrame[] = [];

    @property({
        type: [SpriteFrame],
        tooltip: 'Coin sprite frames: [0]=Red [1]=Yellow [2]=Green',
    })
    coinFrames: SpriteFrame[] = [];

    /** Trạng thái khóa — reel đã dừng ở ô có đồng xu thì không quay nữa */
    isLocked: boolean = false;

    /** Cập nhật kích thước ô grid (182 cho 5×3, 126 cho 5×4/5×5). */
    setGridCellSize(size: number): void {
        const cell = Math.max(1, Math.round(size));
        if (cell === this._gridCellSize && this.symbolHeight === cell) return;
        this._gridCellSize = cell;
        this.symbolHeight = cell;
        this._applyGridCellSymbolFit();
        if (this.symbolNodes.length === 3) {
            const mid = this.symbolNodes[1];
            const midX = mid?.position.x ?? 0;
            const midZ = mid?.position.z ?? 0;
            this.symbolNodes[0]?.setPosition(midX, cell, midZ);
            this.symbolNodes[1]?.setPosition(midX, 0, midZ);
            this.symbolNodes[2]?.setPosition(midX, -cell, midZ);
        }
        this._restY = this.symbolNodes.map(n => n.position.y);
        this._snapToRestPositions();
    }

    /** Reset reel về trạng thái ban đầu (dùng khi kết thúc TopUp / chuyển mode) */
    reset(): void {
        this.isLocked = false;
        this._state = ReelState.IDLE;
        this._pendingStop = null;
        this._debugMidSymbolId = -1;
        this._spinToken++;
        this.unscheduleAllCallbacks();
        this.node.active = true; // đảm bảo node chính được bật lại sau khi bị block
        // Reset rotation/skew về 0 để tránh méo/ẩn do transform còn sót
        this.node.setRotationFromEuler(0, 0, 0);
        for (const node of this.symbolNodes) {
            if (!node?.isValid) continue;
            Tween.stopAllByTarget(node);
            SymbolView.restoreLandBounceIfNeeded(node);
            node.getComponent(SymbolView)?.setSpriteVisible(true);
            // Xóa state blur/spinning còn giữ trong SymbolView từ feature trước.
            node.emit('spin-stop');
        }
        // Một nguồn reset duy nhất cho active/scale/rotation/UIOpacity/CreditLabel.
        this._showSymbolNodes();
        this._snapToRestPositions();
    }

    // ─── CALLBACK ───
    /** Gọi khi reel dừng hẳn (sau tween stop + snap symbol + lock check) */
    onStopComplete: ((reel: TopUpReelController) => void) | null = null;

    // ─── INTERNAL ───
    private _state: ReelState = ReelState.IDLE;
    private _strip: number[] = [];
    private _restY: number[] = [];
    private _logPrefix: string = '';
    private _spinStartTime: number = 0;
    private _pendingStop: { type: number, win: number, index: number, forcedMidSymbol?: number, debugTopUpIdx?: number, token: number } | null = null;
    private _spinToken: number = 0;
    private _debugMidSymbolId: number = -1;

    /** Hệ số tốc độ dựa trên speed mode (NORMAL=1, QUICK=0.8, TURBO=0.6) */
    private get _tm(): number {
        return AutoSpinManager.instance.getTimingMultiplier();
    }

    onLoad(): void {
        this._logPrefix = `[TopUpReel ${this.name}]`;
        this._applyGridCellSymbolFit();

        // Auto-layout: node[1] = Mid giữ Y, Top cao hơn, Bot thấp hơn
        if (this.autoLayoutSymbols && this.symbolNodes.length === 3) {
            const midPos = this.symbolNodes[1].position;
            const baseY = 0;
            const offsets = [1, 0, -1]; // Top → Mid → Bot
            for (let i = 0; i < 3; i++) {
                this.symbolNodes[i].setPosition(midPos.x, baseY + offsets[i] * this.symbolHeight, midPos.z);
            }
        }

        // Snapshot rest Y
        this._restY = this.symbolNodes.map(n => n.position.y);

        // Auto-detect symbolHeight từ gap giữa nodes
        if (this._restY.length >= 2) {
            const gaps: number[] = [];
            for (let i = 1; i < this._restY.length; i++) {
                gaps.push(Math.abs(this._restY[i - 1] - this._restY[i]));
            }
            const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
            if (avg > 1 && Math.abs(avg - this.symbolHeight) > 1) {
                Log.w(`${this._logPrefix} symbolHeight=${this.symbolHeight} → detected=${avg.toFixed(0)}, auto-correcting`);
                this.symbolHeight = avg;
            }
        }

        Log.d(`${this._logPrefix} onLoad — h=${this.symbolHeight} restY=[${this._restY.map(y=>y.toFixed(0)).join(',')}] nodes=${this.symbolNodes.length}`);
    }

    update(dt: number): void {
        if (this._state === ReelState.SPINNING) {
            this._scroll(dt);
        }
    }

    // ─── PUBLIC API ───

    /** Nhận mảng ID biểu tượng để render dải băng */
    setStripData(symbols: number[]): void {
        this._strip = Array.isArray(symbols) ? symbols.slice() : [];
        // Log.d(`${this._logPrefix} setStripData — ${symbols.length} symbols...`);
    }

    getSymbolAtIndex(index: number): number | undefined {
        const L = this._strip.length;
        if (L === 0) return undefined;
        return this._strip[((index % L) + L) % L];
    }

    getDebugMidSymbolId(): number {
        return this._debugMidSymbolId;
    }

    /** Bắt đầu chạy animation cuộn nếu reel chưa bị khóa */
    spin(): void {
        if (this.isLocked) { Log.d(`${this._logPrefix} spin skipped — locked`); return; }
        if (this._state !== ReelState.IDLE) { Log.d(`${this._logPrefix} spin skipped — state=${this._state}`); return; }

        this._state = ReelState.LAUNCHING;
        this._spinToken++;
        this.unscheduleAllCallbacks();
        this._spinStartTime = Date.now();
        Tween.stopAllByTarget(this.node);
        this.node.active = true;
        // Log.d(`${this._logPrefix} spin START...`);

        for (let i = 0; i < this.symbolNodes.length; i++) {
            Tween.stopAllByTarget(this.symbolNodes[i]);
            this.symbolNodes[i].active = true;
            this._randomizeSymbol(i);
        }

        // Bounce up then down → SPINNING
        const bounceH = this.symbolHeight * this.launchBounceHeightRatio;
        const upDur = this.launchBounceUpDuration * this._tm;
        const downDur = this.launchBounceDownDuration * this._tm;
        const launchNodes = this.symbolNodes.filter((n) => !!n);
        if (launchNodes.length === 0) {
            this._state = ReelState.SPINNING;
            return;
        }
        let done = 0;
        for (let i = 0; i < this.symbolNodes.length; i++) {
            const node = this.symbolNodes[i];
            if (!node) continue;
            const restY = this._restY[i] ?? node.position.y;
            tween(node)
                .to(upDur, { position: new Vec3(node.position.x, restY + bounceH, node.position.z) }, { easing: 'sineOut' })
                .to(downDur, { position: new Vec3(node.position.x, restY, node.position.z) }, { easing: 'sineIn' })
                .call(() => {
                    if (++done >= launchNodes.length) {
                        if (this._state === ReelState.LAUNCHING) {
                            this._state = ReelState.SPINNING;
                            if (this._pendingStop) {
                                const { type, win, index, forcedMidSymbol, debugTopUpIdx, token } = this._pendingStop;
                                this._pendingStop = null;
                                if (token !== this._spinToken) {
                                    Log.e(`[TOPUP-PLUS] ignore stale TopUpReel pending token=${token} current=${this._spinToken} topUpIdx=${debugTopUpIdx ?? 'n/a'}`);
                                    return;
                                }
                                this.stop({ type, win, index, _symbolId: forcedMidSymbol, _topUpIdx: debugTopUpIdx });
                            }
                        }
                    }
                })
                .start();
        }
    }

    /** Set symbols tĩnh tại centerIndex (dùng cho init khi vào TopUp) */
    setSymbols(centerIndex: number, forcedMidSymbol?: number): void {
        this._showSymbolNodes();
        // Top/Bot luôn bỏ sticky; Mid chỉ cho Sticky xanh khi forced (land).
        const syms = this._getSymbolsAt(centerIndex).map(sym =>
            this._sanitizeTopUpSymbol(sym, false),
        );
        if (forcedMidSymbol != null) {
            const allowSticky = forcedMidSymbol === SymbolId.STICKY_GREEN;
            syms[1] = this._sanitizeTopUpSymbol(forcedMidSymbol, allowSticky);
        }
        this._debugMidSymbolId = syms[1] ?? -1;
        for (let i = 0; i < this.symbolNodes.length; i++) {
            this._setSymbol(i, syms[i], true);
        }
        // Log.d(`${this._logPrefix} setSymbols center=${centerIndex}...`);
    }

    /** Đặt reel thành locked + hiển thị coin (dùng khi vào TopUp, reel đã có coin từ spin trước) */
    applyStickyResult(type: number, win: number): void {
        this._applyResult(type, win, 0);
    }

    blockInPlace(): void {
        this.isLocked = true;
        this.node.active = true;
        // ★ Khi locked: ẩn symbolNodes để StickyOverlay hiển thị coin thay thế
        for (const node of this.symbolNodes) {
            if (node) node.active = false;
        }
    }

    hideForOverlayResult(): void {
        // ★ Giữ node chính active để tính position, nhưng ẩn symbolNodes
        // để StickyOverlay hiển thị coin thay thế
        this.node.active = true;
        for (const node of this.symbolNodes) {
            if (node) node.active = false;
        }
    }

    /**
     * World-pos tâm ô (Mid restY) — không đọc mid.worldPosition.
     * Snap mid về rest trước khi convert, tránh lệch Y sau stop-bounce.
     */
    getMidRestWorldPosition(out: Vec3 = new Vec3()): Vec3 {
        const mid = this.symbolNodes[1];
        if (!mid) {
            this.node.updateWorldTransform();
            this.node.getWorldPosition(out);
            return out;
        }
        const restY = this._restY.length > 1 ? this._restY[1] : mid.position.y;
        // Snap local về rest (bỏ qua tween/overshoot còn sót)
        if (Math.abs(mid.position.y - restY) > 0.01) {
            mid.setPosition(mid.position.x, restY, mid.position.z);
        }
        const parent = mid.parent ?? this.node;
        parent.updateWorldTransform();
        const local = new Vec3(mid.position.x, restY, mid.position.z);
        Vec3.transformMat4(out, local, parent.worldMatrix);
        return out;
    }

    prepareFreeCellForSpin(): void {
        this.isLocked = false;
        if (this._state !== ReelState.IDLE) {
            this._state = ReelState.IDLE;
            this._pendingStop = null;
            this._spinToken++;
            this.unscheduleAllCallbacks();
            this._snapToRestPositions();
        }
        this._showSymbolNodes();
    }

    /**
     * Dừng animation cuộn tại Index.
     * @param resultData — object kết quả: { Type, Win, Index }
     *   Type = 0 (ô trống) → giữ isLocked = false
     *   Type > 0 (có đồng xu) → isLocked = true, hiển thị đồng xu + Win
     */
    stop(resultData: any): void {
        const type = resultData?.Type ?? resultData?.type ?? 0;
        const win = resultData?.Win ?? resultData?.win ?? 0;
        const index = resultData?.Index ?? resultData?.index ?? 0;
        const forcedMidSymbol = resultData?._symbolId ?? resultData?.symbolId;
        const debugTopUpIdx = resultData?._topUpIdx;
        const token = this._spinToken;
        // Log.d(`${this._logPrefix} stop — Type=${type}...`);

        if (this._state === ReelState.STOPPING) return;

        if (this._state === ReelState.LAUNCHING) {
            // 5×3→5×5: bounce tween trên hàng mới bật có thể không bao giờ .call()
            // → abort launch, vào SPINNING rồi stop luôn.
            this._pendingStop = null;
            this.unscheduleAllCallbacks();
            for (const node of this.symbolNodes) {
                if (node) Tween.stopAllByTarget(node);
            }
            this._snapToRestPositions();
            this._state = ReelState.SPINNING;
        }

        if (this._state !== ReelState.SPINNING) {
            this._snapToRestPositions();
            this.setSymbols(index, forcedMidSymbol);
            this._applyResult(type, win, index);
            this.onStopComplete?.(this);
            return;
        }

        // Đảm bảo quay ít nhất minSpinDuration giây
        const elapsed = (Date.now() - this._spinStartTime) / 1000;
        const remaining = this.minSpinDuration * this._tm - elapsed;
        if (remaining > 0) {
            Log.d(`${this._logPrefix} stop — delay ${remaining.toFixed(2)}s (chưa đủ minSpinDuration)`);
            this.scheduleOnce(() => {
                if (token !== this._spinToken) {
                    Log.e(`[TOPUP-PLUS] ignore stale TopUpReel stop token=${token} current=${this._spinToken}`);
                    return;
                }
                this._doStop(type, win, index, forcedMidSymbol, token, debugTopUpIdx);
            }, remaining);
            return;
        }

        this._doStop(type, win, index, forcedMidSymbol, token, debugTopUpIdx);
    }

    private _doStop(type: number, win: number, index: number, forcedMidSymbol?: number, token: number = this._spinToken, debugTopUpIdx?: number): void {
        if (token !== this._spinToken) {
            Log.e(`[TOPUP-PLUS] ignore stale TopUpReel _doStop token=${token} current=${this._spinToken}`);
            return;
        }
        if (this._state !== ReelState.SPINNING) return; // Có thể đã bị quick stop / force stop
        this._state = ReelState.STOPPING;

        // Build a deterministic landing: final symbols are assigned before the slow-down,
        // then the whole set starts one row above and eases down into its rest positions.
        this._prepareLandingToRest(index, forcedMidSymbol, debugTopUpIdx);

        const overshoot = this.symbolHeight * this.stopBounceOvershootRatio;
        const settleDur = this.stopBounceSettleDuration * this._tm;
        const nodes = this.symbolNodes.filter((n) => !!n);
        if (nodes.length === 0) {
            this._finishStop(type, win, index);
            return;
        }
        let completed = 0;
        for (const node of nodes) {
            const restY = this._restY[this.symbolNodes.indexOf(node)] ?? node.position.y;
            Tween.stopAllByTarget(node);
            tween(node)
                .to(
                    this.stopDuration * this._tm,
                    { position: new Vec3(node.position.x, restY - overshoot, node.position.z) },
                    { easing: 'cubicOut' }
                )
                .to(
                    settleDur,
                    { position: new Vec3(node.position.x, restY, node.position.z) },
                    { easing: 'backOut' }
                )
                .call(() => {
                    if (++completed >= nodes.length) {
                        if (token !== this._spinToken) {
                            Log.e(`[TOPUP-PLUS] ignore stale TopUpReel finish token=${token} current=${this._spinToken}`);
                            return;
                        }
                        this._finishStop(type, win, index);
                    }
                })
                .start();
        }
        const failsafe = (this.stopDuration + this.stopBounceSettleDuration) * this._tm + 0.15;
        this.scheduleOnce(() => {
            if (this._state === ReelState.STOPPING && token === this._spinToken) {
                this._finishStop(type, win, index);
            }
        }, failsafe);
    }

    // ─── INTERNAL ───

    /** Cuộn xuống liên tục — per-node wrap */
    private _scroll(dt: number): void {
        const delta = (this.spinSpeed / this._tm) * dt;
        const minRestY = Math.min(...this._restY);
        const maxRestY = Math.max(...this._restY);
        const totalRange = this.symbolHeight * 3;

        for (let i = 0; i < this.symbolNodes.length; i++) {
            const node = this.symbolNodes[i];
            let y = node.position.y - delta;

            // Wrap: nếu node vượt quá dưới bottom rest nửa symbolHeight
            if (y < minRestY - this.symbolHeight * 0.5) {
                y += totalRange;
                this._randomizeSymbol(i);
            }

            node.setPosition(node.position.x, y, node.position.z);
        }
    }

    private _randomizeSymbol(nodeIdx: number): void {
        if (this._strip.length === 0) return;
        const randIdx = Math.floor(Math.random() * this._strip.length);
        const symId = this._sanitizeTopUpSymbol(this._strip[randIdx]);
        this._setSymbol(nodeIdx, symId);
    }

    private _setSymbol(nodeIdx: number, symId: number, forceFinalSprite: boolean = false): void {
        const node = this.symbolNodes[nodeIdx];
        if (!node) return;
        this._applySymbolColor(node, symId);
        if (forceFinalSprite) {
            const view = node.getComponent(SymbolView);
            if (view) {
                view.setSymbol(symId);
            } else {
                node.emit('spin-stop');
                node.emit('symbol-changed', symId);
            }
        } else {
            node.emit('symbol-changed', symId);
        }
        // Sau SymbolView — fit trong 127×127, giữ tỉ lệ gốc (không ép vuông).
        this._applyStickyScale(node, symId);
        this._fitSymbolInCell(node, symId);
    }

    /** Scale node = 1; kích thước sprite do _fitSymbolInCell. */
    private _applyStickyScale(node: Node, _symId: number): void {
        const s = GRID_MINI_SYMBOL_SCALE;
        node.setScale(s, s, 1);
    }

    /** Symbol thường ≤127 (giữ tỉ lệ). Vàng/xanh = 200×200. */
    private _fitSymbolInCell(node: Node | null, symbolId?: number): void {
        if (!node) return;
        const sp = node.getComponent(Sprite);
        const ut = node.getComponent(UITransform);
        if (!sp || !ut) return;
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        const sid = symbolId
            ?? node.getComponent(SymbolView)?.symbolId
            ?? -1;
        if (isGridMiniCoinSymbol(sid)) {
            const coin = this._gridCoinFitSize();
            ut.setContentSize(coin, coin);
            return;
        }
        const frame = sp.spriteFrame;
        if (!frame) {
            const sym = this._gridSymbolFitSize();
            ut.setContentSize(sym, sym);
            return;
        }
        const fit = fitSpriteFrameInSquare(frame, this._gridSymbolFitSize());
        ut.setContentSize(fit.width, fit.height);
    }

    private _gridSymbolFitSize(): number {
        return Math.max(1, Math.round(this._gridCellSize * GRID_MINI_SYMBOL_SIZE / MATSURI_CELL_SIZE));
    }

    private _gridCoinFitSize(): number {
        return Math.max(1, Math.round(this._gridCellSize * GRID_MINI_COIN_SIZE / MATSURI_CELL_SIZE));
    }

    /** Ô / mask theo matsuriCellSize; symbol content giữ tỉ lệ baseline 130. */
    private _applyGridCellSymbolFit(): void {
        const cell = this._gridCellSize;
        const rootUt = this.node.getComponent(UITransform);
        if (rootUt) rootUt.setContentSize(cell, cell);

        const container = this.node.getChildByName('ReelContainer');
        const containerUt = container?.getComponent(UITransform);
        if (containerUt) containerUt.setContentSize(cell, cell);

        const mask = container?.getChildByName('Mask') ?? this.node.getChildByName('Mask');
        const maskUt = mask?.getComponent(UITransform);
        if (maskUt) maskUt.setContentSize(cell, cell);

        for (const node of this.symbolNodes) {
            if (!node) continue;
            const view = node.getComponent(SymbolView);
            if (view) view.defaultScale = GRID_MINI_SYMBOL_SCALE;
            this._fitSymbolInCell(node);
            node.setScale(GRID_MINI_SYMBOL_SCALE, GRID_MINI_SYMBOL_SCALE, 1);
        }
    }

    /** Lấy 3 symbol từ strip tại centerIndex theo visual normal reel — [visualTop, mid, visualBot]. */
    private _getSymbolsAt(centerIndex: number): number[] {
        const L = this._strip.length;
        if (L === 0) return [0, 0, 0];
        const mid = ((centerIndex % L) + L) % L;
        const top = (mid + 1) % L;
        const bot = ((mid - 1) % L + L) % L;
        return [this._strip[top], this._strip[mid], this._strip[bot]];
    }

    private _finishStop(type: number, win: number, index: number): void {
        if (this._state === ReelState.IDLE) return;
        this._state = ReelState.IDLE;
        this._pendingStop = null;

        // Symbols were already assigned before landing; only normalize transform state.
        this._snapToRestPositions();
        this._applyResult(type, win, index);
        this.onStopComplete?.(this);
    }

    private _prepareLandingToRest(centerIndex: number, forcedMidSymbol?: number, debugTopUpIdx?: number): void {
        this.setSymbols(centerIndex, forcedMidSymbol);
        if (debugTopUpIdx != null) {
            const syms = this._getSymbolsAt(centerIndex).map(sym => this._sanitizeTopUpSymbol(sym));
            if (forcedMidSymbol != null) syms[1] = this._sanitizeTopUpSymbol(forcedMidSymbol);
            Log.e(
                `[TOPUP-PLUS] renderLanding topUpIdx=${debugTopUpIdx}` +
                ` centerIndex=${centerIndex} top=${SymbolId[syms[0]] ?? syms[0]}` +
                ` mid=${SymbolId[syms[1]] ?? syms[1]}` +
                ` bot=${SymbolId[syms[2]] ?? syms[2]}`
            );
        }
        for (let i = 0; i < this.symbolNodes.length; i++) {
            const node = this.symbolNodes[i];
            if (!node) continue;
            const restY = this._restY[i] ?? node.position.y;
            node.setPosition(node.position.x, restY + this.symbolHeight, node.position.z);
        }
    }

    private _snapToRestPositions(): void {
        for (let i = 0; i < this.symbolNodes.length; i++) {
            const node = this.symbolNodes[i];
            if (!node) continue;
            const restY = this._restY[i] ?? node.position.y;
            node.setPosition(node.position.x, restY, node.position.z);
        }
    }

    /**
     * Carnival: chỉ Sticky XANH sáng trắng trên reel.
     * Symbol thường + Sticky vàng (nếu lỡ hiện) → tối.
     */
    private _applySymbolColor(node: Node | null | undefined, symId: number): void {
        if (!node) return;
        const color = (symId === SymbolId.STICKY_GREEN)
            ? LIT_SYMBOL_COLOR
            : DIM_SYMBOL_COLOR;

        const sprites = node.getComponentsInChildren(Sprite);
        for (const sprite of sprites) {
            sprite.color = color;
        }
    }

    /**
     * Carnival: không để Sticky vàng/xanh nằm sẵn trên reel filler.
     * Green chỉ hiện khi result force mid (land) — truyền allowStickyVisual=true.
     */
    private _sanitizeTopUpSymbol(
        symId: number,
        allowStickyVisual: boolean = false,
    ): number {
        if (!allowStickyVisual
            && (symId === SymbolId.STICKY_YELLOW
                || symId === SymbolId.STICKY_GREEN
                || symId === SymbolId.JP_GRAND)) {
            return this._fallbackNonBonusSymbol() ?? SymbolId.MAJOR_CLEOPATRA;
        }
        return symId;
    }

    private _fallbackNonBonusSymbol(): number | undefined {
        for (const symbolId of this._strip) {
            if (
                symbolId !== SymbolId.STICKY_YELLOW &&
                symbolId !== SymbolId.STICKY_GREEN &&
                symbolId !== SymbolId.JP_GRAND
            ) {
                return symbolId;
            }
        }
        return undefined;
    }

    private _showSymbolNodes(): void {
        this.node.active = true;
        for (const node of this.symbolNodes) {
            if (!node) continue;
            node.active = true;
            node.setScale(GRID_MINI_SYMBOL_SCALE, GRID_MINI_SYMBOL_SCALE, 1);
            node.setRotationFromEuler(0, 0, 0);
            const opacity = node.getComponent(UIOpacity);
            if (opacity) {
                Tween.stopAllByTarget(opacity);
                opacity.opacity = 255;
            }

            const credit = node.getChildByName('CreditLabel');
            if (credit) {
                Tween.stopAllByTarget(credit);
                credit.active = false;
                credit.setScale(1, 1, 1);
                credit.setRotationFromEuler(0, 0, 0);
            }
        }
    }

    private _applyResult(type: number, win: number, midSymbolIndex: number): void {
        // ★ Lock reel: giữ node chính active để container còn tính position.
        // TopUp vàng/xanh: giữ Mid sticky visible dưới overlay (overlay bounce phủ lên).
        // Matsuri: luôn ẩn Mid — chỉ StickyOverlay hiện Gold (tránh Green còn sót + lệch vị trí).
        // Đỏ / khác: ẩn ngay, overlay thay thế.
        this.isLocked = type > 0;
        this.node.active = true;
        if (this.isLocked) {
            const isMatsuri = GameData.instance.currentMode === 'matsuri';
            const keepStickyMid =
                !isMatsuri &&
                (type === TopupReelType.YELLOW || type === TopupReelType.GREEN);
            for (let i = 0; i < this.symbolNodes.length; i++) {
                const node = this.symbolNodes[i];
                if (!node) continue;
                node.active = keepStickyMid && i === 1;
            }
        } else {
            for (const node of this.symbolNodes) {
                if (node) node.active = true;
            }
        }
    }

    /** Hiển thị đồng xu ở node Mid + số tiền */
    private _showCoin(coinType: number, win: number): void {
        const frameIdx = coinType - 1; // Type 1→0 (Red), 2→1 (Yellow), 3→2 (Green)
        const midNode = this.symbolNodes[1];

        if (midNode) {
            const sprite = midNode.getComponent(Sprite);
            let frame = (frameIdx >= 0 && frameIdx < this.coinFrames.length)
                ? this.coinFrames[frameIdx]
                : null;
            if (!frame) {
                const sid = coinType === TopupReelType.GREEN
                    ? SymbolId.STICKY_GREEN
                    : SymbolId.STICKY_YELLOW;
                frame = this.symbolFrames[sid] ?? null;
            }
            if (sprite && frame) {
                sprite.spriteFrame = frame;
                const sid = coinType === TopupReelType.GREEN
                    ? SymbolId.STICKY_GREEN
                    : SymbolId.STICKY_YELLOW;
                this._fitSymbolInCell(midNode, sid);
            }
        }

        // Credit label (child node "CreditLabel")
        // Chỉ hiện khi win > 0; win = 0 → ẩn (không vẽ số 0)
        if (midNode) {
            const creditNode = midNode.getChildByName('CreditLabel');
            if (creditNode) {
                Log.e(`[TURC-LABEL] _showCoin ${midNode.name} win=${win} active→${win > 0} (was=${creditNode.active})`);
                creditNode.active = win > 0;
                if (win > 0) {
                    const sn = creditNode.getComponent(SpriteNumber);
                    if (sn) {
                        sn.setData(win, -1, 0, true);
                    } else {
                        const lbl = creditNode.getComponent(Label);
                        if (lbl) lbl.string = win.toString();
                    }
                }
            }
        }
    }

    private _hideCoin(): void {
        const midNode = this.symbolNodes[1];
        if (!midNode) return;
        const creditNode = midNode.getChildByName('CreditLabel');
        if (creditNode) creditNode.active = false;
    }
}
