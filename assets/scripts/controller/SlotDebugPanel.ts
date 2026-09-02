/**

 * SlotDebugPanel — DebugArray presets cho Carnival Neko (SlotId 20).

 *

 * Force Pot / Feature (server DebugArray):

 *   [-1×5]        — Force pot trigger, random feature type (0~6)

 *   [-1×5, 0..5]  — Mighty → Ultimate

 *   [-1×5, 6]     — Red Pick Only (pick game, no free spin)

 *   [-1×5, 7]     — Red Mystery Envelope (instant payout)

 *   All Trail     — stop index thật, land tối đa Trail (PS 41/42/43) trên 5 reel

 *

 * Giữ tên @property cũ để prefab DebbugManager không mất binding.

 * Gửi: DebugManager.setDebugRands(arr) → emit SPIN_REQUEST.

 */





import { _decorator, Component, Node, EditBox, Label, Button } from 'cc';

import { DebugManager } from '../manager/DebugManager';

import { EventBus } from '../core/EventBus';

import { GameEvents } from '../core/GameEvents';

import { GameData } from '../data/GameData';

import { Log } from '../core/Logger';

import { SymbolId, PS_TO_CLIENT } from '../data/SlotTypes';

import { WaysPayCalculator } from '../data/WaysPayCalculator';



const { ccclass, property } = _decorator;



const REEL_COUNT = 5;

/** DebugArray pot-force: 5 stop (-1) + optional feature type. */

const POT_FORCE_LEN = 6;

const MULTI_LINE_SEARCH_ITERS = 6000;



const POT_FORCE_PRESETS: ReadonlyArray<{ arr: readonly number[]; label: string }> = [

    { arr: [-1, -1, -1, -1, -1], label: 'Force pot (random type 0~6)' },

    { arr: [-1, -1, -1, -1, -1, 0], label: 'Mighty (5×3, FS only)' },

    { arr: [-1, -1, -1, -1, -1, 1], label: 'Mega (5×4, FS only)' },

    { arr: [-1, -1, -1, -1, -1, 2], label: 'Super (5×5, FS only)' },

    { arr: [-1, -1, -1, -1, -1, 3], label: 'Ultra (5×3, FS → pick)' },

    { arr: [-1, -1, -1, -1, -1, 4], label: 'Supreme (5×4, FS → pick)' },

    { arr: [-1, -1, -1, -1, -1, 5], label: 'Ultimate (5×5, FS → pick)' },

    { arr: [-1, -1, -1, -1, -1, 6], label: 'Red Pick Only (pick, no FS)' },

    { arr: [-1, -1, -1, -1, -1, 7], label: 'Red Mystery Envelope (instant)' },

];



@ccclass('SlotDebugPanel')

export class SlotDebugPanel extends Component {



    @property(Node) debugPanelNode: Node = null!;

    @property(EditBox) inputReelIndices: EditBox = null!;

    @property(Label) statusLabel: Label = null!;

    @property(Label) memberIdxLabel: Label = null!;



    // ── POT FORCE (property names giữ nguyên để bind prefab) ────────────────

    @property(Button) btnRandomSpin: Button = null!;

    /** [-1×5] Force pot, random feature type */

    @property(Button) btnAllZeros: Button = null!;

    /** [-1×5, 0] Mighty */

    @property(Button) btnForcePickGame: Button = null!;

    /** [-1×5, 1] Mega */

    @property(Button) btnAllNegOnes6: Button = null!;

    /** [-1×5, 2] Super */

    @property(Button) btnPhoenix5: Button = null!;

    /** [-1×5, 3] Ultra */

    @property(Button) btnCoin5: Button = null!;

    /** [-1×5, 4] Supreme */

    @property(Button) btnWild3Reels: Button = null!;

    /** [-1×5, 5] Ultimate */

    @property(Button) btnRedCoins5: Button = null!;

    /** [-1×5, 6] Red Pick Only */

    @property(Button) btnRedCoinsUnder6: Button = null!;

    /** [-1×5, 7] Red Mystery Envelope */

    @property(Button) btnRedWithWin: Button = null!;

    /** Multi Line win — ≥2 symbol thắng cùng lúc (ways pay). */

    @property(Button) btnWin: Button = null!;

    /** Ép stop land tối đa Trail (PS 41/42/43) — label/active trong DebbugManager.prefab. */

    @property(Button) btnAllTrail: Button = null!;



