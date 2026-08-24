/**
 * WaysPayDisplay — Highlight ô symbol thắng (Ways Pay + Line Pay).
 *
 * Dùng Spine skeleton loop trên overlay nodes. Pool lazy: tạo khi cần, reuse khi return.
 *
 * FLOW:
 *   1. WIN_SHOW_ALL_WAYS / WIN_SHOW_ALL_LINES → hiện TOÀN BỘ ô thắng
 *   2. WIN_CYCLE_ONE_WAY / UI_UPDATE_WIN_LABEL → diff update từng way/line
 *   3. REELS_START_SPIN / WIN_HIGHLIGHT_CLEAR / Feature entry → trả tất cả về pool
 *
 * SETUP:
 *   1. Tạo 1 Node "HighlightSpine" trong scene: gắn sp.Skeleton, SkeletonData đúng, đặt inactive.
 *   2. Gắn component WaysPayDisplay vào cùng Node với SlotMachineController (hoặc node khác).
 *   3. Kéo Node WaysPayDisplay vào slot "waysPayDisplay" trong SlotMachineController.
 *   4. Kéo Node "HighlightSpine" vào "highlightSpinePrefab" trong SlotMachineController.
 *   5. Điều chỉnh "highlightSpineAnim" nếu tên animation khác "animation".
 *   6. SlotMachineController.start() sẽ tự gọi WaysPayDisplay.init().
 *
 * NODE LAYOUT (mỗi reel):
 *   symbolNodes[0] = ExtraTop1  (buffer)
 *   symbolNodes[1] = Top  ← visible row 0
 *   symbolNodes[2] = Mid  ← visible row 1
 *   symbolNodes[3] = Bot  ← visible row 2
 *   symbolNodes[4] = ExtraBot1  (buffer)
 */

import { _decorator, Component, Node, sp, instantiate } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';
import { MatchedLinePay, WaysPayWin } from '../data/SlotTypes';
import { Log } from '../core/Logger';
import { ReelController } from './ReelController';
import { SymbolHighlighter, USE_SPINE_HIGHLIGHT } from './SymbolHighlighter';
import { SymbolView } from './SymbolView';

const { ccclass, property } = _decorator;

/** Index bắt đầu của visible rows trong symbolNodes (sau ExtraTop1) */
const VISIBLE_ROW_OFFSET = 1;
/** Số visible rows mỗi reel */
const VISIBLE_ROWS = 3;

@ccclass('WaysPayDisplay')
export class WaysPayDisplay extends Component {

    // ─── SET BỞI SlotMachineController.init() ─────────────────────────────

    /** Tham chiếu tới mảng ReelController (gán từ SlotMachineController) */
    reels: ReelController[] = [];

    /**
     * Node template inactive trong scene — instantiate() khi pool trống (lazy).
     * Gán từ SlotMachineController.highlightSpinePrefab.
     */
    @property({
        type: Node,
        tooltip: 'Node template Spine cho highlight (inactive). Pool tạo object khi cần, không prebuild lúc load.',
    })
    highlightSpinePrefab: Node | null = null;

    /** Tên animation Spine phát khi highlight (mặc định: "animation") */
    highlightSpineAnim: string = 'animation';

    // ─── INTERNAL ──────────────────────────────────────────────────────────

    /** Pool các node idle (inactive). Chỉ add khi borrow mà pool trống. */
    private _pool: Node[] = [];

    /**
     * _overlays[col][row] = node đang active tại ô (col, row), null nếu ô đó đang tắt.
     * Node được parented vào symbolNode tương ứng khi đang hiện.
     */
    private _overlays: Array<Array<Node | null>> = [];

    /** Flag: đã init xong */
    private _ready: boolean = false;

    /** SymbolHighlighter — chờ SymbolSpine sẵn sàng trước khi bật underlay. */
    private _symbolHighlighter: SymbolHighlighter | null = null;

    /**
     * Tăng mỗi lần clear — hủy apply async còn pending
     * (tránh ensureSpines xong rồi bật lại highlight khi đã vào Feature).
     */
    private _applyGen: number = 0;

    // ─── LIFECYCLE ─────────────────────────────────────────────────────────

