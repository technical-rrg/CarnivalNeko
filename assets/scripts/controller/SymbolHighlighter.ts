/**
 * SymbolHighlighter — Highlight symbol thắng bằng fillBlack overlay per reel.
 *
 * Thay vì vẽ đường payline, component này dim các symbol KHÔNG thắng bằng cách:
 *   1. Mỗi reel có 1 node "fillBlack" (màu đen, mặc định alpha=0, nằm NGOÀI reel parent).
 *   2. Sau khi reel dừng và có kết quả:
 *      - Reparent fillBlack VÀO cùng parent với symbolNodes[1..3].
 *      - setSiblingIndex để:  non-winning → fillBlack (alpha=0.7) → winning symbols
 *      - Winning symbols nằm TRÊN fillBlack → nổi bật.
 *      - Non-winning symbols nằm DƯỚI fillBlack → bị tối.
 *   3. Khi spin mới bắt đầu: reset fillBlack alpha về 0.
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Gắn SymbolHighlighter vào 1 Node nào đó (ví dụ cùng node với SlotMachineController).
 *   2. Kéo ReelController vào mảng "reels".
 *   3. Tạo fillBlack nodes (Sprite màu đen) → kéo vào "fillBlackNodes".
 *   4. Spine effect: Prefab trong MainBundle/SymbolSpine/{id}.
 *      Có prefab → clone/borrow từ pool, play spine highlight.
 *      Không có prefab → fallback clone sprite + zoom nhún (code).
 *      Prefab preload ở start(); highlight chỉ bật fillBlack sau khi prefab sẵn sàng.
 *
 * ── NODE LAYOUT ReelController ──
 *   symbolNodes[0] = ExtraTop1  (buffer/clip)
 *   symbolNodes[1] = Top        (row 0, visible)
 *   symbolNodes[2] = Mid        (row 1, visible)
 *   symbolNodes[3] = Bot        (row 2, visible)
 *   symbolNodes[4] = ExtraBot1  (buffer/clip)
 *
 *   Tất cả là con của cùng 1 parent (reel scroll container).
 *
 * ── SIBLING ORDER SAU KHI ÁP DỤNG ──
 *   [idx 0] ExtraTop1 (giữ nguyên, dưới fillBlack)
 *   [idx 1..] non-winning visible symbols
 *   [idx ..] ExtraBot1 (đặt tường minh dưới fillBlack — tránh highlight ngoài mask)
 *   [idx ..] fillBlack (alpha ≈ 179 = 0.7 × 255)
 *   [idx ..] winning visible symbols (nổi bật trên fillBlack)
 */

import { _decorator, Component, Node, Prefab, UIOpacity, tween, Tween, Vec3, sp, instantiate, Color, Sprite, isValid, assetManager, CCString, CCFloat } from 'cc';
import { SpriteNumber } from '../core/SpriteNumber';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';
import { MatchedLinePay, PS_TO_CLIENT, SymbolId, WaysPayWin, isMajor, isMinor } from '../data/SlotTypes';
import { SoundManager } from '../manager/SoundManager';
import { AutoSpinManager, SpeedMode } from '../manager/AutoSpinManager';
import { ReelController } from './ReelController';
import { PaylineIndicatorManager } from './PaylineIndicatorManager';
import { SymbolView } from './SymbolView';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

/** DEBUG flag - tắt trong production để tối ưu performance */
const DEBUG = false;

/** Bundle chứa prefab spine symbol (đã load sẵn bởi LoadingController). */
const SPINE_BUNDLE = 'MainBundle';

/** Prefix tên node spine highlight — phân biệt với WaysPayDisplay / WildTrail trên cùng parent. */
const HL_SPINE_NAME_PREFIX = '__HLSpine_';

/**
 * Path mặc định trong MainBundle theo SymbolId (= file trong SymbolSpine/).
 * Prefab name = path (không extension). Override bằng spineEffectPrefabPaths trong Inspector.
 * Id không có trong map / load fail → bounce bằng code.
 */
const DEFAULT_SPINE_PREFAB_PATHS: Readonly<Record<number, string>> = {
    [SymbolId.MINOR_9]:         'SymbolSpine/0',
    [SymbolId.MINOR_10]:        'SymbolSpine/1',
    [SymbolId.MINOR_J]:         'SymbolSpine/2',
    [SymbolId.MINOR_Q]:         'SymbolSpine/3',
    [SymbolId.MINOR_K]:         'SymbolSpine/4',
    [SymbolId.MINOR_A]:         'SymbolSpine/5',
    [SymbolId.MAJOR_HORUS]:     'SymbolSpine/6',
    [SymbolId.MAJOR_ANUBIS]:    'SymbolSpine/7',
    [SymbolId.MAJOR_SOBEK]:     'SymbolSpine/8',
    [SymbolId.MAJOR_RAMSES]:    'SymbolSpine/9',
    [SymbolId.MAJOR_CLEOPATRA]: 'SymbolSpine/10',
    [SymbolId.WILD]:            'SymbolSpine/11',
};

/** Dữ liệu theo dõi 1 spine node đang active (instantiate từ prefab) */
interface ActiveSpineEntry {
    spineNode:    Node;
    skel:         sp.Skeleton | null;
    view:         SymbolView  | null;
    symId:        number;              // SymbolId — dùng để tra cứu per-symbol timescale
    symbolNode:   Node;               // node cần lắng nghe 'symbol-changed'
    _onSymChanged: (() => void) | null; // bound listener để off() sau
    loop:         boolean;            // spine animation có loop hay không
    gen:          number;
    spriteBounce?: boolean;           // true = highlight bằng sprite bounce, không dùng spine
}

interface CellPos { col: number; row: number; }

@ccclass('SymbolHighlighter')
export class SymbolHighlighter extends Component {

    // ── EDITOR PROPERTIES ────────────────────────────────────────────────────

    @property({
        type: [ReelController],
        tooltip: '3 ReelController theo thứ tự cột 0, 1, 2',
    })
    reels: ReelController[] = [];

    @property({
        type: [Node],
        tooltip: '1 fillBlack node per reel (5 nodes cho 5 reel).\n'
               + 'Đặt NGOÀI reel parent ban đầu (ví dụ con của Canvas).\n'
               + 'Mỗi node cần UIOpacity component, opacity = 0 ban đầu.',
    })
    fillBlackNodes: Node[] = [];

    @property({ tooltip: 'Opacity của fillBlack khi active (0–255). Mặc định ≈ 210' })
    fillAlpha: number = 210;

    @property({ tooltip: 'Thời gian fade IN fillBlack (giây)' })
    fadeDuration: number = 0.15;

    @property({ tooltip: 'Scale zoom symbol thắng (1 = không zoom)' })
    cellZoomScale: number = 1.15;

    @property({ tooltip: 'Thời gian mỗi nhịp zoom in/out (giây)' })
    cellZoomDuration: number = 0.18;

    @property({ type: PaylineIndicatorManager, tooltip: 'PaylineIndicatorManager để highlight ô số đường thắng' })
    paylineIndicator: PaylineIndicatorManager | null = null;

    @property({
        type: Node,
        tooltip: 'Node PaylineManager (chứa WaysPayDisplay) để parent spine effect vào.\n'
               + 'Giúp spine nằm trên cùng, tách biệt với các Reel.',
    })
    paylineManagerNode: Node | null = null;

    @property({
        type: [CCString],
        tooltip: 'Path Prefab Spine trong MainBundle, index = SymbolId.\n'
               + 'Để trống slot = dùng DEFAULT_SPINE_PREFAB_PATHS hoặc không có spine.\n'
               + 'VD: SymbolSpine/0 … SymbolSpine/12.\n'
               + 'KHÔNG reference Prefab trực tiếp — bundle.load + preload ở start().',
    })
    spineEffectPrefabPaths: string[] = [];

    @property({
        type: [CCFloat],
        tooltip: 'Local position X cho mỗi spine effect node, index = SymbolId.\n'
               + 'Y mặc định = 0, chỉ cần thiết lập X.',
    })
    spineLocalPosX: number[] = [];

    @property({
        type: [CCFloat],
        tooltip: 'Local position Y cho mỗi spine effect node, index = SymbolId.\n'
               + 'Dùng khi cần lệch Y so với symbol node.',
    })
    spineLocalPosY: number[] = [];

    @property({
        type: [CCFloat],
        tooltip: 'TimeScale cố định cho mỗi spine effect node, index = SymbolId.\n'
               + '0 hoặc không set = tự tính từ highlightDuration (hành vi cũ).',
    })
    spineTimeScales: number[] = [];

    @property({ tooltip: 'Tên animation Spine phát khi highlight (default: "animation")' })
    spineAnimName: string = 'animation';

    @property({ tooltip: 'TimeScale spine khi Normal mode (0 = tự tính từ highlightDuration).' })
    spineTimeScaleNormal: number = 0;

    @property({ tooltip: 'TimeScale spine khi Quick mode (0 = tự tính từ highlightDuration).' })
    spineTimeScaleQuick: number = 0;

    @property({ tooltip: 'TimeScale spine khi Turbo mode (0 = tự tính từ highlightDuration).' })
    spineTimeScaleTurbo: number = 0;

    @property({ tooltip: 'Thời gian 1 vòng animation spine ở timeScale=1 (giây). Dùng khi spineTimeScales[symId] = 0.' })
    spineAnimDuration: number = 1.0;

    @property({ tooltip: 'Thời gian "show all" highlight — phải khớp WinPresenter.spinEnableDelay (giây)' })
    showAllHighlightDuration: number = 2;

    @property({ tooltip: 'Thời gian mỗi chu kỳ line cycling — phải khớp WinPresenter.lineCycleDuration (giây)' })
    lineCycleHighlightDuration: number = 2.0;

    // ── INTERNAL STATE ────────────────────────────────────────────────────────

    private _zoomedNodes: Node[] = [];
    /** Tất cả spine đang active, mỗi entry tự quản lý lifecycle qua setCompleteListener */
    private _activeSpines: ActiveSpineEntry[] = [];    /** Entries đã deactivate spine nhưng vẫn chờ 'symbol-changed' để restore sprite */
    private _pendingListeners: ActiveSpineEntry[] = [];    /** Tăng mỗi lần highlight cycle mới — callback cũ sẽ tự bỏ qua nếu gen lệch */
    private _spineGen: number = 0;
    /** Đang chờ tất cả spine từ "show all" hoàn tất để emit WIN_HIGHLIGHT_ANIM_DONE */
    private _watchingHighlightDone: boolean = false;

    /** Cells của lần jackpot reveal gần nhất — dùng để loop highlight sau popup */
    private _jackpotCells: CellPos[] = [];
    /** Callback schedule lặp highlight jackpot */
    private _jackpotCycleCallback: (() => void) | null = null;
    /** Counter tăng mỗi lần REELS_START_SPIN — dùng để tương quan debug logs */
    private _spinCount: number = 0;
    /** Nodes đang được green tint (#77FF42) trong FreeSpin — cần restore về white sau highlight */
    private _greenTintedNodes: Node[] = [];
    /** Vị trí gốc của symbol node trước khi bounce highlight (restore khi cleanup) */
    private _bounceOrigPos: Map<Node, Vec3> = new Map();
    /** CreditLabel đã reparent tạm sang paylineManagerNode: lưu parent, sibling & active gốc để restore */
    private _creditLabelRestoreData: Map<Node, { origParent: Node | null; origSibling: number; origActive: boolean }> = new Map();
    /** FreeMode STICKY_YELLOW: clone node đang hiển thị trên paylineManagerNode (symbolNode gốc -> clone) */
    private _yellowClones: Map<Node, Node> = new Map();
    private _yellowCloneTweens: Map<Node, Tween> = new Map();
    /** Sprite bounce highlight: clone trên WaysPayDisplay (symbolNode gốc -> clone bounce) */
    private _spriteBounceClones: Map<Node, Node> = new Map();
    private _currentLineWinCount: number = 0;
    /**
     * Số popup đang chặn match SFX khi cycle line lẻ
     * (Jackpot / ProgressiveWin / PickGame / FeatureSelect / End popup…).
     */
    private _matchSfxBlockCount: number = 0;
    /** FreeSpin entry popup (không có event close riêng). */
    private _blockingFreeSpinPopup: boolean = false;

