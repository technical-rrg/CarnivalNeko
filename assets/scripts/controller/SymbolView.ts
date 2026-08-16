/**
 * SymbolView - Component gắn vào mỗi Symbol Node (ExtraTop1..ExtraBot1).
 *
 * ─── BINDING TRONG EDITOR ───
 * KHÔNG cần kéo ảnh vào từng SymbolView.
 * Chỉ kéo 1 lần vào SlotMachineController → symbolFrames / blurFrames.
 * SlotMachineController.start() tự phân phối xuống tất cả SymbolView.
 *
 * ─── TÊN FILE ẢNH (riêng lẻ, theo PS ID) ───
 *   assets/bundle/newTextures/symbols/reel/ps_01..ps_06, ps_11..ps_15, ps_21, ps_41..ps_43
 *   assets/bundle/newTextures/symbols/pickgame/ps_81..ps_86
 * Trong Editor: kéo vào SlotMachineController.symbolFrames theo Client SymbolId index.
 */

import { _decorator, Component, Sprite, SpriteFrame, Label, LabelOutline, Color, Node, Tween, tween, Vec3, instantiate } from 'cc';
import { SymbolId } from '../data/SlotTypes';
import { SpriteNumber } from '../core/SpriteNumber';
import { GameData } from '../data/GameData';
import { Log } from '../core/Logger';
import { AutoSpinManager } from '../manager/AutoSpinManager';
import { SoundManager } from '../manager/SoundManager';

const { ccclass, property } = _decorator;

const SYMBOL_FRAME_KEYS: Record<number, string> = {
    [SymbolId.MINOR_9]: '0_ps_01',
    [SymbolId.MINOR_10]: '1_ps_02',
    [SymbolId.MINOR_J]: '2_ps_03',
    [SymbolId.MINOR_Q]: '3_ps_04',
    [SymbolId.MINOR_K]: '4_ps_05',
    [SymbolId.MINOR_A]: '5_ps_06',
    [SymbolId.MAJOR_HORUS]: '6_ps_11',
    [SymbolId.MAJOR_ANUBIS]: '7_ps_12',
    [SymbolId.MAJOR_SOBEK]: '8_ps_13',
    [SymbolId.MAJOR_RAMSES]: '9_ps_14',
    [SymbolId.MAJOR_CLEOPATRA]: '10_ps_15',
    [SymbolId.WILD]: '11_ps_21',
    [SymbolId.STICKY_YELLOW]: '13_ps_45',
    [SymbolId.STICKY_GREEN]: '14_ps_44',
    // Carnival Trail
    [SymbolId.TRAIL_NORMAL]: '21_trail_normal',
    [SymbolId.TRAIL_BLUE]: '22_ps_41',
    [SymbolId.TRAIL_RED]: '23_ps_43',
    [SymbolId.TRAIL_GREEN]: '24_ps_42',
    // Pick Game
    [SymbolId.JP_IDLE]: '16_ps_81',
    [SymbolId.JP_MINI]: '17_ps_85',
    [SymbolId.JP_MINOR]: '18_ps_84',
    [SymbolId.JP_MAJOR]: '19_ps_83',
    [SymbolId.JP_GRAND]: '20_ps_82',
    [SymbolId.JP_UPGRADE]: '25_ps_86',
};

/** Fallback frame keys khi chưa gắn art Trail. */
const SYMBOL_FRAME_FALLBACKS: Record<number, string[]> = {
    [SymbolId.TRAIL_NORMAL]: ['21_trail_normal'],
    [SymbolId.TRAIL_BLUE]: ['22_ps_41'],
    [SymbolId.TRAIL_RED]: ['23_ps_43'],
    [SymbolId.TRAIL_GREEN]: ['24_ps_42'],
};

/** Hoisted — tránh tạo mảng mới mỗi lần wrap symbol khi reel đang quay. */
function isStickySymbol(symbolId: number): boolean {
    return symbolId === SymbolId.STICKY_YELLOW
        || symbolId === SymbolId.STICKY_GREEN;
}

@ccclass('SymbolView')
export class SymbolView extends Component {

    // Được gán từ SlotMachineController._distributeFramesToSymbolViews() — KHÔNG kéo tay trong Editor.
    symbolFrames: SpriteFrame[] = [];
    blurFrames: SpriteFrame[] = [];

    @property({ tooltip: 'Scale mặc định của symbol (base scale). Dùng cho cả win zoom effect.' })
    defaultScale: number = 1;

    /** Scale gốc cho symbol nằm ngoài vùng view (ExtraTop1 / ExtraBot1) — tránh mép lấn vào reel. */
    static readonly OUTSIDE_REEL_SCALE = 0.8;

