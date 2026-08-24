/**
 * PayOutDisplay - Bảng trả thưởng (Paytable) hiển thị 8 dòng:
 *
 *   1. 777-777-777   (TripleSeven x3)
 *   2. 77-77-77      (DoubleSeven x3)
 *   3. 7-7-7         (SingleSeven x3)
 *   4. Any 7
 *   5. BARBAR-BARBAR-BARBAR (DoubleBar x3)
 *   6. BAR-BAR-BAR   (SingleBar x3)
 *   7. Any BAR
 *   8. 3x WILD       (luôn hiển thị chữ "WILD")
 *
 * ── NGUỒN DỮ LIỆU ──
 *   API v1.0.3+: PS.Symbols (Array<{Id, Payout}>) → GameData.symbolPayouts.
 *   Fallback khi chưa có PS: Inspector multiplier properties.
 *   Payout = totalBet × multiplier. Tự động cập nhật khi bet thay đổi (BET_CHANGED).
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Kéo 8 Label nodes vào các slot tương ứng trong Inspector.
 *   2. Chỉnh Multiplier fallback cho từng dòng (dùng khi chưa có PS từ server).
 */

import { _decorator, Component, Label, Node } from 'cc';
import { GameData } from '../data/GameData';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { formatCurrency } from '../core/FormatUtils';
import { L } from '../core/LocalizationManager';
import { MatchedLinePay } from '../data/SlotTypes';
import { SymbolId } from '../data/SlotTypes';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

@ccclass('PayOutDisplay')
export class PayOutDisplay extends Component {

    // ─── LABELS ─────────────────────────────────────────────────────────────

    @property({ type: Label, tooltip: '777-777-777 – TripleSeven x3' })
    tripleSevenPayoutLabel: Label | null = null;

    @property({ type: Label, tooltip: '77-77-77 – DoubleSeven x3' })
    doubleSevenPayoutLabel: Label | null = null;

    @property({ type: Label, tooltip: '7-7-7 – SingleSeven x3' })
    singleSevenPayoutLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Any 7' })
    anySevenPayoutLabel: Label | null = null;

    @property({ type: Label, tooltip: 'BARBAR-BARBAR-BARBAR – DoubleBar x3' })
    doubleBarPayoutLabel: Label | null = null;

    @property({ type: Label, tooltip: 'BAR-BAR-BAR – SingleBar x3' })
    singleBarPayoutLabel: Label | null = null;

    @property({ type: Label, tooltip: 'Any BAR' })
    anyBarPayoutLabel: Label | null = null;

    @property({ type: Label, tooltip: '3x WILD – Luon hien chu "WILD"' })
    wildLabel: Label | null = null;

    // ─── EFFECT NODES ────────────────────────────────────────────────────────
    // Mỗi node tương ứng với 1 dòng thắng, active khi dòng đó đang được highlight

    @property({ type: Node, tooltip: 'Effect node cho 777-777-777' })
    tripleSevenEffectNode: Node | null = null;

    @property({ type: Node, tooltip: 'Effect node cho 77-77-77' })
    doubleSevenEffectNode: Node | null = null;

    @property({ type: Node, tooltip: 'Effect node cho 7-7-7' })
    singleSevenEffectNode: Node | null = null;

    @property({ type: Node, tooltip: 'Effect node cho Any 7' })
    anySevenEffectNode: Node | null = null;

    @property({ type: Node, tooltip: 'Effect node cho BARBAR-BARBAR-BARBAR' })
    doubleBarEffectNode: Node | null = null;

    @property({ type: Node, tooltip: 'Effect node cho BAR-BAR-BAR' })
    singleBarEffectNode: Node | null = null;

    @property({ type: Node, tooltip: 'Effect node cho Any BAR' })
    anyBarEffectNode: Node | null = null;

    @property({ type: Node, tooltip: 'Effect node cho 3x WILD' })
    wildEffectNode: Node | null = null;

    // ─── MULTIPLIERS ─────────────────────────────────────────────────────────
    // Payout = totalBet × multiplier

    @property({ tooltip: '777-777-777 multiplier', min: 1 })
    tripleSevenMultiplier: number = 200;

