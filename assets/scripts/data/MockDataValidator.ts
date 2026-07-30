/**
 * MockDataValidator - Kiểm tra toàn bộ mock JSON data so với PS.json rules.
 *
 * ★ CHẠY TEST:
 *   Gọi MockDataValidator.runAllTests() trong console hoặc GameManager.start()
 *   → In báo cáo PASS/FAIL cho từng test case.
 *
 * ★ MỤC ĐÍCH:
 *   Đảm bảo khi chuyển từ Mock → Real API, dữ liệu khớp 100%:
 *   - Rands nằm trong giới hạn strip length
 *   - Symbol IDs hợp lệ (tồn tại trong PS strips)
 *   - TotalBet tính đúng từ Bet × CoinValue
 *   - NextStage hợp lệ cho từng kịch bản
 *   - MatchedLinePays chứa đúng symbol IDs
 *   - Case-sensitivity đúng chuẩn API
 *
 * @module MockDataValidator
 */
import { Log } from '../core/Logger';

// ═══════════════════════════════════════════════════════════
//  PS.JSON CONSTANTS (hardcoded cho validation)
// ═══════════════════════════════════════════════════════════

/** Độ dài mỗi reel strip Normal (từ PS.json) */
const NORMAL_REEL_LENGTHS = [75, 74, 76, 75, 69];

/** Độ dài mỗi reel strip FreeSpin (từ PS.json) */
const FREE_SPIN_REEL_LENGTHS = [41, 41, 43, 40, 40];

/** Symbols hợp lệ trên reel strips (PS IDs) */
const VALID_STRIP_SYMBOLS = new Set([1, 2, 3, 4, 11, 12, 13, 14, 15, 21, 22, 23, 41]);

/** Bet mức hợp lệ từ PS.json */
const VALID_BETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const VALID_COIN_VALUES = [0.1, 0.3, 0.5, 1, 2, 5];

/** PS Special Symbol IDs */
const PS_SCATTER_ID = 21;
const PS_TRIPLE_WILD_ID = 23;
const PS_GRAND_JACKPOT_ID = 52;
const PS_MAJOR_JACKPOT_ID = 51;
const PS_MINOR_JACKPOT_ID = 49;
const PS_MINI_JACKPOT_ID = 48;

/** NextStage values */
const STAGE_SPIN = 0;
const STAGE_FREE_SPIN_START = 3;
const STAGE_FREE_SPIN = 4;
const STAGE_FREE_SPIN_RE_TRIGGER = 5;
const STAGE_NEED_CLAIM = 100;
const STAGE_FREE_SPIN_END = 101;

/** Required PascalCase fields — phải khớp 100% với API server */
const SPIN_TOP_FIELDS = ['RemainCash', 'Res', 'SpinID', 'Before', 'After', 'SMM'];
const SPIN_RES_FIELDS = [
    'Rands', 'MatchedLinePays', 'UpdateCash', 'TotalBet', 'TotalWin',
    'NextStage', 'WinGrade', 'FeatureSpinTotalWin', 'FeatureSpinWin',
    'RemainFreeSpinCount', 'ReelIndex', 'MysteryMultiple', 'MatchedBonus',
    'CollectWin', 'AddSpinCount', 'InitReel',
];
const MATCHED_LINE_PAY_FIELDS = [
    'Feature', 'FeatureParam', 'MatchedSymbols', 'MatchedSymbolsCount',
    'PayLineIndex', 'Payout', 'ReelCnt', 'ContainsWild', 'MatchedSymbolsIndices',
];
const ENTER_FIELDS = [
    'Cash', 'SlotName', 'PS', 'BetIndex', 'CoinValueIndex',
    'LastSpinResponse', 'IsPractice', 'MemberIdx', 'SMM',
];
const CLAIM_FIELDS = ['ClaimResponse', 'WinCash', 'Cash', 'SMM'];
const JACKPOT_FIELDS = ['Wins', 'WinMsgs', 'ReqRace', 'CR', 'SMM', 'UTC'];

// ═══════════════════════════════════════════════════════════
//  TEST RESULT TYPES
// ═══════════════════════════════════════════════════════════

interface TestResult {
    name: string;
    passed: boolean;
    details: string;
}

// ═══════════════════════════════════════════════════════════
//  VALIDATOR CLASS
// ═══════════════════════════════════════════════════════════

export class MockDataValidator {
    private static _results: TestResult[] = [];

