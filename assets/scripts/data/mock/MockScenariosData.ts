/**
 * MockScenariosData — ★ Gold of Fortune (3×5 Ways Pay)
 *
 * Tất cả SpinResponse mock được build từ MockDataProvider.buildScenario().
 * Export giữ đúng tên cũ để NetworkManager.ts không cần sửa imports lớn.
 *
 * Scenario mapping:
 *   SCENARIO_NO_WIN          → NO_WIN
 *   SCENARIO_NORMAL_WIN      → NORMAL_WIN  (Cleopatra 3-of-kind)
 *   SCENARIO_MULTI_LINE      → NORMAL_WIN  (alias)
 *   SCENARIO_BIG_WIN         → BIG_WIN     (Cleopatra 5×3)
 *   SCENARIO_LONG_SPIN       → LONG_SPIN_TRIGGER (3 Red reel 0..2)
 *   SCENARIO_JACKPOT         → GRAND_JACKPOT (Pick Game Grand)
 *   FULL_FREE_SEQUENCE       → FreeSpin flow placeholder (dùng generateSpinResponse)
 *   DEFAULT_SEQUENCE         → [NO_WIN, NORMAL_WIN, FEATURE_TRIGGER_RESPIN]
 *
 * Resume scenarios — stub null (resume logic sẽ xử lý riêng ở B3/GameManager refactor).
 */

import { SlotStageType, SpinResponse, TopupReelType } from '../SlotTypes';
import { MockDataProvider, TestScenario } from '../MockDataProvider';

// ─── SINGLE-SPIN SCENARIOS ───────────────────────────────────────────────────

export const SCENARIO_NO_WIN:     SpinResponse = MockDataProvider.buildScenario(TestScenario.NO_WIN);
export const SCENARIO_NORMAL_WIN: SpinResponse = MockDataProvider.buildScenario(TestScenario.NORMAL_WIN);
export const SCENARIO_MULTI_LINE: SpinResponse = MockDataProvider.buildScenario(TestScenario.NORMAL_WIN);
export const SCENARIO_BIG_WIN:    SpinResponse = MockDataProvider.buildScenario(TestScenario.BIG_WIN);
export const SCENARIO_LONG_SPIN:  SpinResponse = MockDataProvider.buildScenario(TestScenario.LONG_SPIN_TRIGGER);
export const SCENARIO_JACKPOT:    SpinResponse = MockDataProvider.buildScenario(TestScenario.GRAND_JACKPOT);

// ─── SEQUENCE SCENARIOS ───────────────────────────────────────────────────────

/** Normal spin → Feature Select → Re-Spin flow */
export const FULL_FREE_SEQUENCE: SpinResponse[] = [
    MockDataProvider.buildScenario(TestScenario.NO_WIN),
    MockDataProvider.buildScenario(TestScenario.NORMAL_WIN),
    MockDataProvider.buildScenario(TestScenario.FEATURE_TRIGGER_RESPIN),
];

/** Feature Select → Free Spin flow */
export const FULL_FREE_JACKPOT_SEQUENCE: SpinResponse[] = [
    MockDataProvider.buildScenario(TestScenario.NO_WIN),
    MockDataProvider.buildScenario(TestScenario.FEATURE_TRIGGER_FREESPIN),
];

/** ★ Force Feature Entry: spin 1 gauge → spin 2 feature (2 Red + 4 orb fill). */
export const FORCE_FEATURE_ENTRY_SEQUENCE: SpinResponse[] = [
    MockDataProvider.buildScenario(TestScenario.FEATURE_GAUGE_WARMUP),
    MockDataProvider.buildScenario(TestScenario.FORCE_FEATURE_ENTRY),
];

/** Pot Win → Grand Jackpot flow */
export const FULL_FREE_RETRIGGER_SEQUENCE: SpinResponse[] = [
    MockDataProvider.buildScenario(TestScenario.NORMAL_WIN),
    MockDataProvider.buildScenario(TestScenario.POT_WIN),
    MockDataProvider.buildScenario(TestScenario.GRAND_JACKPOT),
];

/** Default test sequence */
export const DEFAULT_SEQUENCE: SpinResponse[] = [
    MockDataProvider.buildScenario(TestScenario.NO_WIN),
    MockDataProvider.buildScenario(TestScenario.NORMAL_WIN),
    MockDataProvider.buildScenario(TestScenario.FEATURE_TRIGGER_RESPIN),
    MockDataProvider.buildScenario(TestScenario.BIG_WIN),
    MockDataProvider.buildScenario(TestScenario.LONG_SPIN_TRIGGER),
];

/** Buy Feature flow — placeholder, dùng FEATURE_TRIGGER_RESPIN */
export const BUY_FREE_SPIN_SEQUENCE: SpinResponse[] = [
    MockDataProvider.buildScenario(TestScenario.FEATURE_TRIGGER_RESPIN),
];

// ─── RESUME SCENARIOS ─────────────────────────────────────────────────────────
// Mỗi object mô phỏng `LastSpinResponse` từ Enter API (server PascalCase).
// GameManager._buildPendingResume() đọc các field: NextStage, RemainFreeSpinCount,
// FeatureSpinTotalWin, Rands, TopupReel, PickGame.
//
// ★ Normal Spin resume: spec không resume (start fresh) → null.
export const MOCK_RESUME_NORMAL_SPIN: null = null;