    // ── Unused legacy bindings — ẩn khi load ────────────────────────────────

    @property(Button) btnSingleWayWin: Button = null!;

    @property(Button) btnNoWin: Button = null!;

    @property(Button) btnMultiLineWin: Button = null!;

    @property(Button) btnYellowFreeSpin: Button = null!;

    @property(Button) btnTopupZeros: Button = null!;

    @property(Button) btnTopupAllYellow: Button = null!;

    @property(Button) btnTopupAllGreen: Button = null!;

    @property(Button) btnSendCustom: Button = null!;



    onLoad(): void {

        if (this.debugPanelNode) this.debugPanelNode.active = false;

        if (this.inputReelIndices) this.inputReelIndices.maxLength = 200;

        this._hideLegacyButtons();

        this._ensureWinButtonVisible();

        this._bindButtons();

        Log.d('%c[SlotDebugPanel] Loaded — Carnival Neko pot-force DebugArray presets',

            'color:#0af;font-weight:bold');

    }



    public onClose(): void { this.onCloseDebug(); }



    onOpenDebug(): void {

        if (!this.debugPanelNode) return;

        this.debugPanelNode.active = true;

        this._ensureWinButtonVisible();

        this._setStatus('Carnival Neko — Force Pot / Feature. All Trail = ép stop land tối đa Trail.');

        this._refreshMemberIdx();

    }



    onCloseDebug(): void {

        if (this.debugPanelNode) this.debugPanelNode.active = false;

    }



    private _hideLegacyButtons(): void {

        const legacy = [

            this.btnSingleWayWin, this.btnNoWin,

            this.btnMultiLineWin, this.btnYellowFreeSpin,

            this.btnTopupZeros, this.btnTopupAllYellow,

            this.btnTopupAllGreen,

        ];

        for (const btn of legacy) {

            if (btn?.node) btn.node.active = false;

        }

    }



    private _ensureWinButtonVisible(): void {

        if (this.btnWin?.node) this.btnWin.node.active = true;

    }



    private _bindButtons(): void {

        try {

            this._bind(this.btnRandomSpin, this._onRandomSpin);

            const potButtons = [

                this.btnAllZeros,

                this.btnForcePickGame,

                this.btnAllNegOnes6,

                this.btnPhoenix5,

                this.btnCoin5,

                this.btnWild3Reels,

                this.btnRedCoins5,

                this.btnRedCoinsUnder6,

                this.btnRedWithWin,

            ];

            for (let i = 0; i < POT_FORCE_PRESETS.length; i++) {

                const preset = POT_FORCE_PRESETS[i];

                this._bind(potButtons[i], () => this._firePreset([...preset.arr], preset.label));

                this._setButtonLabel(potButtons[i], this._shortLabel(i));

            }

            this._bind(this.btnWin, this._onWinSpin);

            this._setButtonLabel(this.btnWin, 'Multi Line');

            this._bind(this.btnAllTrail, this._onAllTrailSpin);

            this._bind(this.btnSendCustom, this.onSendDebugSpin);

        } catch (err) {

            Log.w('[SlotDebugPanel] _bindButtons error:', err);

        }

    }



    private _shortLabel(index: number): string {

        const names = [

            'Pot Rand',

            'Mighty',

            'Mega',

            'Super',

            'Ultra',

            'Supreme',

            'Ultimate',

            'Pick Only',

            'Mystery Env',

        ];

        return names[index] ?? `Type ${index}`;

    }



    private _setButtonLabel(btn: Button | null, text: string): void {

        if (!btn?.node) return;

        const label = btn.node.getComponentInChildren(Label);

        if (label) label.string = text;

    }



    private _bind(btn: Button | null, handler: () => void): void {

        if (btn) btn.node.on(Button.EventType.CLICK, handler, this);

    }



    // ════════════════════════════════════════════════════════════════════════

    //  HANDLERS

    // ════════════════════════════════════════════════════════════════════════



    private _onRandomSpin(): void {

        this._setInputText('');

        this._sendSpinWithDebugArray([], 'Random Spin (clear debug)');

    }



    /**
     * Ép DebugArray = stop index thật (không phải -1).
     * Mỗi reel chọn stop có nhiều Trail (PS 41/42/43) nhất trên 3 ô visible.
     * Server trả đúng grid đó → client bay hết Trail land được.
     */
    private _onAllTrailSpin(): void {

        const found = this._searchMaxTrailStops();

        if (!found) return;

        this._firePreset(

            found.arr,

            `All Trail (${found.trailCount} ô: ${found.detail})`,

        );

    }



