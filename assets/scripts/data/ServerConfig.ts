/**
 * ServerConfig - Cấu hình server API và biến chuyển đổi Mock/Real.
 *
 * ★ USE_REAL_API = false  → Dùng MockDataProvider (offline, dev/test)
 * ★ USE_REAL_API = true   → Gọi API server thật (MessagePack + AES)
 *
 * Khi chuyển sang production, chỉ cần đổi USE_REAL_API = true
 * và cập nhật SERVER_URL + AES_FIXED_KEY.
 */

// ═══════════════════════════════════════════════════════════
//  ★★★  SWITCH CHÍNH: Mock Data ↔ Real API  ★★★
// ═══════════════════════════════════════════════════════════

export const USE_REAL_API: boolean = true; // true = gọi API thật, false = dùng MockDataProvider (dev/test)

/**
 * ★ Tạm: Real API — ép NextStage=SPIN, chặn vào Pick/Matsuri/FS.
 * Vẫn cho phép Trail bay vào Pot (trails + potLevels giữ nguyên).
 * false = full feature flow (Pick / Matsuri / Claim) theo CN API.
 */
export const FORCE_NORMAL_SPIN_ONLY: boolean = false;

/** Bật OpenDebug panel + DebugManager shortcuts (mọi build). Tắt trước release production. */
export const ENABLE_DEBUG_TOOLS: boolean = true;

/**
 * ★ Carnival Neko mock: mỗi Normal Spin luôn land ≥1 Trail (Normal → flip màu → bay Pot).
 * Tắt khi muốn mock feature cũ (Wild Trail GoF).
 * Real API: bỏ qua flag này — trails đến từ server grid (PS 41/42/43).
 */
export const MOCK_FORCE_CARNIVAL_TRAILS: boolean = false;

/** Số Trail tối thiểu / tối đa mỗi spin khi MOCK_FORCE_CARNIVAL_TRAILS = true. */
export const MOCK_CARNIVAL_TRAIL_COUNT_MIN: number = 2;
export const MOCK_CARNIVAL_TRAIL_COUNT_MAX: number = 4;

/**
 * ★ Mock Feature Trigger sau khi Trail bay vào Pot.
 *   none       — chỉ growth, không nổ Pot
 *   auto       — mỗi N spin trail → force 1 trigger (xoay Red→Blue→Green→combo…)
 *   red/blue/green/blue_green/blue_red/red_green/all — force cố định mỗi spin có trail
 *   cycle      — mỗi lần trigger đổi loại (để test đủ case)
 */
export type MockCarnivalFeatureMode =
    | 'none'
    | 'auto'
    | 'red'
    | 'blue'
    | 'green'
    | 'blue_green'
    | 'blue_red'
    | 'red_green'
    | 'all'
    | 'cycle';

/** Đổi mode để test: 'cycle' = xoay đủ loại feature mỗi lần trigger. 'red' = vào Pick Game. */
export const MOCK_CARNIVAL_FEATURE_TRIGGER: MockCarnivalFeatureMode = 'none';

/**
 * ★ Mock Pick Game grid khi vào Jackpot Feature.
 *   random              — random wonTier + đôi khi có Upgrade
 *   plain_mini          — match 3 Mini, không Upgrade
 *   upgrade_to_major    — 3 Upgrade + 3 Minor → trả Major
 *   upgrade_grand_x2    — 3 Upgrade + 3 Grand → Grand ×2
 */
export type MockPickGameMode =
    | 'random'
    | 'plain_mini'
    | 'upgrade_to_major'
    | 'upgrade_grand_x2';

export const MOCK_PICK_GAME_MODE: MockPickGameMode = 'upgrade_to_major';

/** Khi mode='auto': sau bao nhiêu spin có Trail thì force trigger 1 lần. */
export const MOCK_CARNIVAL_FEATURE_EVERY_N_SPINS: number = 2;

