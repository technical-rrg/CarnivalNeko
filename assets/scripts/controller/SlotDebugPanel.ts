/**
 * SlotDebugPanel — DebugArray presets cho Carnival Neko (SlotId 20).
 *
 * Force Pot / Feature (server DebugArray):
 *   [-1×5]        — Force pot trigger, random feature type (0~6)
 *   [-1×5, 0..5]  — Mighty → Ultimate
 *   [-1×5, 6]     — Red Pick Only (pick game, no free spin)
 *   [-1×5, 7]     — Red Mystery Envelope (instant payout)
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

const { ccclass, property } = _decorator;

const REEL_COUNT = 5;
/** DebugArray pot-force: 5 stop (-1) + optional feature type. */
const POT_FORCE_LEN = 6;

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

    // ── Unused legacy bindings — ẩn khi load ────────────────────────────────
    @property(Button) btnMinorWin5: Button = null!;
    @property(Button) btnSingleWayWin: Button = null!;
    @property(Button) btnNoWin: Button = null!;
    @property(Button) btnMultiLineWin: Button = null!;
    @property(Button) btnYellowFreeSpin: Button = null!;
    @property(Button) btnTopupZeros: Button = null!;
    @property(Button) btnTopupAllYellow: Button = null!;
    @property(Button) btnTopupAllGreen: Button = null!;
    @property(Button) btnTopupAllPlusOne: Button = null!;

    @property(Button) btnSendCustom: Button = null!;

    onLoad(): void {
        if (this.debugPanelNode) this.debugPanelNode.active = false;
        if (this.inputReelIndices) this.inputReelIndices.maxLength = 200;
        this._hideLegacyButtons();
        this._bindButtons();
        Log.d('%c[SlotDebugPanel] Loaded — Carnival Neko pot-force DebugArray presets',
            'color:#0af;font-weight:bold');
    }

    public onClose(): void { this.onCloseDebug(); }

    onOpenDebug(): void {
        if (!this.debugPanelNode) return;
        this.debugPanelNode.active = true;
        this._setStatus('Carnival Neko — Force Pot / Feature ([-1×5] hoặc [-1×5, type]).');
        this._refreshMemberIdx();
    }

    onCloseDebug(): void {
        if (this.debugPanelNode) this.debugPanelNode.active = false;
    }

    private _hideLegacyButtons(): void {
        const legacy = [
            this.btnMinorWin5, this.btnSingleWayWin, this.btnNoWin,
            this.btnMultiLineWin, this.btnYellowFreeSpin,
            this.btnTopupZeros, this.btnTopupAllYellow,
            this.btnTopupAllGreen, this.btnTopupAllPlusOne,
        ];
        for (const btn of legacy) {
            if (btn?.node) btn.node.active = false;
        }
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
            Log.e('[SlotDebugPanel] onSendDebugSpin error:', err);
            this._setStatus('❌ Lỗi: ' + String(err));
        }
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
