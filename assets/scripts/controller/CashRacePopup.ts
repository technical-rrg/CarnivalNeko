/**
 * CashRacePopup.ts
 * ──────────────────────────────────────────────────────────────────
 * Component cho Popup bảng xếp hạng Cash Race.
 * Mở khi user bấm nút Cash Race trên HUD (CashRaceWidget).
 *
 * ── SETUP TRONG COCOS EDITOR ──
 *   Gắn component này vào Node popup (bắt đầu inactive).
 *   Cấu trúc node con:
 *
 *     CashRacePopup ← component này
 *       ├── Header
 *       │     ├── LabelTheme      ← Label hiển thị rule (BET / WIN / LOSE)
 *       │     ├── LabelTimer      ← Label đếm ngược DD:HH:MM:SS
 *       │     ├── LabelPrizePool  ← Label "Prize Pool: 999,999B"
 *       │     └── BtnClose        ← Nút X đóng popup
 *       ├── BtnTop3               ← Nút toggle Top 3 / Nearby
 *       ├── BtnRefresh            ← Nút refresh (cooldown 4s)
 *       ├── RankList              ← Node chứa 5 dòng ranking
 *       │     ├── RankRow_0       ← Node dòng 1
 *       │     ├── RankRow_1       ← Node dòng 2
 *       │     ├── RankRow_2       ← Node dòng 3 (YOU!)
 *       │     ├── RankRow_3       ← Node dòng 4
 *       │     └── RankRow_4       ← Node dòng 5
 *       └── HighlightYou          ← Sprite/Node đánh dấu "YOU!" (di chuyển theo dòng isMe)
 *
 *   Mỗi RankRow có cấu trúc:
 *     RankRow_N
 *       ├── LabelRank   ← Label thứ hạng
 *       ├── LabelName   ← Label tên người chơi
 *       ├── LabelScore  ← Label điểm số
 *       └── HighlightBg ← Sprite nền highlight (ẩn mặc định)
 *
 * ── LOGIC CHÍNH ──
 *   1. Nút Refresh: cooldown 4 giây, gọi API getLeaderboard.
 *   2. Toggle Top 3: chuyển giữa Top 3 và Nearby.
 *   3. Hiệu ứng giật số 1.5s (Rolling Numbers Animation):
 *      - Khi data mới trả về → TẮT highlight YOU →
 *        Giật số ngẫu nhiên 1.5s → Dừng, gán data thật → BẬT highlight YOU.
 * ──────────────────────────────────────────────────────────────────
 */

import { _decorator, Component, Node, Label, Sprite, Button, UIOpacity, SpriteFrame, UITransform, Color, Vec3 } from 'cc';
import { getLeaderboard, getRaceInfo, RankItem, RaceInfo, setMockScenario, ACTIVE_SCENARIO, MockScenario } from '../data/CashRaceMockAPI';
import { EventBus } from '../core/EventBus';
import { CashRaceWidget } from './CashRaceWidget';
import { SoundManager } from '../manager/SoundManager';
import { Log } from '../core/Logger';

const { ccclass, property } = _decorator;

// ═══════════════════════════════════════════════════════════
//  Cấu trúc serializable cho mỗi dòng ranking trong Editor
// ═══════════════════════════════════════════════════════════

/**
 * RankRowUI: Nhóm các node label/sprite cho 1 dòng trong bảng xếp hạng.
 * Kéo thả trong Inspector.
 */
@ccclass('RankRowUI')
class RankRowUI {
    @property({ type: Label, tooltip: 'Label thứ hạng (#4, #105 ...); ẩn khi top 1/2/3 dùng sprite' })
    labelRank: Label | null = null;

    @property({ type: Sprite, tooltip: 'Sprite icon thứ hạng (dùng cho Top 1/2/3)\n→ Ẩn mặc định, bật khi rank ≤ 3' })
    spriteRankIcon: Sprite | null = null;

    @property({ type: Label, tooltip: 'Label tên người chơi' })
    labelName: Label | null = null;

    @property({ type: Label, tooltip: 'Label điểm số' })
    labelScore: Label | null = null;

    @property({ type: Node, tooltip: 'Node nền highlight (đánh dấu YOU!)\n→ Ẩn mặc định' })
    highlightBg: Node | null = null;

    @property({ type: Sprite, tooltip: 'Sprite nền của cả Row (được thay bằng hình mờ trong lúc animation)' })
    rowBgSprite: Sprite | null = null;

    @property({ type: Sprite, tooltip: 'Sprite overlay đè lên LabelName khi rolling (chỉ dùng cho Top 3 sub-popup)\n→ Ẩn mặc định' })
    spriteNameOverlay: Sprite | null = null;