    /**
     * Base scale hiệu lực theo vị trí ô hiện tại (hoặc symbolId truyền vào — giữ tương thích).
     * ExtraTop1 / ExtraBot1 (rowIndex < 0) → 0.8;
     * Top / Mid / Bot và mặc định → defaultScale (1).
     */
    getBaseScale(_forSymbolId?: number): number {
        if (this.rowIndex < 0) {
            return SymbolView.OUTSIDE_REEL_SCALE;
        }
        return this.defaultScale;
    }

    @property({
        tooltip: 'Tên debug (tự động cập nhật trong Editor khi symbolId thay đổi)',
        readonly: true,
    })
    currentSymbolName: string = '-';

    // SpriteNumber được inject từ SlotMachineController.creditLabelPrefab — KHÔNG kéo tay trong Editor.
    SpriteNumber: SpriteNumber | null = null;

    /** Gán bởi SlotMachineController — reel này thuộc cột nào (0-based). */
    reelIndex: number = -1;
    /** Gán bởi SlotMachineController — hàng logical (0=top, 1=mid, 2=bot). -1 = ngoài lưới. */
    rowIndex: number = -1;

    /** Node để reparent symbol trong lúc land bounce (WaysPayDisplay node) — vẽ chồng lên tất cả. */
    static landBounceParent: Node | null = null;
    /** Track các symbol node đang trong land bounce để restore khi bị interrupt */
    private static _pendingLandBounces: Map<Node, { origParent: Node | null; origLocalPos: Vec3 }> = new Map();
    /** Land bounce clone trên WaysPayDisplay (symbolNode gốc → clone) — symbol gốc không reparent */
    private static _landBounceClones: Map<Node, Node> = new Map();
    /** Prefix tên node clone land-bounce — dùng để nhận diện orphan khi map bị lệch. */
    private static readonly LAND_BOUNCE_CLONE_PREFIX = '__LBClone_';

    /** Thời lượng 1 lần land bounce (grow + hold + shrink), đã nhân speed mode. */
    static getLandBounceDuration(): number {
        const m = AutoSpinManager.instance?.getTimingMultiplier?.() ?? 1;
        // Khớp _playLandBounce: grow 0.08 + hold 0.12 + shrink 0.32
        return (0.08 + 0.12 + 0.32) * m;
    }

    private static _destroyLandBounceClone(symbolNode: Node): void {
        const clone = SymbolView._landBounceClones.get(symbolNode);
        SymbolView._landBounceClones.delete(symbolNode);
        if (clone?.isValid) {
            Tween.stopAllByTarget(clone);
            // removeFromParent ngay — destroy() của Cocos chỉ dọn cuối frame
            if (clone.parent) clone.removeFromParent();
            clone.destroy();
        }
        // Hiện lại sprite symbol gốc trên reel
        if (symbolNode?.isValid) {
            symbolNode.getComponent(SymbolView)?.setSpriteVisible(true);
        }
    }

    /** Destroy node clone orphan trên WaysPayDisplay (không đụng symbol reel thật). */
    private static _destroyOrphanCloneNode(node: Node): void {
        if (!node?.isValid) return;
        Tween.stopAllByTarget(node);
        let origSymbol: Node | null = null;
        for (const [symNode, clone] of SymbolView._landBounceClones) {
            if (clone === node) {
                origSymbol = symNode;
                SymbolView._landBounceClones.delete(symNode);
                break;
            }
        }
        if (node.parent) node.removeFromParent();
        node.destroy();
        if (origSymbol?.isValid) {
            origSymbol.getComponent(SymbolView)?.setSpriteVisible(true);
        }
    }

    // ─── INTERNAL ───

    private _sprite: Sprite | null = null;
    /** Cache getComponentsInChildren(Sprite) — tránh cấp phát mảng mỗi lần setSpriteVisible. */
    private _sprites: Sprite[] = [];
    private _currentSymbolId: number = -1;
    private _isSpinning: boolean = false;
    private _debugLabel: Label | null = null;
    private _pendingLandBounce: boolean = false;
    private _landBouncePlayed: boolean = false;
    /** Tăng mỗi lần bounce mới / bị interrupt — hủy finishBounce & scheduleOnce cũ. */
    private _landBounceGen: number = 0;
    /** true khi land-bounce đang chạy (kể cả bounce trên node gốc, không clone). */
    private _landBounceInFlight: boolean = false;
    /** Parent reel cố định — không đổi khi reparent tạm sang WaysPayDisplay */
    private _reelHomeParent: Node | null = null;
    private _reelHomeLocalPos: Vec3 = new Vec3();
    /** Cache kết quả _resolveSymbolFrame theo symbolId (invalidate khi đổi symbolFrames). */
    private _resolvedFrameCache: Map<number, SpriteFrame | null> = new Map();
    private _frameCacheSource: SpriteFrame[] | null = null;

