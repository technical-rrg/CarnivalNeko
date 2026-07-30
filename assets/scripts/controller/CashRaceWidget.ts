/**
 * CashRaceWidget.ts
 * ──────────────────────────────────────────────────────────────────
 * Component gắn vào nút Cash Race ngoài màn hình chính (HUD).
 *
 * ── CẤU TRÚC NODE TREE (EDITOR) ──
 *
 *   BtnCashRace  ← gắn component này
 *     ├── ProgressBar           (Sprite FILLED RADIAL — vòng bao quanh)
 *     ├── IconWreath            (Sprite — vòng nguyệt quế)
 *     ├── CenterContainer       (Node trung tâm — chứa nội dung xoay vòng)
 *     │     ├── IconDefault     (Sprite — logo huy chương)
 *     │     └── LabelRolling   (Label — text BET/WIN/LOSE, Prize, Time)
 *     ├── NoticeTooltipContainer(Node nổi lơ lửng trên đỉnh nút khi chờ mở)
 *     │     └── LabelNoticeCountdown (Label — đếm ngược HH:MM:SS)
 *     └── BadgeRankContainer    (Node huy hiệu hạng)
 *           └── LabelRank       (Label — "#105" hoặc "1st")
 *
 * ── TRẠNG THÁI "CHỜ MỞ" (isNotice = true) ──
 *   → Ẩn: ProgressBar, IconWreath, BadgeRankContainer, LabelRolling
 *   → Hiện: IconDefault (tĩnh) + NoticeTooltipContainer (đếm ngược HH:MM:SS)
 *   → Carousel dừng lại
 *
 * ── TRẠNG THÁI "ĐANG ĐUA" (isNotice = false) ──
 *   → Ẩn: LabelCountdown
 *   → Luôn hiện: BadgeRankContainer + LabelRank
 *   → Luân phiên: ProgressBar ↔ IconWreath (tùy rank)
 *   → CAROUSEL tại CenterContainer (chu kỳ 16s = 4 phase × 4s):
 *       Phase 1 ( 0- 4s): IconDefault HIỆN,  LabelRolling ẨN
 *       Phase 2 ( 4- 8s): IconDefault ẨN,    LabelRolling HIỆN → "BET/WIN/LOSE"
 *       Phase 3 ( 8-12s): IconDefault ẨN,    LabelRolling HIỆN → "Prize: 1.5M"
 *       Phase 4 (12-16s): IconDefault ẨN,    LabelRolling HIỆN → "Left: 12:00:00"
 *       → Lặp vô hạn
 *
 * ── GHI CHÚ KỸ THUẬT ──
 *   • Chuyển phase: fade-out 0.2s → đổi nội dung → fade-in 0.2s (dùng cc.tween).
 *   • _isFading = true khi đang transition → không tăng timer carousel.
 *   • IconDefault và LabelRolling KHÔNG bao giờ hiện cùng lúc trong racing mode.
 * ──────────────────────────────────────────────────────────────────
 */

import { _decorator, Component, Node, Label, Sprite, SpriteFrame, tween, Tween, UIOpacity, Color, RichText } from 'cc';
import { getRaceInfo, mapCrToRaceInfo, RaceInfo } from '../data/CashRaceMockAPI';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { NwCashRaceSimpleForUser } from '../data/SlotTypes';
import { Log } from '../core/Logger';
import { USE_REAL_API } from '../data/ServerConfig';
import { NetworkManager } from '../manager/NetworkManager';

const { ccclass, property } = _decorator;

// ── 4 phase trong chu kỳ Carousel 16 giây ──
const enum CarouselPhase {
    ICON = 0,  // 0- 4s: Hiện IconDefault
    RULE = 1,  // 4- 8s: Hiện text chủ đề (BET/WIN/LOSE)
    POOL = 2,  // 8-12s: Hiện tổng thưởng (Prize: 1.5M)
    TIME = 3,  // 12-16s: Hiện thời gian còn lại (Left: HH:MM:SS)
}

const PHASE_DURATION = 4.0;  // Mỗi phase: 4 giây
const FADE_DURATION  = 0.2;  // Thời gian fade-in/out khi chuyển phase

