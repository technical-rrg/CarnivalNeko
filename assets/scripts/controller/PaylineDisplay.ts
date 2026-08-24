/**
 * PaylineDisplay - Vẽ đường nối các ô thắng thưởng lên màn hình.
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo 1 Node (ví dụ "PaylineOverlay") con của Canvas.
 *   2. Gắn component Graphics + PaylineDisplay vào Node đó.
 *   3. Kéo component Graphics vào slot "graphics".
 *   4. Kéo 3 ReelController (cột 0, 1, 2) vào mảng "reels".
 *   5. Đặt node PaylineOverlay kích thước lấp đầy Canvas, không có Sprite/Color.
 *
 * ── NODE MAPPING ──
 *   Mỗi cột: symbolNodes[1]=Top(row0), symbolNodes[2]=Mid(row1), symbolNodes[3]=Bot(row2)
 *   Payline definition: [row_col0, row_col1, row_col2], row 0=top/1=mid/2=bot
 */

import { _decorator, Component, Graphics, Color, Vec3, Mat4, tween, Tween, Node } from 'cc';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';
import { MatchedLinePay } from '../data/SlotTypes';
import { ReelController } from './ReelController';
import { SymbolView } from './SymbolView';

const { ccclass, property } = _decorator;

/** 9 màu phân biệt cho 9 payline */
const PAYLINE_COLORS: Color[] = [
    new Color(255, 220,   0, 255), // Line 1: Vàng   – Middle
    new Color(  0, 200, 255, 255), // Line 2: Cyan    – Top
    new Color(  0, 230,  90, 255), // Line 3: Xanh lá – Bottom
    new Color(255,  70,  70, 255), // Line 4: Đỏ     – Diag ↘
    new Color(255, 150,   0, 255), // Line 5: Cam    – Diag ↗
    new Color(180,   0, 255, 255), // Line 6: Tím    – V top
    new Color(255,   0, 200, 255), // Line 7: Hồng   – V bottom
    new Color( 80, 200, 255, 255), // Line 8: Xanh nhạt
    new Color(160, 255,   0, 255), // Line 9: Lime
];

@ccclass('PaylineDisplay')
export class PaylineDisplay extends Component {

    @property({
        type: [ReelController],
        tooltip: '3 ReelController theo thứ tự cột 0, 1, 2\n(từ SlotMachineController hoặc kéo trực tiếp)',
    })
    reels: ReelController[] = [];

    @property({ type: Graphics, tooltip: 'Graphics component để vẽ đường payline' })
    graphics: Graphics | null = null;

    @property({ tooltip: 'Độ dày đường kẻ (pixels)' })
    lineWidth: number = 6;

    @property({ tooltip: 'Bán kính chấm tròn tại mỗi symbol thắng (pixels)' })
    dotRadius: number = 14;

    @property({ tooltip: 'Opacity của đường kẻ (0–255)' })
    lineAlpha: number = 220;

    @property({ tooltip: 'Scale zoom ô thắng (1.0 = không zoom)' })
    cellZoomScale: number = 1.18;

    @property({ tooltip: 'Thời gian mỗi nhịp zoom in/out (giây)' })
    cellZoomDuration: number = 0.18;

    private _zoomedNodes: Node[] = [];

    // ─── LIFECYCLE ───

    onLoad(): void {
        const bus = EventBus.instance;
        bus.on(GameEvents.UI_UPDATE_WIN_LABEL,  this._onLineHighlight, this);
        bus.on(GameEvents.WIN_SHOW_ALL_LINES,   this._onShowAllLines,  this);
        bus.on(GameEvents.REELS_START_SPIN,     this._clearLines,      this);
        bus.on(GameEvents.WIN_PRESENT_END,      this._clearLines,      this);
        bus.on(GameEvents.WIN_HIGHLIGHT_CLEAR,  this._clearLines,      this);
        bus.on(GameEvents.PICK_GAME_OPEN,       this._clearLines,      this);
        bus.on(GameEvents.PICK_GAME_CLOSE,      this._clearLines,      this);
    }

    onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    // ─── DRAW ───

    /** Hiện 1 line duy nhất (dùng cho cycling: xoá trước rồi vẽ + zoom) */
    private _onLineHighlight(linePay: MatchedLinePay): void {
        this._clearLines();
        this._drawSingleLine(linePay);
        this._zoomCells(linePay);
    }

    /** Hiện tất cả winning lines cùng 1 lúc (không zoom, không xoá từng cái) */
    private _onShowAllLines(lines: MatchedLinePay[]): void {
        this._clearLines();
        for (const linePay of lines) {
            this._drawSingleLine(linePay);
        }
    }

    /** Vẽ 1 payline lên Graphics (không xoá, không zoom) */
    private _drawSingleLine(linePay: MatchedLinePay): void {
        if (!this.graphics || this.reels.length < 3) return;

        const rawColor = PAYLINE_COLORS[linePay.payLineIndex % PAYLINE_COLORS.length];
        const color = new Color(rawColor.r, rawColor.g, rawColor.b, this.lineAlpha);

        // Thu thập vị trí các ô trong local space của Graphics node
        const positions: Vec3[] = [];

        // Ưu tiên dùng matchedSymbolsIndices từ server (chính xác nhất)
        // Fallback: dùng payline definition từ client config
        const serverIndices = linePay.matchedSymbolsIndices;
        const useServerIndices = serverIndices && serverIndices.length >= 3;

        const ROW_NAME = ['top(0)', 'mid(1)', 'bot(2)'];
        const source = useServerIndices ? 'SERVER-IDX' : 'PAYLINE-DEF';
        const paylines = GameData.instance.config.paylines;
        const paylineLogical = paylines[linePay.payLineIndex];

        if (useServerIndices) {
            // Server trả chính xác: Item1=reelCol (0-2), Item2=row (0=top,1=mid,2=bot)
            const serverStr = serverIndices!.map(s => `col${s.Item1}:row${s.Item2}`).join(' | ');
            const displayStr = serverIndices!.map(s => `col${s.Item1}:row${this._toDisplayRow(s.Item2)}(node${this._toDisplayRow(s.Item2)+1})`).join(' | ');
            // console.log(`%c[PaylineDisplay] Line#${linePay.payLineIndex+1}(idx=${linePay.payLineIndex}) ${source}\n  server logical: ${serverStr}\n  → display node: ${displayStr}`, 'color:#0af;font-weight:bold');
            for (const idx of serverIndices!) {
                const reel = this.reels[idx.Item1];
                if (!reel) continue;
                const cellNode = reel.symbolNodes[this._toDisplayRow(idx.Item2) + 1];  // [1]=Top,[2]=Mid,[3]=Bot
                if (!cellNode) continue;
                positions.push(this._worldToLocal(cellNode.getWorldPosition()));
            }
        } else {
            // Fallback: tính từ payline definition
            if (!paylineLogical) return;
            const logicalStr  = paylineLogical.map((r, c) => `col${c}:row${r}(${ROW_NAME[r]??r})`).join(' | ');
            const displayStr  = paylineLogical.map((r, c) => `col${c}:row${this._toDisplayRow(r)}(node${this._toDisplayRow(r)+1})`).join(' | ');
            // console.log(`%c[PaylineDisplay] Line#${linePay.payLineIndex+1}(idx=${linePay.payLineIndex}) ${source}\n  payline logical: ${logicalStr}\n  → display node:  ${displayStr}`, 'color:#fa0;font-weight:bold');
            for (let col = 0; col < 3; col++) {
                const reel = this.reels[col];
                if (!reel) continue;
                const cellNode = reel.symbolNodes[this._toDisplayRow(paylineLogical[col]) + 1];
                if (!cellNode) continue;
                positions.push(this._worldToLocal(cellNode.getWorldPosition()));
            }
        }

        if (positions.length < 2) return;

        const gfx = this.graphics;

        // Vẽ đường
        gfx.lineWidth   = this.lineWidth;
        gfx.strokeColor = color;
        gfx.moveTo(positions[0].x, positions[0].y);
        for (let i = 1; i < positions.length; i++) {
            gfx.lineTo(positions[i].x, positions[i].y);
        }
        gfx.stroke();

        // Vẽ chấm tại mỗi ô
        gfx.fillColor = color;
        for (const pos of positions) {
            gfx.circle(pos.x, pos.y, this.dotRadius);
            gfx.fill();
        }
    }

