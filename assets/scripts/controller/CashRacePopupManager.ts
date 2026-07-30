/**
 * CashRacePopupManager.ts
 * ──────────────────────────────────────────────────────────────────
 * Quản lý việc load CashRacePopup từ prefab portrait hoặc landscape.
 * Khi phát hiện thay đổi orientation (portrait ↔ landscape), instance
 * cũ được hủy và prefab tương ứng được load lại, state được khôi phục.
 *
 * ── SETUP TRONG EDITOR ──
 *   1. Tạo một Node con của Canvas (ví dụ: "CashRacePopupManager").
 *   2. Gắn component này vào node đó.
 *   3. Kéo Prefab portrait và landscape vào đúng slot Inspector.
 *   4. (Tuỳ chọn) Kéo Node popupParent vào — nếu để trống, popup được
 *      mount vào chính node của Manager.
 *
 * ── LƯU Ý ──
 *   Prefab portrait và landscape đều phải có component CashRacePopup
 *   ở root node của prefab. Toàn bộ @property được cấu hình bên trong prefab.
 *
 * ── FLOW ORIENTATION CHANGE ──
 *   canvas-resize → kiểm tra width vs height → nếu đổi chiều:
 *     1. captureState() từ instance cũ
 *     2. destroy() instance cũ
 *     3. instantiate(prefab mới) → addChild
 *     4. restoreState(state)
 * ──────────────────────────────────────────────────────────────────
 */

import { _decorator, Component, Node, Prefab, instantiate, view, screen, assetManager } from 'cc';
import { CashRacePopup, CashRacePopupState } from './CashRacePopup';
import { RaceInfo } from '../data/CashRaceMockAPI';
import { EventBus } from '../core/EventBus';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

// ── BUNDLE & PREFAB NAMES ──────────────────────────────────────────────────
const BUNDLE_NAME = 'MainBundle';
const PREFAB_NAME_PORTRAIT  = 'CashRacePopupH';  // W = Portrait (dọc)
const PREFAB_NAME_LANDSCAPE = 'CashRacePopupW';  // H = Horizontal (ngang)

@ccclass('CashRacePopupManager')
export class CashRacePopupManager extends Component {

    // ═══════════════════════════════════════════════════════
    //  EDITOR PROPERTIES
    // ═══════════════════════════════════════════════════════

    @property({ type: Node, tooltip: 'Node cha để mount popup vào\n→ Nếu để trống, dùng chính node của Manager' })
    popupParent: Node | null = null;

    /** Đang trong quá trình load prefab — tránh double-instantiate */
    private _isLoading: boolean = false;

    // ═══════════════════════════════════════════════════════
    //  INTERNAL STATE
    // ═══════════════════════════════════════════════════════

    private _currentInstance: Node | null = null;
    private _currentPopup: CashRacePopup | null = null;
    private _isLandscape: boolean = false;

    // ═══════════════════════════════════════════════════════
    //  LIFECYCLE
    // ═══════════════════════════════════════════════════════

    onLoad(): void {
        this._isLandscape = this._checkIsLandscape();
        // Không load prefab sẵn — chỉ load khi cần
        view.on('canvas-resize', this._onCanvasResize, this);
        // Lắng nghe event từ CashRaceWidget — lazy-load + mở popup
        EventBus.instance.on('CASH_RACE_OPEN_POPUP', this._onOpenPopupEvent, this);
    }

    onDestroy(): void {
        view.off('canvas-resize', this._onCanvasResize, this);
        EventBus.instance.offTarget(this);
        this._destroyCurrent();
    }

    // ═══════════════════════════════════════════════════════
    //  EVENT HANDLER
    // ═══════════════════════════════════════════════════════

    /** Nhận event từ CashRaceWidget, lazy-load prefab nếu cần rồi mở popup */
    private _onOpenPopupEvent(raceInfo?: RaceInfo): void {
        if (!this._currentInstance) {
            this._loadPrefab(null, () => this._currentPopup?.openPopup(raceInfo));
            return;
        }
        // Gọi trực tiếp thay vì dùng EventBus để tránh vòng lặp
        this._currentPopup?.openPopup(raceInfo);
    }