    /** Cache parent reel + local pos (chỉ khi node đang nằm trên reel, không phải WaysPayDisplay). */
    private _ensureReelHomeCached(): void {
        const top = SymbolView.landBounceParent;
        const p = this.node.parent;
        if (!p?.isValid) return;
        if (top && p === top) return;
        this._reelHomeParent = p;
        this._reelHomeLocalPos = this.node.position.clone();
    }

    /** Đăng ký symbol node đang bị reparent sang top layer (dùng bởi effect ngoài SymbolView) */
    public static registerLandBounce(node: Node, origParent: Node | null, origLocalPos?: Vec3): void {
        SymbolView._pendingLandBounces.set(node, {
            origParent,
            origLocalPos: origLocalPos?.clone() ?? node.position.clone(),
        });
    }
    /** Hủy đăng ký khi symbol node đã tự restore về parent gốc */
    public static unregisterLandBounce(node: Node): void {
        SymbolView._pendingLandBounces.delete(node);
    }
    /** Force-restore tất cả symbol node đang trong land bounce về parent gốc */
    public static restoreAllLandBounces(): void {
        for (const symNode of SymbolView._landBounceClones.keys()) {
            SymbolView._destroyLandBounceClone(symNode);
        }
        for (const [node, data] of SymbolView._pendingLandBounces) {
            if (node?.isValid && data.origParent && data.origParent.isValid) {
                Tween.stopAllByTarget(node);
                SymbolView.restoreToReelParent(node, data.origParent, data.origLocalPos);
                const base = node.getComponent(SymbolView)?.getBaseScale() ?? 1;
                node.setScale(base, base, 1);
            }
        }
        SymbolView._pendingLandBounces.clear();
        SymbolView._landBounceClones.clear();
    }

    /** Restore 1 node đang land-bounce (nếu có) — dừng clone hoặc kéo symbol về reel. */
    public static restoreLandBounceIfNeeded(node: Node): void {
        const view = node?.isValid ? node.getComponent(SymbolView) : null;
        const hadLandClone = SymbolView._landBounceClones.has(node);

        if (view) view._invalidateLandBounce();

        if (hadLandClone) {
            SymbolView._destroyLandBounceClone(node);
        }

        const data = SymbolView._pendingLandBounces.get(node);
        if (data) {
            SymbolView._pendingLandBounces.delete(node);
            if (node?.isValid) {
                const top = SymbolView.landBounceParent;
                const origParent = (data.origParent?.isValid && data.origParent !== top)
                    ? data.origParent
                    : view?._reelHomeParent ?? null;
                const origLocalPos = (origParent && origParent === view?._reelHomeParent)
                    ? view!._reelHomeLocalPos
                    : data.origLocalPos;
                if (origParent?.isValid) {
                    Tween.stopAllByTarget(node);
                    SymbolView.restoreToReelParent(node, origParent, origLocalPos);
                    const base = view?.getBaseScale() ?? 1;
                    node.setScale(base, base, 1);
                }
            }
        } else if (node?.isValid && SymbolView.landBounceParent && node.parent === SymbolView.landBounceParent) {
            SymbolView.restoreToReelHome(node);
            return;
        }

        if (node?.isValid) {
            Tween.stopAllByTarget(node);
            const base = view?.getBaseScale() ?? 1;
            node.setScale(base, base, 1);
        }
    }

    /** Hủy callback/tween land-bounce đang chạy trên instance này. */
    private _invalidateLandBounce(): void {
        this._landBounceGen++;
        this._landBounceInFlight = false;
        if (this.node?.isValid) Tween.stopAllByTarget(this.node);
    }

    /**
     * Quét WaysPayDisplay — xóa land-bounce clone + kéo symbol reel thật về parent gốc.
     * Chỉ DESTROY clone land-bounce (tracked/tagged). Không đụng highlight clone.
     * Symbol reel thật bị reparent → RESTORE về _reelHomeParent.
     */
    public static restoreAllOrphansOnLandBounceParent(): void {
        const top = SymbolView.landBounceParent;
        if (!top?.isValid) return;

        for (const symNode of [...SymbolView._landBounceClones.keys()]) {
            SymbolView._destroyLandBounceClone(symNode);
        }

        for (const child of [...top.children]) {
            if (!child?.isValid) continue;

            // Clone land-bounce còn sót (map lệch / destroy defer) → DESTROY ngay
            if (SymbolView._isOrphanLandBounceClone(child)) {
                Log.e(`[LB-DEBUG] DESTROY orphan land-bounce clone name=${child.name}`);
                SymbolView._destroyOrphanCloneNode(child);
                continue;
            }

            const view = child.getComponent(SymbolView);
            if (!view) continue;

            // Highlight clone (reel vẫn còn symbol gốc) — không đụng
            if (SymbolView._isHighlightCloneNode(child)) continue;

            // Symbol reel thật đang kẹt trên WaysPayDisplay → kéo về parent gốc
            if (view._reelHomeParent?.isValid && child.parent !== view._reelHomeParent) {
                Log.e(
                    `[LB-DEBUG] RESTORE real symbol r${view.reelIndex}row${view.rowIndex} ` +
                    `sid=${view.symbolId} → parent=${view._reelHomeParent.name}`
                );
                SymbolView.restoreToReelHome(child);
            }
        }
    }