    /** Zoom in rồi bounce nhún nhún các node ô thắng */
    private _zoomCells(linePay: MatchedLinePay): void {
        const getBase = (n: Node) => n.getComponent(SymbolView)?.getBaseScale() ?? 1;

        // Dừng zoom cũ và trả về base scale
        for (const n of this._zoomedNodes) {
            Tween.stopAllByTarget(n);
            const base = getBase(n);
            n.setScale(base, base, 1);
        }
        this._zoomedNodes = [];

        const d = this.cellZoomDuration;

        // Dùng matchedSymbolsIndices nếu có (chính xác nhất)
        const serverIndices = linePay.matchedSymbolsIndices;
        const useServerIndices = serverIndices && serverIndices.length >= 3;

        const getCellNode = (col: number, row: number): Node | null => {
            const reel = this.reels[col];
            return reel ? (reel.symbolNodes[row + 1] as Node) ?? null : null;
        };

        if (useServerIndices) {
            for (const idx of serverIndices!) {
                const cellNode = getCellNode(idx.Item1, this._toDisplayRow(idx.Item2));
                if (!cellNode) continue;
                const BASE = getBase(cellNode);
                const s = BASE * this.cellZoomScale;
                this._zoomedNodes.push(cellNode);
                cellNode.setScale(BASE, BASE, 1);
                tween(cellNode)
                    .to(d, { scale: new Vec3(s,    s,    1) }, { easing: 'backOut' })
                    .to(d, { scale: new Vec3(BASE, BASE, 1) }, { easing: 'sineOut' })
                    .call(() => { cellNode.setScale(BASE, BASE, 1); })
                    .start();
            }
        } else {
            const paylines = GameData.instance.config.paylines;
            const payline  = paylines[linePay.payLineIndex];
            if (!payline) return;
            for (let col = 0; col < 3; col++) {
                const cellNode = getCellNode(col, this._toDisplayRow(payline[col]));
                if (!cellNode) continue;
                const BASE = getBase(cellNode);
                const s = BASE * this.cellZoomScale;
                this._zoomedNodes.push(cellNode);
                cellNode.setScale(BASE, BASE, 1);
                tween(cellNode)
                    .to(d, { scale: new Vec3(s,    s,    1) }, { easing: 'backOut' })
                    .to(d, { scale: new Vec3(BASE, BASE, 1) }, { easing: 'sineOut' })
                    .call(() => { cellNode.setScale(BASE, BASE, 1); })
                    .start();
            }
        }
    }

    private _clearLines(): void {
        for (const n of this._zoomedNodes) {
            Tween.stopAllByTarget(n);
            const base = n.getComponent(SymbolView)?.getBaseScale() ?? 1;
            n.setScale(base, base, 1);
        }
        this._zoomedNodes = [];
        this.graphics?.clear();
    }

    // ─── COORDINATE CONVERSION ───

    /**
     * Chuyển từ world position → local position của Graphics node.
     * Dùng inverse world matrix để đảm bảo đúng với mọi hierarchy.
     */
    private _worldToLocal(worldPos: Vec3): Vec3 {
        if (!this.graphics) return worldPos.clone();

        const invMat = new Mat4();
        this.graphics.node.getWorldMatrix(invMat);
        Mat4.invert(invMat, invMat);

        const local = new Vec3();
        Vec3.transformMat4(local, worldPos, invMat);
        return local;
    }

    private _toDisplayRow(row: number): number {
        return GameData.instance.toDisplayRow(row);
    }
}