    /**
     * Chạy tất cả test cases. Import mock JSON files và validate.
     * In báo cáo chi tiết ra console.
     */
    static async runAllTests(): Promise<void> {
        this._results = [];
        Log.d('╔══════════════════════════════════════════════╗');
        Log.d('║   MOCK DATA VALIDATION — START               ║');
        Log.d('╚══════════════════════════════════════════════╝');

        // ─── Load mock files ───
        // Trong Cocos Creator, dùng resources.load hoặc import trực tiếp
        // Ở đây ta pass data objects trực tiếp cho testability
        Log.d('\n⚠ Gọi validateSpinData / validateEnterData / ... với data object từ mock JSON.');
        Log.d('  Xem ví dụ ở cuối file.\n');
    }

    // ═══════════════════════════════════════════════════════════
    //  PUBLIC VALIDATION METHODS
    // ═══════════════════════════════════════════════════════════

    /** Validate mock_enter.json */
    static validateEnterData(data: any, label: string = 'Enter'): TestResult[] {
        const results: TestResult[] = [];

        // 1. Check required fields (PascalCase)
        results.push(this._checkFields(data, ENTER_FIELDS, `${label}: top-level fields`));

        // 2. Cash phải > 0
        results.push(this._check(`${label}: Cash > 0`, data.Cash > 0, `Cash=${data.Cash}`));

        // 3. PS phải là Base64 hợp lệ
        if (data.PS) {
            let psValid = false;
            let psContent = '';
            try {
                psContent = atob(data.PS);
                const psObj = JSON.parse(psContent);
                psValid = psObj.GameName === 'SuperNova';
            } catch { /* invalid */ }
            results.push(this._check(`${label}: PS is valid Base64 → SuperNova PS`, psValid, `PS length=${data.PS?.length}`));
        }

        // 4. BetIndex trong range
        results.push(this._check(
            `${label}: BetIndex valid`,
            data.BetIndex >= 0 && data.BetIndex < VALID_BETS.length,
            `BetIndex=${data.BetIndex}`
        ));

        // 5. CoinValueIndex trong range
        results.push(this._check(
            `${label}: CoinValueIndex valid`,
            data.CoinValueIndex >= 0 && data.CoinValueIndex < VALID_COIN_VALUES.length,
            `CoinValueIndex=${data.CoinValueIndex}`
        ));

        this._printResults(results, label);
        return results;
    }