    /** Prefab đã lazy-load theo SymbolId — không serialize trên Base. */
    private _spinePrefabCache: Map<number, Prefab> = new Map();
    /** SymbolId đã thử load nhưng không có prefab — fallback bounce, không retry mỗi cycle. */
    private _spinePrefabMissing: Set<number> = new Set();
    /** In-flight load promises theo path — tránh double bundle.load. */
    private _spinePrefabLoading: Map<string, Promise<Prefab | null>> = new Map();
    /** Pool spine node theo SymbolId — reuse sau mỗi lần highlight. */
    private _spineNodePool: Map<number, Node[]> = new Map();

    // ── LIFECYCLE ────────────────────────────────────────────────────────────

    onLoad(): void {
        // Đảm bảo tất cả fillBlack bắt đầu với opacity = 0
        for (const fb of this.fillBlackNodes) {
            if (fb) this._setOpacity(fb, 0);
        }

        const bus = EventBus.instance;
        bus.on(GameEvents.UI_UPDATE_WIN_LABEL,    this._onLineHighlight,     this);
        bus.on(GameEvents.WIN_SHOW_ALL_LINES,      this._onShowAllLines,     this);
        bus.on(GameEvents.WIN_SHOW_ALL_WAYS,       this._onShowAllWays,      this);
        bus.on(GameEvents.WIN_CYCLE_ONE_WAY,       this._onCycleOneWay,      this);
        bus.on(GameEvents.WIN_HIGHLIGHT_CLEAR,     this._onWinHighlightClear, this);
        bus.on(GameEvents.JACKPOT_END,         this._onJackpotEndHighlight, this);
        bus.on(GameEvents.REELS_START_SPIN,    this._onReelsStartSpin, this);
        // Cập nhật highlight frame mode khi vào/thoát Feature game
        bus.on(GameEvents.FREE_SPIN_START,      this._onFeatureGameStart, this);
        bus.on(GameEvents.FREE_SPIN_GOLD_START, this._onFeatureGameStart, this);
        bus.on(GameEvents.TOPUP_START,           this._onFeatureGameStart, this);
        bus.on(GameEvents.FREE_SPIN_END,         this._onFeatureGameEnd,   this);
        bus.on(GameEvents.FREE_SPIN_GOLD_END,    this._onFeatureGameEnd,   this);
        bus.on(GameEvents.TOPUP_END,             this._onFeatureGameEnd,   this);
        // Long spin hint: spine effect trên 2 symbol ở reel1+reel2 tương tự highlight
        bus.on(GameEvents.LONG_SPIN_HINT_SHOW,     this._onLongSpinHintShow,     this);
        // Jackpot reveal: play spine cả 3 symbol cùng lúc trước khi popup hiện (mọi loại jackpot)
        bus.on(GameEvents.LONG_SPIN_JACKPOT_REVEAL, this._onLongSpinJackpotReveal, this);
        // Bonus reveal: highlight symbol Bonus trước khi FreeSpinPopup hiện
        bus.on(GameEvents.FREE_SPIN_BONUS_REVEAL, this._onBonusReveal, this);
        // Carnival Feature (Normal + lineWin cùng spin) → clear spine/highlight ngay khi pot burst
        bus.on(GameEvents.CARNIVAL_POT_BURST, this._onFeatureSelectOpen, this);
        bus.on(GameEvents.MATSURI_START_POPUP, this._onFeatureSelectOpen, this);
        bus.on(GameEvents.CARNIVAL_MATSURI_START, this._onFeatureGameStart, this);
        bus.on(GameEvents.PICK_GAME_OPEN, this._onPickGameBoundary, this);
        bus.on(GameEvents.PICK_GAME_CLOSE, this._onPickGameBoundary, this);
        // Red symbol bounce (kept for sticky red land FX)

        // Chặn match SFX khi cycle line lẻ nếu đang có popup / feature flow
        bus.on(GameEvents.JACKPOT_TRIGGER, this._onMatchSfxBlockBegin, this);
        bus.on(GameEvents.JACKPOT_END, this._onMatchSfxBlockEnd, this);
        bus.on(GameEvents.PROGRESSIVE_WIN_SHOW, this._onMatchSfxBlockBegin, this);
        bus.on(GameEvents.PROGRESSIVE_WIN_END, this._onMatchSfxBlockEnd, this);
        bus.on(GameEvents.PICK_GAME_OPEN, this._onMatchSfxBlockBegin, this);
        bus.on(GameEvents.PICK_GAME_CLOSE, this._onMatchSfxBlockEnd, this);
        bus.on(GameEvents.FREE_SPIN_END_POPUP, this._onMatchSfxBlockBegin, this);
        bus.on(GameEvents.FREE_SPIN_END_POPUP_CLOSED, this._onMatchSfxBlockEnd, this);
        bus.on(GameEvents.TOPUP_END_POPUP, this._onMatchSfxBlockBegin, this);
        bus.on(GameEvents.TOPUP_END_POPUP_CLOSED, this._onMatchSfxBlockEnd, this);
        bus.on(GameEvents.TOPUP_TRANSITION_SHOW, this._onMatchSfxBlockBegin, this);
        bus.on(GameEvents.TOPUP_TRANSITION_DONE, this._onMatchSfxBlockEnd, this);
        bus.on(GameEvents.FREE_SPIN_POPUP, () => { this._blockingFreeSpinPopup = true; }, this);
        bus.on(GameEvents.FREE_SPIN_START, () => { this._blockingFreeSpinPopup = false; }, this);
    }

    start(): void {
        // Preload SymbolSpine (đặc biệt Wild/11) trước spin đầu — tránh fillBlack/WaysPay
        // hiện sớm trong lúc bundle.load lazy lần đầu.
        const ids = Object.keys(DEFAULT_SPINE_PREFAB_PATHS).map(Number);
        void this._ensureSpinePrefabs(ids).then(() => {
            Log.d(`[SymbolHighlighter] SymbolSpine warmup done (${ids.length} ids)`);
        });
    }

    onDestroy(): void {
        this._deactivateAllSpines();
        EventBus.instance.offTarget(this);
    }

    /**
     * Public API cho WaysPayDisplay: chờ prefab spine của các ô thắng sẵn sàng
     * trước khi bật underlay highlight — tránh overlay hiện trước Wild spine.
     */
    ensureSpinesForDisplayCells(cells: Array<{ col: number; row: number }>): Promise<void> {
        return this._ensureSpinePrefabs(this._collectNeededSpineIds(cells));
    }

    // ── EVENT HANDLERS ────────────────────────────────────────────────────────

    /** Cycling từng line một → chỉ highlight cells của line đó */
    private _onLineHighlight(linePay: MatchedLinePay): void {
        const cells = this._getWinningCells(linePay);
        // Force-clean toàn bộ spine/bounce cũ trước khi activate line mới —
        // tránh highlight line trước còn sót (orphan clone trên PaylineManager).
        this._deactivateAllSpines();
        this.paylineIndicator?.showWinLine(linePay.payLineIndex);
        if (this._canPlayCycleMatchSound()) {
            // Cycle lẻ: không play wild_layer — có Wild thì dùng high_value.
            this._playSymbolMatchSound(linePay.matchedSymbols ?? [], linePay.containsWild, false);
        }
        void this._runHighlightWithSpines(cells, this.lineCycleHighlightDuration, false, () => {
            this._zoomCells(cells);
        });
    }

    /**
     * Play đúng 1 SFX match:
     *   allowWildLayer + có Wild → sx_symbol_match_wild_layer (chỉ show-all / multiply)
     *   có Wild nhưng cycle lẻ → sx_symbol_match_high_value
     *   highCount > lowCount → sx_symbol_match_high_value
     *   còn lại → sx_symbol_match_low_value
     */
    private _playSymbolMatchSound(syms: number[], containsWild = false, allowWildLayer = false): void {
        const snd = SoundManager.instance;
        if (!snd) return;

        const clientSyms = this._normalizeSymbols(syms);
        if (clientSyms.includes(SymbolId.MAJOR_CLEOPATRA)) {
            snd.playGirlSymbolAnim();
        }

        const hasWild = containsWild || clientSyms.includes(SymbolId.WILD);
        if (hasWild && allowWildLayer) {
            snd.playSymbolMatchWild();
            return;
        }
        if (hasWild) {
            // Cycle line/way lẻ: Wild → high_value (wild_layer chỉ 1 lần ở show-all)
            snd.playSymbolMatchHigh();
            return;
        }
        if (clientSyms.length === 0) return;

        let high = 0;
        let low = 0;
        for (const s of clientSyms) {
            if (isMajor(s)) high++;
            else if (isMinor(s)) low++;
        }
        if (high === 0 && low === 0) return;

        if (high > low) snd.playSymbolMatchHigh();
        else snd.playSymbolMatchLow();
    }

    /** Cycle line/way lẻ: chỉ play khi không popup và chưa vào Feature. */
    private _canPlayCycleMatchSound(): boolean {
        if (this._matchSfxBlockCount > 0 || this._blockingFreeSpinPopup) return false;
        return GameData.instance.currentMode === 'normal';
    }

    private _onMatchSfxBlockBegin(): void {
        this._matchSfxBlockCount++;
    }

    private _onMatchSfxBlockEnd(): void {
        this._matchSfxBlockCount = Math.max(0, this._matchSfxBlockCount - 1);
    }

    /** Hiện tất cả winning lines cùng lúc → highlight union của mọi cell thắng */
    private _normalizeSymbols(syms: number[]): number[] {
        const map = GameData.instance.psToClientMap ?? {};
        return syms.map(symId => {
            if (map[symId] !== undefined) return map[symId];
            if (PS_TO_CLIENT[symId] !== undefined) return PS_TO_CLIENT[symId];
            return symId;
        });
    }