/** Tắt GIỮA Free Spin (FreeSpin Gold) — còn 5 lượt, đã thắng 120. */
export const MOCK_RESUME_FREE_SPIN_MID = {
    NextStage: SlotStageType.FREE_SPIN,        // 4
    Rands: [0, 0, 0, 0, 0],
    TotalBet: 1,
    TotalWin: 0,
    FeatureSpinTotalWin: 120,
    RemainFreeSpinCount: 5,
};

/** Tắt SAU KHI Free Spin kết thúc nhưng chưa Claim → Claim + hiện end popup. */
export const MOCK_RESUME_FREE_SPIN_NEED_CLAIM = {
    NextStage: SlotStageType.FREE_SPIN_END,    // 101
    Rands: [0, 0, 0, 0, 0],
    TotalBet: 1,
    TotalWin: 0,
    FeatureSpinTotalWin: 250,
    RemainFreeSpinCount: 0,
};

/** Tắt SAU KHI trúng Jackpot trong Free Spin — còn 3 lượt, tổng đã bao gồm jackpot. */
export const MOCK_RESUME_FREE_SPIN_JACKPOT_MID = {
    NextStage: SlotStageType.FREE_SPIN,        // 4
    Rands: [0, 0, 0, 0, 0],
    TotalBet: 1,
    TotalWin: 0,
    FeatureSpinTotalWin: 1500,
    RemainFreeSpinCount: 3,
};

/** Tắt GIỮA Buy Free Spin — còn 5 lượt. */
export const MOCK_RESUME_BUY_FREE_SPIN_MID = {
    NextStage: SlotStageType.BUY_FREE_SPIN,    // 9
    Rands: [0, 0, 0, 0, 0],
    TotalBet: 1,
    TotalWin: 0,
    FeatureSpinTotalWin: 80,
    RemainFreeSpinCount: 5,
};

/** Tắt SAU KHI Buy Free Spin kết thúc nhưng chưa Claim. */
export const MOCK_RESUME_BUY_FREE_SPIN_NEED_CLAIM = {
    NextStage: SlotStageType.BUY_FREE_SPIN_END, // 107
    Rands: [0, 0, 0, 0, 0],
    TotalBet: 1,
    TotalWin: 0,
    FeatureSpinTotalWin: 300,
    RemainFreeSpinCount: 0,
};

/**
 * Tắt khi ĐANG ở Pick Game (vừa trúng Pot Win, chưa pick xong).
 * NextStage=POT_WIN(220) + PickGame state để client mở lại Pick Game popup.
 * PickGame ở dạng client PickGameState ({ grid, revealed, wonTier }) — tier sẽ
 * được quyết định theo coin người chơi pick (giống flow bình thường).
 */
export const MOCK_RESUME_PICK_GAME = {
    NextStage: SlotStageType.POT_WIN,          // 220
    Rands: [0, 0, 0, 0, 0],
    TotalBet: 1,
    TotalWin: 0,
    FeatureSpinTotalWin: 0,
    RemainFreeSpinCount: 0,
    PickGame: MockDataProvider.buildPickGame(),
};

const MOCK_TOPUP_REEL = [
    { Type: TopupReelType.NONE,   Win: 0,   Index: 0 },
    { Type: TopupReelType.RED,    Win: 20,  Index: 1 },
    { Type: TopupReelType.NONE,   Win: 0,   Index: 2 },
    { Type: TopupReelType.RED,    Win: 10,  Index: 3 },
    { Type: TopupReelType.NONE,   Win: 0,   Index: 4 },
    { Type: TopupReelType.YELLOW, Win: 30,  Index: 5 },
    { Type: TopupReelType.NONE,   Win: 0,   Index: 6 },
    { Type: TopupReelType.RED,    Win: 15,  Index: 7 },
    { Type: TopupReelType.GREEN,  Win: 75,  Index: 8 },
    { Type: TopupReelType.NONE,   Win: 0,   Index: 9 },
    { Type: TopupReelType.NONE,   Win: 0,   Index: 10 },
    { Type: TopupReelType.RED,    Win: 25,  Index: 11 },
    { Type: TopupReelType.NONE,   Win: 0,   Index: 12 },
    { Type: TopupReelType.RED,    Win: 10,  Index: 13 },
    { Type: TopupReelType.NONE,   Win: 0,   Index: 14 },
];

export const MOCK_RESUME_TOPUP_MID = {
    NextStage: SlotStageType.TOPUP_SPIN,
    Rands: [0, 0, 0, 0, 0],
    TotalBet: 1,
    TotalWin: 0,
    FeatureSpinTotalWin: 105,
    RemainFeatureSpinCount: 3,
    TopupReel: MOCK_TOPUP_REEL,
};

export const MOCK_RESUME_TOPUP_NEED_CLAIM = {
    NextStage: SlotStageType.TOPUP_SPIN_END,
    Rands: [0, 0, 0, 0, 0],
    TotalBet: 1,
    TotalWin: 0,
    FeatureSpinTotalWin: 180,
    RemainFeatureSpinCount: 0,
    TopupReel: MOCK_TOPUP_REEL,
};