@ccclass('CashRaceWidget')
export class CashRaceWidget extends Component {

    // ═══════════════════════════════════════════════════════
    //  EDITOR PROPERTIES — kéo thả node vào Inspector
    // ═══════════════════════════════════════════════════════

    // ── Sprite chính của node (thay frame theo trạng thái) ──
    @property({ type: Sprite, tooltip: 'Sprite chính của node BtnCashRace\n→ Frame sẽ đổi tự động theo trạng thái' })
    spriteMain: Sprite | null = null;

    @property({ type: Node, tooltip: 'line' })
    line: Node | null = null;

    
    @property({ type: SpriteFrame, tooltip: 'SpriteFrame khi chưa vào event (isNotice = true)\n→ Hiện cùng lúc LabelNoticeCountdown mở' })
    spriteFrameNotice: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: 'SpriteFrame khi đang đua (isNotice = false)\n→ Hiện khi carousel bắt đầu chạy' })
    spriteFrameRacing: SpriteFrame | null = null;

    // ── Vòng bao quanh ──
    @property({ type: Sprite, tooltip: 'ProgressBar: Sprite FILLED RADIAL — vòng bao quanh\nActive khi rank > rewardUsers' })
    progressBar: Sprite | null = null;

    @property({ type: Sprite, tooltip: 'IconWreath: Sprite vòng nguyệt quế\nActive khi rank ≤ rewardUsers (lọt top thưởng)' })
    iconWreath: Sprite | null = null;

    // ── CenterContainer và các node con ──
    @property({ type: Node, tooltip: 'CenterContainer: Node trung tâm chứa nội dung xoay vòng\n→ Kéo node CenterContainer vào đây' })
    centerContainer: Node | null = null;

    @property({ type: Sprite, tooltip: 'IconDefault: Sprite logo huy chương (Phase 1)\n→ Con của CenterContainer' })
    iconDefault: Sprite | null = null;

    @property({ type: RichText, tooltip: 'LabelRolling: Label text chạy (Phase 3/4)\n→ Con của CenterContainer' })
    labelRolling: RichText | null = null;

    @property({ type: Sprite, tooltip: 'IconRule: Sprite hiển thị luật chơi (Phase 2 — BET/WIN/LOSE)\n→ Con của CenterContainer' })
    iconRule: Sprite | null = null;

    @property({ type: [SpriteFrame], tooltip: 'RuleSpriteFrames: [0]=BET, [1]=WIN, [2]=LOSE\n→ SpriteFrame tương ứng với từng luật' })
    ruleSpriteFrames: SpriteFrame[] = [];

    // ── NoticeTooltipContainer (nổi trên đỉnh nút, chỉ hiện khi isNotice=true) ──
    @property({ type: Node, tooltip: 'NoticeTooltipContainer: Node Tooltip đếm ngược lơ lửng trên đỉnh nút\n→ Chỉ hiện khi isNotice=true' })
    noticeTooltipContainer: Node | null = null;

    @property({ type: Label, tooltip: 'LabelNoticeCountdown: Label đếm ngược HH:MM:SS bên trong NoticeTooltipContainer' })
    labelNoticeCountdown: Label | null = null;

    // ── BadgeRankContainer ──
    @property({ type: Node, tooltip: 'BadgeRankContainer: Node huy hiệu hạng (góc/cạnh dưới)\n→ Luôn hiện khi đang đua' })
    badgeRankContainer: Node | null = null;

    @property({ type: Label, tooltip: 'LabelRank: Label hiển thị "#105" hoặc "1st"\n→ Con của BadgeRankContainer' })
    labelRank: Label | null = null;

    // ── Nút bấm mở popup ──
    @property({ type: Node, tooltip: 'Node bắt sự kiện touch để mở CashRacePopup\n→ Thường là chính node BtnCashRace' })
    btnOpenPopup: Node | null = null;

    // ── Cấu hình ──
    @property({ tooltip: 'Khoảng thời gian polling data từ server (giây)' })
    pollInterval: number = 5.0;

    // ═══════════════════════════════════════════════════════
    //  INTERNAL STATE
    // ═══════════════════════════════════════════════════════

    private _raceInfo: RaceInfo | null = null;

    // Carousel
    private _carouselPhase: CarouselPhase = CarouselPhase.ICON;
    private _carouselTimer: number = 0;
    /** true khi đang trong transition fade → bỏ qua tăng timer */
    private _isFading: boolean = false;
    /** true nếu phase đã được apply lần đầu */
    private _carouselInitialized: boolean = false;

    // MyPrizePercent từ Jackpot CR polling (0-100)
    private _myPrizePercent: number = 0;

    /** true khi Jackpot đã xác nhận CR=null (race kết thúc, user chưa tham gia)
     *  → ngăn widget gọi CashRaceMyRankGetFirst không cần thiết. */
    private _crIsNull: boolean = false;

    // Polling & countdown
    private _pollTimer: number = 0;
    private _secondTimer: number = 0;

    // Wreath blink
    private _isWreathBlinking: boolean = false;
    private _wreathTween: Tween<UIOpacity> | null = null;

    // ═══════════════════════════════════════════════════════
    //  LIFECYCLE
    // ═══════════════════════════════════════════════════════

    onLoad(): void {
        // Stay hidden until data confirms a race exists.
        this._hideAll();
        this.node.active = false;

        if (this.btnOpenPopup) {
            this.btnOpenPopup.on(Node.EventType.TOUCH_END, this._onTap, this);
        }

        EventBus.instance.on(GameEvents.CASH_RACE_CR_UPDATED, this._onCrUpdated, this);

        // Real API: wait for Jackpot CR event (avoids flash when CR=null).
        // Mock mode: no Jackpot CR events, so fetch immediately.
        if (!USE_REAL_API) {
            this._fetchData();
        }
    }

    update(dt: number): void {
        if (!this._raceInfo) return;

        // ── Polling data định kỳ ──
        this._pollTimer += dt;
        if (this._pollTimer >= this.pollInterval) {
            this._pollTimer = 0;
            this._fetchData();
        }

        // ── Đồng hồ đếm ngược local (giảm 1 giây/frame khi tích lũy đủ) ──
        this._secondTimer += dt;
        if (this._secondTimer >= 1.0) {
            this._secondTimer = 0;
            if (this._raceInfo.timeLeft > 0) this._raceInfo.timeLeft--;
        }

        // ── Phân nhánh theo trạng thái ──
        if (this._raceInfo.isNotice) {
            this._runNoticeMode();
        } else {
            this._runRacingMode(dt);
        }
    }

    onDestroy(): void {
        if (this.btnOpenPopup) {
            this.btnOpenPopup.off(Node.EventType.TOUCH_END, this._onTap, this);
        }
        EventBus.instance.off(GameEvents.CASH_RACE_CR_UPDATED, this._onCrUpdated, this);
        this._stopWreathBlink();
    }

    // ═══════════════════════════════════════════════════════
    //  DATA FETCHING
    // ═══════════════════════════════════════════════════════

    private _onCrUpdated(cr: NwCashRaceSimpleForUser | null): void {
        if (!cr) {
            // Jackpot confirms CR=null: race ended or user never participated.
            // Hide the button and block further CashRaceMyRankGetFirst calls.
            if (!this._crIsNull) {
                Log.d('%c[CashRace][Widget] CR=null from Jackpot → hiding Cash Race button', 'color:#f44;font-weight:bold');
                this._crIsNull = true;
            }
            this._raceInfo = null;
            this.node.active = false;
            this._hideAll();
            return;
        }
        // CR is present → reset the null-flag so polling resumes if race restarts
        this._crIsNull = false;
        this._myPrizePercent = cr.MyPrizePercent ?? 0;
        Log.d('%c[CashRace][Widget] CR nhận từ Jackpot polling:', 'color:#fa0;font-weight:bold',
            `MyRank=${cr.MyRank}  MyPrizePercent=${cr.MyPrizePercent}%`,
            '| Race.State=', cr.Race?.State, '| Race.Rule=', cr.Race?.Rule,
            '| TotalPrize=', cr.Race?.TotalPrize,
            '| CT=', cr.Race?.CT);

        if (!cr.Race) {
            // CR exists but Race is null inside it — keep hidden
            return;
        }

        if (!this._raceInfo) {
            // First time we know a race exists: populate from Jackpot CR
            // and kick off a full CashRaceMyRankGetFirst for detailed rank data.
            const mapped = mapCrToRaceInfo(cr, null);
            if (mapped) {
                this._raceInfo = mapped;
                this.node.active = true;
                Log.d('%c[CashRace][Widget] _raceInfo populated from Jackpot CR → showing button', 'color:#0f9;font-weight:bold');
                // Fetch detailed rank info (TopRanks etc.) in background
                this._fetchData();
            }
        } else {
            // Subsequent polls: update real-time fields from Jackpot
            this._raceInfo.prizePool = cr.Race.TotalPrize;
            this._raceInfo.myRank   = (cr.MyRank as any) ?? this._raceInfo.myRank;
        }
    }

    private async _fetchData(): Promise<void> {
        try {
            const prev = this._raceInfo;

            // Chuyển đổi Mock ↔ Real dựa trên USE_REAL_API
            if (USE_REAL_API) {
                // When the Jackpot polling has already confirmed CR=null, skip the
                // CashRaceMyRankGetFirst call entirely — no race is active for this user.
                if (this._crIsNull) {
                    this.node.active = false;
                    return;
                }

                // Real API: gọi NetworkManager
                const resp = await NetworkManager.instance.sendCashRaceMyRankGetFirst();
                if (resp?.Race) {
                    // Convert CashRaceMyRankGetFirstResponse → NwCashRaceSimpleForUser compatible
                    const cr: NwCashRaceSimpleForUser = {
                        Race: resp.Race as any,
                        MyRank: resp.MyRank?.Rank ?? 0,
                        MyPrizePercent: 0,
                    };
                    this._raceInfo = mapCrToRaceInfo(cr, null);
                } else {
                    this._raceInfo = null;
                }
            } else {
                // Mock mode: dùng CashRaceMockAPI
                this._raceInfo = await getRaceInfo();
            }

            if (!this._raceInfo) {
                // Không có sự kiện → ẩn toàn bộ nút
                this.node.active = false;
                this._hideAll();
                return;
            }

            // Có sự kiện → hiện nút
            this.node.active = true;

            // Chuyển từ không có event (null) hoặc Notice → Racing: reset carousel
            if ((!prev || prev.isNotice) && !this._raceInfo.isNotice) {
                this._resetCarousel();
            }
        } catch (err) {
            Log.w('[CashRaceWidget] Lỗi _fetchData:', err);
        }
    }

    // ═══════════════════════════════════════════════════════
    //  TRẠNG THÁI "CHỜ MỞ" (isNotice = true)
    // ═══════════════════════════════════════════════════════
    //
    //  Ẩn tất cả: ProgressBar, IconWreath, BadgeRankContainer, LabelRolling.
    //  Hiện: IconDefault (tĩnh) + NoticeTooltipContainer (đếm ngược HH:MM:SS).
    //  Carousel không chạy.
    //

    private _runNoticeMode(): void {
        this._setActive(this.progressBar?.node,      false);
        this._setActive(this.iconWreath?.node,       false);
        this._setActive(this.badgeRankContainer,     false);
        this._setActive(this.labelRolling?.node,     false);
        this._setActive(this.iconDefault?.node,      false);

        // Hiện Tooltip đếm ngược nổi trên đỉnh nút
        this._setActive(this.noticeTooltipContainer, true);
        if (this.labelNoticeCountdown && this._raceInfo) {
            this.labelNoticeCountdown.string = CashRaceWidget.formatHHMMSS(this._raceInfo.timeLeft);
        }

        // Đổi sprite chính sang frame "chưa vào event"
        if (this.spriteMain && this.spriteFrameNotice) {
            this.spriteMain.spriteFrame = this.spriteFrameNotice;
            
        }
        if(this.line)
            this.line.active = false;
        this._stopWreathBlink();
        // Dừng tween carousel và freeze timer
        if (this.iconDefault?.node)  Tween.stopAllByTarget(this.iconDefault.node);
        if (this.labelRolling?.node) Tween.stopAllByTarget(this.labelRolling.node);
        if (this.iconRule?.node)     Tween.stopAllByTarget(this.iconRule.node);
        this._isFading = false;
        this._carouselTimer = 0;
    }

    // ═══════════════════════════════════════════════════════
    //  TRẠNG THÁI "ĐANG ĐUA" (isNotice = false)
    // ═══════════════════════════════════════════════════════
    //
    //  • NoticeTooltipContainer luôn ẩn.
    //  • BadgeRankContainer luôn hiện.
    //  • ProgressBar ↔ IconWreath luân phiên theo rank.
    //  • Carousel chạy ở CenterContainer (Phase TIME dùng LabelRolling).
    //

    private _runRacingMode(dt: number): void {

        if(this.line)
            this.line.active = true;

        if (!this._raceInfo) return;

        this._setActive(this.noticeTooltipContainer, false);

        // Đổi sprite chính sang frame "đang đua"
        if (this.spriteMain && this.spriteFrameRacing) {
            this.spriteMain.spriteFrame = this.spriteFrameRacing;
        }

        // BadgeRankContainer: chỉ hiện khi user đã có rank (myRank > 0)
        const hasRank = (this._raceInfo.myRank ?? 0) > 0;
        this._setActive(this.badgeRankContainer, hasRank);
        if (hasRank) this._updateRankLabel();

        // ProgressBar ↔ IconWreath: chỉ hiện khi user đã có rank
        const rewardUsers = this._raceInfo.rewardUsers ?? 0;
        const isPrizeEligible = hasRank && rewardUsers > 0 && this._raceInfo.myRank <= rewardUsers;
        if (isPrizeEligible) {
            this._setActive(this.progressBar?.node, false);
            this._showWreath(true);
        } else {
            this._showWreath(false);
            this._setActive(this.progressBar?.node, true);
            this._updateProgressFill();
        }
    
        // Lần đầu tiên: apply phase initial
        if (!this._carouselInitialized) {
            this._carouselInitialized = true;
            this._applyPhase(this._carouselPhase);
        }

        // Carousel tại CenterContainer
        this._tickCarousel(dt);
    }

    // ═══════════════════════════════════════════════════════
    //  CAROUSEL (Chu kỳ 16 giây, 4 phase × 4 giây)
    // ═══════════════════════════════════════════════════════
    //
    //  Phase ICON ( 0- 4s): IconDefault HIỆN, LabelRolling ẨN, IconRule ẨN
    //  Phase RULE ( 4- 8s): IconDefault ẨN,   IconRule HIỆN (sprite BET/WIN/LOSE)
    //  Phase POOL ( 8-12s): IconDefault ẨN,   LabelRolling HIỆN → prize pool
    //  Phase TIME (12-16s): IconDefault ẨN,   LabelRolling HIỆN → time left
    //
    //  Cơ chế chuyển phase:
    //    1. _isFading = true → timer bị freeze
    //    2. Fade-out node đang hiện (0.2s)
    //    3. Ẩn/Hiện node + set text mới
    //    4. Fade-in node mới (0.2s)
    //    5. _isFading = false → timer tiếp tục
    //

    private _tickCarousel(dt: number): void {
        // Đang trong transition fade → không tăng timer
        if (this._isFading) return;

        this._carouselTimer += dt;
        if (this._carouselTimer >= PHASE_DURATION) {
            this._carouselTimer = 0;
            // Xoay vòng: 0 → 1 → 2 → 3 → 0 → ...
            const next = ((this._carouselPhase + 1) % 4) as CarouselPhase;
            this._transitionToPhase(next);
        }
    }

    /**
     * Chuyển sang phase mới với hiệu ứng fade.
     * Bước 1: Xác định node đang hiển thị → fade-out.
     * Bước 2: Ẩn/bật node + set text.
     * Bước 3: Fade-in node mới.
     */
    private _transitionToPhase(next: CarouselPhase): void {
        this._isFading = true;
        this._carouselPhase = next;

        const currentNode = this._getActiveCenterNode();

        if (!currentNode) {
            // Không có node nào đang hiện → apply ngay không cần fade
            this._applyPhase(next);
            this._isFading = false;
            return;
        }

        let op = currentNode.getComponent(UIOpacity);
        if (!op) op = currentNode.addComponent(UIOpacity);

        Tween.stopAllByTarget(currentNode);

        // Fade-out → áp dụng phase mới → Fade-in node mới
        tween(op)
            .to(FADE_DURATION, { opacity: 0 })
            .call(() => {
                this._applyPhase(next);
            })
            .to(FADE_DURATION, { opacity: 255 })
            .call(() => {
                this._isFading = false;
            })
            .start();
    }

    /**
     * Áp dụng nội dung cho phase mới (không có fade, chỉ toggle active + text/sprite).
     *   Phase ICON: bật IconDefault, tắt LabelRolling, tắt IconRule.
     *   Phase RULE: tắt IconDefault, tắt LabelRolling, bật IconRule với frame BET/WIN/LOSE.
     *   Phase khác: tắt IconDefault, tắt IconRule, bật LabelRolling với text phù hợp.
     */
    private _applyPhase(phase: CarouselPhase): void {
        if (!this._raceInfo) return;

        if (phase === CarouselPhase.ICON) {
            this._setActive(this.iconDefault?.node,  true);
            this._setActive(this.labelRolling?.node, false);
            this._setActive(this.iconRule?.node,     false);
            this._resetOpacity(this.iconDefault?.node);
        } else if (phase === CarouselPhase.RULE) {
            this._setActive(this.iconDefault?.node,  false);
            this._setActive(this.labelRolling?.node, false);
            this._setActive(this.iconRule?.node,     true);
            this._resetOpacity(this.iconRule?.node);
            if (this.iconRule) {
                const frame = this._getRuleSpriteFrame(this._raceInfo.rule);
                if (frame) this.iconRule.spriteFrame = frame;
            }
        } else {
            this._setActive(this.iconDefault?.node,  false);
            this._setActive(this.iconRule?.node,     false);
            this._setActive(this.labelRolling?.node, true);
            this._resetOpacity(this.labelRolling?.node);

            if (this.labelRolling) {
                this.labelRolling.string = this._getPhaseText(phase);
            }
        }
    }

    /** Trả về SpriteFrame tương ứng với rule ('BET'→[0], 'WIN'→[1], 'LOSE'→[2]) */
    private _getRuleSpriteFrame(rule: 'BET' | 'WIN' | 'LOSE'): SpriteFrame | null {
        const map: Record<string, number> = { BET: 0, WIN: 1, LOSE: 2 };
        const idx = map[rule] ?? -1;
        return this.ruleSpriteFrames[idx] ?? null;
    }

    /** Trả về text hiển thị trong LabelRolling tương ứng phase */
    private _getPhaseText(phase: CarouselPhase): string {
        if (!this._raceInfo) return '';
        switch (phase) {
            case CarouselPhase.RULE: return this._raceInfo.rule;
            case CarouselPhase.POOL: return `<size=16>Prize Pool</size>\n <size=30>${CashRaceWidget.formatKMBT(this._raceInfo.prizePool)}</size>`;
            case CarouselPhase.TIME: {
                // Nếu có ngày → size 22, không có ngày → size 30
                const hasDay = this._raceInfo.timeLeft >= 86400;
                const fontSize = hasDay ? 22 : 30;
                return `<size=16>Left Time</size>\n<size=${fontSize}>${CashRaceWidget.formatHHMMSS(this._raceInfo.timeLeft)}</size>`;
            }
            default: return '';
        }
    }

    /**
     * Trả về node đang active trong CenterContainer.
     * Dùng để xác định node cần fade-out khi chuyển phase.
     */
    private _getActiveCenterNode(): Node | null {
        if (this.iconDefault?.node?.active)  return this.iconDefault.node;
        if (this.iconRule?.node?.active)     return this.iconRule.node;
        if (this.labelRolling?.node?.active) return this.labelRolling.node;
        return null;
    }

    /**
     * Reset Carousel về Phase 1 (IconDefault).
     * Gọi khi: Notice → Racing, hoặc cần reset từ đầu.
     */
    private _resetCarousel(): void {
        this._carouselTimer = 0;
        this._isFading = false;
        this._carouselPhase = CarouselPhase.ICON;
        this._carouselInitialized = false;

        // Dừng tween đang chạy trên các node carousel
        if (this.iconDefault?.node)  Tween.stopAllByTarget(this.iconDefault.node);
        if (this.labelRolling?.node) Tween.stopAllByTarget(this.labelRolling.node);
        if (this.iconRule?.node)     Tween.stopAllByTarget(this.iconRule.node);

        // Áp dụng ngay Phase 1 không cần fade
        this._setActive(this.iconDefault?.node,  true);
        this._setActive(this.labelRolling?.node, false);
        this._setActive(this.iconRule?.node,     false);
        this._resetOpacity(this.iconDefault?.node);
    }

    // ═══════════════════════════════════════════════════════
    //  PROGRESS BAR
    // ═══════════════════════════════════════════════════════

    private _updateProgressFill(): void {
        if (!this.progressBar) return;
        // MyPrizePercent từ server (0-100) → fillRange (0-1)
        this.progressBar.fillRange = Math.max(0, Math.min(1, this._myPrizePercent / 100));
    }

    // ═══════════════════════════════════════════════════════
    //  BADGE RANK
    // ═══════════════════════════════════════════════════════

    private _updateRankLabel(): void {
        if (!this.labelRank || !this._raceInfo) return;
        const myRank = this._raceInfo.myRank ?? 0;
        const rewardUsers = this._raceInfo.rewardUsers ?? 0;

        if (myRank <= 0) {
            // Chưa có rank (chưa bet) — cài gọi này không nên xảy ra vì badge đã bị ẩn
            this.labelRank.string = '#';           
        }
        else
        if (rewardUsers > 0 && myRank <= rewardUsers) {
            // Lọt top thưởng → ordinal màu vàng
            this.labelRank.string = CashRaceWidget.toOrdinal(myRank);
            this.labelRank.color  = new Color(255, 215, 0, 255);
        } else {
            // Chưa lọt → #rank màu trắng
            this.labelRank.string = `#${myRank}`;
            this.labelRank.color  = new Color(255, 255, 255, 255);
        }
    }

    // ═══════════════════════════════════════════════════════
    //  WREATH BLINK
    // ═══════════════════════════════════════════════════════

    private _showWreath(show: boolean): void {
        if (!this.iconWreath) return;

        if (show && !this._isWreathBlinking) {
            this._setActive(this.iconWreath.node, true);
            this._isWreathBlinking = true;

            let op = this.iconWreath.node.getComponent(UIOpacity);
            if (!op) op = this.iconWreath.node.addComponent(UIOpacity);

            this._wreathTween = tween(op)
                .repeatForever(
                    tween(op)
                        .to(0.5, { opacity: 80 })
                        .to(0.5, { opacity: 255 })
                )
                .start();

        } else if (!show && this._isWreathBlinking) {
            this._stopWreathBlink();
            this._setActive(this.iconWreath.node, false);
        }
    }

    private _stopWreathBlink(): void {
        if (this._wreathTween) {
            this._wreathTween.stop();
            this._wreathTween = null;
        }
        this._isWreathBlinking = false;
        if (this.iconWreath?.node) {
            const op = this.iconWreath.node.getComponent(UIOpacity);
            if (op) op.opacity = 255;
        }
    }

    // ═══════════════════════════════════════════════════════
    //  BUTTON HANDLER
    // ═══════════════════════════════════════════════════════

    private _onTap(): void {
        // Chỉ cho mở popup khi đã vào Notice/Racing mode và race đang chạy (không phải chỉ notify)
        if (!this._raceInfo || this._raceInfo.isNotice) {
            Log.d('%c[CashRace][Widget] Click blocked: race chưa bắt đầu (đang ở Notice mode)', 'color:#f99');
            return;
        }
        EventBus.instance.emit('CASH_RACE_OPEN_POPUP', this._raceInfo);
    }

    // ═══════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════

    /** Ẩn toàn bộ node khi chưa có data */
    private _hideAll(): void {
        this._setActive(this.progressBar?.node,         false);
        this._setActive(this.iconWreath?.node,          false);
        this._setActive(this.iconDefault?.node,         false);
        this._setActive(this.labelRolling?.node,        false);
        this._setActive(this.iconRule?.node,            false);
        this._setActive(this.noticeTooltipContainer,    false);
        this._setActive(this.badgeRankContainer,        false);
    }

    /** Set active an toàn (bỏ qua nếu node null/undefined) */
    private _setActive(node: Node | null | undefined, active: boolean): void {
        if (node) node.active = active;
    }

    /** Reset UIOpacity về 255 (sau khi bị fade từ tween cũ) */
    private _resetOpacity(node: Node | null | undefined): void {
        if (!node) return;
        const op = node.getComponent(UIOpacity);
        if (op) op.opacity = 255;
    }

    // ═══════════════════════════════════════════════════════
    //  STATIC UTILITIES
    // ═══════════════════════════════════════════════════════

    /**
     * Widget format (ngoài màn hình chính):
     *   < 24h  : HH:MM:SS
     *   ≥ 1 ngày: DDd:HH:MM:SS  (giữ giây luôn)
     */
    static formatHHMMSS(totalSeconds: number): string {
        const s    = Math.max(0, Math.floor(totalSeconds));
        const days = Math.floor(s / 86400);
        const hh   = Math.floor((s % 86400) / 3600);
        const mm   = Math.floor((s % 3600) / 60);
        const ss   = s % 60;
        if (days > 0) {
            return `${days}D:${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
        }
        return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    }

    /**
     * Popup format (bên trong CashRacePopup):
     *   < 24h  : HH:MM:SS
     *   ≥ 1 ngày: DDd:HH:MM:SS  (giữ giây)
     */
    static formatDDHHMMSS(totalSeconds: number): string {
        const s    = Math.max(0, Math.floor(totalSeconds));
        const days = Math.floor(s / 86400);
        const hh   = Math.floor((s % 86400) / 3600);
        const mm   = Math.floor((s % 3600) / 60);
        const ss   = s % 60;
        if (days > 0) {
            return `${days}D:${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
        }
        return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    }

    /** Alias giữ tương thích với CashRacePopup (dùng formatTime / formatCountdown) */
    static formatTime      = CashRaceWidget.formatHHMMSS;
    static formatCountdown = CashRaceWidget.formatHHMMSS;

    /** Format số → KMBT theo KMBT USAGE RULES (bắt đầu từ 100K) */
    static formatKMBT(value: number): string {
        if (value < 1e5) return Math.floor(value).toLocaleString('en-US');

        // T: >= 1e13
        if (value >= 1e13) {
            const t = Math.floor(value / 1e12);
            if (value >= 1e14) return t + 'T';
            const t1 = Math.floor(value / 1e11) / 10;
            return (t1 % 1 === 0 ? t1.toFixed(0) : t1.toFixed(1)) + 'T';
        }
        // B: >= 1e10
        if (value >= 1e10) {
            const b = Math.floor(value / 1e9);
            if (value >= 1e11) return b + 'B';
            const b1 = Math.floor(value / 1e8) / 10;
            return (b1 % 1 === 0 ? b1.toFixed(0) : b1.toFixed(1)) + 'B';
        }
        // M: >= 1e7
        if (value >= 1e7) {
            const m = Math.floor(value / 1e6);
            if (value >= 1e8) return m + 'M';
            const m1 = Math.floor(value / 1e5) / 10;
            return (m1 % 1 === 0 ? m1.toFixed(0) : m1.toFixed(1)) + 'M';
        }
        // K: >= 1e5
        const k1 = Math.floor(value / 100) / 10;
        return (k1 % 1 === 0 ? k1.toFixed(0) : k1.toFixed(1)) + 'K';
    }

    /** Chuyển số thành ordinal: 1→"1st", 2→"2nd", 3→"3rd", 11→"11th" */
    static toOrdinal(n: number): string {
        const v = n % 100;
        const s = ['th', 'st', 'nd', 'rd'];
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
    }

    // ── Getter công khai ──
    get raceInfo(): RaceInfo | null { return this._raceInfo; }
}