    private _onShowAllLines(lines: MatchedLinePay[], duration?: number): void {
        Log.d(`[WinHL] SymbolHighlighter SHOW_ALL_LINES | lines=${lines?.length ?? 0} duration=${duration ?? 'default'}`);
        this._currentLineWinCount = lines?.length ?? 0;
        // ── DEBUG: log toàn bộ kết quả spin ──────────────────────────────────────
        // {
        //     const totalWin = lines.reduce((s, l) => s + (l.winAmount ?? 0), 0);
        //     const paylines = GameData.instance.config.paylines;
        //     Log.e(
        //         `[HighlightDebug #${this._spinCount}] ═══ WIN RESULT: ${lines.length} line(s), totalWin≈${totalWin.toFixed(2)} ═══\n` +
        //         lines.map((l, i) => {
        //             const pl = paylines[l.payLineIndex];
        //             const plStr = pl ? pl.map((r, c) => `(col${c},row${r})`).join(',') : 'N/A';
        //             const si = l.matchedSymbolsIndices;
        //             const siStr = si && si.length > 0
        //                 ? si.map(s => `(col${s.Item1},row${s.Item2})`).join(',')
        //                 : 'none';
        //             return `  [line${i}] payLine#${l.payLineIndex} win=${(l.winAmount ?? 0).toFixed(2)}` +
        //                    ` | SERVER=[${siStr}] | PAYLINEDEF=[${plStr}]`;
        //         }).join('\n')
        //     );
        // }
        // ─────────────────────────────────────────────────────────────────────────
        const allCells: CellPos[] = [];
        for (const line of lines) {
            for (const c of this._getWinningCells(line)) {
                if (!allCells.some(x => x.col === c.col && x.row === c.row)) {
                    allCells.push(c);
                }
            }
        }
        // Log.e(
        //     `[HighlightDebug #${this._spinCount}] SHOW_ALL_LINES` +
        //     ` unionCells=[${allCells.map(c => `col${c.col}row${c.row}`).join(',')}]`
        // );
        // Bonus symbol (cột 2) được xử lý riêng qua FREE_SPIN_BONUS_REVEAL —
        // KHÔNG đưa vào allCells để tránh fillBlack highlight cho nó.
        // Clear highlight cũ trước show-all — tránh sót bounce/spine từ spin/cycle trước.
        this._deactivateAllSpines();
        // Zoom cho gold coin được xử lý trong _applyGreenTint (gọi từ _activateSpinesForCells)
        // Dùng duration từ WinPresenter.spinEnableDelay nếu được truyền vào,
        // fallback sang property showAllHighlightDuration nếu không
        // Nếu chỉ có 1 line win duy nhất → loop spine animation thay vì play once
        const loopSpine = lines.length === 1;
        this.paylineIndicator?.showMultipleWinLines(lines.map(l => l.payLineIndex));

        // Match SFX: Wild ưu tiên; không thì high vs low theo số lượng symbol.
        const allSyms = lines.flatMap(l => l.matchedSymbols ?? []);
        const hasWild = lines.some(l => l.containsWild)
            || this._normalizeSymbols(allSyms).includes(SymbolId.WILD);
        this._playSymbolMatchSound(allSyms, hasWild, true);

        // Chờ prefab (Wild/11…) sẵn sàng TRƯỚC fillBlack — tránh overlay hiện sớm hơn spine.
        void this._runHighlightWithSpines(allCells, duration ?? this.showAllHighlightDuration, loopSpine)
            .then(() => this._finishShowAllHighlightWatch(loopSpine));
    }

    // ── WAYS PAY HIGHLIGHT ────────────────────────────────────────────────────

    /**
     * Hiện fillBlack cho TẤT CẢ Ways Pay wins cùng lúc (union của mọi winning cell).
     * Được gọi khi WinPresenter emit WIN_SHOW_ALL_WAYS.
     */
    private _onShowAllWays(ways: WaysPayWin[], duration?: number): void {
        const allCells: CellPos[] = [];
        for (const way of ways) {
            for (const { reel, row } of way.cells) {
                // grid row (0=center-1=visual Bot, 2=center+1=visual Top): displayRow = 2 - gridRow
                const displayRow = 2 - row;
                if (!allCells.some(x => x.col === reel && x.row === displayRow)) {
                    allCells.push({ col: reel, row: displayRow });
                }
            }
        }
        const wildWays = ways.filter(w => w.containsWild || w.symbolId === SymbolId.WILD).length;
        Log.d(
            `[WinHL] SymbolHighlighter SHOW_ALL_WAYS | ways=${ways?.length ?? 0} cells=${allCells.length} ` +
            `wildWays=${wildWays} duration=${duration ?? 'default'}`
        );

        // Clear highlight cũ trước show-all — tránh sót bounce/spine từ cycle trước.
        this._deactivateAllSpines();
        // Zoom cho gold coin được xử lý trong _applyGreenTint (gọi từ _activateSpinesForCells)
        // Nếu chỉ có 1 way win duy nhất → loop spine animation thay vì play once
        const loopSpine = ways.length === 1;

        // Match SFX: Wild ưu tiên; không thì đếm high/low theo từng ô trong mọi way.
        const waySyms: number[] = [];
        let hasWild = false;
        for (const w of ways) {
            if (w.containsWild || w.symbolId === SymbolId.WILD) hasWild = true;
            const n = Math.max(1, w.cells?.length ?? 1);
            for (let i = 0; i < n; i++) waySyms.push(w.symbolId);
        }
        this._playSymbolMatchSound(waySyms, hasWild, true);

        // Chờ prefab (Wild/11…) sẵn sàng TRƯỚC fillBlack — tránh overlay hiện sớm hơn spine.
        void this._runHighlightWithSpines(allCells, duration ?? this.showAllHighlightDuration, loopSpine)
            .then(() => this._finishShowAllHighlightWatch(loopSpine));
    }

    /**
     * Sau khi spine đã spawn (kể cả sau lazy-load): quyết định emit WIN_HIGHLIGHT_ANIM_DONE ngay
     * hay chờ setCompleteListener. Loop / chỉ Wild → emit ngay.
     */
    private _finishShowAllHighlightWatch(loopSpine: boolean): void {
        // Wild / loop không tự complete — emit ngay. Còn lại chờ setCompleteListener / bounce complete.
        const nonWildActive = this._activeSpines.filter(e => e.symId !== SymbolId.WILD);
        Log.d(
            `[WinHL] showAll spawn done | active=${this._activeSpines.length} nonWild=${nonWildActive.length} loop=${loopSpine}`
        );
        if (loopSpine || nonWildActive.length === 0) {
            EventBus.instance.emit(GameEvents.WIN_HIGHLIGHT_ANIM_DONE);
        } else {
            this._watchingHighlightDone = true;
        }
    }

    /**
     * Hiện fillBlack cho 1 Way cụ thể trong vòng lặp cycling.
     * Được gọi khi WinPresenter emit WIN_CYCLE_ONE_WAY.
     */
    private _onCycleOneWay(way: WaysPayWin): void {
        // grid row ngược với visual row: displayRow = 2 - gridRow
        const cells: CellPos[] = way.cells.map(({ reel, row }) => ({ col: reel, row: 2 - row }));

        // Cycle từng way: chỉ play match SFX khi không popup / chưa vào Feature.
        if (this._canPlayCycleMatchSound()) {
            const n = Math.max(1, way.cells?.length ?? 1);
            const syms = Array(n).fill(way.symbolId);
            // Cycle lẻ: không play wild_layer — có Wild thì dùng high_value.
            this._playSymbolMatchSound(syms, way.containsWild || way.symbolId === SymbolId.WILD, false);
        }

        // Deactivate spine/bounce cho symbol không còn trong way mới (cả active + pending)
        // Freemode: giữ STICKY_YELLOW entries (loop spine) — không deactivate khi cycle sang way khác
        const isFreeMode = this._isFreeSpinMode();
        const nodeSet = new Set(cells.map(c => this.reels[c.col]?.symbolNodes[c.row + 1]).filter((n): n is Node => !!n));
        for (const entry of [...this._activeSpines, ...this._pendingListeners]) {
            if (!nodeSet.has(entry.symbolNode)) {
                // Freemode: STICKY_YELLOW giữ nguyên trên PaylineManager suốt toàn bộ cycle
                if (isFreeMode && entry.symId === SymbolId.STICKY_YELLOW) continue;
                this._deactivateEntry(entry);
            }
        }
        // Dọn bounce clone còn sót (không còn entry track) cho cell ngoài way hiện tại
        this._clearUntrackedBounceClones(nodeSet);
        // Cleanup orphan spine nodes trên PaylineManager (không còn entry nào track).
        // ★ Chỉ dọn node `__HLSpine_*` của highlighter — KHÔNG đụng WaysPayDisplay / WildTrail.
        if (this.paylineManagerNode) {
            const trackedSpines = new Set([...this._activeSpines, ...this._pendingListeners].map(e => e.spineNode));
            const orphans = this.paylineManagerNode.children.filter(
                child => child.name.startsWith(HL_SPINE_NAME_PREFIX) && !trackedSpines.has(child),
            );
            for (const child of orphans) {
                this._returnSpineToPool(child, this._parseHlSpineSymId(child.name));
            }
        }

        void this._runHighlightWithSpines(cells, this.lineCycleHighlightDuration, false, () => {
            this._zoomCells(cells);
        });
    }

    /**
     * Khi reel mới bắt đầu: force-clear TOÀN BỘ spine + reset fillBlack + zoom + sibling order.
     *
     * BUG CŨ: Chỉ gọi _resetHighlights() mà không clear spines → trong Quick/Turbo mode,
     * 'symbol-changed' có thể không fire nếu node không scroll đủ (reel dừng nhanh),
     * khiến spine effect của lần thắng trước kẹt lại trên symbol nodes → highlight sai symbol.
     *
     * FIX: Gọi _deactivateAllSpines() trước _resetHighlights() để đảm bảo sạch hoàn toàn.
     * Longspin hint/bonus reveal đều thuộc spin VỪA KẾT THÚC → safe to clear khi spin mới bắt đầu.
     */
    private _onReelsStartSpin(): void {
        this._spinCount++;
        this._currentLineWinCount = 0;
        if (DEBUG) console.log(`[HighlightDebug] _onReelsStartSpin #${this._spinCount}`);
        this._resetGreenTint();
        this._watchingHighlightDone = false;
        this._stopJackpotCycle();
        // Xóa jackpot cells của lần quay trước để không merge vào highlight của lần quay mới.
        this._jackpotCells = [];
        // Tăng gen để vô hiệu hóa các callback highlight cũ còn treo.
        this._spineGen++;
        // Hard-reset toàn bộ spine (active + pending) để đảm bảo sạch hoàn toàn
        // khi bắt đầu lượt quay mới — ngăn các spine giữ frame cuối còn tồn tại trên màn hình.
        this._deactivateAllSpines();
        this._resetHighlights();
        this._restoreReparentedSymbolNodes();
        this._restoreCreditLabels();
        SymbolView.restoreAllLandBounces();
        //Log.e(`[HighlightDebug #${this._spinCount}] ═══ REELS_START_SPIN — kept ${this._pendingListeners.length} pending spine(s) for scroll-out cleanup ═══`);
    }

    /** Reset về trạng thái trung tính: fillBlack alpha=0, zoom trả về defaultScale, restore sibling order */
    private _resetHighlights(): void {
        this.paylineIndicator?.resetAllIndicators();
        this._resetGreenTint();
        // Spine không bị deactivate ở đây — chỉ symbol-changed mới được restore sprite
        // Dừng zoom và reset scale về defaultScale (không hardcode 1)
        for (const n of this._zoomedNodes) {
            Tween.stopAllByTarget(n);
            const baseScale = this._getDefaultScale(n);
            n.setScale(baseScale, baseScale, 1);
        }
        this._zoomedNodes = [];

        // Ẩn fillBlack trên tất cả reels
        for (let col = 0; col < this.fillBlackNodes.length; col++) {
            const fb = this.fillBlackNodes[col];
            if (!fb) continue;
            this._setOpacity(fb, 0);
            fb.active = false;
        }
    }

    // ── SPINE HIGHLIGHT (Prefab instantiate on demand) ───────────────────────