    onLoad(): void {
        try {
            this._symbolHighlighter = this.node.scene?.getComponentInChildren(SymbolHighlighter) ?? null;
        } catch (_e) {
            this._symbolHighlighter = null;
        }
        const bus = EventBus.instance;
        bus.on(GameEvents.WIN_SHOW_ALL_WAYS,  this._onShowAllWays,  this);
        bus.on(GameEvents.WIN_CYCLE_ONE_WAY,  this._onCycleOneWay,  this);
        // Real API dùng MatchedLinePays → WIN_SHOW_ALL_LINES / UI_UPDATE_WIN_LABEL
        bus.on(GameEvents.WIN_SHOW_ALL_LINES, this._onShowAllLines, this);
        bus.on(GameEvents.UI_UPDATE_WIN_LABEL, this._onCycleOneLine, this);
        bus.on(GameEvents.REELS_START_SPIN,   this._onSpinStart,    this);
        bus.on(GameEvents.WIN_HIGHLIGHT_CLEAR, this._onSpinStart,   this);
        bus.on(GameEvents.FREE_SPIN_START,    this._onFeatureStart, this);
        bus.on(GameEvents.FREE_SPIN_GOLD_START, this._onFeatureStart, this);
        bus.on(GameEvents.TOPUP_START,         this._onFeatureStart, this);
        // Carnival Feature entry (sau Press to Start)
        bus.on(GameEvents.CARNIVAL_MATSURI_START,  this._onFeatureStart, this);
        bus.on(GameEvents.FREE_SPIN_END,       this._onFeatureEnd,   this);
        bus.on(GameEvents.FREE_SPIN_GOLD_END, this._onFeatureEnd,   this);
        bus.on(GameEvents.TOPUP_END,          this._onFeatureEnd,   this);
        bus.on(GameEvents.PICK_GAME_OPEN,     this._onFeatureStart, this);
        bus.on(GameEvents.PICK_GAME_CLOSE,    this._onFeatureEnd,   this);
    }

    onDestroy(): void {
        this._returnAll();
        for (const n of this._pool) { if (n?.isValid) n.destroy(); }
        this._pool = [];
        EventBus.instance.offTarget(this);
    }

    // ─── PUBLIC API ────────────────────────────────────────────────────────

    /**
     * Khởi tạo. Gọi từ SlotMachineController.start() SAU khi reels đã setup xong.
     * Không prebuild pool — node highlight tạo khi _showOverlay cần.
     */
    init(reels: ReelController[], templateNode: Node | null, animName: string = 'animation'): void {
        this.reels               = reels;
        this.highlightSpinePrefab = templateNode;
        this.highlightSpineAnim  = animName;
        this._overlays = reels.map(() => new Array<Node | null>(VISIBLE_ROWS).fill(null));
        this._ready = true;
    }

    // ─── EVENT HANDLERS ────────────────────────────────────────────────────

    /**
     * Hiện toàn bộ ô thắng (union của mọi WaysPayWin) + bắt đầu frame animation.
     * @param ways     Mảng WaysPayWin từ SpinResponse
     * @param duration (không dùng trực tiếp — WinPresenter quản lý timer)
     */
    private _onShowAllWays(ways: WaysPayWin[], _duration?: number): void {
        if (!this._ready) {
            // Log.d(`[WinHL] WaysPay SHOW_ALL_WAYS skip — not ready`);
            return;
        }
        const cells = this._collectWayCells(ways);
        Log.e(
            `[MULTI-LINE-WIN] WaysPayDisplay SHOW_ALL_WAYS ways=${ways?.length ?? 0} cells=${cells.size}` +
            ` payouts=[${ways.map(w => `sym${w.symbolId}=${w.payout}(ways=${w.ways})`).join('|')}]`
        );
        void this._applyCellsWhenSpinesReady(cells);
    }

    /**
     * Cycle từng way riêng lẻ: chỉ giữ ô của way này (diff — không destroy/recreate ô còn lại).
     */
    private _onCycleOneWay(way: WaysPayWin): void {
        if (!this._ready) {
            // Log.d(`[WinHL] WaysPay CYCLE_ONE_WAY skip — not ready`);
            return;
        }
        const cells = this._collectWayCells([way]);
        Log.e(
            `[MULTI-LINE-WIN] WaysPayDisplay CYCLE_ONE_WAY sym=${way?.symbolId} payout=${way?.payout}` +
            ` ways=${way?.ways} cells=${cells.size}`
        );
        void this._applyCellsWhenSpinesReady(cells);
    }