/**
 * ★ Tạm: Guide xong → vào thẳng game, bỏ TransitionController (chest fly).
 * false = giữ intro Transition cũ (icon bay vào Pot).
 */
export const SKIP_GUIDE_TRANSITION: boolean = true;

// ═══════════════════════════════════════════════════════════
//  Server endpoints
// ═══════════════════════════════════════════════════════════
export const ServerConfig = {
    /** Base URL của Slot Game Server */
    SERVER_URL: 'https://dev-slot.realreelsgaming.com',

    /** Slot Game ID — Carnival Neko (API V1.0.2) */
    SLOT_ID: 20,

    /** Game client version */
    GAME_VERSION: '1.0.0',

    /** AES-128 fixed key cho Login request */
    AES_LOGIN_KEY: 'Q2FuZGljb2RlQDBAMjAjIQ==',

    /** Country/Language code mặc định */
    DEFAULT_LID: 0,

    /** HeartBeat interval (ms) - mỗi 10 giây */
    HEARTBEAT_INTERVAL: 10_000,

    /** Jackpot polling interval (ms) - mỗi 2 giây */
    JACKPOT_POLL_INTERVAL: 2_000,

    // ─── CDN ───────────────────────────────────────────────
    /** Base URL của CDN assets (locale-online.json, fonts).
     *  Để null → bỏ qua CDN, dùng local bundled assets.
     *  Để test: set CDN_BASE = null, xoá localStorage 'sn_cdn_*' để clear cache.
     */
    CDN_BASE: 'https://downloads.realreelsgaming.com/slotlanguage/shangrila' as string | null,

    /**
     * Bật/tắt tải locale từ CDN.
     *  true  → Fetch locale-online.json từ CDN và override local .ts files (mặc định).
     *  false → Dùng local .ts files đã build sẵn (thường dùng khi test locale từ tool).
     *
     * ★ Khi chạy localization-tool-update để tạo .ts mới từ Excel,
     *   set USE_CDN_LOCALE = false để game dùng đúng file đó thay vì bị CDN override.
     */
    USE_CDN_LOCALE: false,

    /** Bật/tắt log của Jackpot polling (mỗi 2s sẽ rất nhiều log) */
    LOG_JACKPOT_POLLING: false,

    /** Request timeout (ms) */
    REQUEST_TIMEOUT: 15_000,

    /** Số lần retry khi timeout */
    MAX_RETRY: 3,

    // ─── API ENDPOINTS ───
    API: {
        /** Login qua partner link (production) */
        WEB_LINK_LOGIN: '/Auth/ReqWebLinkLogin',
        /** Login test (dev) */
        TEST_LOGIN:     '/Test/ReqTestLogin',
        /** Logout */
        LOGOUT:         '/Auth/ReqLogout',
        /** Enter slot game */
        ENTER:          '/Slot/{slotId}/Enter',
        /** Spin */
        SPIN:           '/Slot/{slotId}/Spin',
        /** Claim free spin winnings */
        CLAIM:          '/Slot/{slotId}/Claim',
        /** Pick Game — gửi PickIndex khi người chơi bấm ô */
        PICK:           '/Slot/{slotId}/Pick',
        /** Jackpot info (poll every 2s) */
        JACKPOT:        '/Slot/{slotId}/Jackpot',
        /** HeartBeat (every 10s) */
        HEARTBEAT:      '/HeartBeat',
        /** Feature item list */
        FEATURE_ITEM_GET: '/Slot/{slotId}/FeatureItemGet',
        /** Feature item buy */
        FEATURE_ITEM_BUY: '/Slot/{slotId}/FeatureItemBuy',
        /** Game option change */
        GAME_OPT_CHANGE:  '/Slot/{slotId}/GameOptChange',
        /** Cash race rank (nearby + top snapshot) */
        CASH_RACE_RANK:   '/Slot/{slotId}/CashRaceMyRankGetFirst',
        /** Cash race rank page (pagination / top page) — API V1.0.2 §8.2 */
        CASH_RACE_RANK_PAGE: '/Slot/{slotId}/CashRaceMyRankGetPage',
        /** Refresh balance from partner (dùng khi balance thay đổi bên ngoài, e.g. top-up) */
        BALANCE_GET:      '/Slot/{slotId}/BalanceGet',
    },
    // ─── GATE API ───
    /** Key text để decrypt gp token từ URL (khác với AES_LOGIN_KEY); IV = 16 ký tự đầu */
    GATE_DECRYPT_KEY: 'f429dc4d624d461d8989409f3a4c1b38',
    /** Gate server endpoint (append vào GateUrl) để lấy GameServerUrl */
    GATE_API: '/Gate/GetServiceInfo',
    /** Thay {slotId} trong endpoint path */
    getEndpoint(api: string): string {
        return api.replace('{slotId}', String(this.SLOT_ID));
    },

    /** Full URL cho 1 API */
    getUrl(api: string): string {
        return this.SERVER_URL + this.getEndpoint(api);
    },
} as const;