    private static _isLandBounceCloneNode(node: Node): boolean {
        for (const clone of SymbolView._landBounceClones.values()) {
            if (clone === node) return true;
        }
        return false;
    }

    /** Clone land-bounce: tracked trong map HOẶC mang prefix tên. */
    private static _isOrphanLandBounceClone(node: Node): boolean {
        if (SymbolView._isLandBounceCloneNode(node)) return true;
        return !!node?.name?.startsWith(SymbolView.LAND_BOUNCE_CLONE_PREFIX);
    }

    /** Restore node về reel home đã cache. Trả false nếu skip (clone / đã ở reel). */
    public static restoreToReelHome(node: Node): boolean {
        if (!node?.isValid) return false;

        // Land-bounce clone → destroy (không kéo về reel, tránh duplicate)
        if (SymbolView._isOrphanLandBounceClone(node)) {
            SymbolView._destroyOrphanCloneNode(node);
            return true;
        }

        const view = node.getComponent(SymbolView);
        if (!view?._reelHomeParent?.isValid) return false;
        if (node.parent === view._reelHomeParent) return false;
        // Highlight clone: reel vẫn còn symbol gốc → bỏ qua
        if (SymbolView._isHighlightCloneNode(node)) return false;

        Tween.stopAllByTarget(node);
        SymbolView.restoreToReelParent(node, view._reelHomeParent, view._reelHomeLocalPos);
        const base = view.getBaseScale();
        node.setScale(base, base, 1);
        SymbolView._pendingLandBounces.delete(node);
        return true;
    }

    /** Node trên WaysPayDisplay là clone nếu reel home vẫn còn symbol khác cùng reel/row. */
    private static _isHighlightCloneNode(node: Node): boolean {
        const view = node.getComponent(SymbolView);
        if (!view?._reelHomeParent?.isValid || view.rowIndex < 0) return false;
        for (const child of view._reelHomeParent.children) {
            if (child === node || !child.isValid) continue;
            const other = child.getComponent(SymbolView);
            if (other && other.reelIndex === view.reelIndex && other.rowIndex === view.rowIndex) {
                return true;
            }
        }
        return false;
    }

    /** Đặt node lên trên cùng trong parent — symbol bounce xong sau sẽ đè lên các symbol khác. */
    public static placeOnTopInParent(node: Node, parent: Node): void {
        if (!node?.isValid || !parent?.isValid || node.parent !== parent) return;
        node.setSiblingIndex(parent.children.length - 1);
    }

    /**
     * Restore symbol node về reel parent sau reparent zoom/bounce.
     * Snap localX=0, giữ localY/Z trước khi tách khỏi parent.
     */
    public static restoreToReelParent(node: Node, parent: Node, origLocalPos: Vec3): void {
        if (!node?.isValid || !parent?.isValid) return;
        if (node.parent !== parent) {
            node.setParent(parent, false);
        }
        node.setPosition(0, origLocalPos.y, origLocalPos.z);
        SymbolView.placeOnTopInParent(node, parent);
    }

    /** PS ID name helper — removed (GoF không dùng PS schema cũ) */

    // ─── LIFECYCLE ───

    onLoad(): void {
        this._sprite = this.getComponent(Sprite) ?? this.getComponentInChildren(Sprite);
        this._sprites = this.node.getComponentsInChildren(Sprite);
       // this._createDebugLabel();

        // Áp dụng base scale (ngoài view ExtraTop/ExtraBot = 0.8)
        const s0 = this.getBaseScale();
        this.node.setScale(s0, s0, 1);
        this._ensureReelHomeCached();

        // Ẩn credit label ban đầu
        if (this.SpriteNumber) this.SpriteNumber.node.active = false;

        // Lắng nghe event từ ReelController
        this.node.on('symbol-changed', this._onSymbolChanged, this);
        this.node.on('spin-start', this._onSpinStart, this);
        this.node.on('spin-fast',  this._onSpinFast,  this);
        this.node.on('spin-stop',  this._onSpinStop,  this);
        this.node.on('reel-settled', this._onReelSettled, this);
        this.node.on('sticky-result-landed', this._onStickyResultLanded, this);
    }

    onDestroy(): void {
        this.node.off('symbol-changed', this._onSymbolChanged, this);
        this.node.off('spin-start', this._onSpinStart, this);
        this.node.off('spin-fast',  this._onSpinFast,  this);
        this.node.off('spin-stop',  this._onSpinStop,  this);
        this.node.off('reel-settled', this._onReelSettled, this);
        this.node.off('sticky-result-landed', this._onStickyResultLanded, this);
    }