    @property({ tooltip: '77-77-77 multiplier', min: 1 })
    doubleSevenMultiplier: number = 100;

    @property({ tooltip: '7-7-7 multiplier', min: 1 })
    singleSevenMultiplier: number = 50;

    @property({ tooltip: 'Any 7 multiplier', min: 1 })
    anySevenMultiplier: number = 10;

    @property({ tooltip: 'BARBAR-BARBAR-BARBAR multiplier', min: 1 })
    doubleBarMultiplier: number = 30;

    @property({ tooltip: 'BAR-BAR-BAR multiplier', min: 1 })
    singleBarMultiplier: number = 15;

    @property({ tooltip: 'Any BAR multiplier', min: 1 })
    anyBarMultiplier: number = 5;

    // ─── LIFECYCLE ───────────────────────────────────────────────────────────

    onLoad(): void {
        this._updateAll();
        this._hideAllEffects();
        const bus = EventBus.instance;
        bus.on(GameEvents.BET_CHANGED,          this._onBetChanged,       this);
        bus.on(GameEvents.UI_UPDATE_WIN_LABEL,  this._onLineHighlight,    this);
        bus.on(GameEvents.WIN_SHOW_ALL_LINES,   this._onShowAllLines,     this);
        bus.on(GameEvents.REELS_START_SPIN,     this._hideAllEffects,     this);
        bus.on(GameEvents.WIN_HIGHLIGHT_CLEAR,  this._hideAllEffects,     this);
        bus.on(GameEvents.JACKPOT_LOOP_START,   this._hideAllEffects,     this);
        bus.on(GameEvents.PICK_GAME_OPEN,       this._hideAllEffects,     this);
        bus.on(GameEvents.PICK_GAME_CLOSE,      this._hideAllEffects,     this);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    // ─── PUBLIC API ──────────────────────────────────────────────────────────

    /** Force cập nhật tất cả labels. */
    public refresh(): void {
        this._updateAll();
    }

    // ─── PRIVATE ─────────────────────────────────────────────────────────────

    private _onBetChanged(): void {
        this._updateAll();
    }

    /** Cycling từng line một → set mỗi effect active/inactive trong cùng 1 pass.
     *  Không gọi _hideAllEffects() trước để tránh blank frame giữa "show all" → "cycling". */
    private _onLineHighlight(linePay: MatchedLinePay): void {
        Log.e(
            `[MULTI-LINE-WIN] PayOutDisplay CYCLE_ONE pl=#${linePay.payLineIndex} payout=${linePay.payout}`
        );
        const target = this._getEffectNodeForLine(linePay);
        this.tripleSevenEffectNode  && (this.tripleSevenEffectNode.active  = target === this.tripleSevenEffectNode);
        this.doubleSevenEffectNode  && (this.doubleSevenEffectNode.active  = target === this.doubleSevenEffectNode);
        this.singleSevenEffectNode  && (this.singleSevenEffectNode.active  = target === this.singleSevenEffectNode);
        this.anySevenEffectNode     && (this.anySevenEffectNode.active     = target === this.anySevenEffectNode);
        this.doubleBarEffectNode    && (this.doubleBarEffectNode.active    = target === this.doubleBarEffectNode);
        this.singleBarEffectNode    && (this.singleBarEffectNode.active    = target === this.singleBarEffectNode);
        this.anyBarEffectNode       && (this.anyBarEffectNode.active       = target === this.anyBarEffectNode);
        this.wildEffectNode         && (this.wildEffectNode.active         = target === this.wildEffectNode);
    }

    /** Hiện tất cả winning lines cùng lúc → bật tất cả effect tương ứng */
    private _onShowAllLines(lines: MatchedLinePay[]): void {
        const sumPayout = lines.reduce((s, l) => s + (l.payout ?? 0), 0);
        Log.e(
            `[MULTI-LINE-WIN] PayOutDisplay SHOW_ALL lines=${lines.length}` +
            ` sumLinePayout=${sumPayout} payouts=[${lines.map(l => `pl${l.payLineIndex}=${l.payout}`).join(',')}]`
        );
        this._hideAllEffects();
        for (const line of lines) {
            const effectNode = this._getEffectNodeForLine(line);
            if (effectNode) effectNode.active = true;
        }
    }

    /** Ẩn tất cả effect nodes */
    private _hideAllEffects(): void {
        this.tripleSevenEffectNode  && (this.tripleSevenEffectNode.active  = false);
        this.doubleSevenEffectNode  && (this.doubleSevenEffectNode.active  = false);
        this.singleSevenEffectNode  && (this.singleSevenEffectNode.active  = false);
        this.anySevenEffectNode     && (this.anySevenEffectNode.active     = false);
        this.doubleBarEffectNode    && (this.doubleBarEffectNode.active    = false);
        this.singleBarEffectNode    && (this.singleBarEffectNode.active    = false);
        this.anyBarEffectNode       && (this.anyBarEffectNode.active       = false);
        this.wildEffectNode         && (this.wildEffectNode.active         = false);
    }

    /**
     * Xác định effect node tương ứng với 1 dòng thắng dựa vào matchedSymbols.
     *
     * Thứ tự ưu tiên (từ cụ thể → chung):
     *   WILD_3X x3       → wildEffectNode
     *   SEVEN_TRIPLE x3  → tripleSevenEffectNode
     *   SEVEN_DOUBLE x3  → doubleSevenEffectNode
     *   SEVEN_SINGLE x3  → singleSevenEffectNode
     *   Any Seven (mix)  → anySevenEffectNode
     *   BAR_DOUBLE x3    → doubleBarEffectNode
     *   BAR_SINGLE x3    → singleBarEffectNode
     *   Any BAR (mix)    → anyBarEffectNode
     */
    private _getEffectNodeForLine(linePay: MatchedLinePay): Node | null {
        const raw = linePay.matchedSymbols; // raw PS IDs (real API) or client IDs (mock)
        const ids = GameData.instance.psWinTypeIds;
        const usePS = ids.oneSeven !== -1; // true = real API with PS loaded

        let winType = 'UNKNOWN';
        let effectNode: Node | null = null;

        if (usePS) {
            // ── Real API path: compare raw PS IDs against named PS symbol IDs ──
            const has     = (id: number) => id !== -1 && raw.includes(id);
            const allSame = (id: number) => id !== -1 && raw.length > 0 && raw.every(s => s === id);

            if (linePay.containsWild || has(ids.tripleWild) || has(ids.anyWild) || has(ids.blueWild) || has(ids.redWild)) {
                winType = '3x WILD';       effectNode = this.wildEffectNode;
            } else if (allSame(ids.tripleSeven)) {
                winType = '777-777-777';   effectNode = this.tripleSevenEffectNode;
            } else if (allSame(ids.doubleSeven)) {
                winType = '77-77-77';      effectNode = this.doubleSevenEffectNode;
            } else if (allSame(ids.oneSeven)) {
                winType = '7-7-7';         effectNode = this.singleSevenEffectNode;
            } else if (has(ids.anySeven)) {
                winType = 'Any 7';         effectNode = this.anySevenEffectNode;
            } else if (allSame(ids.doubleBar)) {
                winType = 'BARBAR-BARBAR'; effectNode = this.doubleBarEffectNode;
            } else if (allSame(ids.oneBar)) {
                winType = 'BAR-BAR-BAR';   effectNode = this.singleBarEffectNode;
            } else if (has(ids.anyBar)) {
                winType = 'Any BAR';       effectNode = this.anyBarEffectNode;
            }
        } else {
            // ── Mock path: matchedSymbols are client SymbolIds ──
            // const allSameC = (id: SymbolId) => raw.every(s => s === id);
            // const allInC   = (...cids: SymbolId[]) => raw.every(s => cids.includes(s as SymbolId));

            // if (linePay.containsWild || raw.some(s => s === SymbolId.WILD_3X)) {
            //     winType = '3x WILD';       effectNode = this.wildEffectNode;
            // } else if (allSameC(SymbolId.SEVEN_TRIPLE)) {
            //     winType = '777-777-777';   effectNode = this.tripleSevenEffectNode;
            // } else if (allSameC(SymbolId.SEVEN_DOUBLE)) {
            //     winType = '77-77-77';      effectNode = this.doubleSevenEffectNode;
            // } else if (allSameC(SymbolId.SEVEN_SINGLE)) {
            //     winType = '7-7-7';         effectNode = this.singleSevenEffectNode;
            // } else if (allInC(SymbolId.SEVEN_SINGLE, SymbolId.SEVEN_DOUBLE, SymbolId.SEVEN_TRIPLE)) {
            //     winType = 'Any 7';         effectNode = this.anySevenEffectNode;
            // } else if (allSameC(SymbolId.BAR_DOUBLE)) {
            //     winType = 'BARBAR-BARBAR'; effectNode = this.doubleBarEffectNode;
            // } else if (allSameC(SymbolId.BAR_SINGLE)) {
            //     winType = 'BAR-BAR-BAR';   effectNode = this.singleBarEffectNode;
            // } else if (allInC(SymbolId.BAR_SINGLE, SymbolId.BAR_DOUBLE)) {
            //     winType = 'Any BAR';       effectNode = this.anyBarEffectNode;
            // }
        }

        // Log để verify: line index (0-based) → payline pattern → win type
        const data = GameData.instance;
        const payline = data.config.paylines[linePay.payLineIndex];
        const ROW = ['top', 'mid', 'bot'];
        const pattern = payline ? `[${payline.map(r => ROW[r] ?? r).join('-')}]` : '?';
        // Log.e(
        //     `[PAYOUT] Line#${linePay.payLineIndex + 1}(idx=${linePay.payLineIndex}) pattern=${pattern}` +
        //     ` matchedSymbols=${JSON.stringify(raw)} containsWild=${linePay.containsWild}` +
        //     ` → "${winType}" payout=${linePay.payout} effectNode=${effectNode ? 'SET' : 'null'}`
        // );

        return effectNode;
    }

    private _updateAll(): void {
        const data       = GameData.instance;
        const betPerLine = data.totalBet / 9;
        const ids        = data.psWinTypeIds;

        this._setLabel(this.tripleSevenPayoutLabel, betPerLine * this._getMultiplier(ids.tripleSeven, this.tripleSevenMultiplier));
        this._setLabel(this.doubleSevenPayoutLabel, betPerLine * this._getMultiplier(ids.doubleSeven, this.doubleSevenMultiplier));
        this._setLabel(this.singleSevenPayoutLabel, betPerLine * this._getMultiplier(ids.oneSeven,    this.singleSevenMultiplier));
        this._setLabel(this.anySevenPayoutLabel,    betPerLine * this._getMultiplier(ids.anySeven,    this.anySevenMultiplier));
        this._setLabel(this.doubleBarPayoutLabel,   betPerLine * this._getMultiplier(ids.doubleBar,   this.doubleBarMultiplier));
        this._setLabel(this.singleBarPayoutLabel,   betPerLine * this._getMultiplier(ids.oneBar,      this.singleBarMultiplier));
        this._setLabel(this.anyBarPayoutLabel,      betPerLine * this._getMultiplier(ids.anyBar,      this.anyBarMultiplier));

        // WILD không có payout số — luôn là chữ "WILD"
        if (this.wildLabel) {
            this.wildLabel.string = 'WILD';
        }
    }

    /**
     * Trả về multiplier cho symbol:
     *  - Nếu `psId` hợp lệ và `GameData.symbolPayouts` có entry → dùng giá trị từ PS.
     *  - Ngược lại (mock mode / PS chưa load) → fallback về Inspector value.
     */
    private _getMultiplier(psId: number, fallback: number): number {
        if (psId === -1) return fallback;
        const psMultiplier = GameData.instance.symbolPayouts[psId];
        return psMultiplier !== undefined ? psMultiplier : fallback;
    }

    private _setLabel(label: Label | null, amount: number): void {
        if (!label) return;
        const currencySymbol = L('CLIENT_CURRENENCY_SYMBOL');
       label.string = `${currencySymbol}${formatCurrency(amount)}`;
    }
}0