// ═══════════════════════════════════════════════════════════
//  ★★★  MOCK SCENARIO: Chọn kịch bản test  ★★★
// ═══════════════════════════════════════════════════════════
/**
 * Chọn kịch bản spin sẽ phát khi USE_REAL_API = false.
 *
 *  'random'            — Tạo ngẫu nhiên (mặc định)
 *  'no_win'            — Spin không trúng
 *  'normal_win'        — Cleopatra 3-of-kind
 *  'big_win'           — Cleopatra 5×3 (243 ways combo)
 *  'long_spin'         — 3 Red sticky reel 0..2 → Long Spin
 *  'pot_win'           — Wild Trail tích lũy → Pot Win → Pick Game
 *  'grand_jackpot'     — Pick Game match 3 Grand
 *  'sequence'          — Lần lượt: no_win → normal_win → big_win → long_spin
 */
export type MockScenario =
    | 'random'
    | 'no_win'
    | 'normal_win'
    | 'big_win'
    | 'long_spin'
    | 'pot_win'
    | 'grand_jackpot'
    | 'sequence';

export const MOCK_SPIN_SCENARIO: MockScenario = 'random';

// ═══════════════════════════════════════════════════════════
//  ★★★  DEBUG RANDS: Force server result (dùng DebugArray)  ★★★
// ═══════════════════════════════════════════════════════════
/**
 * Khi khác null, giá trị này sẽ được gửi vào `DebugArray` của Spin request,
 * buộc server trả về kết quả tương ứng với rands chỉ định.
 *
 * Chỉ có tác dụng khi USE_REAL_API = true.
 *
 * ─── Cách tính DebugArray ───────────────────────────────────────
 * DebugArray[col] = raw strip index (kể cả Empty=99).
 * strip[index] = symbol ở hàng giữa (mid row) của cột đó.
 * Strip thực tế: xen kẽ [symbol, 99, symbol, 99, ...] (bước 2).
 * Strip lengths: Reel0=58, Reel1=44, Reel2=352.
 *
 * ─── Symbol IDs (PS thực tế của game) ──────────────────────────
 *   12 = OneSeven (7)       13 = DoubleSeven (77)    14 = TripleSeven (777)
 *   2  = OneBar (BAR)       3  = DoubleBar (BARBAR)
 *   21 = BlueWild           22 = RedWild              23 = TripleWild
 *   98 = Scatter/Bonus      99 = Empty
 *   PickGame: BasePick=81 Grand=82 Major=83 Minor=84 Mini=85 Upgrade=86
 *   (Lưu ý: 81-84 KHÔNG xuất hiện trên reel strip — là ID ảo trong payout table)
 *
 * ─── Trạng thái xác nhận ─────────────────────────────────────────
 *   ✅ Server confirmed  — đã test thành công
 *   🧮 Calculated from PS — tính từ PS, chưa confirm với server
 *   ❓ Needs server confirm — cần server xác nhận trigger condition
 */