    // ─── PUBLIC API ───

    /** Symbol ID hiện tại đang hiển thị (-1 = trống) */
    get symbolId(): number { return this._currentSymbolId; }

    /** Hiển thị symbol theo ID (0-8), hoặc -1 = ô trống (blank) */
    setSymbol(symbolId: number): void {
        this._currentSymbolId = symbolId;
        this._isSpinning = false;
        this._pendingLandBounce = false;
        this._landBouncePlayed = false;
        // Reset scale về base (ngoài view ExtraTop/ExtraBot = 0.8) và dừng tween cũ — tránh scale dang dở khi đổi symbol
        Tween.stopAllByTarget(this.node);
        if (SymbolView.landBounceParent && this.node.parent === SymbolView.landBounceParent) {
            SymbolView.restoreToReelHome(this.node);
        }
        const base = this.getBaseScale(symbolId);
        this.node.setScale(base, base, 1);
        // Reset rotation tuyệt đối để tránh bị nghiêng méo do kế thừa từ parent hoặc lần trước
        this.node.setRotationFromEuler(0, 0, 0);
        // Ẩn tất cả CreditLabel (SpriteNumber) trong symbol node — đảm bảo symbol thường ko lộ credit
        for (const sn of this.node.getComponentsInChildren(SpriteNumber)) {
            sn.node.active = false;
        }
        // Reset sprite visible khi symbol được recycle (ra khỏi mask rồi quay lại)
        this.setSpriteVisible(true);

        // [DIAG] Log mọi call cho visible cells - TẮT trong production để tối ưu
        // if (DEBUG && this.rowIndex >= 0 && this.reelIndex >= 0) {
        //     const frameName = (this.symbolFrames[symbolId] as any)?._uuid ?? this.symbolFrames[symbolId]?.name ?? 'null';
        //     Log.d(`[SV-CALL] r${this.reelIndex}row${this.rowIndex} id=${symbolId}(${SymbolId[symbolId] ?? '?'}) framesLen=${this.symbolFrames.length} frame=${frameName}`);
        // }

        // Nếu là sticky coin → luôn hiện credit label (active true) và gán đúng giá trị
        // ★ TopUp mode: background reel KHÔNG hiện credit/bounce — StickyOverlay đã xử lý
        if (isStickySymbol(symbolId) && this.reelIndex >= 0 && this.rowIndex >= 0
            && GameData.instance.currentMode !== 'respin') {
            const _key = `${this.reelIndex}-${this.rowIndex}`;
            const cell = GameData.instance.stickyCells.get(_key);
            // Luôn active true, gán credit từ cell hoặc 0 nếu chưa có data
            const creditValue = cell && cell.symbolId === symbolId ? cell.credit : 0;
            this.showCredit(creditValue);
            this._pendingLandBounce = !this._landBouncePlayed;
        } else {
            if (this.SpriteNumber) this.SpriteNumber.node.active = false;
        }

        // Empty slot (-1): xóa sprite, ẩn ô đi
        if (symbolId < 0) {
            this._syncSymbolDebugName(symbolId);
            this._applySpriteFrame(null);
            this._updateDebugOverlay();
            return;
        }

        this._syncSymbolDebugName(symbolId);

        const frame = this._resolveSymbolFrame(symbolId);
        if (!frame) {
            // Log removed for performance
            // Xóa sprite cũ — tránh sprite từ symbol trước bị lộ (stale sprite)
            this._applySpriteFrame(null);
            return;
        }

        this._applySpriteFrame(frame);
        this._updateDebugOverlay();
    }

    /** Hiển thị blur tương ứng với symbolId hiện tại khi reel đang quay */
    showBlur(): void {
        this._isSpinning = true;
        if (!this._sprite) return;
        const blurFrame = this.blurFrames[this._currentSymbolId] ?? this.blurFrames[0] ?? null;
        if (blurFrame) {
            this._applySpriteFrame(blurFrame);
        }
    }

    private _resolveSymbolFrame(symbolId: number): SpriteFrame | null {
        if (this._frameCacheSource !== this.symbolFrames) {
            this._resolvedFrameCache.clear();
            this._frameCacheSource = this.symbolFrames;
        }
        if (this._resolvedFrameCache.has(symbolId)) {
            return this._resolvedFrameCache.get(symbolId)!;
        }

        const expectedKey = SYMBOL_FRAME_KEYS[symbolId];
        const indexedFrame = this.symbolFrames[symbolId] ?? null;
        let resolved: SpriteFrame | null = indexedFrame;
        if (expectedKey) {
            if (this._frameMatches(indexedFrame, expectedKey)) {
                resolved = indexedFrame;
            } else {
                resolved = this.symbolFrames.find(frame => this._frameMatches(frame, expectedKey)) ?? indexedFrame;
            }
        }
        if (!resolved) {
            const fallbacks = SYMBOL_FRAME_FALLBACKS[symbolId];
            if (fallbacks) {
                for (const key of fallbacks) {
                    const found = this.symbolFrames.find(frame => this._frameMatches(frame, key));
                    if (found) {
                        resolved = found;
                        break;
                    }
                }
            }
        }
        this._resolvedFrameCache.set(symbolId, resolved);
        return resolved;
    }