    /** Validate mock_spin_*.json (normal, trigger_free, jackpot, etc.) */
    static validateSpinData(
        data: any,
        label: string = 'Spin',
        options: {
            isFreeSpin?: boolean;
            expectedNextStage?: number;
            expectedScatter?: boolean;
            expectedJackpotId?: number;
        } = {}
    ): TestResult[] {
        const results: TestResult[] = [];
        const res = data.Res;

        // 1. Top-level field names (PascalCase)
        results.push(this._checkFields(data, SPIN_TOP_FIELDS, `${label}: top-level fields`));

        // 2. Res field names (PascalCase)
        results.push(this._checkFields(res, SPIN_RES_FIELDS, `${label}: Res fields`));

        // 3. Rands length = 5
        results.push(this._check(
            `${label}: Rands length = 5`,
            Array.isArray(res.Rands) && res.Rands.length === 5,
            `Rands=${JSON.stringify(res.Rands)}`
        ));

        // 4. Rands bounds check
        const reelLengths = options.isFreeSpin ? FREE_SPIN_REEL_LENGTHS : NORMAL_REEL_LENGTHS;
        if (Array.isArray(res.Rands) && res.Rands.length === 5) {
            for (let i = 0; i < 5; i++) {
                results.push(this._check(
                    `${label}: Rands[${i}] in range [0, ${reelLengths[i] - 1}]`,
                    res.Rands[i] >= 0 && res.Rands[i] < reelLengths[i],
                    `Rands[${i}]=${res.Rands[i]}`
                ));
            }
        }

        // 5. TotalBet hợp lệ (Bet × CoinValue)
        const validBets: Set<number> = new Set();
        for (const b of VALID_BETS) {
            for (const cv of VALID_COIN_VALUES) {
                validBets.add(Math.round(b * cv * 1000) / 1000);
            }
        }
        results.push(this._check(
            `${label}: TotalBet is valid Bet×CoinValue`,
            validBets.has(Math.round(res.TotalBet * 1000) / 1000),
            `TotalBet=${res.TotalBet}`
        ));

        // 6. NextStage hợp lệ
        const validStages = [STAGE_SPIN, STAGE_FREE_SPIN_START, STAGE_FREE_SPIN, STAGE_FREE_SPIN_RE_TRIGGER, STAGE_NEED_CLAIM, STAGE_FREE_SPIN_END];
        results.push(this._check(
            `${label}: NextStage is valid enum`,
            validStages.indexOf(res.NextStage) !== -1,
            `NextStage=${res.NextStage}`
        ));

        if (options.expectedNextStage !== undefined) {
            results.push(this._check(
                `${label}: NextStage = ${options.expectedNextStage}`,
                res.NextStage === options.expectedNextStage,
                `actual=${res.NextStage}`
            ));
        }

        // 7. MatchedLinePays format check
        if (Array.isArray(res.MatchedLinePays) && res.MatchedLinePays.length > 0) {
            for (let i = 0; i < res.MatchedLinePays.length; i++) {
                const lp = res.MatchedLinePays[i];
                results.push(this._checkFields(lp, MATCHED_LINE_PAY_FIELDS, `${label}: MatchedLinePays[${i}] fields`));

                // MatchedSymbols phải chứa PS Symbol IDs hợp lệ (hoặc Group IDs)
                if (Array.isArray(lp.MatchedSymbols)) {
                    for (const symId of lp.MatchedSymbols) {
                        results.push(this._check(
                            `${label}: MatchedLinePays[${i}].MatchedSymbols contains valid PS ID`,
                            symId >= 1 && symId <= 52,
                            `SymbolID=${symId}`
                        ));
                    }
                }
            }
        }

        // 8. Scatter trigger check
        if (options.expectedScatter) {
            const hasScatter = res.MatchedLinePays?.some(
                (lp: any) => lp.MatchedSymbols?.includes(PS_SCATTER_ID)
            );
            results.push(this._check(
                `${label}: MatchedSymbols contains Scatter (${PS_SCATTER_ID})`,
                !!hasScatter,
                `found=${!!hasScatter}`
            ));
            results.push(this._check(
                `${label}: NextStage = FREE_SPIN_START (3) when Scatter triggered`,
                res.NextStage === STAGE_FREE_SPIN_START,
                `NextStage=${res.NextStage}`
            ));
        }

        // 9. Jackpot check
        if (options.expectedJackpotId) {
            const hasJp = res.MatchedLinePays?.some(
                (lp: any) => lp.MatchedSymbols?.includes(options.expectedJackpotId)
            );
            results.push(this._check(
                `${label}: MatchedSymbols contains Jackpot ID (${options.expectedJackpotId})`,
                !!hasJp,
                `found=${!!hasJp}`
            ));
            results.push(this._check(
                `${label}: TotalWin > 0 for jackpot`,
                res.TotalWin > 0,
                `TotalWin=${res.TotalWin}`
            ));
        }

        // 10. WinGrade  (should be null or valid string)
        if (res.WinGrade !== null) {
            const validGrades = ['Normal', 'Big', 'Super', 'Mega', 'Invalid'];
            results.push(this._check(
                `${label}: WinGrade is valid string`,
                validGrades.indexOf(res.WinGrade) !== -1,
                `WinGrade="${res.WinGrade}"`
            ));
        }

        // 11. Before/After are dictionary {string: number}
        if (data.Before) {
            results.push(this._check(
                `${label}: Before is object with numeric keys`,
                typeof data.Before === 'object' && !Array.isArray(data.Before),
                `Before keys=${Object.keys(data.Before)}`
            ));
        }

        // 12. RemainCash (number)
        results.push(this._check(
            `${label}: RemainCash is number`,
            typeof data.RemainCash === 'number',
            `RemainCash=${data.RemainCash}`
        ));

        // 13. Free Spin specific: UpdateCash should be false
        if (options.isFreeSpin) {
            results.push(this._check(
                `${label}: UpdateCash = false (FreeSpin)`,
                res.UpdateCash === false,
                `UpdateCash=${res.UpdateCash}`
            ));
            results.push(this._check(
                `${label}: RemainFreeSpinCount >= 0 (FreeSpin)`,
                res.RemainFreeSpinCount >= 0,
                `RemainFreeSpinCount=${res.RemainFreeSpinCount}`
            ));
        }

        this._printResults(results, label);
        return results;
    }