export const DEBUG_RANDS_PRESET = {
    // ── ✅ Server confirmed ──────────────────────────────────────
    FREE_SPIN_TRIGGER:        [2,  5,  16],  // ✅ Free Spin Bonus (Scatter ở Reel 2 mid)
    TRIPLE_SEVEN_WIN:         [2,  5,  12],  // ✅ 777-777-777 (TripleSeven × 3)
    GRAND_JACKPOT:            [6,  1,  58],  // ✅ Grand Jackpot (TripleWild × 3)

    // ── 🧮 Calculated from PS ────────────────────────────────────
    ONE_SEVEN_WIN:            [4,  23, 26],  // 🧮 7-7-7   (OneSeven × 3)
    DOUBLE_SEVEN_WIN:         [20, 9,  8 ],  // 🧮 77-77-77 (DoubleSeven × 3)
    ANY_SEVEN_WIN:            [4,  9,  12],  // 🧮 Any-7   (7 + 77 + 777 mix)
    ONE_BAR_WIN:              [10, 3,  2 ],  // 🧮 BAR-BAR-BAR (OneBar × 3)
    DOUBLE_BAR_WIN:           [16, 19, 0 ],  // 🧮 BARBAR-BARBAR-BARBAR (DoubleBar × 3)
    ANY_BAR_WIN:              [10, 19, 2 ],  // 🧮 Any-BAR (BAR + BARBAR + BAR mix)

    // ── ❓ Needs server confirm ──────────────────────────────────
    // Jackpot symbols (81-84) không có trên reel strip, trigger là server-side logic.
    // Giả thuyết: Major=3×RedWild(22), Minor=3×BlueWild(21), Mini=unknown
    MAJOR_JACKPOT_GUESS:      [12, 13, 10],  // ❓ Major? (RedWild × 3)
    MINOR_JACKPOT_GUESS:      [0,  7,  4 ],  // ❓ Minor? (BlueWild × 3)
    MINI_JACKPOT_GUESS:       [6,  7,  10 ]   // ❓ Mini? (Unknown × 3)
    // MINI_JACKPOT: unknown — symbol 81 không xuất hiện trên strip, cần server confirm
} as const;

export const DEBUG_RANDS: readonly number[] | null =  null;//DEBUG_RANDS_PRESET.GRAND_JACKPOT;
// Ví dụ: DEBUG_RANDS_PRESET.FREE_SPIN_TRIGGER để force Free Spin trigger
//        DEBUG_RANDS_PRESET.TRIPLE_SEVEN_WIN   để force Triple Seven win
//        DEBUG_RANDS_PRESET.GRAND_JACKPOT       để force Grand Jackpot

// ═══════════════════════════════════════════════════════════
//  ★★★  DEV FORCE LANG: Buộc ngôn ngữ game cho testing  ★★★
// ═══════════════════════════════════════════════════════════
/**
 * Buộc ngôn ngữ game sang một giá trị cụ thể, bỏ qua localStorage.
 * Dùng extension: Extensions → 🌐 Language Switcher để thay đổi nhanh.
 *
 *  null      — Dùng ngôn ngữ đã lưu trong localStorage (mặc định)
 *  'en'      — English
 *  'ko'      — Korean (한국어)
 *  'zh-cn'   — Simplified Chinese (简体中文)
 *  'zh-tw'   — Traditional Chinese (繁體中文)
 *  'fil'     — Filipino
 *  'ja'      — Japanese (日本語)
 *  'th'      — Thai (ภาษาไทย)
 *  'sg'      — Singapore English
 *  'ms'      — Malay (Bahasa Melayu)
 *  'vi'      — Vietnamese (Tiếng Việt)
 *  'au'      — Australia English (AUD / A$)
 *  'hk'      — Hong Kong English (HKD / HK$)
 */