    /**
     * Hard-reset: deactivate tất cả spine/bounce và restore sprite ngay lập tức.
     * Gọi khi đổi line cycle, spin mới, hoặc reset cứng.
     * Cuối cùng luôn force-clear clone map — bắt orphan không còn entry track
     * (nguyên nhân highlight line trước vẫn nằm trên PaylineManager).
     */
    private _deactivateAllSpines(): void {
        this._spineGen++;
        const all = [...this._activeSpines, ...this._pendingListeners];
        this._activeSpines = [];
        this._pendingListeners = [];
        for (const entry of all) {
            if (entry._onSymChanged) {
                entry.symbolNode.off('symbol-changed', entry._onSymChanged);
                entry._onSymChanged = null;
            }
            if (entry.spriteBounce) {
                this._stopSpriteBounce(entry);
                if (entry.view) entry.view.setSpriteVisible(true);
                continue;
            }
            if (entry.skel && entry.spineNode.active) entry.skel.setCompleteListener(null);
            // Destroy clone STICKY_YELLOW (freemode) thay vì restore reparent
            const clone = this._yellowClones.get(entry.symbolNode);
            if (clone && isValid(clone)) {
                Tween.stopAllByTarget(clone);
                clone.destroy();
                Log.e(`[FreeYellow] _deactivateAll DESTROY clone for ${entry.symbolNode.name}`);
            }
            this._yellowClones.delete(entry.symbolNode);
            this._yellowCloneTweens.delete(entry.symbolNode);
            if (entry.view) entry.view.setSpriteVisible(true);
            this._returnSpineToPool(entry.spineNode, entry.symId);
        }
        // Belt-and-suspenders: dọn mọi bounce/yellow clone còn sót sau khi clear entries
        this._forceClearAllHighlightClones();
        this._sweepOrphanHighlightClones();
    }

    /** Destroy mọi sprite-bounce / yellow clone còn trong map (kể cả orphan không còn entry). */
    private _forceClearAllHighlightClones(): void {
        for (const [symNode, clone] of this._spriteBounceClones) {
            if (clone && isValid(clone)) {
                Tween.stopAllByTarget(clone);
                this._bounceOrigPos.delete(clone);
                if (clone.parent) clone.removeFromParent();
                clone.destroy();
            }
            if (symNode?.isValid) {
                symNode.getComponent(SymbolView)?.setSpriteVisible(true);
            }
        }
        this._spriteBounceClones.clear();

        for (const [symNode, clone] of this._yellowClones) {
            if (clone && isValid(clone)) {
                Tween.stopAllByTarget(clone);
                clone.destroy();
            }
            if (symNode?.isValid) {
                symNode.getComponent(SymbolView)?.setSpriteVisible(true);
            }
        }
        this._yellowClones.clear();
        this._yellowCloneTweens.clear();
    }

    /**
     * Dọn bounce clone không thuộc tập cell đang giữ (ways cycle).
     * Freemode STICKY_YELLOW được giữ nguyên nếu vẫn còn entry.
     */
    private _clearUntrackedBounceClones(keepNodes: Set<Node>): void {
        for (const [symNode, clone] of [...this._spriteBounceClones]) {
            if (keepNodes.has(symNode)) continue;
            if (clone && isValid(clone)) {
                Tween.stopAllByTarget(clone);
                this._bounceOrigPos.delete(clone);
                if (clone.parent) clone.removeFromParent();
                clone.destroy();
            }
            this._spriteBounceClones.delete(symNode);
            if (symNode?.isValid) {
                symNode.getComponent(SymbolView)?.setSpriteVisible(true);
            }
        }
    }

    /** Quét node `__HLClone_*` / `__HLSpine_*` orphan trên PaylineManager (không còn trong map). */
    private _sweepOrphanHighlightClones(): void {
        if (!this.paylineManagerNode?.isValid) return;
        const tracked = new Set<Node>([
            ...this._spriteBounceClones.values(),
            ...this._yellowClones.values(),
            ...this._activeSpines.map(e => e.spineNode),
            ...this._pendingListeners.map(e => e.spineNode),
        ]);
        const orphans = this.paylineManagerNode.children.filter(
            (child) =>
                (child.name.startsWith('__HLClone_') || child.name.startsWith(HL_SPINE_NAME_PREFIX))
                && !tracked.has(child),
        );
        for (const child of orphans) {
            if (!isValid(child)) continue;
            if (child.name.startsWith(HL_SPINE_NAME_PREFIX)) {
                this._returnSpineToPool(child, this._parseHlSpineSymId(child.name));
                continue;
            }
            Tween.stopAllByTarget(child);
            this._bounceOrigPos.delete(child);
            child.destroy();
        }
    }

    private _isFreeSpinMode(): boolean {
        return GameData.instance.currentMode === 'freespin';
    }

    /** Path prefab trong MainBundle cho SymbolId (Inspector override → default map → null). */
    private _getSpinePrefabPath(symId: number): string | null {
        if (symId < 0) return null;
        const override = this.spineEffectPrefabPaths[symId];
        if (typeof override === 'string' && override.trim().length > 0) {
            return override.trim();
        }
        // STICKY_YELLOW không có SymbolSpine → fallback clone + zoom nhún (không map sang Wild)
        return DEFAULT_SPINE_PREFAB_PATHS[symId] ?? null;
    }

    /** Lazy-load 1 prefab spine theo SymbolId; cache sau lần đầu. */
    private _ensureSpinePrefab(symId: number): Promise<Prefab | null> {
        const cached = this._spinePrefabCache.get(symId);
        if (cached) return Promise.resolve(cached);
        if (this._spinePrefabMissing.has(symId)) return Promise.resolve(null);

        const path = this._getSpinePrefabPath(symId);
        if (!path) {
            this._spinePrefabMissing.add(symId);
            return Promise.resolve(null);
        }

        const inflight = this._spinePrefabLoading.get(path);
        if (inflight) {
            return inflight.then((prefab) => {
                if (prefab) this._spinePrefabCache.set(symId, prefab);
                else this._spinePrefabMissing.add(symId);
                return prefab;
            });
        }

        const promise = new Promise<Prefab | null>((resolve) => {
            const bundle = assetManager.getBundle(SPINE_BUNDLE);
            if (!bundle) {
                Log.w(`[SymbolHighlighter] Bundle '${SPINE_BUNDLE}' missing — cannot lazy-load ${path}`);
                this._spinePrefabMissing.add(symId);
                resolve(null);
                return;
            }
            bundle.load(path, Prefab, (err: Error | null, prefab: Prefab) => {
                this._spinePrefabLoading.delete(path);
                if (err || !prefab) {
                    Log.w(`[SymbolHighlighter] Lazy load failed: ${path}`, err);
                    this._spinePrefabMissing.add(symId);
                    resolve(null);
                    return;
                }
                this._spinePrefabCache.set(symId, prefab);
                this._spinePrefabMissing.delete(symId);
                Log.d(`[SymbolHighlighter] Lazy-loaded spine prefab: ${path}`);
                resolve(prefab);
            });
        });
        this._spinePrefabLoading.set(path, promise);
        return promise;
    }

    /** Đảm bảo tất cả prefab cho danh sách SymbolId đã có trong cache. */
    private async _ensureSpinePrefabs(symIds: number[]): Promise<void> {
        const unique = [...new Set(symIds.filter((id) => id >= 0 && this._getSpinePrefabPath(id) && !this._spinePrefabMissing.has(id)))];
        if (unique.length === 0) return;
        await Promise.all(unique.map((id) => this._ensureSpinePrefab(id)));
    }

    /** true nếu SymbolId có (hoặc có thể có) prefab SymbolSpine — chưa biết missing. */
    private _canTrySpine(symId: number): boolean {
        return symId >= 0 && !!this._getSpinePrefabPath(symId) && !this._spinePrefabMissing.has(symId);
    }

    /** Parse SymbolId từ tên `__HLSpine_{symId}`. */
    private _parseHlSpineSymId(name: string): number {
        if (!name.startsWith(HL_SPINE_NAME_PREFIX)) return -1;
        const id = Number(name.slice(HL_SPINE_NAME_PREFIX.length));
        return Number.isFinite(id) ? id : -1;
    }

    /** Borrow từ pool; hết pool thì instantiate từ prefab đã cache. */
    private _borrowSpineNode(symId: number): Node | null {
        const pool = this._spineNodePool.get(symId);
        if (pool) {
            while (pool.length > 0) {
                const n = pool.pop()!;
                if (n?.isValid) {
                    n.name = `${HL_SPINE_NAME_PREFIX}${symId}`;
                    n.active = false;
                    n.setScale(1, 1, 1);
                    n.setPosition(0, 0, 0);
                    n.setRotationFromEuler(0, 0, 0);
                    return n;
                }
            }
        }
        return this._spawnSpineFromPrefab(symId);
    }

    /** Instantiate spine effect từ prefab đã cache theo SymbolId. */
    private _spawnSpineFromPrefab(symId: number): Node | null {
        const prefab = this._spinePrefabCache.get(symId);
        if (!prefab) return null;
        const spineNode = instantiate(prefab);
        spineNode.name = `${HL_SPINE_NAME_PREFIX}${symId}`;
        spineNode.active = false;
        return spineNode;
    }

    /** Trả spine về pool để dùng lại (không destroy). */
    private _returnSpineToPool(spineNode: Node | null | undefined, symId: number): void {
        if (!spineNode || !spineNode.isValid) return;
        const skel = spineNode.getComponent(sp.Skeleton);
        if (skel) {
            skel.setCompleteListener(null);
            skel.clearTracks();
        }
        Tween.stopAllByTarget(spineNode);
        spineNode.active = false;
        if (spineNode.parent) spineNode.removeFromParent();
        spineNode.setParent(this.node);
        spineNode.setPosition(0, 0, 0);
        spineNode.setScale(1, 1, 1);
        spineNode.setRotationFromEuler(0, 0, 0);

        const id = symId >= 0 ? symId : this._parseHlSpineSymId(spineNode.name);
        if (id < 0) {
            spineNode.destroy();
            return;
        }
        spineNode.name = `${HL_SPINE_NAME_PREFIX}${id}`;
        let pool = this._spineNodePool.get(id);
        if (!pool) {
            pool = [];
            this._spineNodePool.set(id, pool);
        }
        if (!pool.includes(spineNode)) {
            pool.push(spineNode);
        }
    }

    /**
     * Ưu tiên:
     *   1. Mode-based timescale (spineTimeScaleNormal/Quick/Turbo) nếu > 0
     *   2. Per-symbol timescale (spineTimeScales[symId]) nếu > 0
     *   3. Tự tính từ highlightDuration để animation vừa khít 1 cycle
     */
    private _getTimeScaleForSym(symId: number, highlightDuration: number): number {
        const mode = AutoSpinManager.instance.speedMode;
        let modeScale = 0;
        if (mode === SpeedMode.NORMAL) modeScale = this.spineTimeScaleNormal;
        else if (mode === SpeedMode.QUICK) modeScale = this.spineTimeScaleQuick;
        else if (mode === SpeedMode.TURBO) modeScale = this.spineTimeScaleTurbo;
        if (modeScale > 0) return modeScale;

        const custom = this.spineTimeScales[symId] ?? 0;
        if (custom > 0) return custom;

        const BUFFER     = 0.05;
        const playWindow = Math.max(highlightDuration - BUFFER, 0.1);
        return Math.min(Math.max(this.spineAnimDuration / playWindow, 1.0), 10);
    }

