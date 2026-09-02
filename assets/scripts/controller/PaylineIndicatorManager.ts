import { _decorator, Component, Node } from 'cc';
import { IndicatorItem } from './IndicatorItem';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

@ccclass('PaylineIndicatorManager')
export class PaylineIndicatorManager extends Component {

    @property({ type: Node, tooltip: 'Node cha "Left" — các child đặt tên là số (1, 2, 3…) tương ứng index indicator (0-based).' })
    leftContainer: Node | null = null;

    @property({ type: Node, tooltip: 'Node cha "Right" — các child đặt tên là số (1, 2, 3…) tương ứng index indicator (0-based).' })
    rightContainer: Node | null = null;

    @property({ type: [IndicatorItem], tooltip: 'Mảng IndicatorItem bên trái (0-based) — được tự động điền từ leftContainer, không cần kéo tay.' })
    leftIndicators: IndicatorItem[] = [];

    @property({ type: [IndicatorItem], tooltip: 'Mảng IndicatorItem bên phải (0-based) — được tự động điền từ rightContainer, không cần kéo tay.' })
    rightIndicators: IndicatorItem[] = [];

    onLoad(): void {
        this._autoFillFromContainer(this.leftContainer,  this.leftIndicators,  'Left');
        this._autoFillFromContainer(this.rightContainer, this.rightIndicators, 'Right');

        // Validate sau khi auto-fill
        for (let i = 0; i < this.leftIndicators.length; i++) {
            if (!this.leftIndicators[i]) {
                Log.e(`[PaylineIndicatorManager] leftIndicators[${i}] is NULL — Line ${i + 1} sẽ không highlight được!`);
            }
        }
        for (let i = 0; i < this.rightIndicators.length; i++) {
            if (!this.rightIndicators[i]) {
                Log.e(`[PaylineIndicatorManager] rightIndicators[${i}] is NULL — Line ${i + 1} sẽ không highlight được!`);
            }
        }
        Log.e(`[PaylineIndicatorManager] onLoad — leftIndicators.length=${this.leftIndicators.length}, rightIndicators.length=${this.rightIndicators.length}`);
    }


    /**
     * Duyệt qua các child của container, đọc tên child là số nguyên (1-based),
     * lấy IndicatorItem component và gán vào mảng theo index 0-based (trừ 1 từ tên).
     * Ví dụ: child tên "1" → target[0], tên "2" → target[1]
     */
    private _autoFillFromContainer(container: Node | null, target: IndicatorItem[], side: string): void {
        if (!container) return;
        const children = container.children;
        for (const child of children) {
            const nameNum = parseInt(child.name, 10);
            if (isNaN(nameNum)) {
                Log.e(`[PaylineIndicatorManager] ${side} child "${child.name}" — tên không phải số, bỏ qua.`);
                continue;
            }
            const idx = nameNum - 1;  // Chuyển từ 1-based (tên) sang 0-based (index)
            if (idx < 0) {
                Log.e(`[PaylineIndicatorManager] ${side} child "${child.name}" — số < 1, bỏ qua.`);
                continue;
            }
            const item = child.getComponent(IndicatorItem);
            if (!item) {
                Log.e(`[PaylineIndicatorManager] ${side}[${idx}] node "${child.name}" không có IndicatorItem component!`);
                continue;
            }
            target[idx] = item;
        }
    }

    resetAllIndicators(): void {
        for (const item of this.leftIndicators) {
            item?.setHighlight(false);
        }
        for (const item of this.rightIndicators) {
            item?.setHighlight(false);
        }
    }

    showWinLine(lineIndex: number): void {
        this.resetAllIndicators();
        this._highlightLine(lineIndex);
    }

    showMultipleWinLines(lineIndices: number[]): void {
        this.resetAllIndicators();
        for (const index of lineIndices) {
            this._highlightLine(index);
        }
    }

    /**
     * Ánh xạ từ payLineIndex (0-based, từ server) sang vị trí mảng indicator trong Inspector.
     * Thứ tự đúng theo định nghĩa payline:
     *   Line 1 (idx 0): [1,0],[1,1],[1,2] — Hàng giữa ngang
     *   Line 2 (idx 1): [0,0],[0,1],[0,2] — Hàng trên ngang
     *   Line 3 (idx 2): [2,0],[2,1],[2,2] — Hàng dưới ngang
     *   Line 4 (idx 3): [0,0],[1,1],[2,2] — Chéo trên-trái → dưới-phải
     *   Line 5 (idx 4): [2,0],[1,1],[0,2] — Chéo dưới-trái → trên-phải
     *   Line 6 (idx 5): [1,0],[0,1],[1,2] — Nón ngửa (Giữa→Trên→Giữa)
     *   Line 7 (idx 6): [1,0],[2,1],[1,2] — Nón úp  (Giữa→Dưới→Giữa)
     *   Line 8 (idx 7): [2,0],[1,1],[2,2] — Chữ V   (Dưới→Giữa→Dưới)
     *   Line 9 (idx 8): [0,0],[1,1],[0,2] — Chữ V ngược (Trên→Giữa→Trên)
     *
     * Nếu Inspector kéo indicator không đúng thứ tự, sửa mảng dưới đây thay vì đổi thứ tự drag.
     * Ví dụ: Line 8 và Line 9 bị hoán đổi → đặt INDICATOR_REMAP[7]=8, INDICATOR_REMAP[8]=7
     */
    private static readonly INDICATOR_REMAP: number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    //                                         Line:     1  2  3  4  5  6  7  8  9

    private _highlightLine(lineIndex: number): void {
        const indicatorIndex = PaylineIndicatorManager.INDICATOR_REMAP[lineIndex] ?? lineIndex;
        const left  = this.leftIndicators[indicatorIndex];
        const right = this.rightIndicators[indicatorIndex];
        Log.d(
            `[PaylineIndicator] server payLineIndex=${lineIndex} (Line ${lineIndex + 1})` +
            ` → REMAP[${lineIndex}]=${indicatorIndex}` +
            ` → indicator[${indicatorIndex}]` +
            ` left=${!!left} right=${!!right}`,
        );
        if (!left && !right) {
            Log.e(`[PaylineIndicatorManager] _highlightLine(${lineIndex}→indicator[${indicatorIndex}]): không có indicator nào để highlight!`);
            return;
        }
        if (left)  left.setHighlight(true);
        if (right) right.setHighlight(true);
    }

    /** Đặt mode game cho tất cả indicators (Base Game hoặc Feature/Free Bonus) */
    public setFeatureGameMode(isFeature: boolean): void {
        for (const item of this.leftIndicators) {
            item?.setFeatureGameMode(isFeature);
        }
        for (const item of this.rightIndicators) {
            item?.setFeatureGameMode(isFeature);
        }
    }
}