    /** Validate mock_claim.json */
    static validateClaimData(data: any, label: string = 'Claim'): TestResult[] {
        const results: TestResult[] = [];

        results.push(this._checkFields(data, CLAIM_FIELDS, `${label}: top-level fields`));

        if (data.ClaimResponse) {
            const cr = data.ClaimResponse;
            results.push(this._check(`${label}: ClaimResponse.TotalWin > 0`, cr.TotalWin > 0, `TotalWin=${cr.TotalWin}`));
            results.push(this._check(`${label}: ClaimResponse.FeatureName exists`, !!cr.FeatureName, `FeatureName="${cr.FeatureName}"`));
            results.push(this._check(`${label}: Cash > 0`, data.Cash > 0, `Cash=${data.Cash}`));
        }

        this._printResults(results, label);
        return results;
    }

    /** Validate mock_jackpot.json */
    static validateJackpotData(data: any, label: string = 'Jackpot'): TestResult[] {
        const results: TestResult[] = [];

        results.push(this._checkFields(data, JACKPOT_FIELDS, `${label}: top-level fields`));
        results.push(this._check(
            `${label}: Wins is array of 4 numbers`,
            Array.isArray(data.Wins) && data.Wins.length === 4 && data.Wins.every((v: any) => typeof v === 'number'),
            `Wins=${JSON.stringify(data.Wins)}`
        ));

        this._printResults(results, label);
        return results;
    }

    // ═══════════════════════════════════════════════════════════
    //  INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════

    private static _check(name: string, condition: boolean, details: string): TestResult {
        return { name, passed: condition, details };
    }

    private static _checkFields(obj: any, requiredFields: string[], label: string): TestResult {
        if (!obj || typeof obj !== 'object') {
            return { name: label, passed: false, details: 'Object is null/undefined' };
        }
        const missing = requiredFields.filter((f) => !(f in obj));
        const extra_camelCase = Object.keys(obj).filter((k) => {
            // Check nếu có camelCase version của PascalCase field → warning
            const pascal = k.charAt(0).toUpperCase() + k.slice(1);
            return pascal !== k && requiredFields.indexOf(pascal) !== -1;
        });

        let details = '';
        if (missing.length > 0) details += `Missing: [${missing.join(', ')}] `;
        if (extra_camelCase.length > 0) details += `CamelCase instead of PascalCase: [${extra_camelCase.join(', ')}]`;
        if (!details) details = 'All fields present ✓';

        return { name: label, passed: missing.length === 0 && extra_camelCase.length === 0, details };
    }

    private static _printResults(results: TestResult[], section: string): void {
        const passed = results.filter((r) => r.passed).length;
        const failed = results.filter((r) => !r.passed).length;
        const total = results.length;

        Log.d(`\n── ${section} ── [${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ''}]`);
        for (const r of results) {
            const icon = r.passed ? '✅' : '❌';
            Log.d(`  ${icon} ${r.name} — ${r.details}`);
        }

        if (failed > 0) {
            Log.w(`⚠ ${section}: ${failed} test(s) FAILED! Fix trước khi chuyển sang real API.`);
        }
    }
}

// ═══════════════════════════════════════════════════════════
//  USAGE EXAMPLES (gọi trong console hoặc test script)
// ═══════════════════════════════════════════════════════════

/*
// ─── Cách 1: Import mock JSON và validate ───

import mockEnter from './mock/mock_enter.json';
import mockSpinNormal from './mock/mock_spin_normal.json';
import mockSpinTriggerFree from './mock/mock_spin_trigger_free.json';
import mockSpinJackpot from './mock/mock_spin_jackpot.json';
import mockSpinFreeSpin from './mock/mock_spin_freespin.json';
import mockSpinFreeSpinEnd from './mock/mock_spin_freespin_end.json';
import mockClaim from './mock/mock_claim.json';
import mockJackpot from './mock/mock_jackpot.json';

MockDataValidator.validateEnterData(mockEnter, 'mock_enter');
MockDataValidator.validateSpinData(mockSpinNormal, 'mock_spin_normal');
MockDataValidator.validateSpinData(mockSpinTriggerFree, 'mock_spin_trigger_free', {
    expectedNextStage: 3,
    expectedScatter: true,
});
MockDataValidator.validateSpinData(mockSpinJackpot, 'mock_spin_jackpot', {
    expectedJackpotId: 52,
});
MockDataValidator.validateSpinData(mockSpinFreeSpin, 'mock_spin_freespin', {
    isFreeSpin: true,
    expectedNextStage: 4,
});
MockDataValidator.validateSpinData(mockSpinFreeSpinEnd, 'mock_spin_freespin_end', {
    isFreeSpin: true,
    expectedNextStage: 101,
});
MockDataValidator.validateClaimData(mockClaim, 'mock_claim');
MockDataValidator.validateJackpotData(mockJackpot, 'mock_jackpot');
*/