    /** SymbolIds trong cells chưa có trong cache — cần load trước khi highlight. */
    private _collectNeededSpineIds(cells: Array<{ col: number; row: number }>): number[] {
        const neededIds: number[] = [];
        for (const { col, row } of cells) {
            const reel = this.reels[col];
            const symbolNode = reel?.symbolNodes[row + 1];
            if (!symbolNode) continue;
            const existing = this._findEntryOnNode(symbolNode);
            if (existing && !existing.spriteBounce) continue; // replay spine — đã có instance
            const symId = symbolNode.getComponent(SymbolView)?.symbolId ?? -1;
            if (this._canTrySpine(symId) && !this._spinePrefabCache.has(symId)) {
                neededIds.push(symId);
            }
        }
        return neededIds;
    }

    /**
     * Chờ prefab spine sẵn sàng, rồi mới fillBlack + spawn spine cùng lúc.
     * Tránh visual lỗi: fillBlack/WaysPay hiện trước, Wild spine (11) delay vì lazy-load.
     */
    private _runHighlightWithSpines(
        cells: CellPos[],
        highlightDuration: number,
        loopSpine: boolean = false,
        beforeSpawn?: () => void,
    ): Promise<void> {
        const gen = this._spineGen;
        const neededIds = this._collectNeededSpineIds(cells);
        const run = (): void => {
            if (gen !== this._spineGen || !this.isValid) return;
            this._applyHighlight(cells);
            beforeSpawn?.();
            this._activateSpinesForCellsSync(cells, highlightDuration, loopSpine);
        };
        if (neededIds.length === 0) {
            run();
            return Promise.resolve();
        }
        return this._ensureSpinePrefabs(neededIds).then(run);
    }

    /**
     * Với mỗi winning cell:
     *   - Có prefab trong SymbolSpine → borrow từ pool (hoặc instantiate) rồi play spine.
     *   - Không có prefab → giữ sprite, nhún nhẹ (bounce) như trước.
     *   - Nếu node đã có spine active (từ lần highlight trước) → replay animation.
     *   - Animation xong: move sang _pendingListeners, spine GIỮ frame cuối trên node.
     *   - symbol-changed: điều kiện DUY NHẤT để trả spine về pool + restore sprite.
     *
     * @returns Promise resolve khi spawn sync đã chạy xong (sau lazy-load nếu cần).
     */
    private _activateSpinesForCells(cells: CellPos[], highlightDuration: number, loopSpine: boolean = false): Promise<void> {
        const neededIds = this._collectNeededSpineIds(cells);
        if (neededIds.length === 0) {
            this._activateSpinesForCellsSync(cells, highlightDuration, loopSpine);
            return Promise.resolve();
        }

        const gen = this._spineGen;
        return this._ensureSpinePrefabs(neededIds).then(() => {
            if (gen !== this._spineGen) return; // spin/highlight mới đã hủy request này
            if (!this.isValid) return;
            this._activateSpinesForCellsSync(cells, highlightDuration, loopSpine);
        });
    }

    /** Phần sync sau khi prefab đã sẵn sàng (hoặc sprite-bounce fallback). */
    private _activateSpinesForCellsSync(cells: CellPos[], highlightDuration: number, loopSpine: boolean = false): void {
        // KHÔNG gọi _deactivateAllSpines — spine từ cycle trước vẫn tiếp tục giữ frame cuối
        if (DEBUG) console.log(`[HighlightDebug] _activateSpinesForCells cells=[${cells.map(c=>`(${c.col},${c.row})`).join(',')}]`);

        for (const { col, row } of cells) {
            const reel = this.reels[col];
            if (!reel) continue;
            const symbolNode = reel.symbolNodes[row + 1];
            if (!symbolNode) continue;

            const view  = symbolNode.getComponent(SymbolView);
            const symId = view?.symbolId ?? -1;

            const existing = this._findEntryOnNode(symbolNode);

            // FreeSpin: STICKY_YELLOW (đồng xu vàng tính như wild) → green tint thay vì spine
            if (this._shouldUseGreenTint(symId)) {
                if (existing) {
                    this._deactivateEntry(existing);
                }
                this._applyGreenTint(symbolNode);
                continue;
            }

            // Không có SymbolSpine prefab → bounce bằng code (giữ hành vi cũ)
            if (!this._canTrySpine(symId) || !this._spinePrefabCache.has(symId)) {
                this._activateSpriteBounceForCell(symbolNode, view, symId, highlightDuration, loopSpine, existing);
                continue;
            }

            // Đang bounce mà giờ đã có spine → chuyển sang spine
            if (existing?.spriteBounce) {
                this._deactivateEntry(existing);
            } else if (existing) {
                if (DEBUG) console.log(`[HighlightDebug] cell(${col},${row}) EXISTING → REPLAY`);
                const ts = this._getTimeScaleForSym(existing.symId, highlightDuration);
                this._replayEntry(existing, ts);
                // Freemode + STICKY_YELLOW: clone symbolNode cho paylineManagerNode
                const isFreeYellowExisting = existing.symId === SymbolId.STICKY_YELLOW && this._isFreeSpinMode();
                if (isFreeYellowExisting && this.paylineManagerNode) {
                    let clone = this._yellowClones.get(symbolNode);
                    if (!clone || !isValid(clone)) {
                        clone = instantiate(symbolNode);
                        this._yellowClones.set(symbolNode, clone);
                        Log.e(`[FreeYellow] REPLAY clone col=${col} row=${row}`);
                    }
                    const sv = symbolNode.getComponent(SymbolView);
                    const symScale = sv?.getBaseScale() ?? 1;
                    clone.setScale(symScale, symScale, 1);
                    clone.setParent(this.paylineManagerNode, true);
                    clone.setWorldPosition(symbolNode.getWorldPosition());
                    clone.setSiblingIndex(this.paylineManagerNode.children.length - 1);
                    clone.active = true;
                    // Nhún zoom nhẹ lên xuống loop trên clone
                    const oldTween2 = this._yellowCloneTweens.get(symbolNode);
                    if (oldTween2) { oldTween2.stop(); this._yellowCloneTweens.delete(symbolNode); }
                    const t2 = tween(clone)
                        .to(0.35, { scale: new Vec3(symScale * 1.08, symScale * 1.08, 1) }, { easing: 'sineOut' })
                        .to(0.35, { scale: new Vec3(symScale, symScale, 1) }, { easing: 'sineIn' })
                        .union()
                        .repeatForever()
                        .start();
                    this._yellowCloneTweens.set(symbolNode, t2);
                }
                continue;
            }

            // Nếu trail/impact spine đang chạy → để nó tự kết thúc,
            // không xóa. SymbolHighlighter sẽ spawn spine highlight của riêng mình lên trên.
            // Chỉ destroy nếu spine đó không còn active (đã freeze ở frame cuối).
            const wildTrailSpine = this._findSpineNodeOnNode(symbolNode);
            if (wildTrailSpine && !wildTrailSpine.active && !wildTrailSpine.name.startsWith(HL_SPINE_NAME_PREFIX)) {
                wildTrailSpine.destroy();
                if (view) view.setSpriteVisible(true);
            }

            if (symId < 0) {
                if (DEBUG) console.log(`[HighlightDebug] cell(${col},${row}) SKIP invalid symId`);
                continue;
            }

            const spineNode = this._borrowSpineNode(symId);
            if (!spineNode) {
                if (DEBUG) console.log(`[HighlightDebug] cell(${col},${row}) SKIP no prefab for symId=${symId}`);
                // Prefab chưa có / load fail → fallback bounce để vẫn có feedback
                this._activateSpriteBounceForCell(symbolNode, view, symId, highlightDuration, loopSpine, null);
                continue;
            }

            // Freemode + STICKY_YELLOW: giữ sprite visible, reparent symbolNode lên paylineManagerNode
            // để nằm trên spine effect highlight (sibling index cao hơn).
            // Các symbol khác: ẩn sprite — spine thay thế hoàn toàn.
            const isFreeYellow = symId === SymbolId.STICKY_YELLOW && this._isFreeSpinMode();
            // Freemode + STICKY_YELLOW (khi có spine): giữ sprite visible, clone nằm trên effect.
            // Không có spine → đã fallback bounce ở trên (clone + zoom nhún).
            if (!isFreeYellow) {
                if (view) view.setSpriteVisible(false);
            }

            const posX = this.spineLocalPosX[symId] ?? 0;
            const posY = this.spineLocalPosY[symId] ?? 0;

            if (this.paylineManagerNode) {
                // Parent vào PaylineManager để nằm trên cùng, tách biệt reel
                spineNode.setParent(this.paylineManagerNode, false);
                spineNode.setWorldPosition(symbolNode.getWorldPosition());
                // Chỉ Wild được đẩy lên sibling index cao nhất; các symbol khác giữ mặc định append
                if (symId === SymbolId.WILD) {
                    spineNode.setSiblingIndex(this.paylineManagerNode.children.length - 1);
                }
                if (posX !== 0 || posY !== 0) {
                    spineNode.setPosition(spineNode.position.x + posX, spineNode.position.y + posY, spineNode.position.z);
                }
                // Freemode + STICKY_YELLOW: clone symbolNode cho paylineManagerNode,
                // sibling index cao hơn spine effect để clone nằm trên effect highlight.
                if (isFreeYellow) {
                    let clone = this._yellowClones.get(symbolNode);
                    if (!clone || !isValid(clone)) {
                        clone = instantiate(symbolNode);
                        this._yellowClones.set(symbolNode, clone);
                        Log.e(`[FreeYellow] NEW clone col=${col} row=${row}`);
                    }
                    const symScale = view?.getBaseScale() ?? 1;
                    clone.setScale(symScale, symScale, 1);
                    clone.setParent(this.paylineManagerNode, true);
                    clone.setWorldPosition(symbolNode.getWorldPosition());
                    clone.setSiblingIndex(this.paylineManagerNode.children.length - 1);
                    clone.active = true;
                    // Nhún zoom nhẹ lên xuống loop trên clone
                    const oldTween2 = this._yellowCloneTweens.get(symbolNode);
                    if (oldTween2) { oldTween2.stop(); this._yellowCloneTweens.delete(symbolNode); }
                    const t2 = tween(clone)
                        .to(0.35, { scale: new Vec3(symScale * 1.08, symScale * 1.08, 1) }, { easing: 'sineOut' })
                        .to(0.35, { scale: new Vec3(symScale, symScale, 1) }, { easing: 'sineIn' })
                        .union()
                        .repeatForever()
                        .start();
                    this._yellowCloneTweens.set(symbolNode, t2);
                    Log.e(`[FreeYellow] NEW DONE col=${col} row=${row} cloneSib=${clone.getSiblingIndex()} total=${this.paylineManagerNode.children.length}`);
                } else if (symId === SymbolId.STICKY_YELLOW) {
                    // Base game: reparent CreditLabel lên paylineManagerNode
                    this._reparentCreditLabel(symbolNode);
                }
            } else {
                spineNode.setParent(symbolNode, false);
                spineNode.setSiblingIndex(0);
                spineNode.setPosition(posX, posY, 0);
            }
            spineNode.active = true;
            if (DEBUG) console.log(`[HighlightDebug] cell(${col},${row}) CREATE spine from prefab symId=${symId}`);

            const skel = spineNode.getComponent(sp.Skeleton);
            const entry: ActiveSpineEntry = {
                spineNode,
                skel:         skel ?? null,
                view:         view ?? null,
                symId,
                symbolNode,
                _onSymChanged: null,
                loop:         false,
                gen:          this._spineGen,
            };
            this._activeSpines.push(entry);

            // Wild: loop trong suốt thời gian highlight (chỉ deactivate khi _deactivateEntry/_deactivateAllSpines)
            // Các symbol khác: loop nếu loopSpine=true, STICKY_YELLOW luôn loop
            const shouldLoop = symId === SymbolId.WILD || (symId !== SymbolId.WILD && loopSpine) || symId === SymbolId.STICKY_YELLOW;
            entry.loop = shouldLoop;
            const timeScale = this._getTimeScaleForSym(symId, highlightDuration);
            if (skel) {
                skel.timeScale = timeScale;
                skel.clearTrack(0);
                skel.setAnimation(0, this._getSpineAnimName(symId), shouldLoop); // STICKY_YELLOW luôn loop

                if (!shouldLoop) {
                    // Animation xong: clear listener, GIỮ frame cuối, chuyển sang pending
                    const completeGen = entry.gen;
                    skel.setCompleteListener(() => {
                        this._onSpineComplete(entry, completeGen);
                    });
                }
            }

            const onSymChanged = () => this._onEntrySymbolChanged(entry);
            entry._onSymChanged = onSymChanged;
            symbolNode.on('symbol-changed', onSymChanged);
        }

        // Đẩy tất cả Wild spine lên sibling index cao nhất trong paylineManagerNode
        // để đảm bảo Wild luôn nằm trên cùng so với mọi spine khác bất kể thứ tự thêm.
        if (this.paylineManagerNode) {
            const allEntries = [...this._activeSpines, ...this._pendingListeners];
            for (const entry of allEntries) {
                if (entry.symId === SymbolId.WILD && entry.spineNode.isValid && entry.spineNode.parent === this.paylineManagerNode) {
                    entry.spineNode.setSiblingIndex(this.paylineManagerNode.children.length - 1);
                }
            }
            // Đẩy tất cả STICKY_YELLOW clones lên TRÊN CÙNG (sau Wild)
            // — do vòng lặp xử lý từng cell tuần tự, spine của cell sau sẽ đè lên clone của cell trước.
            // Pass thứ 2 này đảm bảo tất cả clone đều nằm trên tất cả spine effects.
            for (const [, clone] of this._yellowClones) {
                if (isValid(clone) && clone.parent === this.paylineManagerNode) {
                    clone.setSiblingIndex(this.paylineManagerNode.children.length - 1);
                }
            }
        }
    }