    @property({ type: Sprite, tooltip: 'Sprite overlay đè lên LabelScore khi rolling (chỉ dùng cho Top 3 sub-popup)\n→ Ẩn mặc định' })
    spriteScoreOverlay: Sprite | null = null;

    @property({ type: Label, tooltip: 'Label prize (dùng cho sub-popup Top 3)\n→ Có thể null nếu không cần' })
    labelPrize: Label | null = null;
}

/** Snapshot trạng thái runtime để khôi phục sau khi load lại prefab mới (orientation change) */
export interface CashRacePopupState {
    isOpen: boolean;
    raceInfo: RaceInfo | null;
    currentData: RankItem[];
    currentTop3Data: RankItem[];
    isTop3SubOpen: boolean;
}

// ═══════════════════════════════════════════════════════════

@ccclass('CashRacePopup')
export class CashRacePopup extends Component {

    // ═══════════════════════════════════════════════════════
    //  EDITOR PROPERTIES
    // ═══════════════════════════════════════════════════════

    // ── Header ──
    @property({ type: Sprite, tooltip: 'Sprite hiển thị loại đua (BET / WIN / LOSE)\n→ SpriteFrame được đổi theo rule của sự kiện' })
    spriteTheme: Sprite | null = null;

    @property({ type: [SpriteFrame], tooltip: 'Sprite cho 3 loại đua (3 phần tử: index 0=BET, 1=WIN, 2=LOSE)' })
    themeFrames: SpriteFrame[] = [];

    @property({ type: Label, tooltip: 'Label đếm ngược DD:HH:MM:SS' })
    labelTimer: Label | null = null;

    @property({ type: Label, tooltip: 'Label Prize Pool (tổng thưởng)' })
    labelPrizePool: Label | null = null;

    @property({ type: Label, tooltip: 'Label tên sự kiện' })
    labelEventName: Label | null = null;

    // ── Buttons ──
    @property({ type: Node, tooltip: 'Nút X đóng popup' })
    btnClose: Node | null = null;

    @property({ type: Node, tooltip: 'Nút Toggle Top 3 / Nearby' })
    btnTop3: Node | null = null;

    @property({ type: Label, tooltip: 'Label trên nút Top3 (để đổi text)' })
    labelBtnTop3: Label | null = null;

    @property({ type: Node, tooltip: 'Nút Refresh' })
    btnRefresh: Node | null = null;

    // ── Cheat button (debug only) ──
    @property({ type: Node, tooltip: '[DEBUG] Nút ẩn để cycle MockScenario: RANDOM → TOP3 → NEARBY → RANDOM\n→ Mỗi lần nhấn: reset state + fetch lại data' })
    cheatBtn: Node | null = null;

    // ── Icon trên nút Top3 (hiện khi sub-popup đang mở) ──
    @property({ type: Node, tooltip: 'Icon node bên trong btnTop3\n→ active=true khi top3SubPopup đang mở, false khi đóng' })
    iconTop3Active: Node | null = null;

    @property({ type: Node, tooltip: 'Icon node bên trong btnTop3\n→ active=false khi top3SubPopup đang mở, true khi đóng' })
    iconTop3UnActive: Node | null = null;


    // ── Rank List: 5 dòng ──
    @property({ type: [RankRowUI], tooltip: 'Mảng 5 dòng ranking (kéo thả từng dòng)' })
    rankRows: RankRowUI[] = [];

    // ── Highlight YOU marker ──
    @property({ type: Node, tooltip: 'Node "YOU!" marker (di chuyển theo dòng isMe)' })
    youMarker: Node | null = null;

    // ── Top 3 Sub-Popup ──
    @property({ type: Node, tooltip: 'Node sub-popup Top 3 (nằm dính liền popup chính)\n→ Bắt đầu inactive' })
    top3SubPopup: Node | null = null;

    @property({ type: [RankRowUI], tooltip: 'Mảng 3 dòng Top 3 trong sub-popup' })
    top3Rows: RankRowUI[] = [];

    @property({ type: Node, tooltip: 'Node "YOU!" marker trong sub-popup Top 3' })
    youMarkerTop3: Node | null = null;

    // ── Refresh cooldown ──
    @property({ tooltip: 'Thời gian cooldown nút Refresh (giây)' })
    refreshCooldown: number = 4.0;

    // ── Rolling animation duration ──
    @property({ tooltip: 'Thời gian giật số (giây) - theo tài liệu: 1.5s' })
    rollingDuration: number = 1.5;