    // ═══════════════════════════════════════════════════════
    //  ORIENTATION DETECTION
    // ═══════════════════════════════════════════════════════

    private _checkIsLandscape(): boolean {
        const ws = screen.windowSize;
        return ws.width >= ws.height;
    }

    private _onCanvasResize(): void {
        const isLandscape = this._checkIsLandscape();
        if (isLandscape === this._isLandscape) return; // Cùng orientation → bỏ qua

        this._isLandscape = isLandscape;

        // Chỉ reload nếu prefab đã được load (popup đang hoặc đã được mở)
        if (!this._currentInstance) return;

        Log.d(`[CashRacePopupManager] Orientation → ${isLandscape ? 'LANDSCAPE' : 'PORTRAIT'} — reloading prefab`);

        // Chụp state trước khi hủy
        const state = this._currentPopup?.captureState() ?? null;

        // Hủy instance cũ
        this._destroyCurrent();

        // Load prefab mới và khôi phục state
        this._loadPrefab(state);
    }

    // ═══════════════════════════════════════════════════════
    //  PREFAB MANAGEMENT
    // ═══════════════════════════════════════════════════════

    private _loadPrefab(state: CashRacePopupState | null, onReady?: () => void): void {
        if (this._isLoading) {
            Log.d('[CashRacePopupManager] Đang load prefab, bỏ qua');
            return;
        }

        const bundle = assetManager.getBundle(BUNDLE_NAME);
        if (!bundle) {
            Log.w(`[CashRacePopupManager] Bundle '${BUNDLE_NAME}' chưa được load!`);
            return;
        }

        const prefabName = this._isLandscape ? PREFAB_NAME_LANDSCAPE : PREFAB_NAME_PORTRAIT;
        this._isLoading = true;

        bundle.load(prefabName, Prefab, (err: Error | null, prefab: Prefab) => {
            this._isLoading = false;
            if (err || !prefab) {
                Log.e(`[CashRacePopupManager] Load prefab thất bại: ${prefabName}`, err);
                return;
            }

            const parent = this.popupParent ?? this.node;
            const instance = instantiate(prefab);
            parent.addChild(instance);

            this._currentInstance = instance;
            this._currentPopup = instance.getComponent(CashRacePopup);

            if (!this._currentPopup) {
                Log.w('[CashRacePopupManager] Prefab không có component CashRacePopup ở root node!');
                return;
            }

            // Khôi phục state nếu có (sau orientation change)
            if (state) {
                // scheduleOnce để đảm bảo onLoad của CashRacePopup đã chạy xong
                this.scheduleOnce(() => {
                    this._currentPopup?.restoreState(state);
                }, 0);
            }

            Log.d(`[CashRacePopupManager] Loaded ${prefabName} OK`);
            onReady?.();
        });
    }

    private _destroyCurrent(): void {
        if (this._currentInstance) {
            this._currentInstance.destroy();
            this._currentInstance = null;
        }
        this._currentPopup = null;
    }

    // ═══════════════════════════════════════════════════════
    //  PUBLIC API — proxy sang popup instance hiện tại
    // ═══════════════════════════════════════════════════════

    /** Mở popup (truyền raceInfo nếu có) — lazy-load prefab nếu chưa load */
    public openPopup(raceInfo?: RaceInfo): void {
        if (!this._currentInstance) {
            this._loadPrefab(null, () => this._currentPopup?.openPopup(raceInfo));
            return;
        }
        this._currentPopup?.openPopup(raceInfo);
    }

    /** Đóng popup */
    public closePopup(): void {
        this._currentPopup?.closePopup();
    }

    /** Trả về true nếu popup đang mở */
    public get isOpen(): boolean {
        return this._currentPopup?.isOpen ?? false;
    }

    /** Lấy popup instance hiện tại (nếu cần thao tác trực tiếp) */
    public get popup(): CashRacePopup | null {
        return this._currentPopup;
    }
}