    /** Real API line win: hiện union ô thắng của mọi MatchedLinePay. */
    private _onShowAllLines(lines: MatchedLinePay[], _duration?: number): void {
        if (!this._ready) {
            // Log.d(`[WinHL] WaysPay SHOW_ALL_LINES skip — not ready`);
            return;
        }
        const cells = this._collectLineCells(lines);
        Log.e(
            `[MULTI-LINE-WIN] WaysPayDisplay SHOW_ALL_LINES lines=${lines?.length ?? 0} cells=${cells.size}` +
            ` payouts=[${lines.map(l => `pl${l.payLineIndex}=${l.payout}`).join(',')}]`
        );
        void this._applyCellsWhenSpinesReady(cells);
    }

    /** Cycle từng line (UI_UPDATE_WIN_LABEL): chỉ giữ ô của line hiện tại. */
    private _onCycleOneLine(linePay: MatchedLinePay): void {
        if (!this._ready || !linePay) {
            // Log.d(`[WinHL] WaysPay CYCLE_ONE_LINE skip — ready=${this._ready} line=${!!linePay}`);
            return;
        }
        const cells = this._collectLineCells([linePay]);
        Log.e(
            `[MULTI-LINE-WIN] WaysPayDisplay CYCLE_ONE_LINE pl=#${linePay.payLineIndex}` +
            ` payout=${linePay.payout} cells=${cells.size}`
        );
        void this._applyCellsWhenSpinesReady(cells);
    }

    /**
     * Chờ win-spine SkeletonData sẵn sàng rồi mới bật underlay —
     * đồng bộ với SymbolHighlighter để tránh highlight hiện trước anim symbol.
     */
    private async _applyCellsWhenSpinesReady(wanted: Set<string>): Promise<void> {
        const gen = this._applyGen;
        if (!USE_SPINE_HIGHLIGHT) return;
        const hl = this._symbolHighlighter
            ?? this.node.scene?.getComponentInChildren(SymbolHighlighter)
            ?? null;
        this._symbolHighlighter = hl;
        if (hl) {
            const cells: Array<{ col: number; row: number }> = [];
            for (const key of wanted) {
                const [colStr, rowStr] = key.split(',');
                cells.push({ col: Number(colStr), row: Number(rowStr) });
            }
            await hl.ensureSpinesForDisplayCells(cells);
        }
        // Đã clear / vào Feature trong lúc await → bỏ apply
        if (!this.isValid || !this._ready || gen !== this._applyGen) return;
        this._applyCells(wanted);
        // SymbolHighlighter có thể append clone/spine sau → pin lại underlay cuối frame
        this.scheduleOnce(() => {
            if (gen !== this._applyGen) return;
            this._pinOverlaysToBottom();
        }, 0);
    }

    /** Gom unique display cells từ ways (grid row → visual row). */
    private _collectWayCells(ways: WaysPayWin[]): Set<string> {
        const shown = new Set<string>();
        for (const way of ways) {
            for (const { reel, row } of way.cells) {
                // grid row (0=center-1, 2=center+1) ngược với visual row (0=Top=center+1).
                const displayRow = GameData.instance.toDisplayRow(row);
                shown.add(`${reel},${displayRow}`);
            }
        }
        return shown;
    }

    /** Gom unique display cells từ MatchedLinePay (server indices hoặc payline def). */
    private _collectLineCells(lines: MatchedLinePay[]): Set<string> {
        const shown = new Set<string>();
        const maxCol = Math.max(0, this.reels.length - 1);
        const paylines = GameData.instance.config?.paylines ?? [];

        for (const line of lines) {
            if (!line) continue;
            const serverIdx = line.matchedSymbolsIndices;
            if (serverIdx && serverIdx.length >= 3) {
                const valid = serverIdx.every(s =>
                    s.Item1 >= 0 && s.Item1 <= maxCol &&
                    s.Item2 >= 0 && s.Item2 <= 2
                );
                if (valid) {
                    for (const s of serverIdx) {
                        shown.add(`${s.Item1},${GameData.instance.toDisplayRow(s.Item2)}`);
                    }
                    continue;
                }
            }
            const payline = paylines[line.payLineIndex];
            if (!payline) continue;
            for (let col = 0; col < payline.length; col++) {
                shown.add(`${col},${GameData.instance.toDisplayRow(payline[col])}`);
            }
        }
        return shown;
    }

    /**
     * Diff update overlays: giữ node đã có, chỉ return ô thừa, show ô mới.
     * Tránh destroy/recreate liên tục khi cycle (gây flicker / mất effect).
     * FreeMode: luôn hiện Highlight cho mọi ô thắng (kể cả có STICKY_YELLOW).
     */
    private _applyCells(wanted: Set<string>): void {
        // Return overlays không còn trong wanted
        for (let col = 0; col < this._overlays.length; col++) {
            for (let row = 0; row < this._overlays[col].length; row++) {
                if (!this._overlays[col][row]) continue;
                if (!wanted.has(`${col},${row}`)) {
                    this._returnOverlay(col, row);
                }
            }
        }
        // Show overlays còn thiếu
        for (const key of wanted) {
            const [colStr, rowStr] = key.split(',');
            this._showOverlay(Number(colStr), Number(rowStr));
        }
        // Giữ Highlight underlay dưới clone/spine của SymbolHighlighter
        this._pinOverlaysToBottom();
    }