    /**
     * Clone symbol lên WaysPayDisplay để bounce nằm trên fillBlack.
     * Symbol gốc trên reel được ẩn sprite trong lúc clone đang chạy.
     */
    private _ensureSpriteBounceClone(symbolNode: Node, view: SymbolView | null): Node {
        // Nếu symbol đang land-bounce trên WaysPayDisplay → kéo về reel / destroy clone trước
        SymbolView.restoreLandBounceIfNeeded(symbolNode);

        if (!this.paylineManagerNode?.isValid) return symbolNode;

        let clone = this._spriteBounceClones.get(symbolNode);
        if (!clone || !isValid(clone)) {
            clone = instantiate(symbolNode);
            clone.name = `__HLClone_r${view?.reelIndex ?? '?'}_row${view?.rowIndex ?? '?'}`;
            this._spriteBounceClones.set(symbolNode, clone);
        }

        const baseScale = view?.getBaseScale() ?? this._getDefaultScale(symbolNode);
        clone.setScale(baseScale, baseScale, 1);
        clone.setParent(this.paylineManagerNode, true);
        clone.setWorldPosition(symbolNode.getWorldPosition());
        clone.setSiblingIndex(this.paylineManagerNode.children.length - 1);
        clone.active = true;
        view?.setSpriteVisible(false);
        return clone;
    }

    private _destroySpriteBounceClone(symbolNode: Node): void {
        const clone = this._spriteBounceClones.get(symbolNode);
        if (clone && isValid(clone)) {
            Tween.stopAllByTarget(clone);
            this._bounceOrigPos.delete(clone);
            if (clone.parent) clone.removeFromParent();
            clone.destroy();
        }
        this._spriteBounceClones.delete(symbolNode);
        if (symbolNode?.isValid) {
            symbolNode.getComponent(SymbolView)?.setSpriteVisible(true);
        }
    }

    /** Sprite bounce fallback khi không có prefab SymbolSpine cho SymbolId. */
    private _activateSpriteBounceForCell(
        symbolNode: Node,
        view: SymbolView | null,
        symId: number,
        highlightDuration: number,
        loopSpine: boolean,
        existing: ActiveSpineEntry | null,
    ): void {
        const shouldLoop = symId === SymbolId.WILD || loopSpine || symId === SymbolId.STICKY_YELLOW;

        if (existing) {
            if (!existing.spriteBounce) {
                this._deactivateEntry(existing);
                existing = null;
            } else {
                existing.loop = shouldLoop;
                existing.gen = this._spineGen;
                this._startSpriteBounce(existing, highlightDuration);
                const pendIdx = this._pendingListeners.indexOf(existing);
                if (pendIdx >= 0) {
                    this._pendingListeners.splice(pendIdx, 1);
                    this._activeSpines.push(existing);
                }
                return;
            }
        }

        if (symId < 0) return;
        view?.setSpriteVisible(true);

        const entry: ActiveSpineEntry = {
            spineNode:  symbolNode,
            skel:       null,
            view,
            symId,
            symbolNode,
            _onSymChanged: null,
            loop:       shouldLoop,
            gen:        this._spineGen,
            spriteBounce: true,
        };
        this._activeSpines.push(entry);
        this._startSpriteBounce(entry, highlightDuration);

        const onSymChanged = () => this._onEntrySymbolChanged(entry);
        entry._onSymChanged = onSymChanged;
        symbolNode.on('symbol-changed', onSymChanged);
    }

    private _startSpriteBounce(entry: ActiveSpineEntry, highlightDuration: number): void {
        const symbolNode = entry.symbolNode;
        if (!symbolNode?.isValid) return;

        const bounceNode = this._ensureSpriteBounceClone(symbolNode, entry.view);
        entry.spineNode = bounceNode;

        Tween.stopAllByTarget(bounceNode);
        const baseScale = entry.view?.getBaseScale() ?? this._getDefaultScale(symbolNode);
        bounceNode.setScale(baseScale, baseScale, 1);

        if (!this._bounceOrigPos.has(bounceNode)) {
            this._bounceOrigPos.set(bounceNode, bounceNode.position.clone());
        }
        const origPos = this._bounceOrigPos.get(bounceNode)!;
        bounceNode.setPosition(origPos);

        const dur = Math.max(0.18, Math.min(0.32, highlightDuration * 0.12));
        const liftY = 10;
        const bounceOnce = tween(bounceNode)
            .to(dur, {
                position: new Vec3(origPos.x, origPos.y + liftY, origPos.z),
                scale: new Vec3(baseScale * 1.05, baseScale * 1.05, 1),
            }, { easing: 'sineOut' })
            .to(dur, {
                position: origPos,
                scale: new Vec3(baseScale, baseScale, 1),
            }, { easing: 'sineIn' });

        if (entry.loop) {
            bounceOnce.union().repeatForever().start();
            return;
        }

        const completeGen = entry.gen;
        bounceOnce.call(() => this._onSpriteBounceComplete(entry, completeGen)).start();
    }

    private _stopSpriteBounce(entry: ActiveSpineEntry): void {
        const symbolNode = entry.symbolNode;
        const bounceNode = entry.spineNode;

        // Luôn stop tween + destroy clone — kể cả khi symbolNode đã invalid,
        // tránh orphan `__HLClone_*` nằm lại trên PaylineManager.
        if (bounceNode?.isValid && bounceNode !== symbolNode) {
            Tween.stopAllByTarget(bounceNode);
        } else if (symbolNode?.isValid) {
            Tween.stopAllByTarget(symbolNode);
        }

        if (symbolNode) {
            this._destroySpriteBounceClone(symbolNode);
        } else if (bounceNode?.isValid && bounceNode !== symbolNode) {
            Tween.stopAllByTarget(bounceNode);
            this._bounceOrigPos.delete(bounceNode);
            if (bounceNode.parent) bounceNode.removeFromParent();
            bounceNode.destroy();
        }

        if (symbolNode?.isValid) {
            const baseScale = entry.view?.getBaseScale() ?? this._getDefaultScale(symbolNode);
            symbolNode.setScale(baseScale, baseScale, 1);
            entry.spineNode = symbolNode;
        }
    }

    private _onSpriteBounceComplete(entry: ActiveSpineEntry, gen: number): void {
        if (gen !== this._spineGen) return;

        const idx = this._activeSpines.indexOf(entry);
        if (idx < 0) return;

        this._activeSpines.splice(idx, 1);
        // Luôn giữ entry trong pending để cycle line sau còn track được clone "frame cuối"
        if (!this._pendingListeners.includes(entry)) {
            this._pendingListeners.push(entry);
        }

        const nonWildActive = this._activeSpines.filter(e => e.symId !== SymbolId.WILD);
        if (this._watchingHighlightDone && nonWildActive.length === 0) {
            this._watchingHighlightDone = false;
            EventBus.instance.emit(GameEvents.WIN_HIGHLIGHT_ANIM_DONE);
        }
    }

    /** Tìm entry đang giữ spine trên symbolNode (active hoặc pending). */
    private _findEntryOnNode(symbolNode: Node): ActiveSpineEntry | null {
        return this._activeSpines.find(e => e.symbolNode === symbolNode)
            ?? this._pendingListeners.find(e => e.symbolNode === symbolNode)
            ?? null;
    }

    /** Trả về tên animation spine cho symbol — WILD highlight dùng "win1", các symbol khác dùng spineAnimName. */
    private _getSpineAnimName(symId: number): string {
        return symId === SymbolId.WILD ? 'win1' : this.spineAnimName;
    }

    /**
     * Play lại animation trên entry đã có (không tạo spine mới).
     * Đưa entry về _activeSpines nếu đang ở _pendingListeners.
     */
    private _replayEntry(entry: ActiveSpineEntry, timeScale: number): void {
        const skel = entry.skel;
        if (DEBUG) console.log(`[HighlightDebug] _replayEntry symId=${entry.symId}`);
        if (!skel) return;

        // Đảm bảo spine vẫn active (pending entries đã bị deactivate chưa? Không nữa)
        if (!entry.spineNode.active) entry.spineNode.active = true;

        // Wild: luôn loop khi highlight (nhất quán với logic tạo mới)
        const shouldLoop = entry.symId === SymbolId.WILD || (entry.symId !== SymbolId.WILD && entry.loop) || entry.symId === SymbolId.STICKY_YELLOW;
        entry.gen = this._spineGen;
        skel.timeScale = timeScale;
        skel.clearTrack(0);
        skel.setAnimation(0, this._getSpineAnimName(entry.symId), shouldLoop);

        // Đặt lại setCompleteListener (chỉ nếu không loop)
        if (!shouldLoop) {
            const completeGen = entry.gen;
            skel.setCompleteListener(() => {
                this._onSpineComplete(entry, completeGen);
            });
        }

        // Move từ pending → active nếu cần
        const pendIdx = this._pendingListeners.indexOf(entry);
        if (pendIdx >= 0) {
            this._pendingListeners.splice(pendIdx, 1);
            this._activeSpines.push(entry);
        }
    }