    // ── Sprites nền dòng ──
    @property({ type: SpriteFrame, tooltip: 'Sprite nền dòng YOU (highlight hồng/đỏ)\n→ Kéo SpriteFrame vào đây' })
    youHighlightSprite: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: 'Sprite nền dòng Top 1/2/3 (vàng)\n→ Kéo SpriteFrame vào đây' })
    top3Sprite: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: 'Sprite nền dòng bình thường (xanh dương)\n→ Kéo SpriteFrame vào đây' })
    normalSprite: SpriteFrame | null = null;

    // ── Icon rank Top 1/2/3 (danh sách chính) ──
    @property({ type: [SpriteFrame], tooltip: 'Icon rank Top 1/2/3 cho danh sách chính (3 phần tử: index 0=Top1, 1=Top2, 2=Top3)' })
    rankIconFrames: SpriteFrame[] = [];

    // ── Icon rank Top 1/2/3 (sub-popup Top 3 — bộ hình khác) ──
    @property({ type: [SpriteFrame], tooltip: 'Icon rank Top 1/2/3 cho sub-popup Top 3 (3 phần tử: index 0=Top1, 1=Top2, 2=Top3)' })
    subRankIconFrames: SpriteFrame[] = [];

    // ── Hình mờ dùng trong lúc animation rolling (nearby list) ──
    @property({ type: [SpriteFrame], tooltip: 'Mảng SpriteFrame đã làm mờ, dùng thay thế sprite gốc của Row trong 1.5s animation\n→ Dùng cho danh sách chính (nearby)' })
    rollingBgFrames: SpriteFrame[] = [];

    // ── Hình rolling cho Top 3 sub-popup (2 mảng riêng cho Name và Score) ──
    @property({ type: [SpriteFrame], tooltip: 'Mảng SpriteFrame random cho overlay Name khi rolling Top 3' })
    rollingNameFrames: SpriteFrame[] = [];

    @property({ type: [SpriteFrame], tooltip: 'Mảng SpriteFrame random cho overlay Score khi rolling Top 3' })
    rollingScoreFrames: SpriteFrame[] = [];

    // ═══════════════════════════════════════════════════════
    //  INTERNAL STATE
    // ═══════════════════════════════════════════════════════

    /** true = sub-popup Top 3 đang mở */
    private _isTop3SubOpen: boolean = false;

    /** Data hiện tại đang hiển thị (nearby) */
    private _currentData: RankItem[] = [];

    /** Data mới chờ hiển thị (nearby - sau animation giật số) */
    private _pendingData: RankItem[] | null = null;

    /** Data Top 3 hiện tại và pending */
    private _currentTop3Data: RankItem[] = [];
    private _pendingTop3Data: RankItem[] | null = null;

    /** Animation giật số sub-popup Top 3 */
    private _isTop3Rolling: boolean = false;
    private _top3RollingElapsed: number = 0;

    /** Lưu SpriteFrame gốc của rowBgSprite trước khi animation để khôi phục sau */
    private _rowOriginalFrames: (SpriteFrame | null)[] = [];
    private _top3RowOriginalFrames: (SpriteFrame | null)[] = [];

    /** Trạng thái cooldown nút Refresh */
    private _isRefreshCooling: boolean = false;
    private _refreshCooldownTimer: number = 0;

    /** Trạng thái animation giật số đang chạy */
    private _isRolling: boolean = false;
    private _rollingElapsed: number = 0;

    /** Race info cho header */
    private _raceInfo: RaceInfo | null = null;

    /** Timer đếm ngược local */
    private _countdownTimer: number = 0;

    // ═══════════════════════════════════════════════════════
    //  LIFECYCLE
    // ═══════════════════════════════════════════════════════

    onLoad(): void {
        this.node.active = false;

        // Ẩn tất cả highlight ban đầu
        for (const row of this.rankRows) {
            if (row.highlightBg) row.highlightBg.active = false;
        }
        if (this.youMarker) this.youMarker.active = false;

        // Ẩn sub-popup Top 3
        if (this.top3SubPopup) this.top3SubPopup.active = false;
        for (const row of this.top3Rows) {
            if (row.highlightBg)        row.highlightBg.active         = false;
            if (row.spriteNameOverlay)  row.spriteNameOverlay.node.active  = false;
            if (row.spriteScoreOverlay) row.spriteScoreOverlay.node.active = false;
        }
        if (this.youMarkerTop3) this.youMarkerTop3.active = false;

        // Ẩn icon top3 lúc khởi tạo
        if (this.iconTop3Active) this.iconTop3Active.active = false;
        if (this.iconTop3UnActive) this.iconTop3UnActive.active = true;

        // Button listeners
        if (this.btnClose)  this.btnClose.on(Node.EventType.TOUCH_END,  this._onClose,              this);
        if (this.btnTop3)   this.btnTop3.on(Node.EventType.TOUCH_END,   this._onToggleTop3,          this);
        if (this.btnRefresh) this.btnRefresh.on(Node.EventType.TOUCH_END, this._onRefresh,           this);
        if (this.cheatBtn)  this.cheatBtn.on(Node.EventType.TOUCH_END,  this._onCheatCycleScenario, this);
    }

    update(dt: number): void {
        if (!this.node.active) return;

        // ── Cooldown nút Refresh ──
        if (this._isRefreshCooling) {
            this._refreshCooldownTimer += dt;
            if (this._refreshCooldownTimer >= this.refreshCooldown) {
                this._isRefreshCooling = false;
                this._refreshCooldownTimer = 0;
                this._setRefreshButtonEnabled(true);
            }
        }

        // ── Animation giật số (nearby) ──
        if (this._isRolling) {
            this._rollingElapsed += dt;
            this._tickRollingAnimation();

            if (this._rollingElapsed >= this.rollingDuration) {
                this._finishRollingAnimation();
            }
        }

        // ── Animation giật số (Top 3 sub-popup) ──
        if (this._isTop3Rolling) {
            this._top3RollingElapsed += dt;
            this._tickTop3RollingAnimation();

            if (this._top3RollingElapsed >= this.rollingDuration) {
                this._finishTop3RollingAnimation();
            }
        }

        // ── Đếm ngược header timer ──
        if (this._raceInfo && this._raceInfo.timeLeft > 0) {
            this._countdownTimer += dt;
            if (this._countdownTimer >= 1.0) {
                this._countdownTimer = 0;
                this._raceInfo.timeLeft--;
                this._updateHeaderTimer();
            }
        }
    }

    onDestroy(): void {
        if (this.btnClose)  this.btnClose.off(Node.EventType.TOUCH_END,  this._onClose,              this);
        if (this.btnTop3)   this.btnTop3.off(Node.EventType.TOUCH_END,   this._onToggleTop3,          this);
        if (this.btnRefresh) this.btnRefresh.off(Node.EventType.TOUCH_END, this._onRefresh,           this);
        if (this.cheatBtn)  this.cheatBtn.off(Node.EventType.TOUCH_END,  this._onCheatCycleScenario, this);
    }

    // ═══════════════════════════════════════════════════════
    //  OPEN / CLOSE POPUP
    // ═══════════════════════════════════════════════════════

    private async _onOpenPopup(raceInfo?: RaceInfo): Promise<void> {
        this.node.active = true;

        // Nhận raceInfo từ widget (nếu có) hoặc fetch mới
        if (raceInfo) {
            this._raceInfo = raceInfo;
        } else {
            try { this._raceInfo = await getRaceInfo(); } catch (e) { /* fallback */ }
        }

        this._updateHeader();
        // Đóng sub-popup Top 3 khi mở lại popup chính
        this._isTop3SubOpen = false;
        this._isTop3Rolling = false;
        if (this.top3SubPopup) this.top3SubPopup.active = false;
        this._updateTop3ButtonLabel();

        // Fetch nearby leaderboard
        await this._fetchAndAnimate();
    }

    private _onClose(): void {
        SoundManager.instance?.playButtonClick();
        this.node.active = false;
        this._isRolling = false;
        this._isTop3Rolling = false;
        this._isTop3SubOpen = false;
        if (this.top3SubPopup) this.top3SubPopup.active = false;
    }

    // ═══════════════════════════════════════════════════════
    //  BUTTON HANDLERS
    // ═══════════════════════════════════════════════════════

    /**
     * Nút Refresh: Gọi API lại, bắt đầu cooldown 4 giây.
     * Trong thời gian cooldown, nút bị vô hiệu hóa (interactable = false).
     * Theo tài liệu p.37: "a 4-second cooldown is applied"
     */
    private async _onRefresh(): Promise<void> {
        if (this._isRefreshCooling || this._isRolling) return;

        // Bắt đầu cooldown
        this._isRefreshCooling = true;
        this._refreshCooldownTimer = 0;
        this._setRefreshButtonEnabled(false);

        await this._fetchAndAnimate();
    }

    /**
     * Nút TOP 3: Toggle sub-popup Top 3.
     * Khi mở → fetch Top 3 data và hiển thị với animation giật số.
     * Khi đóng → ẩn sub-popup.
     */
    private async _onToggleTop3(): Promise<void> {
        if (this._isRolling) return;

        this._isTop3SubOpen = !this._isTop3SubOpen;
        this._updateTop3ButtonLabel();

        if (this._isTop3SubOpen) {
            if (this.top3SubPopup) this.top3SubPopup.active = true;
            await this._fetchTop3AndShow();
        } else {
            this._isTop3Rolling = false;
            if (this.top3SubPopup) this.top3SubPopup.active = false;
        }
    }

    // ═══════════════════════════════════════════════════════
    //  DATA FETCHING + ANIMATION PIPELINE
    // ═══════════════════════════════════════════════════════

    /**
     * Pipeline nearby: Fetch nearby leaderboard → animation → hiển thị.
     */
    private async _fetchAndAnimate(): Promise<void> {
        try {
            const data = await getLeaderboard(false);
            this._pendingData = data;
            this._startRollingAnimation();
        } catch (err) {
            Log.w('[CashRacePopup] Lỗi khi gọi getLeaderboard (nearby):', err);
        }
    }

    /**
     * Pipeline Top 3: Fetch Top 3 data → hiển thị ngay (không rolling).
     */
    private async _fetchTop3AndShow(): Promise<void> {
        try {
            const data = await getLeaderboard(true);
            this._currentTop3Data = data;
            this._applyDataToRows(this._currentTop3Data, this.top3Rows, this.youMarkerTop3, true);
        } catch (err) {
            Log.w('[CashRacePopup] Lỗi khi gọi getLeaderboard (top3):', err);
        }
    }

    // ═══════════════════════════════════════════════════════
    //  HIỆU ỨNG ROLLING 1.5 GIÂY
    // ═══════════════════════════════════════════════════════
    //
    //  BƯỚC 1: Ẩn toàn bộ labels/icons trong mỗi Row.
    //          Thay sprite nền Row bằng hình mờ random từ rollingBgFrames.
    //          Tắt YOU! marker + highlight.
    //
    //  BƯỚC 2: Mỗi frame đổi sprite nền Row sang hình mờ random khác
    //          → tạo hiệu ứng "xẹt xẹt" nhấp nháy.
    //
    //  BƯỚC 3: Sau 1.5s: khôi phục sprite nền gốc → gán data thật.
    //

    private _startRollingAnimation(): void {
        this._isRolling = true;
        this._rollingElapsed = 0;

        if (this.youMarker) this.youMarker.active = false;

        this._rowOriginalFrames = this.rankRows.map(row => row.rowBgSprite?.spriteFrame ?? null);
        for (const row of this.rankRows) {
            if (row.highlightBg)    row.highlightBg.active         = false;
            if (row.labelRank)      row.labelRank.node.active      = false;
            if (row.spriteRankIcon) row.spriteRankIcon.node.active = false;
            if (row.labelName)      row.labelName.node.active      = false;
            if (row.labelScore)     row.labelScore.node.active     = false;
            if (row.labelPrize)     row.labelPrize.node.active     = false;
            this._setRandomRollingBg(row);
        }
    }

    private _tickRollingAnimation(): void {
        for (const row of this.rankRows) {
            this._setRandomRollingBg(row);
        }
    }

    private _finishRollingAnimation(): void {
        this._isRolling = false;

        this.rankRows.forEach((row) => {
            if (row.spriteScoreOverlay) row.spriteScoreOverlay.node.active = false;
        });

        if (!this._pendingData) return;
        this._currentData = this._pendingData;
        this._pendingData = null;
        this._applyDataToRows(this._currentData, this.rankRows, this.youMarker, false);

        Log.d('%c♪ Play Ting-Ting Sound ♪', 'color:#FFD700;font-weight:bold;font-size:14px');
    }

    // ── TOP 3 SUB-POPUP ANIMATION ──

    private _startTop3RollingAnimation(): void {
        this._isTop3Rolling = true;
        this._top3RollingElapsed = 0;

        if (this.youMarkerTop3) this.youMarkerTop3.active = false;

        this._top3RowOriginalFrames = this.top3Rows.map(row => row.rowBgSprite?.spriteFrame ?? null);
        for (const row of this.top3Rows) {
            if (row.highlightBg)    row.highlightBg.active         = false;
            if (row.labelRank)      row.labelRank.node.active      = false;
            if (row.spriteRankIcon) row.spriteRankIcon.node.active = false;
            if (row.labelPrize)     row.labelPrize.node.active     = false;
            // Ẩn label Name/Score, bật overlay sprite chồng lên
            if (row.labelName)  row.labelName.node.active  = false;
            if (row.labelScore) row.labelScore.node.active = false;
            if (row.spriteNameOverlay)  row.spriteNameOverlay.node.active  = true;
            if (row.spriteScoreOverlay) row.spriteScoreOverlay.node.active = true;
            this._tickTop3RowOverlay(row);
        }
    }

    private _tickTop3RollingAnimation(): void {
        for (const row of this.top3Rows) {
            this._tickTop3RowOverlay(row);
        }
    }

    /** Đặt SpriteFrame random vào overlay Name và Score của một Top3 row */
    private _tickTop3RowOverlay(row: RankRowUI): void {
        if (row.spriteNameOverlay && this.rollingNameFrames.length > 0) {
            row.spriteNameOverlay.spriteFrame =
                this.rollingNameFrames[Math.floor(Math.random() * this.rollingNameFrames.length)];
        }
        if (row.spriteScoreOverlay && this.rollingScoreFrames.length > 0) {
            row.spriteScoreOverlay.spriteFrame =
                this.rollingScoreFrames[Math.floor(Math.random() * this.rollingScoreFrames.length)];
        }
    }

    private _finishTop3RollingAnimation(): void {
        this._isTop3Rolling = false;

        // Ẩn overlay, bật label trở lại (sẽ được gán data trong _applyDataToRows)
        for (const row of this.top3Rows) {
            if (row.spriteNameOverlay)  row.spriteNameOverlay.node.active  = false;
            if (row.spriteScoreOverlay) row.spriteScoreOverlay.node.active = false;
        }

        this.top3Rows.forEach((row, i) => {
            if (row.rowBgSprite) row.rowBgSprite.spriteFrame = this._top3RowOriginalFrames[i] ?? null;
        });

        if (!this._pendingTop3Data) return;
        this._currentTop3Data = this._pendingTop3Data;
        this._pendingTop3Data = null;
        this._applyDataToRows(this._currentTop3Data, this.top3Rows, this.youMarkerTop3, true);

        Log.d('%c♪ Play Ting-Ting Sound (Top 3) ♪', 'color:#FFD700;font-weight:bold;font-size:14px');
    }

    /** Bật spriteScoreOverlay và gán SpriteFrame mờ ngẫu nhiên từ rollingBgFrames */
    private _setRandomRollingBg(row: RankRowUI): void {
        if (!row.spriteScoreOverlay || this.rollingBgFrames.length === 0) return;
        row.spriteScoreOverlay.node.active = true;
        const idx = Math.floor(Math.random() * this.rollingBgFrames.length);
        row.spriteScoreOverlay.spriteFrame = this.rollingBgFrames[idx];
    }

    // ═══════════════════════════════════════════════════════
    //  ÁP DỤNG DATA VÀO UI ROWS
    // ═══════════════════════════════════════════════════════

    /**
     * Gán data vào các dòng ranking.
     * @param data      Mảng RankItem cần hiển thị
     * @param rows      Mảng RankRowUI mục tiêu
     * @param youMarker Node YOU! marker cần di chuyển (null = bỏ qua)
     * @param showPrize true = hiển thị cột prize (sub-popup Top 3)
     */
    private _applyDataToRows(
        data: RankItem[],
        rows: RankRowUI[],
        youMarker: Node | null,
        showPrize: boolean
    ): void {
        let youRowIndex = -1;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row) continue;

            if (i < data.length) {
                const item = data[i];

                // ── Rank: sprite cho top 1/2/3, label cho phần còn lại ──
                const isTop3Rank = item.rank >= 1 && item.rank <= 3;
                const iconFrames = showPrize ? this.subRankIconFrames : this.rankIconFrames;
                const iconFrame  = isTop3Rank ? (iconFrames[item.rank - 1] ?? null) : null;

                if (row.spriteRankIcon) {
                    if (iconFrame) {
                        row.spriteRankIcon.spriteFrame = iconFrame;
                        row.spriteRankIcon.node.active = true;
                    } else {
                        row.spriteRankIcon.node.active = false;
                    }
                }

                if (row.labelRank) {
                    if (iconFrame) {
                        row.labelRank.node.active = false;
                    } else if (this._raceInfo && item.rank <= (this._raceInfo.rewardUsers || 100)) {
                        row.labelRank.node.active = true;
                        row.labelRank.string = CashRaceWidget.toOrdinal(item.rank);
                    } else {
                        row.labelRank.node.active = true;
                        row.labelRank.string = `#${item.rank}`;
                    }
                }

                // ── Name Label: tối đa 10 ký tự, bật active ──
                if (row.labelName) {
                    row.labelName.node.active = true;
                    const name = item.playerName;
                    row.labelName.string = name.length > 10 ? name.slice(0, 10) + '...' : name;
                    row.labelName.color = item.isMe
                        ? new Color(235, 255, 5, 255)   // #EBFF05
                        : new Color(214, 214, 214, 255); // #d6d6d6
                }

                // ── Score Label: số đầy đủ, dấu phẩy, 3 chữ số thập phân, bật active ──
                if (row.labelScore) {
                    row.labelScore.node.active = true;
                    row.labelScore.string = item.score.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
                }

                // ── Prize Label: dùng format KMBT ──
                if (row.labelPrize) {
                    if (showPrize && item.prize != null) {
                        row.labelPrize.string = `Prize: ${CashRaceWidget.formatKMBT(item.prize)}`;
                        row.labelPrize.node.active = true;
                    } else {
                        row.labelPrize.node.active = false;
                    }
                }

                // ── Highlight: đánh dấu dòng isMe ──
                if (row.highlightBg) {
                    if (item.isMe) {
                        row.highlightBg.active = true;
                        youRowIndex = i;
                        const sprite = row.highlightBg.getComponent(Sprite);
                        if (sprite && this.youHighlightSprite) sprite.spriteFrame = this.youHighlightSprite;
                    } else if (showPrize && item.rank <= 3) {
                        // Sub-popup Top 3: dòng top dùng sprite vàng
                        row.highlightBg.active = true;
                        const sprite = row.highlightBg.getComponent(Sprite);
                        if (sprite && this.top3Sprite) sprite.spriteFrame = this.top3Sprite;
                    } else if (this.normalSprite) {
                        row.highlightBg.active = true;
                        const sprite = row.highlightBg.getComponent(Sprite);
                        if (sprite) sprite.spriteFrame = this.normalSprite;
                    } else {
                        row.highlightBg.active = false;
                    }
                }

                // Hiện dòng (dùng labelName làm anchor vì labelRank có thể bị ẩn khi top 1/2/3)
                const rowRootNode = row.labelName?.node.parent ?? row.labelRank?.node.parent ?? null;
                if (rowRootNode) rowRootNode.active = true;
            } else {
                // Hiện dòng rỗng (không có data)
                const rowRootNode = row.labelName?.node.parent ?? row.labelRank?.node.parent ?? null;
                if (rowRootNode) rowRootNode.active = true;
                if (row.spriteRankIcon) row.spriteRankIcon.node.active = false;
                if (row.highlightBg) row.highlightBg.active = false;
                if (row.labelRank)  { row.labelRank.node.active  = true; row.labelRank.string  = ''; }
                if (row.labelName)  { row.labelName.node.active  = true; row.labelName.string  = ''; }
                if (row.labelScore) { row.labelScore.node.active = true; row.labelScore.string = ''; }
                if (row.labelPrize) row.labelPrize.node.active = false;
            }
        }

        // ── YOU! Marker: di chuyển đến dòng isMe ──
        if (youMarker) {
            if (youRowIndex >= 0 && rows[youRowIndex]?.labelRank?.node.parent) {
                youMarker.active = true;
                const targetRow = rows[youRowIndex].labelRank!.node.parent!;
                const worldPos = targetRow.worldPosition.clone();
                const parentNode = youMarker.parent;
                if (parentNode) {
                    const localPos = parentNode.inverseTransformPoint(new Vec3(), worldPos);
                    youMarker.setPosition(youMarker.position.x, localPos.y + 30, 0);
                }
            } else {
                youMarker.active = false;
            }
        }
    }

    // ═══════════════════════════════════════════════════════
    //  HEADER UI UPDATE
    // ═══════════════════════════════════════════════════════

    private _updateHeader(): void {
        if (!this._raceInfo) return;

        // Đổi sprite theo rule: BET=0, WIN=1, LOSE=2
        if (this.spriteTheme && this.themeFrames.length >= 3) {
            const ruleIndex = this._raceInfo.rule === 'BET' ? 0 : this._raceInfo.rule === 'WIN' ? 1 : 2;
            this.spriteTheme.spriteFrame = this.themeFrames[ruleIndex] ?? null;
        }
        if (this.labelEventName) this.labelEventName.string = this._raceInfo.eventName;
        if (this.labelPrizePool) {
            this.labelPrizePool.string = `${CashRaceWidget.formatKMBT(this._raceInfo.prizePool)}`;
        }

        this._updateHeaderTimer();
    }

    private _updateHeaderTimer(): void {
        if (!this.labelTimer || !this._raceInfo) return;

        this.labelTimer.string = CashRaceWidget.formatDDHHMMSS(this._raceInfo.timeLeft);
    }

    // ═══════════════════════════════════════════════════════
    //  UI HELPERS
    // ═══════════════════════════════════════════════════════

    /** Bật/tắt nút Refresh */
    private _setRefreshButtonEnabled(enabled: boolean): void {
        if (!this.btnRefresh) return;
        const btn = this.btnRefresh.getComponent(Button);
        if (btn) btn.interactable = enabled;

        // Đổi opacity để thể hiện trạng thái disabled
        let opacity = this.btnRefresh.getComponent(UIOpacity);
        if (!opacity) opacity = this.btnRefresh.addComponent(UIOpacity);
        opacity.opacity = enabled ? 255 : 128;
    }

    /** Cập nhật label nút Top 3 + icon active state */
    private _updateTop3ButtonLabel(): void {
        if (this.labelBtnTop3) {
            this.labelBtnTop3.string = this._isTop3SubOpen ? '< ẨN TOP 3 >' : '< TOP 3 >';
        }
        if (this.iconTop3Active) {
            this.iconTop3Active.active = this._isTop3SubOpen;
        }
        if (this.iconTop3UnActive) {
            this.iconTop3UnActive.active = !this._isTop3SubOpen;
        }
    }

    /**
     * [DEBUG CHEAT] Cycle MockScenario: RANDOM → TOP3 → NEARBY → RANDOM.
     * Reset state và fetch lại data ngay lập tức.
     */
    private async _onCheatCycleScenario(): Promise<void> {
        const order: MockScenario[] = ['RANDOM', 'TOP3', 'NEARBY', 'EMPTY'];
        const currentIdx = order.indexOf(ACTIVE_SCENARIO);
        const nextScenario = order[(currentIdx + 1) % order.length];
        setMockScenario(nextScenario);
        Log.w(`[CHEAT] MockScenario → ${nextScenario}`);

        // Fetch lại race info + nearby list với scenario mới
        try { this._raceInfo = await getRaceInfo(); } catch (e) { /* ignore */ }
        this._updateHeader();
        await this._fetchAndAnimate();

        // Nếu Top3 sub-popup đang mở thì fetch lại Top3 luôn
        if (this._isTop3SubOpen) {
            await this._fetchTop3AndShow();
        }
    }

    /**
     * Tạo chuỗi ký tự ngẫu nhiên (dùng cho animation giật số).
     * Mô phỏng hiệu ứng bảng điện tử sân bay.
     */
    private _randomString(length: number): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    // ═══════════════════════════════════════════════════════
    //  PUBLIC API (cho external control)
    // ═══════════════════════════════════════════════════════

    /** Mở popup từ code bên ngoài (không qua EventBus) */
    public openPopup(raceInfo?: RaceInfo): void {
        this._onOpenPopup(raceInfo);
    }

    /** Đóng popup từ code bên ngoài */
    public closePopup(): void {
        this._onClose();
    }

    /** Kiểm tra popup đang mở */
    public get isOpen(): boolean {
        return this.node.active;
    }

    /**
     * Chụp toàn bộ trạng thái runtime hiện tại.
     * Dùng bởi CashRacePopupManager trước khi destroy instance cũ.
     */
    public captureState(): CashRacePopupState {
        return {
            isOpen:          this.node.active,
            raceInfo:        this._raceInfo,
            currentData:     [...this._currentData],
            currentTop3Data: [...this._currentTop3Data],
            isTop3SubOpen:   this._isTop3SubOpen,
        };
    }

    /**
     * Khôi phục trạng thái vào instance mới (sau khi load lại prefab cho orientation mới).
     * Nếu popup đang mở thì render lại toàn bộ UI ngay lập tức.
     */
    public restoreState(state: CashRacePopupState): void {
        this._raceInfo        = state.raceInfo;
        this._currentData     = state.currentData;
        this._currentTop3Data = state.currentTop3Data;
        this._isTop3SubOpen   = state.isTop3SubOpen;

        if (!state.isOpen) return;

        this.node.active = true;
        this._updateHeader();
        this._applyDataToRows(this._currentData, this.rankRows, this.youMarker, false);

        if (this._isTop3SubOpen && this.top3SubPopup) {
            this.top3SubPopup.active = true;
            this._applyDataToRows(this._currentTop3Data, this.top3Rows, this.youMarkerTop3, true);
        }
        this._updateTop3ButtonLabel();
    }
}