    private _onWinSpin(): void {

        const found = this._searchMultiLineStops();

        if (!found) return;

        this._firePreset(

            found.arr,

            `Multi Line (${found.winCount} symbols, ${found.totalWays} ways)`,

        );

    }



    onSendDebugSpin(): void {

        try {

            if (!this.inputReelIndices) {

                this._setStatus('⚠ EditBox inputReelIndices chưa gắn!');

                return;

            }

            const raw = this.inputReelIndices.string?.trim();

            if (!raw) {

                this._setStatus('⚠ Nhập VD: "-1,-1,-1,-1,-1,3"');

                return;

            }

            const arr = this._parseInput(raw);

            if (!arr) return;

            if (arr.length === REEL_COUNT || arr.length === POT_FORCE_LEN) {

                this._sendSpinWithDebugArray(arr, 'Custom Pot/Force');

            } else {

                const msg = `⚠ Count=${arr.length}. Cần ${REEL_COUNT} hoặc ${POT_FORCE_LEN}.`;

                this._setStatus(msg);

                this._sendSpinWithDebugArray(arr, 'Wrong count');

            }

        } catch (err) {

            Log.err('[SlotDebugPanel] onSendDebugSpin error:', err);

            this._setStatus('❌ Lỗi: ' + String(err));

        }

    }



    // ════════════════════════════════════════════════════════════════════════

    //  MULTI LINE SEARCH

    // ════════════════════════════════════════════════════════════════════════



    /** PS Trail IDs trên strip — 41 Blue / 42 Green / 43 Red. */

    private _isPsTrail(psId: number): boolean {

        return psId === 41 || psId === 42 || psId === 43;

    }



    /**
     * Mỗi reel: duyệt hết strip, chọn center index làm 3 ô visible có nhiều Trail nhất.
     * Reel không có Trail → giữ 0 (không bịa -1, -1 sẽ làm server bỏ qua stop).
     */
    private _searchMaxTrailStops(): { arr: number[]; trailCount: number; detail: string } | null {

        const psStrips = this._getDebugPsStrips();

        if (!psStrips) return null;

        const arr: number[] = [];

        let trailCount = 0;

        const perReel: string[] = [];

        for (let r = 0; r < REEL_COUNT; r++) {

            const strip = psStrips[r] ?? [];

            let bestIdx = 0;

            let bestN = -1;

            let bestIds: number[] = [];

            for (let i = 0; i < strip.length; i++) {

                const win = this._psWindow(strip, i);

                const ids = win.filter((ps) => this._isPsTrail(ps));

                if (ids.length > bestN) {

                    bestN = ids.length;

                    bestIdx = i;

                    bestIds = ids;

                }

            }

            arr.push(bestIdx);

            trailCount += Math.max(0, bestN);

            perReel.push(`r${r}:${Math.max(0, bestN)}[${bestIds.join('/')}]`);

        }

        if (trailCount <= 0) {

            this._setStatus('⚠ Strip không có Trail PS 41/42/43 — Enter game / check PS.');

            Log.w('[SlotDebugPanel] All Trail search: no trail on strips');

            return null;

        }

        return { arr, trailCount, detail: perReel.join(' ') };

    }



    private _searchMultiLineStops(): { arr: number[]; winCount: number; totalWays: number } | null {

        const psStrips = this._getDebugPsStrips();

        if (!psStrips) return null;

        const lens = psStrips.map((s) => s.length);

        let best = { arr: lens.map(() => 0), winCount: 0, totalWays: 0 };

        let bestScore = -1;

        for (let n = 0; n < MULTI_LINE_SEARCH_ITERS; n++) {

            const arr = lens.map((len) => Math.floor(Math.random() * len));

            const evaled = this._evalMultiLineStops(psStrips, arr);

            if (evaled.winCount < 2) continue;

            const score = evaled.winCount * 1000 + evaled.totalWays * 10;

            if (score > bestScore) {

                bestScore = score;

                best = { arr: arr.slice(), ...evaled };

                if (evaled.winCount >= 3) break;

            }

        }

        if (best.winCount < 2) {

            this._setStatus('⚠ Không tìm được Multi Line trên strips hiện tại — thử lại.');

            Log.w('[SlotDebugPanel] Multi Line search failed');

            return null;

        }

        return best;

    }