    private _onSpineComplete(entry: ActiveSpineEntry, gen: number): void {
        if (gen !== this._spineGen) return;
        if (entry.skel && entry.spineNode.active) entry.skel.setCompleteListener(null);

        const idx = this._activeSpines.indexOf(entry);
        if (idx < 0) return;

        this._activeSpines.splice(idx, 1);
        // Luôn giữ entry trong pending — spine giữ frame cuối phải được track để cycle line clear được
        if (!this._pendingListeners.includes(entry)) {
            this._pendingListeners.push(entry);
        }

        // Wild loop mãi nên không bao giờ fire complete — chỉ đếm non-Wild entries khi quyết định done.
        const nonWildActive = this._activeSpines.filter(e => e.symId !== SymbolId.WILD);
        if (this._watchingHighlightDone && nonWildActive.length === 0) {
            this._watchingHighlightDone = false;
            EventBus.instance.emit(GameEvents.WIN_HIGHLIGHT_ANIM_DONE);
        }
    }

    /**
     * Callback từ 'symbol-changed' trên symbolNode.
     * Node đã scroll ra ngoài vùng mask và được wrap lên đầu với symbol mới.
     * Đây là điều kiện DUY NHẤT để restore sprite và deactivate spine.
     * Không có gen check — luôn thực hiện bất kể cycle hiện tại là gì.
     */
    private _onEntrySymbolChanged(entry: ActiveSpineEntry): void {
        if (DEBUG) console.log(`[HighlightDebug] _onEntrySymbolChanged symId=${entry.symId}`);
        // Reset green tint nếu node đang tinted
        this._resetGreenTintForNode(entry.symbolNode);

        // Gỡ listener
        if (entry._onSymChanged) {
            entry.symbolNode.off('symbol-changed', entry._onSymChanged);
            entry._onSymChanged = null;
        }
        if (entry.skel && entry.spineNode.active) entry.skel.setCompleteListener(null);

        // Destroy clone STICKY_YELLOW (freemode) thay vì restore reparent
        const clone = this._yellowClones.get(entry.symbolNode);
        if (clone && isValid(clone)) {
            Tween.stopAllByTarget(clone);
            clone.destroy();
        }
        this._yellowClones.delete(entry.symbolNode);
        this._yellowCloneTweens.delete(entry.symbolNode);

        // Restore sprite
        if (entry.view) entry.view.setSpriteVisible(true);

        if (entry.spriteBounce) {
            this._stopSpriteBounce(entry);
            let idx = this._activeSpines.indexOf(entry);
            if (idx >= 0) this._activeSpines.splice(idx, 1);
            idx = this._pendingListeners.indexOf(entry);
            if (idx >= 0) this._pendingListeners.splice(idx, 1);
            return;
        }

        this._returnSpineToPool(entry.spineNode, entry.symId);

        // Xóa khỏi cả 2 danh sách
        let idx = this._activeSpines.indexOf(entry);
        if (idx >= 0) this._activeSpines.splice(idx, 1);
        idx = this._pendingListeners.indexOf(entry);
        if (idx >= 0) this._pendingListeners.splice(idx, 1);
    }

    // ── FREE SPIN GREEN TINT HELPERS ─────────────────────────────────────────

    private _shouldUseGreenTint(symId: number): boolean {
        return false;
    }

    private _applyGreenTint(symbolNode: Node): void {
        const spr = symbolNode.getComponent(Sprite) ?? symbolNode.getComponentInChildren(Sprite);
        if (!spr) return;
        spr.color = new Color(0x77, 0xFF, 0x42, 255);
        // Chỉ zoom tween LẦN ĐẦU tiên trong spin — nếu node đã tinted rồi thì giữ scale hiện tại
        if (this._greenTintedNodes.includes(symbolNode)) return;
        this._greenTintedNodes.push(symbolNode);
        // Zoom up cho coin vàng — scale lên 1.15 và GIỮ NGUYÊN cho tới lượt tiếp theo
        const view = symbolNode.getComponent(SymbolView);
        const baseScale = view?.getBaseScale() ?? 1;
        const s = 1.15; // hardcode zoom scale cho gold coin, không phụ thuộc inspector
        const d = this.cellZoomDuration;
        Tween.stopAllByTarget(symbolNode);
        symbolNode.setScale(baseScale, baseScale, 1);
        tween(symbolNode)
            .to(d, { scale: new Vec3(s * baseScale, s * baseScale, 1) }, { easing: 'backOut' })
            .start();
    }

    private _resetGreenTintForNode(node: Node): void {
        const idx = this._greenTintedNodes.indexOf(node);
        if (idx < 0) return;
        this._greenTintedNodes.splice(idx, 1);
        if (!node.isValid) return;
        const spr = node.getComponent(Sprite) ?? node.getComponentInChildren(Sprite);
        if (spr) spr.color = Color.WHITE.clone();
        // Không reset scale — coin giữ nguyên zoom 1.15 cho tới lượt tiếp theo
        Tween.stopAllByTarget(node);
    }

    private _resetGreenTint(): void {
        for (const node of this._greenTintedNodes) {
            if (!node.isValid) continue;
            const spr = node.getComponent(Sprite) ?? node.getComponentInChildren(Sprite);
            if (spr) spr.color = Color.WHITE.clone();
            // Không reset scale — coin giữ nguyên zoom 1.15 cho tới lượt tiếp theo
            Tween.stopAllByTarget(node);
        }
        this._greenTintedNodes = [];
    }

    private _deactivateEntry(entry: ActiveSpineEntry): void {
        if (entry._onSymChanged) {
            entry.symbolNode.off('symbol-changed', entry._onSymChanged);
            entry._onSymChanged = null;
        }
        if (entry.spriteBounce) {
            this._stopSpriteBounce(entry);
            if (entry.view) entry.view.setSpriteVisible(true);
            let idx = this._activeSpines.indexOf(entry);
            if (idx >= 0) this._activeSpines.splice(idx, 1);
            idx = this._pendingListeners.indexOf(entry);
            if (idx >= 0) this._pendingListeners.splice(idx, 1);
            return;
        }
        if (entry.skel && entry.spineNode.active) entry.skel.setCompleteListener(null);
        // Destroy clone STICKY_YELLOW (freemode) thay vì restore reparent
        const clone = this._yellowClones.get(entry.symbolNode);
        if (clone && isValid(clone)) {
            Tween.stopAllByTarget(clone);
            clone.destroy();
        }
        this._yellowClones.delete(entry.symbolNode);
        this._yellowCloneTweens.delete(entry.symbolNode);
        if (entry.view) entry.view.setSpriteVisible(true);
        this._returnSpineToPool(entry.spineNode, entry.symId);
        let idx = this._activeSpines.indexOf(entry);
        if (idx >= 0) this._activeSpines.splice(idx, 1);
        idx = this._pendingListeners.indexOf(entry);
        if (idx >= 0) this._pendingListeners.splice(idx, 1);
    }

    // ── CORE HIGHLIGHT LOGIC ─────────────────────────────────────────────────

    /**
     * Reset fillBlack và sibling order cho 1 reel cụ thể.
     * Dùng khi reel đó không có symbol nào thắng trong cycle hiện tại
     * (tránh lưu lại fillBlack state từ cycle/lần quay trước).
     */
    private _resetReelHighlight(col: number): void {
        const fb = this.fillBlackNodes[col];
        if (!fb) return;
        this._setOpacity(fb, 0);
        fb.active = false;
    }

    private _applyHighlight(winningCells: CellPos[]): void {
        if (DEBUG) console.log(`[SymHighlight] _applyHighlight: cells=[${winningCells.map(c => `col${c.col}:row${c.row}`).join(',')}]`);

        // Jackpot được xử lý như 1 line thường qua WinPresenter cycling —
        // KHÔNG merge _jackpotCells vào mọi lần highlight. Mỗi line cycle chỉ
        // highlight đúng cells của line đó; jackpot symbols sẽ bị dim khi line
        // khác đang được cycle (giống behavior các line thường).
        for (let col = 0; col < this.fillBlackNodes.length; col++) {
            const fillBlack = this.fillBlackNodes[col];
            if (!fillBlack) continue;

            fillBlack.active = true;

            // Chỉ fade in lần đầu tiên (khi alpha đang = 0).
            const currentAlpha = this._getUIOpacity(fillBlack).opacity;
            if (currentAlpha < this.fillAlpha) {
                this._fadeOpacity(fillBlack, currentAlpha, this.fillAlpha, this.fadeDuration);
            }
        }
    }

    // ── ZOOM ANIMATION ────────────────────────────────────────────────────────

    private _zoomCells(cells: CellPos[]): void {
        if (DEBUG) console.log(`[HighlightDebug] _zoomCells cells=[${cells.map(c=>`(${c.col},${c.row})`).join(',')}]`);
        for (const { col, row } of cells) {
            const reel = this.reels[col];
            const node = reel?.symbolNodes[row + 1] as Node | undefined;
            // zooming
        }
        // Dừng zoom cũ — reset về defaultScale
        for (const n of this._zoomedNodes) {
            SymbolView.restoreLandBounceIfNeeded(n);
            Tween.stopAllByTarget(n);
            const baseScale = this._getDefaultScale(n);
            n.setScale(baseScale, baseScale, 1);
        }
        this._zoomedNodes = [];

        const s = this.cellZoomScale;
        const d = this.cellZoomDuration;

        for (const { col, row } of cells) {
            const reel = this.reels[col];
            if (!reel) continue;
            const node = reel.symbolNodes[row + 1] as Node | undefined;
            if (!node) continue;

            SymbolView.restoreLandBounceIfNeeded(node);
            this._zoomedNodes.push(node);
            const baseScale = this._getDefaultScale(node);
            node.setScale(baseScale, baseScale, 1);
            tween(node)
                .to(d, { scale: new Vec3(s * baseScale, s * baseScale, 1) }, { easing: 'backOut' })
                .to(d, { scale: new Vec3(baseScale, baseScale, 1) }, { easing: 'sineOut' })
                .call(() => {
                    node.setScale(baseScale, baseScale, 1);
                })
                .start();
        }
    }

    // ── FEATURE GAME MODE HANDLERS ────────────────────────────────────────────

    /** Vào Feature/Free Bonus game → cập nhật indicator highlight frame và cleanup spine/highlight cũ */
    private _onFeatureGameStart(): void {
        this.paylineIndicator?.setFeatureGameMode(true);
        // Cleanup toàn bộ spine và highlight còn sót từ base game —
        // đảm bảo khi vào feature mode không còn Wild spine effect nào dính lại.
        this._deactivateAllSpines();
        this._resetHighlights();
        this._restoreReparentedSymbolNodes();
        this._restoreCreditLabels();
        this._jackpotCells = [];
    }

    /** Thoát Feature/Free Bonus game → quay lại Base Game frame */
    private _onFeatureGameEnd(): void {
        this.paylineIndicator?.setFeatureGameMode(false);
        // Cleanup toàn bộ spine và highlight còn sót từ feature —
        // đảm bảo reel normal mode không còn đồng tiền vàng highlight dính trên màn hình.
        this._deactivateAllSpines();
        this._resetHighlights();
        this._restoreReparentedSymbolNodes();
        this._restoreCreditLabels();
        SymbolView.restoreAllLandBounces();
        this._jackpotCells = [];
    }

    /** Popup Select Feature hiện lên → cleanup spine/credit labels ngay (sớm hơn FREE_SPIN_START) */
    private _onFeatureSelectOpen(): void {
        this._clearAllWinHighlightRuntime();
    }

    /** Tắt hẳn highlight trước khi feature red bounce / credit fly. */
    private _onWinHighlightClear(): void {
        this._clearAllWinHighlightRuntime();
    }