    private _frameMatches(frame: SpriteFrame | null, expectedKey: string): boolean {
        if (!frame) return false;
        const name = frame.name;
        if (!name) return false;
        // indexOf tránh toLowerCase() cấp phát chuỗi mỗi lần resolve
        const lowerKey = expectedKey; // keys đã lowercase
        const n = name.length;
        const k = lowerKey.length;
        if (k === 0 || n < k) return false;
        // So khớp case-insensitive không tạo string mới
        for (let i = 0; i <= n - k; i++) {
            let ok = true;
            for (let j = 0; j < k; j++) {
                const a = name.charCodeAt(i + j);
                const b = lowerKey.charCodeAt(j);
                const al = a >= 65 && a <= 90 ? a + 32 : a;
                if (al !== b) { ok = false; break; }
            }
            if (ok) return true;
        }
        return false;
    }

    private _applySpriteFrame(frame: SpriteFrame | null): void {
        if (!this._sprite) {
            // Log removed for performance
            return;
        }
        this._sprite.spriteFrame = frame;
    }

    public prefillStickyCredit(symbolId: number, targetRowIndex: number): void {
        if (!isStickySymbol(symbolId) || this.reelIndex < 0 || targetRowIndex < 0 || GameData.instance.currentMode === 'respin') {
            this.clearCredit();
            return;
        }

        const key = `${this.reelIndex}-${targetRowIndex}`;
        const cell = GameData.instance.stickyCells.get(key);
        const creditValue = cell && cell.symbolId === symbolId ? cell.credit : 0;
        this.showCredit(creditValue);
    }

    /**
     * Ẩn/hiện Sprite component (dùng khi spine effect đang phát để tránh chồng ảnh).
     * Chỉ toggle enabled — không xóa spriteFrame, restore ngay khi gọi lại true.
     */
    setSpriteVisible(visible: boolean): void {
        if (this._sprites.length === 0) {
            this._sprites = this.node.getComponentsInChildren(Sprite);
        }
        for (let i = 0; i < this._sprites.length; i++) {
            const spr = this._sprites[i];
            if (spr?.isValid) spr.enabled = visible;
        }
    }

    // ─── CREDIT LABEL (Sticky) ────────────────────────────────────────────

    /**
     * Hiển thị giá trị credit ở giữa symbol sticky (green/gold).
     * Dùng format KMBT (1500 → "1.5K"). Label pop-in nhỏ.
     * Gọi sau khi reel dừng và sticky cell đã được xác nhận.
     */
    showCredit(value: number): void {
        if (!this.SpriteNumber) return;
        const labelNode = this.SpriteNumber.node;
        Tween.stopAllByTarget(labelNode);
        const shouldActive = value > 0;
        this.SpriteNumber.setData(value);
        // Reset rotation của CreditLabel để tránh bị nghiêng méo (đặc biệt case row0 col0)
        labelNode.setRotationFromEuler(0, 0, 0);
        labelNode.active = shouldActive;
    }

    /**
     * Force feature entry — đổi symbol reel thành sticky (green/gold) + nhún land.
     */
    public applyStickyFill(symbolId: number, credit: number): void {
        if (!isStickySymbol(symbolId)) return;
        this.setSymbol(symbolId);
        if (credit > 0) {
            this.showCredit(credit);
        }
        this._landBouncePlayed = false;
        this._pendingLandBounce = false;
        this._playLandBounce();
    }