    /** Reset khi spin mới bắt đầu / WIN_HIGHLIGHT_CLEAR */
    private _onSpinStart(): void {
        // Log.d(`[WinHL] WaysPay CLEAR overlays (spinStart/highlightClear)`);
        this._invalidatePendingApply();
        this._returnAll();
        this._restoreVisibleSprites();
    }

    /** Cleanup khi bắt đầu feature (FreeSpin / TopUp / Carnival / Pick) */
    private _onFeatureStart(): void {
        this._invalidatePendingApply();
        this._returnAll();
        this._restoreVisibleSprites();
    }

    /** Cleanup khi kết thúc feature game */
    private _onFeatureEnd(): void {
        this._invalidatePendingApply();
        this._returnAll();
        this._restoreVisibleSprites();
    }

    private _invalidatePendingApply(): void {
        this._applyGen++;
    }

    private _restoreVisibleSprites(): void {
        for (const reel of this.reels) {
            if (!reel) continue;
            for (let i = VISIBLE_ROW_OFFSET; i < VISIBLE_ROW_OFFSET + VISIBLE_ROWS; i++) {
                const symNode = reel.symbolNodes[i];
                if (!symNode) continue;
                const view = symNode.getComponent(SymbolView);
                if (view) view.setSpriteVisible(true);
            }
        }
    }

    // ─── POOL BORROW / RETURN ───────────────────────────────────────────

    /** Lấy node từ pool; nếu trống thì instantiate từ template. */
    private _borrowHighlight(): Node | null {
        while (this._pool.length > 0) {
            const n = this._pool.pop()!;
            if (n?.isValid) return n;
        }
        if (!this.highlightSpinePrefab) return null;
        const node = instantiate(this.highlightSpinePrefab);
        node.active = false;
        this.node.addChild(node);
        return node;
    }

    /**
     * Hiện overlay tại (col, row): mượn node từ pool (hoặc tạo mới),
     * đặt position, bật Spine loop.
     */
    private _showOverlay(col: number, row: number): void {
        if (!USE_SPINE_HIGHLIGHT) return;
        if (this._overlays[col]?.[row]) return; // đang hiện rồi

        const symNode = this.reels[col]?.symbolNodes[row + VISIBLE_ROW_OFFSET];
        if (!symNode) return;

        const node = this._borrowHighlight();
        if (!node) return;

        // Đặt node vào đúng vị trí world của symbol,
        // sibling thấp để highlight nằm dưới symbol spine / bounce clone
        node.setWorldPosition(symNode.getWorldPosition());
        node.setSiblingIndex(0);
        node.active = true;

        const skel = node.getComponent(sp.Skeleton);
        if (skel) skel.setAnimation(0, this.highlightSpineAnim, true);

        this._overlays[col][row] = node;
    }

    /** Đẩy mọi underlay Highlight xuống dưới cùng (dưới __HLSpine_* / __HLClone_*). */
    private _pinOverlaysToBottom(): void {
        let idx = 0;
        for (let col = 0; col < this._overlays.length; col++) {
            for (let row = 0; row < this._overlays[col].length; row++) {
                const n = this._overlays[col][row];
                if (n?.isValid && n.parent === this.node) {
                    n.setSiblingIndex(idx++);
                }
            }
        }
    }

    private _returnOverlay(col: number, row: number): void {
        const node = this._overlays[col]?.[row];
        if (!node || !node.isValid) {
            if (this._overlays[col]) this._overlays[col][row] = null;
            return;
        }

        const skel = node.getComponent(sp.Skeleton);
        if (skel) skel.clearTracks();

        node.active = false;
        if (this.node?.isValid) {
            node.setParent(this.node, false);
            this._pool.push(node);
        }
        this._overlays[col][row] = null;
    }

    /** Trả tất cả node đang active về pool */
    private _returnAll(): void {
        for (let col = 0; col < this._overlays.length; col++) {
            for (let row = 0; row < this._overlays[col].length; row++) {
                this._returnOverlay(col, row);
            }
        }
    }
}