    private _evalMultiLineStops(

        psStrips: number[][],

        arr: number[],

    ): { winCount: number; totalWays: number } {

        const grid: number[][] = [];

        for (let r = 0; r < REEL_COUNT; r++) {

            grid.push(

                this._psWindow(psStrips[r], arr[r]).map((ps) => PS_TO_CLIENT[ps] ?? -1),

            );

        }

        const wins = WaysPayCalculator.calculate(grid, 1, false);

        return {

            winCount: wins.length,

            totalWays: wins.reduce((sum, w) => sum + w.ways, 0),

        };

    }



    private _psWindow(strip: number[], idx: number): [number, number, number] {

        const len = strip.length;

        const i = ((idx % len) + len) % len;

        return [

            strip[(i - 1 + len) % len],

            strip[i],

            strip[(i + 1) % len],

        ];

    }



    private _getDebugPsStrips(): number[][] | null {

        const data = GameData.instance;

        const raw = data.getRawPsStrips(false);

        if (raw.length === REEL_COUNT && raw.every((s) => s?.length > 0)) return raw;

        const client = data.getReelStrips(false);

        if (!client?.length || client.some((s) => !s?.length)) {

            this._setStatus('⚠ Strips chưa load — Enter game trước.');

            return null;

        }

        return this._clientStripsToPs(client);

    }



    private _clientStripsToPs(clientStrips: number[][]): number[][] {

        const map: Record<number, number> = {

            [SymbolId.MINOR_9]: 1, [SymbolId.MINOR_10]: 2, [SymbolId.MINOR_J]: 3,

            [SymbolId.MINOR_Q]: 4, [SymbolId.MINOR_K]: 5, [SymbolId.MINOR_A]: 6,

            [SymbolId.MAJOR_HORUS]: 11, [SymbolId.MAJOR_ANUBIS]: 12,

            [SymbolId.MAJOR_SOBEK]: 13, [SymbolId.MAJOR_RAMSES]: 14,

            [SymbolId.MAJOR_CLEOPATRA]: 15,

            [SymbolId.WILD]: 21,

            [SymbolId.STICKY_YELLOW]: 45, [SymbolId.STICKY_GREEN]: 44,

            [SymbolId.TRAIL_NORMAL]: 41, [SymbolId.TRAIL_BLUE]: 41,

            [SymbolId.TRAIL_RED]: 43, [SymbolId.TRAIL_GREEN]: 42,

        };

        return (clientStrips ?? []).map((strip) => (strip ?? []).map((cs) => map[cs] ?? 1));

    }



    // ════════════════════════════════════════════════════════════════════════

    //  SEND

    // ════════════════════════════════════════════════════════════════════════



    private _parseInput(raw: string): number[] | null {

        const parts = raw.split(/[,\s]+/).filter((s) => s.length > 0);

        const result: number[] = [];

        for (const p of parts) {

            const num = parseInt(p, 10);

            if (isNaN(num)) {

                this._setStatus(`⚠ "${p}" không phải số nguyên`);

                return null;

            }

            result.push(num);

        }

        return result;

    }



    private _firePreset(arr: number[], label: string): void {

        this._setInputText(arr.join(', '));

        this._sendSpinWithDebugArray(arr, label);

    }



    private _sendSpinWithDebugArray(debugArray: number[], label: string = ''): void {

        Log.d(

            `%c[SlotDebugPanel] Sending Debug Array: [${debugArray.join(', ')}] (len=${debugArray.length})`

            + (label ? ` — ${label}` : ''),

            'color:#0f0;font-weight:bold',

        );

        DebugManager.instance.setDebugRands(debugArray);

        EventBus.instance.emit(GameEvents.SPIN_REQUEST);

        this._setStatus(`✅ [${debugArray.join(', ')}]${label ? ' — ' + label : ''}`);

    }



    private _setInputText(text: string): void {

        if (this.inputReelIndices) this.inputReelIndices.string = text;

    }



    private _setStatus(msg: string): void {

        if (this.statusLabel) this.statusLabel.string = msg;

        Log.d(`[SlotDebugPanel] ${msg}`);

    }



    private _refreshMemberIdx(): void {

        const memberIdx = GameData.instance.serverSession?.memberIdx ?? 'N/A';

        if (this.memberIdxLabel) this.memberIdxLabel.string = `Member_Idx: ${memberIdx}`;

    }

}