    /**
     * Bounce nhẹ khi symbol coin vừa land trên reel.
     * Clone lên WaysPayDisplay để nhún trên fillBlack — symbol gốc GIỮ NGUYÊN trên reel.
     */
    private _playLandBounce(reparentToTop: boolean = true): void {
        const s = this.getBaseScale();

        // Dọn clone/tween/schedule cũ trước khi nhún mới (tránh dư âm → lúc nhanh lúc chậm)
        SymbolView.restoreLandBounceIfNeeded(this.node);
        this._landBounceGen++;
        const myGen = this._landBounceGen;
        Tween.stopAllByTarget(this.node);

        // Play sound when a sticky yellow coin lands in FreeSpin Gold
        if (this._currentSymbolId === SymbolId.STICKY_YELLOW && GameData.instance.currentMode === 'freespin') {
            SoundManager.instance?.playSfxByName('sxBonusStickyGoldLand');
        }

        this._landBounceInFlight = true;

        this._ensureReelHomeCached();
        const topNode = SymbolView.landBounceParent;
        const m = AutoSpinManager.instance?.getTimingMultiplier?.() ?? 1;

        // Symbol gốc luôn ở reel — chỉ clone nhún trên WaysPayDisplay
        let bounceTarget: Node = this.node;
        let usedClone = false;
        if (reparentToTop && topNode && topNode.isValid) {
            SymbolView._destroyLandBounceClone(this.node);
            const clone = instantiate(this.node);
            clone.name = `${SymbolView.LAND_BOUNCE_CLONE_PREFIX}r${this.reelIndex}_row${this.rowIndex}`;
            clone.setParent(topNode, true);
            clone.setWorldPosition(this.node.getWorldPosition());
            clone.setSiblingIndex(topNode.children.length - 1);
            clone.active = true;
            // Clone phải visible; symbol gốc tạm ẩn sprite trong lúc nhún
            const cloneView = clone.getComponent(SymbolView);
            cloneView?.setSpriteVisible(true);
            SymbolView._landBounceClones.set(this.node, clone);
            bounceTarget = clone;
            usedClone = true;
            this.setSpriteVisible(false);
        }

        // Reset scale/pos + cắt mọi tween còn sót trên target (clone mới hoặc node gốc)
        this.node.setScale(s, s, 1);
        Tween.stopAllByTarget(bounceTarget);
        bounceTarget.setScale(s, s, 1);
        // Đẩy lên nhanh → hold ngắn → rơi xuống chậm hơn
        const growDur = 0.08 * m;
        const holdDur = 0.12 * m;
        const shrinkDur = 0.32 * m;
        const bounceDuration = growDur + holdDur + shrinkDur;
        // Nhún nhẹ lên khi zoom — tạo cảm giác symbol nhảy rồi rơi về chỗ cũ
        const basePos = bounceTarget.position.clone();
        const jumpY = 16;
        const peakPos = new Vec3(basePos.x, basePos.y + jumpY, basePos.z);
        let bounceFinished = false;

        const finishBounce = () => {
            // Gen lệch = bounce đã bị thay/interrupt — không destroy clone mới / không đếm counter 2 lần
            if (myGen !== this._landBounceGen || bounceFinished) return;
            bounceFinished = true;
            this._landBounceInFlight = false;
            SymbolView._destroyLandBounceClone(this.node); // cũng setSpriteVisible(true) trên gốc
            if (this.node?.isValid) {
                Tween.stopAllByTarget(this.node);
                this.node.setScale(s, s, 1);
                if (usedClone) this.setSpriteVisible(true);
            }
            // Clone đã destroy; nếu bounce trên node gốc thì trả vị trí về base
            if (bounceTarget === this.node && this.node?.isValid) {
                this.node.setPosition(basePos);
            } else if (bounceTarget?.isValid && bounceTarget !== this.node) {
                Tween.stopAllByTarget(bounceTarget);
            }
        };

        tween(bounceTarget)
            .to(growDur, {
                scale: new Vec3(s * 1.12, s * 1.12, 1),
                position: peakPos,
            }, { easing: 'sineOut' })
            .delay(holdDur)
            .to(shrinkDur, {
                scale: new Vec3(s, s, 1),
                position: basePos.clone(),
            }, { easing: 'sineIn' })
            .call(finishBounce)
            .start();

        // Fallback: tween bị cắt giữa chừng → vẫn xóa clone + giảm counter
        this.scheduleOnce(() => {
            if (!this.node?.isValid || myGen !== this._landBounceGen || bounceFinished) return;
            finishBounce();
        }, bounceDuration + 0.08);
    }

    /**
     * Ẩn credit label. Gọi khi reel bắt đầu quay hoặc symbol bị reset.
     */
    clearCredit(): void {
        if (!this.SpriteNumber) return;
        const labelNode = this.SpriteNumber.node;
        Tween.stopAllByTarget(labelNode);
        labelNode.active = false;
    }

    /** Cập nhật tên node/debug cho khớp symbolId hiện tại (kể cả lúc đang quay). */
    private _syncSymbolDebugName(symbolId: number): void {
        if (symbolId < 0) {
            this.currentSymbolName = 'Empty';
            this.node.name = '[Empty]';
            return;
        }
        this.currentSymbolName = SymbolId[symbolId] ?? `Symbol_${symbolId}`;
        this.node.name = `[${this.currentSymbolName}]`;
    }

    // ─── EVENT HANDLERS (từ ReelController) ───