export const DEV_FORCE_LANG: string | null = null;  // null = auto-detect từ URL `gl` parameter

// ═══════════════════════════════════════════════════════════
//  ★★★  MOCK RESUME SCENARIO: Giả lập tắt game giữa chừng  ★★★
// ═══════════════════════════════════════════════════════════
/**
 * Chọn kịch bản "tắt game giữa chừng" sẽ được giả lập khi USE_REAL_API = false.
 * MockNetworkAdapter.enterGame() sẽ trả về lastSpinResponse tương ứng,
 * kích hoạt toàn bộ resume logic giống như server thật.
 *
 *  'none'                   — Không resume (bình thường, mặc định)
 *  'normal_spin'            — Tắt TRONG lúc Normal Spin → start fresh (spec: không resume)
 *  'free_spin_mid'          — Tắt giữa Free Spin (còn 5 lượt)
 *  'free_spin_need_claim'   — Tắt SAU KHI Free Spin kết thúc, chưa Claim → Claim ngay
 *  'free_spin_jackpot_mid'  — Tắt SAU KHI trúng Jackpot trong Free Spin (còn 3 lượt)
 *  'buy_free_spin_mid'      — Tắt giữa Buy Free Spin (còn 5 lượt)
 *  'buy_free_spin_need_claim' — Tắt SAU KHI Buy Free Spin kết thúc, chưa Claim
 *  'topup_mid'              — Tắt giữa TopUp (còn lượt, có sticky grid)
 *  'topup_need_claim'       — Tắt SAU KHI TopUp kết thúc, chưa Claim
 *  'pick_game'              — Tắt khi đang ở Pick Game (trúng Pot/Jackpot, chưa pick xong) → mở lại Pick Game
 *  'matsuri_mid'            — Tắt giữa Matsuri Hold&Spin (còn re-spin, có AllStickies)
 *  'matsuri_start'          — Tắt lúc FREE_SPIN_START Matsuri (Start popup + StarterCoins)
 *  'matsuri_need_claim'     — Tắt SAU Matsuri FREE_SPIN_END, chưa Claim
 */
export type MockResumeScenario =
    | 'none'
    | 'normal_spin'
    | 'free_spin_mid'
    | 'free_spin_need_claim'
    | 'free_spin_jackpot_mid'
    | 'buy_free_spin_mid'
    | 'buy_free_spin_need_claim'
    | 'topup_mid'
    | 'topup_need_claim'
    | 'pick_game'
    | 'matsuri_mid'
    | 'matsuri_start'
    | 'matsuri_need_claim';

// ★ 'none' = vào game bình thường (dùng MOCK_SPIN_SCENARIO cho spin test)
// ★ 'pick_game' = giả lập tắt game giữa Pick Game → mở lại Pick Game ngay khi Enter
export const MOCK_RESUME_SCENARIO: MockResumeScenario = 'none';

// ─── Test Login config (chỉ dùng khi dev) ───
export const TestLoginConfig = {
    PlatformId: 'testuser01',
    DeviceToken: 'a2b07025fdc0416c8ef8cb68ea39c1ef',
    IsPractice: false,
    Currency: 'USD',
    PartnerId: null as number | null,
};

// ═══════════════════════════════════════════════════════════
//  Tắt toàn bộ console.log/warn/info/debug trong game.
//  Chỉ giữ lại console.error cho các debug log quan trọng.
//  Xoá / comment block này để bật lại log đầy đủ.
// ═══════════════════════════════════════════════════════════
/* eslint-disable no-console */
// (function _silenceGameLogs() {
//     const noop = (..._a: any[]) => {};
//     console.log   = noop;
//     console.warn  = noop;
//     console.info  = noop;
//     console.debug = noop;
// })();
// ↑ Tạm tắt để debug — bỏ comment để re-enable khi production