    private _clearAllWinHighlightRuntime(): void {
        this._watchingHighlightDone = false;
        this._stopJackpotCycle();
        this._deactivateAllSpines();
        this._resetHighlights();
        this._restoreReparentedSymbolNodes();
        this._restoreCreditLabels();
        SymbolView.restoreAllLandBounces();
        this._jackpotCells = [];
    }

    /** PickGame can interrupt normal win cycling; clear all line highlight runtime state. */
    private _onPickGameBoundary(): void {
        this._clearAllWinHighlightRuntime();
    }

    // ── LONG SPIN HINT ────────────────────────────────────────────────────────

    /**
     * Khi 1 reel hint dừng: phát spine effect 1 lần (dừng ở frame cuối).
     * payload: [{reelIndex, rowIndex}] (luôn là 1 phần tử — emit per-reel)
     */
    private _onLongSpinHintShow(positions: { reelIndex: number; rowIndex: number }[]): void {
        const cells: CellPos[] = positions.map(p => ({ col: p.reelIndex, row: this._toDisplayRow(p.rowIndex) }));
        if (cells.length === 0) return;
        // Log.e(`[SPIN-HANG][WinHL] LONG_SPIN_HINT_SHOW cells=${cells.map(c => `r${c.col}row${c.row}`).join(',')}`);
        // duration=10 → timeScale=1.0 (tốc độ animation bình thường)
        // Hint chỉ được emit SAU onStopComplete — an toàn tween/spine trên symbol node
        this._activateSpinesForCells(cells, 10.0);
    }

    /**
     * Jackpot xác nhận: replay spine trên 3 symbol cùng lúc.
     * Được emit cho mọi loại jackpot (long spin hoặc không) để đảm bảo spines luôn active.
     * payload: [{reel0}, {reel1}, {reel2}]
     */
    private _onLongSpinJackpotReveal(positions: { reelIndex: number; rowIndex: number }[], _jackpot?: number): void {
        const cells: CellPos[] = positions.map(p => ({ col: p.reelIndex, row: this._toDisplayRow(p.rowIndex) }));
        // Lưu lại cells để dùng khi loop sau popup đóng
        this._jackpotCells = cells;
        if (cells.length === 0) return;
        void this._runHighlightWithSpines(cells, 10.0, false);
    }

    /**
     * Sau jackpot popup đóng: nhường hoàn toàn cho WinPresenter cycling.
     * WinPresenter._onJackpotEndForCycle() đã được gọi TRƯỚC (đăng ký trước) —
     * đã emit WIN_SHOW_ALL_LINES và schedule _startLineCycle cho tất cả lines (kể cả jackpot line).
     * Handler này chỉ emit JACKPOT_LOOP_START (cho PayOutDisplay/các component khác) rồi return;
     * không chạy loop jackpot riêng để tránh xung đột với WinPresenter cycling.
     */
    private _onJackpotEndHighlight(): void {
        if (this._jackpotCells.length === 0) return;
        this._stopJackpotCycle();

        // Báo cho PayOutDisplay và các component khác xóa hiệu ứng jackpot
        EventBus.instance.emit(GameEvents.JACKPOT_LOOP_START);

        // WinPresenter hoàn toàn kiểm soát cycling (bao gồm cả jackpot line).
        // Không reset highlight và không loop riêng ở đây.
    }

    private _stopJackpotCycle(): void {
        if (this._jackpotCycleCallback) {
            this.unschedule(this._jackpotCycleCallback);
            this._jackpotCycleCallback = null;
        }
    }

    /**
     * Bonus trigger: phát spine highlight trên symbol Bonus (col 2) trước FreeSpinPopup.
     * Reset fillBlack/highlight win trước — để bonus animation hiển thị rõ không bị che.
     */
    private _onBonusReveal(positions: { reelIndex: number; rowIndex: number }[]): void {
        const cells: CellPos[] = positions.map(p => ({ col: p.reelIndex, row: this._toDisplayRow(p.rowIndex) }));
        if (cells.length === 0) return;
        // Xóa highlight win (fillBlack) trước để bonus symbol không bị dim bởi các reel khác
        this._resetHighlights();
        this._activateSpinesForCells(cells, 2.0);
    }

    // ── HELPERS ──────────────────────────────────────────────────────────────

    /**
     * Lấy danh sách {col, row} của các ô thắng trong 1 payline.
     * Ưu tiên matchedSymbolsIndices từ server, fallback sang payline definition.
     */
    private _getWinningCells(linePay: MatchedLinePay): CellPos[] {
        const serverIdx = linePay.matchedSymbolsIndices;
        if (serverIdx && serverIdx.length >= 3) {
            // Validate: col phải trong [0, reels.length-1], row phải trong [0, 2]
            const maxCol = this.reels.length - 1;
            const valid = serverIdx.every(s =>
                s.Item1 >= 0 && s.Item1 <= maxCol &&
                s.Item2 >= 0 && s.Item2 <= 2
            );
            if (valid) {
                const cells = serverIdx.map(s => ({ col: s.Item1, row: this._toDisplayRow(s.Item2) }));
                if (DEBUG) console.log(`[HighlightDebug] Line#${linePay.payLineIndex} from server`);
                return cells;
            }
            // Indices out-of-range → log và dùng fallback payline
            if (DEBUG) console.warn(`[SymbolHighlighter] payLine#${linePay.payLineIndex} OUT OF RANGE`);
        }
        // Fallback: tính từ client payline config
        const paylines = GameData.instance.config.paylines;
        const payline  = paylines[linePay.payLineIndex];
        if (!payline) {
            if (DEBUG) console.warn(`[SymbolHighlighter] payLine#${linePay.payLineIndex} not found`);
            return [];
        }
        const cells = payline.map((row, col) => ({ col, row: this._toDisplayRow(row) }));
        if (DEBUG) console.log(`[HighlightDebug] Line#${linePay.payLineIndex} from payline def`);
        return cells;
    }

    private _toDisplayRow(row: number): number {
        return GameData.instance.toDisplayRow(row);
    }

    /** Set opacity ngay lập tức (dừng tween đang chạy nếu có) */
    private _setOpacity(node: Node, opacity: number): void {
        const uiOp = this._getUIOpacity(node);
        Tween.stopAllByTarget(uiOp);
        uiOp.opacity = opacity;
    }

    /** Tween opacity từ `from` → `to` trong `duration` giây */
    private _fadeOpacity(node: Node, from: number, to: number, duration: number): void {
        const uiOp = this._getUIOpacity(node);
        Tween.stopAllByTarget(uiOp);
        uiOp.opacity = from;
        tween(uiOp)
            .to(duration, { opacity: to }, { easing: 'sineOut' })
            .start();
    }

    /** Lấy hoặc tạo UIOpacity component cho node */
    private _getUIOpacity(node: Node): UIOpacity {
        return node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
    }

    /** Reparent CreditLabel của symbolNode lên paylineManagerNode (nằm trên spine) */
    private _reparentCreditLabel(symbolNode: Node): void {
        if (!this.paylineManagerNode) return;
        // Tìm CreditLabel bằng component SpriteNumber (không hardcode tên node)
        const creditLabel = symbolNode.getComponentInChildren(SpriteNumber)?.node ?? null;
        if (!creditLabel) return;
        if (this._creditLabelRestoreData.has(creditLabel)) return; // đã reparent rồi
        this._creditLabelRestoreData.set(creditLabel, {
            origParent: creditLabel.parent,
            origSibling: creditLabel.getSiblingIndex(),
            origActive: creditLabel.active,
        });
        // Giữ world position khi reparent sang paylineManagerNode
        creditLabel.setParent(this.paylineManagerNode, true);
        creditLabel.active = true;
        // Đảm bảo tất cả children (các sprite số tiền) cũng active
        for (const child of creditLabel.children) {
            child.active = true;
        }
        // Bật lại Sprite components — bị tắt bởi setSpriteVisible(false) trước đó
        const sprites = creditLabel.getComponentsInChildren(Sprite);
        for (const spr of sprites) {
            spr.enabled = true;
        }
        // Append vào cuối → nằm trên cùng, phía trên spine effect
    }

    /** Restore tất cả CreditLabel đã reparent về parent, sibling gốc — reset nếu symbol không còn là sticky coin */
    private _restoreCreditLabels(): void {
        for (const [labelNode, restoreData] of this._creditLabelRestoreData) {
            if (!isValid(labelNode)) continue;
            const { origParent, origSibling } = restoreData;
            if (origParent && labelNode.parent !== origParent) {
                labelNode.setParent(origParent, true); // giữ world position
                labelNode.setSiblingIndex(origSibling);
            }
            // Tìm SymbolView trong parent chain để biết symbol hiện tại
            let symbolNode: Node | null = origParent;
            let symbolView: SymbolView | null = null;
            while (symbolNode) {
                symbolView = symbolNode.getComponent(SymbolView);
                if (symbolView) break;
                symbolNode = symbolNode.parent;
            }
            const isSticky = symbolView && (
                symbolView.symbolId === SymbolId.STICKY_YELLOW ||
                symbolView.symbolId === SymbolId.STICKY_GREEN
            );
            if (!isSticky) {
                // Symbol thường → ẩn CreditLabel hoàn toàn, reset children & sprite
                labelNode.active = false;
                for (const child of labelNode.children) {
                    child.active = false;
                }
                for (const spr of labelNode.getComponentsInChildren(Sprite)) {
                    spr.enabled = false;
                }
            }
            // Nếu là sticky coin → giữ nguyên active state gốc, showCredit() sẽ bật nếu cần
        }
        this._creditLabelRestoreData.clear();
    }

    /** Destroy tất cả clone trên paylineManagerNode (STICKY_YELLOW freemode + sprite bounce highlight) */
    private _restoreReparentedSymbolNodes(): void {
        if (this._yellowClones.size > 0) {
            Log.e(`[FreeYellow] _restoreReparentedSymbolNodes: destroy ${this._yellowClones.size} clones`);
        }
        for (const [symNode, clone] of this._yellowClones) {
            if (isValid(clone)) {
                Tween.stopAllByTarget(clone);
                clone.destroy();
                Log.e(`[FreeYellow] DESTROY clone for ${symNode.name}`);
            }
        }
        this._yellowClones.clear();
        this._yellowCloneTweens.clear();

        for (const [symNode, clone] of this._spriteBounceClones) {
            if (isValid(clone)) {
                Tween.stopAllByTarget(clone);
                this._bounceOrigPos.delete(clone);
                clone.destroy();
            }
            if (symNode?.isValid) {
                symNode.getComponent(SymbolView)?.setSpriteVisible(true);
            }
        }
        this._spriteBounceClones.clear();
    }

    /** Lấy base scale từ SymbolView (ExtraTop/ExtraBot = 0.8). Mặc định = 1 nếu không tìm thấy. */
    private _getDefaultScale(symbolNode: Node): number {
        const view = symbolNode.getComponent(SymbolView);
        return view?.getBaseScale() ?? 1;
    }

    /**
     * Tìm spine node (có sp.Skeleton) trong descendant của symbol node.
     * Trả về node đó hoặc null. Dùng để replay animation khi trail effect đã spawn spine.
     */
    private _findSpineNodeOnNode(node: Node): Node | null {
        if (node.getComponent(sp.Skeleton)) return node;
        for (const child of node.children) {
            const found = this._findSpineNodeOnNode(child);
            if (found) return found;
        }
        return null;
    }
}