    private _onSymbolChanged(symbolId: number): void {
        // Hot path khi đang quay: chỉ đổi sprite — không tween/rename/restore
        if (this._isSpinning) {
            this._currentSymbolId = symbolId;
            if (symbolId < 0) {
                if (this._sprite) this._sprite.spriteFrame = null;
                return;
            }
            const frame = this._resolveSymbolFrame(symbolId)
                ?? this.blurFrames[symbolId]
                ?? this.symbolFrames[symbolId]
                ?? null;
            if (this._sprite && frame) {
                this._sprite.spriteFrame = frame;
            }
            // Sticky credit trên visible cells (rowIndex>=0) ngay cả lúc quay
            if (isStickySymbol(symbolId) && this.reelIndex >= 0 && this.rowIndex >= 0) {
                const cell = GameData.instance.stickyCells.get(`${this.reelIndex}-${this.rowIndex}`);
                const creditValue = cell && cell.symbolId === symbolId ? cell.credit : 0;
                this.showCredit(creditValue);
            }
            return;
        }

        // Idle / settle: sticky cùng ID → giữ scale/tween land-bounce đang chạy
        const isSticky = isStickySymbol(symbolId);
        const sameSticky = isSticky && this._currentSymbolId === symbolId;
        const keepRunningLandBounce = sameSticky && this._landBouncePlayed;
        if (!keepRunningLandBounce) {
            Tween.stopAllByTarget(this.node);
            if (SymbolView.landBounceParent && this.node.parent === SymbolView.landBounceParent) {
                SymbolView.restoreToReelHome(this.node);
            }
        }
        if (!sameSticky) {
            const base = this.getBaseScale(symbolId);
            this.node.setScale(base, base, 1);
        }

        if (sameSticky) {
            const frame = this._resolveSymbolFrame(symbolId);
            if (frame) this._applySpriteFrame(frame);
            if (this.rowIndex >= 0) {
                this.prefillStickyCredit(symbolId, this.rowIndex);
                this._pendingLandBounce = !this._landBouncePlayed;
            }
            return;
        }
        this.setSymbol(symbolId);
    }

    private _onSpinStart(): void {
        // Đánh dấu đang trong chu kỳ spin nhưng chưa hiện blur
        // (reel đang bounce lên, chưa vào tốc độ nhanh)
        this._isSpinning = true;
        this._landBouncePlayed = false;
        // KHÔNG ẩn credit label ở đây — sticky vẫn còn visible trong giai đoạn launch bounce.
        // Credit sẽ bị ẩn khi spin-fast fire (blur bắt đầu hiển, symbol đi ra khỏi view).
    }

    private _onSpinFast(): void {
        // Reel đã vào tốc độ nhanh → hiện blur
        // ★ Chỉ ẩn credit label cho non-sticky coins; sticky coins giữ credit hiển thị
        if (!isStickySymbol(this._currentSymbolId)) {
            this.clearCredit();
        }
        this.showBlur();
    }

    private _onSpinStop(): void {
        // Clear flag — symbol-changed tiếp theo sẽ gọi setSymbol() → hiện ảnh thật
        this._isSpinning = false;
    }

    private _onStickyResultLanded(symbolId: number): void {
        if (GameData.instance.currentMode === 'respin') return;
        if (this.rowIndex < 0 || this._landBouncePlayed) return;

        this._isSpinning = false;
        this._currentSymbolId = symbolId;
        this._syncSymbolDebugName(symbolId);
        const frame = this._resolveSymbolFrame(symbolId);
        if (frame) this._applySpriteFrame(frame);
        this.prefillStickyCredit(symbolId, this.rowIndex);

        this._pendingLandBounce = true;
        this._landBouncePlayed = false;
    }

    private _onReelSettled(): void {
        if (this._pendingLandBounce && !this._landBouncePlayed && GameData.instance.currentMode !== 'respin') {
            // Capture Y sau reel position settle (trước khi reparent sang WaysPayDisplay)
            if (!SymbolView.landBounceParent || this.node.parent !== SymbolView.landBounceParent) {
                this._ensureReelHomeCached();
            }
            this._pendingLandBounce = false;
            this._landBouncePlayed = true;
            this._playLandBounce();
        }
    }

    // ─── DEBUG OVERLAY ───

    private _createDebugLabel(): void {
        // Tạo child node chứa Label để overlay PS ID lên symbol
        const labelNode = new Node('DebugLabel');
        this.node.addChild(labelNode);
        const label = labelNode.addComponent(Label);
        label.string = '';
        label.fontSize = 20;
        label.lineHeight = 22;
        label.color = new Color(255, 255, 0, 255);  // yellow
        label.isBold = true;
        // Outline for readability
        const outline = labelNode.addComponent(LabelOutline);
        outline.color = new Color(0, 0, 0, 255);
        outline.width = 2;
        this._debugLabel = label;
    }

    /**
     * Cập nhật debug overlay hiển thị PS ID + Client ID.
     * Gọi sau khi setSymbol() để hiển thị thông tin mapping.
     */
    private _updateDebugOverlay(): void {
        if (!this._debugLabel) return;
        const clientId = this._currentSymbolId;
        const clName = clientId < 0 ? 'Empty' : (SymbolId[clientId] ?? `cl${clientId}`);
        this._debugLabel.string = `CL:${clientId}(${clName})`;
    }
}
