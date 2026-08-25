/**
 * GameEvents - Định nghĩa tất cả Event key dùng trong game.
 * Tập trung 1 chỗ, tránh dùng magic string.
 * @updated BuyBonusSystem events added
 */

export const GameEvents = {
    // ─── SPIN FLOW ───
    /** Người chơi nhấn nút Spin */
    SPIN_REQUEST: 'spin:request',
    /** Balance OK, bắt đầu quay reel ngay (trước khi chờ server) */
    REELS_START_SPIN: 'reels:start:spin',
    /** Nhận được SpinResponse (từ mock/server) → ra lệnh dừng reel */
    SPIN_RESPONSE: 'spin:response',
    /** Tất cả reel đã dừng xong */
    REELS_STOPPED: 'reels:stopped',
    /** Một reel đơn lẻ đã dừng */
    REEL_STOPPED: 'reel:stopped',
    /** Một reel đã snap về vị trí cuối (trước bounce) — dùng để phát special symbol sounds đúng thời điểm visual */
    REEL_SNAPPED: 'reel:snapped',
    /** Một reel bắt đầu giảm tốc — payload: {reelIndex, decelDuration} */
    REEL_DECEL_START: 'reel:decel:start',
    /** Người chơi nhấn Spin lại khi reel đang quay → dừng ngay lập tức (quick stop) */
    REELS_QUICK_STOP: 'reels:quick:stop',
    /** Resume Normal Spin bị gián đoạn: snap reel về vị trí kết quả cuối rồi emit REELS_STOPPED */
    RESUME_NORMAL_SPIN: 'resume:normal:spin',
    /** Resume Free Spin: chỉ vẽ lại reel tĩnh từ rands, không trigger win flow */
    RESUME_FREE_SPIN_REELS: 'resume:free:spin:reels',

    // ─── WIN ───
    /** Có line thắng, bắt đầu trình diễn */
    WIN_PRESENT_START: 'win:present:start',
    /** Kết thúc trình diễn win */
    WIN_PRESENT_END: 'win:present:end',
    /** Tắt hoàn toàn win highlight (fillBlack / bounce / cycling) — dùng trước feature red bounce. */
    WIN_HIGHLIGHT_CLEAR: 'win:highlight:clear',
    /** Show popup BigWin / MegaWin */
    WIN_POPUP: 'win:popup',
    /** Count-up tiền thắng hoàn tất */
    WIN_COUNTUP_DONE: 'win:countup:done',
    /** Hiện tất cả winning lines cùng 1 lúc (payload: MatchedLinePay[]) */
    WIN_SHOW_ALL_LINES: 'win:show:all:lines',
    /** Tất cả animation spine highlight đã hoàn tất (hoặc không có spine nào) */
    WIN_HIGHLIGHT_ANIM_DONE: 'win:highlight:anim:done',

    // ─── WAYS PAY HIGHLIGHT (Gold of Fortune) ───
    /** Hiện tất cả winning cells cùng lúc (payload: WaysPayWin[], duration?) */
    WIN_SHOW_ALL_WAYS: 'win:show:all:ways',
    /** Cycling từng way một (payload: WaysPayWin) */
    WIN_CYCLE_ONE_WAY: 'win:cycle:one:way',
    /** High/low win match — cùng quyết định với SoundManager.playSymbolMatchHigh/Low.
     *  Payload: 'high' | 'low' */
    WIN_SYMBOL_MATCH_TIER: 'win:symbol:match:tier',

    // ─── POT (legacy single pot / Pick) ───
    /** Pot level hoặc tổng counter thay đổi. Payload: { level:number, total:number } */
    POT_LEVEL_CHANGED: 'pot:level:changed',
    /** Server trigger pot win — bắt đầu animation intro hũ. No payload. */
    POT_WIN_INTRO: 'pot:win:intro',
    /** Animation intro hũ hoàn tất — GameManager có thể tiếp tục pick game. No payload. */
    POT_WIN_DONE: 'pot:win:done',
    /** Pot level transition animation (spine) hoàn tất — GameManager có thể enable spin. No payload. */
    POT_TRANSITION_END: 'pot:transition:end',

    // ─── CARNIVAL NEKO — 3 Trail / 3 Pot ───
    /** Có Trail trên spin — bắt đầu flip+fly pipeline.
     *  Payload: { trails: CarnivalTrailHit[], potLevels?: CarnivalPotLevels } */
    CARNIVAL_TRAIL_START: 'carnival:trail:start',
    /** Một Trail land trên 1 reel — flip Normal→Color rồi bay vào Pot màu tương ứng.
     *  Payload: CarnivalTrailHit */
    CARNIVAL_TRAIL_ONE: 'carnival:trail:one',
    /** Một Trail vừa chạm Pot. Payload: { color: TrailColor } */
    CARNIVAL_TRAIL_ONE_HIT: 'carnival:trail:one:hit',
    /** Tất cả Trail đã flip+fly xong. No payload. */
    CARNIVAL_TRAIL_FLY_DONE: 'carnival:trail:fly:done',
    /** 3 Pot levels đổi. Payload: CarnivalPotLevels */
    CARNIVAL_POT_LEVELS_CHANGED: 'carnival:pot:levels:changed',
    /** Pot nổ — bắt đầu burst anim. Payload: CarnivalFeatureTrigger */
    CARNIVAL_POT_BURST: 'carnival:pot:burst',
    /** Burst anim xong — GameManager tiếp tục Jackpot / Matsuri. Payload: CarnivalFeatureTrigger */
    CARNIVAL_POT_BURST_DONE: 'carnival:pot:burst:done',
    /**
     * Popup thông báo Matsuri — hiện sau khi đã vào Feature shell (overlay + FramFront/Top).
     * Payload: CarnivalFeatureTrigger — chờ MATSURI_START_POPUP_CLOSED rồi mới MATSURI_SEED_START.
     */
    MATSURI_START_POPUP: 'matsuri:start:popup',
    /**
     * Slam-in Title/Grid/Press xong — an toàn để warm PickGame / StickyOverlay / BG Feature.
     * No payload.
     */
    MATSURI_START_POPUP_INTRO_DONE: 'matsuri:start:popup:intro:done',
    /** Người chơi Press to Start — payload: CarnivalFeatureTrigger */
    MATSURI_START_POPUP_CLOSED: 'matsuri:start:popup:closed',
    /** Matsuri Hold&Spin bắt đầu (payload: CarnivalFeatureTrigger). */
    CARNIVAL_MATSURI_START: 'carnival:matsuri:start',
    /** Matsuri Hold&Spin kết thúc → về Base. No payload. */
    CARNIVAL_MATSURI_END: 'carnival:matsuri:end',
    /** Red Mystery Envelope payout (normal spin). Payload: { amount: number } */
    CARNIVAL_RED_ENVELOPE: 'carnival:red:envelope',
    /** Red Mystery Envelope popup đóng (tap hoặc auto 3s). No payload. */
    CARNIVAL_RED_ENVELOPE_CLOSED: 'carnival:red:envelope:closed',
    /** Matsuri full grid Grand. Payload: { amount: number } */
    CARNIVAL_GRID_FULL: 'carnival:grid:full',
    /**
     * Matsuri enter: bắn Start Gold vào grid (giống StickyFill orb).
     * Payload: { cells: StickyCell[] }
     */
    MATSURI_SEED_START: 'matsuri:seed:start',
    /** Cat Spine bonus loop — MatsuriEffect bắn 1 quả cầu seed. No payload. */
    MATSURI_SEED_CAT_ORB_FIRE: 'matsuri:seed:cat:orb:fire',
    /** 1 Start Gold vừa land trên overlay. Payload: StickyCell */
    MATSURI_SEED_CELL: 'matsuri:seed:cell',
    /** Seed Start Gold xong → GameManager lock + spin đầu. No payload. */
    MATSURI_SEED_DONE: 'matsuri:seed:done',
    /**
     * Matsuri: 1 Green trong queue → hút toàn bộ Yellow đang hold.
     * Payload: { goldCells: StickyCell[], bounceGreens?: StickyCell[], flipGreenKey?: string }
     */
    MATSURI_COLLECT_START: 'matsuri:collect:start',
    /** 1 Gold vừa bay xong → cộng credit vào tổng. Payload: { credit: number } */
    MATSURI_COLLECT_CREDIT: 'matsuri:collect:credit',
    /** Collect/fly Gold xong → StickyOverlay flip 1 Green (flipGreenKey) → Gold. */
    MATSURI_COLLECT_DONE: 'matsuri:collect:done',
    /** Flip 1 Green xong → GameManager loop Green kế hoặc chốt stage. */
    MATSURI_FLIP_DONE: 'matsuri:flip:done',
    /** @deprecated dùng CARNIVAL_MATSURI_START — giữ alias cho listener cũ */
    CARNIVAL_MATSURI_STUB: 'carnival:matsuri:stub',
    /** @deprecated dùng CARNIVAL_MATSURI_END */
    CARNIVAL_MATSURI_STUB_DONE: 'carnival:matsuri:stub:done',
    /**
     * Popup Press to Start trên Pick Game shell (Pick Game đã hiện sẵn bên dưới).
     * Payload: PickGameState — chờ PICK_GAME_START_POPUP_CLOSED rồi PICK_GAME_BEGIN_ENTRY.
     */
    PICK_GAME_START_POPUP: 'pick:game:start:popup',
    /**
     * Slam-in Title1/Title2/Press xong — an toàn để warm PickGame / TopUpEnd.
     * No payload.
     */
    PICK_GAME_START_POPUP_INTRO_DONE: 'pick:game:start:popup:intro:done',
    /** Người chơi Press to Start — payload: PickGameState */
    PICK_GAME_START_POPUP_CLOSED: 'pick:game:start:popup:closed',
    /**
     * Sau JackpotStartPopup đóng — chạy entry bounce + bật pick (Pick shell đã mở sẵn).
     * Payload: PickGameState
     */
    PICK_GAME_BEGIN_ENTRY: 'pick:game:begin:entry',
    /** Mở Pick Game popup (resume / skip Start popup). Payload: PickGameState */
    PICK_GAME_OPEN: 'pick:game:open',
    /** Pick Game popup đóng (người chơi đã pick xong + jackpot hiển thị xong). No payload. */
    PICK_GAME_CLOSE: 'pick:game:close',
    /** Pick Game kết thúc — server trả NextStage=PICK_END(102) → client phải gọi /Claim. No payload. */
    PICK_GAME_NEED_CLAIM: 'pick:game:need:claim',
    /** Pick Game entry animation xong — coin grid sẵn sàng để player tap. No payload. */
    PICK_GAME_ENTRY_DONE: 'pick:game:entry:done',
    /** Ẩn bottom UI (spin/bet controls) — phát khi bắt đầu Pick Game gameplay. No payload. */
    HIDE_BOTTOM_UI: 'ui:bottom:hide',
    /** Hiện bottom UI — phát khi Pick Game kết thúc hoàn toàn. No payload. */
    SHOW_BOTTOM_UI: 'ui:bottom:show',

    // ─── JACKPOT ───
    JACKPOT_TRIGGER: 'jackpot:trigger',
    JACKPOT_END: 'jackpot:end',
    JACKPOT_LOOP_START: 'jackpot:loop:start',
    /** Pick Game vừa tìm ra 3 ô match — emit ngay, trước khi JACKPOT_TRIGGER (payload: JackpotType) */
    PICK_GAME_MATCH_FOUND: 'pickgame:match:found',
    /** Đủ 3 Upgrade Coin — payload: { upgradeCount, jackpotValues }. */
    PICK_GAME_UPGRADE_COMPLETE: 'pickgame:upgrade:complete',

    // ─── WALLET & BET ───
    BALANCE_UPDATED: 'wallet:balance:updated',
    BET_CHANGED: 'bet:changed',

    // ─── FREE SPIN ───
    FREE_SPIN_START: 'freespin:start',
    FREE_SPIN_END: 'freespin:end',
    FREE_SPIN_COUNT_UPDATED: 'freespin:count:updated',
    /** Người chơi bấm nút Auto Spin Free — kiểm tra điều kiện & chuyển mode */
    FREE_SPIN_AUTO_TRIGGERED: 'freespin:auto:triggered',
    FREE_SPIN_MULTIPLIER: 'freespin:multiplier',
    /** Phase 1: Bắt đầu quay reel → hiệu ứng rolling các hệ số nhân */
    FREE_SPIN_MULTIPLIER_SPIN: 'freespin:multiplier:spin',
    /** Phase 2: Server trả kết quả → chốt hệ số nhân (kèm value: number) */
    FREE_SPIN_MULTIPLIER_LOCK: 'freespin:multiplier:lock',
    /** Phase 3a: Clone effect vừa xuất hiện (ngay khi tween bắt đầu) */
    FREE_SPIN_MULTIPLIER_CLONE_SHOW: 'freespin:multiplier:clone:show',
    /** Phase 3b: Clone animation bay xong (hoặc no-win skip) → an toàn để bắt đầu auto-spin tiếp */
    FREE_SPIN_MULTIPLIER_FLY_DONE: 'freespin:multiplier:fly:done',
    /** Phase 4: Spin cycle kết thúc → ẩn display */
    FREE_SPIN_MULTIPLIER_HIDE: 'freespin:multiplier:hide',
    /** Khi trúng Bonus trigger: highlight spine trên symbol Bonus trước khi FreeSpinPopup hiện — payload: {reelIndex, rowIndex}[] */
    FREE_SPIN_BONUS_REVEAL: 'freespin:bonus:reveal',

    // ─── GAME STATE ───
    STAGE_CHANGED: 'game:stage:changed',
    GAME_READY: 'game:ready',

    // ─── LONG SPIN ───
    LONG_SPIN_TRIGGERED: 'longspin:triggered',
    /** VFX bật khi Cột 3 vào trạng thái long spin (anticipation) */
    LONG_SPIN_VFX_START: 'longspin:vfx:start',
    /** VFX tắt khi Cột 3 khựng lại xong */
    LONG_SPIN_VFX_END: 'longspin:vfx:end',
    /** Camera/SlotMachine zoom đã về scale gốc sau Long Spin (hoặc không có zoom). */
    LONG_SPIN_ZOOM_DONE: 'longspin:zoom:done',
    /** Bounce gợi ý 2 symbol có thể tạo jackpot — payload: {reelIndex, rowIndex}[] */
    LONG_SPIN_SYMBOL_HINT: 'longspin:symbol:hint',
    /** Hiện spine hint trên 2 symbol khi VFX bắt đầu — payload: {reelIndex, rowIndex}[] */
    LONG_SPIN_HINT_SHOW: 'longspin:hint:show',
    /** Jackpot được xác nhận: phát spine hiệu ứng trên cả 3 symbol trước khi popup hiện — payload: {reelIndex, rowIndex}[] */
    LONG_SPIN_JACKPOT_REVEAL: 'longspin:jackpot:reveal',

    // ─── UI ───
    UI_SPIN_BUTTON_STATE: 'ui:spinbutton:state',
    UI_UPDATE_WIN_LABEL: 'ui:winlabel:update',
    UI_UPDATE_BET_LABEL: 'ui:betlabel:update',

    // ─── FREE SPIN POPUP ───
    /** Hiển thị popup thông báo Free Spin (kèm số lượt) */
    FREE_SPIN_POPUP: 'ui:freespin:popup',

    // ─── PROGRESSIVE WIN ───
    /** Hiện popup Progressive Win (BIG/SUPER/EPIC/MEGA) — payload: tier, amount */
    PROGRESSIVE_WIN_SHOW: 'progressivewin:show',
    /** User click skip button trên popup Progressive Win — ngay lập tức */
    PROGRESSIVE_WIN_SKIP: 'progressivewin:skip',
    /** Popup Progressive Win đóng xong */
    PROGRESSIVE_WIN_END: 'progressivewin:end',

    // ─── FREE SPIN END POPUP ───
    /** Hiện popup tổng kết Free Spin — payload: totalWin, spinCount */
    FREE_SPIN_END_POPUP: 'freespin:end:popup',
    /** Popup tổng kết Free Spin đóng xong */
    FREE_SPIN_END_POPUP_CLOSED: 'freespin:end:popup:closed',

    // ─── INTRO FLOW ───
    /** Loading bar đạt 90% — gửi tín hiệu bắt đầu tải dữ liệu server */
    LOADING_GATE_REACHED: 'intro:loading:gate',
    /** LoadingController hoàn tất → chuyển sang GuideController */
    LOADING_COMPLETE: 'intro:loading:complete',
    /** Loading bar đã tween tới 100% (chưa delay 1s) → GameEntryController có thể show GuideView */
    LOADING_BAR_100: 'intro:loading:bar:100',
    /** Người chơi vừa bấm Continue (trước khi GuideView fade out) → ẩn sharedNode ngay */
    GUIDE_CONTINUE: 'intro:guide:continue',
    /** Người chơi bấm CLICK TO CONTINUE → vào game chính */
    GUIDE_COMPLETE: 'intro:guide:complete',
    /** Kích hoạt hiệu ứng tiến vào Pot (팟 진입 연출) */
    GAME_ENTRY_EFFECT: 'game:entry:effect',
    /** GameRoot opacity=255 dưới Transition (sau fade-in Transition, trước spine fade alpha). */
    GAME_VIEW_READY_UNDER_TRANSITION: 'game:view:ready:under:transition',

    // ─── SERVER API ───
    /** Login bắt đầu */
    LOGIN_START: 'server:login:start',
    /** Login thành công — payload: ServerSession */
    LOGIN_SUCCESS: 'server:login:success',
    /** Login thất bại — payload: error string */
    LOGIN_FAILED: 'server:login:failed',
    /** Enter game thành công — payload: ServerEnterResponse */
    ENTER_SUCCESS: 'server:enter:success',
    /** Enter game thất bại */
    ENTER_FAILED: 'server:enter:failed',
    /** Server maintenance message nhận được — payload: ServerMaintenanceMessage */
    SERVER_MAINTENANCE: 'server:maintenance',
    /** Jackpot values cập nhật từ server — payload: number[] */
    JACKPOT_VALUES_UPDATED: 'server:jackpot:updated',
    /** Cash Race CR data từ Jackpot polling — payload: NwCashRaceSimpleForUser */
    CASH_RACE_CR_UPDATED: 'server:cashrace:cr:updated',
    /** Win broadcast nhận từ Jackpot polling — payload: ServerWinBroadcast */
    BROADCAST_WIN_MESSAGE: 'server:broadcast:win',
    /** User bật/tắt broadcast trong settings — payload: boolean */
    BROADCAST_SETTING_CHANGED: 'settings:broadcast:changed',

    // ─── LOCALIZATION ───
    /** Ngôn ngữ thay đổi — payload: LanguageCode string */
    LANGUAGE_CHANGED: 'i18n:language:changed',

    // ─── AUTO SPIN ───
    /** Số lượt auto spin thay đổi — payload: number */
    AUTO_SPIN_CHANGED: 'autospin:changed',
    /** Chế độ tốc độ thay đổi — payload: SpeedMode string */
    SPEED_MODE_CHANGED: 'autospin:speed:changed',
    /** Một vòng Normal Spin kết thúc và game về IDLE (dùng cho auto spin trigger) */
    NORMAL_SPIN_DONE: 'spin:normal:done',

    // ─── BUY BONUS ───
    /** Người chơi bấm nút Buy Bonus → yêu cầu lấy danh sách gói */
    BUY_BONUS_REQUEST: 'buybonus:request',
    /** Danh sách gói Feature đã load xong — payload: FeatureItem[] */
    BUY_BONUS_ITEMS_LOADED: 'buybonus:items:loaded',
    /** Người chơi xác nhận mua gói — payload: FeatureItem */
    BUY_BONUS_CONFIRM: 'buybonus:confirm',
    /** Mua thành công — payload: { remainCash: number } */
    BUY_BONUS_SUCCESS: 'buybonus:success',
    /** Mua thất bại — payload: error string */
    BUY_BONUS_FAILED: 'buybonus:failed',
    /** Yêu cầu activate item (effectType 2/3) — payload: FeatureItem */
    BUY_BONUS_ACTIVATE: 'buybonus:activate',
    /** Activate thành công — payload: { itemId: number, priceRatio: number, remainCash: number } */
    BUY_BONUS_ACTIVATE_SUCCESS: 'buybonus:activate:success',
    /** Yêu cầu deactivate item — không cần payload */
    BUY_BONUS_DEACTIVATE: 'buybonus:deactivate',
    /** Deactivate thành công */
    BUY_BONUS_DEACTIVATE_SUCCESS: 'buybonus:deactivate:success',
    /** Total Bet đã thay đổi do activate item — payload: { displayBet: number, isActive: boolean } */
    BUY_BONUS_TOTAL_BET_CHANGED: 'buybonus:totalbet:changed',

    // ─── BUY BONUS SYSTEM (New) ───
    /** Danh sách IBonusItem đã load xong — payload: { items: IBonusItem[], balance: number, totalBet: number } */
    BONUS_SYSTEM_ITEMS_LOADED: 'bonussystem:items:loaded',
    /** User chọn 1 item từ list → mở recheck popup — payload: IBonusItem */
    BONUS_SYSTEM_ITEM_SELECTED: 'bonussystem:item:selected',
    /** User xác nhận mua/bật item từ recheck popup — payload: IBonusItem */
    BONUS_SYSTEM_ITEM_CONFIRMED: 'bonussystem:item:confirmed',
    /** Item activate được bật thành công — payload: { itemId: string } */
    BONUS_SYSTEM_ACTIVATE_ON: 'bonussystem:activate:on',
    /** Item activate được tắt (cancel) — payload: { itemId: string } */
    BONUS_SYSTEM_ACTIVATE_OFF: 'bonussystem:activate:off',
    /** Mua item onceuse thành công — payload: IBonusItem */
    BONUS_SYSTEM_ONCEUSE_SUCCESS: 'bonussystem:onceuse:success',
    /** TotalBet thay đổi → tất cả giá item đã được tính lại */
    BONUS_SYSTEM_PRICES_UPDATED: 'bonussystem:prices:updated',

    // ─── SETTINGS POPUPS ───
    /** Mở AutoSettingPopup (chọn auto spin count & speed mode) */
    AUTO_SETTING_OPEN: 'ui:autosetting:open',
    /** Mở BetSettingsPopup (chọn mức cược) */
    BET_SETTING_OPEN: 'ui:betsetting:open',
    /** Mở GameSettingPopup (âm thanh, intro, broadcast) */
    GAME_SETTING_OPEN: 'ui:gamesetting:open',
    /** Master mute từ MiniSetting thay đổi — payload: muted: boolean */
    MASTER_MUTE_CHANGED: 'setting:master:mute:changed',

    // ─── PAY TABLE ───
    /** Mở popup PayTable (Info) */
    PAY_TABLE_OPEN: 'ui:paytable:open',

    // ─── SYSTEM POPUP ───
    /** Hiển thị system popup thông báo lỗi — payload: SystemPopupPayload */
    SHOW_SYSTEM_POPUP: 'ui:system:popup',

    // ─── TOPUP GAME ───
    /** Hiện transition popup. Payload: TransitionMode (FreeSpin | TopUp | PickGame). */
    TOPUP_TRANSITION_SHOW: 'topup:transition:show',
    /**
     * TransitionPopup đã fade-in full (overlay phủ kín).
     * Payload: TransitionMode — lúc này mới được đổi UI mode (TopUp / FreeSpin / PickGame).
     */
    TOPUP_TRANSITION_READY: 'topup:transition:ready',
    TOPUP_TRANSITION_DONE: 'topup:transition:done',
    TOPUP_START: 'topup:start',
    TOPUP_END: 'topup:end',
    TOPUP_END_POPUP: 'topup:end:popup',           // Hiện popup tổng kết TopUp (payload: totalWin)
    TOPUP_END_POPUP_CLOSED: 'topup:end:popup:closed', // Popup đã đóng → cleanup TopUp state
    TOPUP_COUNT_UPDATED: 'topup:count:updated',
    TOPUP_TOTAL_UPDATED: 'topup:total:updated',
    /** Bắt đầu chuỗi absorb effect sau khi reels dừng (payload: TopUpAbsorbPayload) */
    TOPUP_ABSORB_START: 'topup:absorb:start',
    /** Toàn bộ absorb effect (yellow + green) xong → GameManager tiếp tục transition */
    TOPUP_ABSORB_DONE: 'topup:absorb:done',
    /** Một đồng Vàng hoặc Xanh vừa hút xong → cộng credit của nó vào tổng (payload: { credit: number }) */
    TOPUP_ABSORB_CREDIT: 'topup:absorb:credit',
    /** NextWin TopUp thay đổi theo max credit hiện có của các đồng Green (payload: number) */
    TOPUP_NEXT_WIN_UPDATED: 'topup:next-win:updated',

    // ─── TRANSITION ───
    /** TransitionController icon bay tới đích xong — PotController bật potSpine */
    TRANSITION_DONE: 'transition:done',

    // ─── FREE SPIN GOLD (GoF — chế độ 8 lượt quay với đồng xu vàng) ───
    /** FreeSpin Gold bắt đầu — payload: { spinsRemaining: number; baseCredit: number } */
    FREE_SPIN_GOLD_START: 'freespin:gold:start',
    /** FreeSpin Gold kết thúc (sau khi TopUpEndPopup đóng) — payload: totalWin: number */
    FREE_SPIN_GOLD_END: 'freespin:gold:end',
    /** Số lượt quay FreeSpin Gold còn lại thay đổi — payload: count: number */
    FREE_SPIN_GOLD_COUNT_UPDATED: 'freespin:gold:count:updated',
    /** 1 đồng xu vàng vừa hút xong — cộng credit vào tổng — payload: { credit: number } */
    FREE_SPIN_GOLD_ABSORB_CREDIT: 'freespin:gold:absorb:credit',

    // ─── POPUP TRACKING (dùng để block Space key) ───
    /** Bất kỳ popup nào mở ra — dùng để block phím Space */
    POPUP_OPENED: 'ui:popup:opened',
    /** Bất kỳ popup nào đóng lại */
    POPUP_CLOSED: 'ui:popup:closed',

} as const;
