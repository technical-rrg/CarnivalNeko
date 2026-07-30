/**
 * validate-mock-data.js — Script chạy độc lập (Node.js) để validate mock JSON.
 *
 * ★ CHẠY: node assets/scripts/data/validate-mock-data.js
 *
 * Không cần Cocos Creator. Test toàn bộ mock JSON files so với PS.json rules.
 */

const fs = require('fs');
const path = require('path');

// ─── CONSTANTS (từ PS.json) ───
const NORMAL_REEL_LENGTHS = [75, 74, 76, 75, 69];
const FREE_SPIN_REEL_LENGTHS = [41, 41, 43, 40, 40];
const PURCHASE_REEL_LENGTHS = [76, 76, 76, 77, 77];
const VALID_BETS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const VALID_COIN_VALUES = [0.1, 0.3, 0.5, 1, 2, 5];
const VALID_STRIP_SYMBOLS = new Set([1, 2, 3, 4, 11, 12, 13, 14, 15, 21, 22, 23, 41]);
const PS_SCATTER_ID = 21;
const PS_TRIPLE_WILD_ID = 23;
const PS_GRAND_JACKPOT_ID = 52;

// ─── HELPERS ───

let totalPass = 0;
let totalFail = 0;

function check(name, condition, details) {
    if (condition) {
        totalPass++;
        console.log(`  ✅ ${name} — ${details}`);
    } else {
        totalFail++;
        console.log(`  ❌ ${name} — ${details}`);
    }
    return condition;
}

function checkFields(obj, requiredFields, label) {
    const missing = requiredFields.filter(f => !(f in obj));
    const camelInstead = Object.keys(obj).filter(k => {
        const pascal = k.charAt(0).toUpperCase() + k.slice(1);
        return pascal !== k && requiredFields.includes(pascal);
    });
    const ok = missing.length === 0 && camelInstead.length === 0;
    let details = ok ? 'All fields present ✓' : '';
    if (missing.length) details += `Missing: [${missing.join(', ')}] `;
    if (camelInstead.length) details += `camelCase→PascalCase: [${camelInstead.join(', ')}]`;
    check(label, ok, details);
    return ok;
}

const MOCK_DIR = path.resolve(__dirname, '../assets/scripts/data');

function loadJson(filePath) {
    const full = path.resolve(MOCK_DIR, filePath);
    if (!fs.existsSync(full)) {
        console.log(`  ⚠ File not found: ${full}`);
        return null;
    }
    let text = fs.readFileSync(full, 'utf-8');
    // Strip UTF-8 BOM if present
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
}

// ─── REEL STRIP VERIFICATION ───

function loadPSStrips() {
    const psPath = path.resolve(__dirname, '../response-examples/SuperNova PS.json');
    const ps = JSON.parse(fs.readFileSync(psPath, 'utf-8'));
    return ps;
}

function verifyRandsAgainstStrips(rands, strips, label) {
    for (let i = 0; i < 5; i++) {
        const len = strips[i].Symbols.length;
        check(
            `${label}: Rands[${i}] in [0, ${len - 1}]`,
            rands[i] >= 0 && rands[i] < len,
            `Rands[${i}]=${rands[i]}`
        );
    }
}

function getVisibleSymbols(strip, centerIdx) {
    const len = strip.length;
    const idx = ((centerIdx % len) + len) % len;
    return {
        top: strip[((idx - 1) + len) % len],
        mid: strip[idx],
        bot: strip[(idx + 1) % len],
    };
}

function printGrid(rands, strips, label) {
    console.log(`  📊 ${label} Grid:`);
    const grid = [];
    for (let c = 0; c < 5; c++) {
        grid.push(getVisibleSymbols(strips[c].Symbols, rands[c]));
    }
    const topRow = grid.map(g => String(g.top).padStart(3)).join(',');
    const midRow = grid.map(g => String(g.mid).padStart(3)).join(',');
    const botRow = grid.map(g => String(g.bot).padStart(3)).join(',');
    console.log(`     Top: [${topRow}]`);
    console.log(`     Mid: [${midRow}]`);
    console.log(`     Bot: [${botRow}]`);
    return grid;
}

// ═══════════════════════════════════════════════════════════
//  VALIDATE FUNCTIONS
// ═══════════════════════════════════════════════════════════

function validateEnter(data, label) {
    console.log(`\n── ${label} ──`);
    const enterFields = ['Cash', 'SlotName', 'PS', 'BetIndex', 'CoinValueIndex', 'LastSpinResponse', 'IsPractice', 'MemberIdx', 'SMM'];
    checkFields(data, enterFields, `${label}: fields`);
    check(`${label}: Cash > 0`, data.Cash > 0, `Cash=${data.Cash}`);
    check(`${label}: BetIndex valid`, data.BetIndex >= 0 && data.BetIndex < VALID_BETS.length, `BetIndex=${data.BetIndex}`);
    check(`${label}: CoinValueIndex valid`, data.CoinValueIndex >= 0 && data.CoinValueIndex < VALID_COIN_VALUES.length, `CoinValueIndex=${data.CoinValueIndex}`);

    // Decode PS base64
    try {
        const psJson = Buffer.from(data.PS, 'base64').toString('utf-8');
        const ps = JSON.parse(psJson);
        check(`${label}: PS decodes to valid SuperNova PS`, ps.GameName === 'SuperNova', `GameName="${ps.GameName}"`);
        check(`${label}: PS has Reel.Strips[5]`, ps.Reel?.Strips?.length === 5, `Strips=${ps.Reel?.Strips?.length}`);
        check(`${label}: PS has ScatterSymbolID=21`, ps.ScatterSymbolID === 21, `Scatter=${ps.ScatterSymbolID}`);
        check(`${label}: PS has GrandJackpotID=52`, ps.GrandJackpotID === 52, `Grand=${ps.GrandJackpotID}`);
    } catch (e) {
        check(`${label}: PS base64 decode`, false, `Error: ${e.message}`);
    }
}

function validateSpin(data, label, opts = {}) {
    console.log(`\n── ${label} ──`);
    const res = data.Res;

    const spinTopFields = ['RemainCash', 'Res', 'SpinID', 'Before', 'After', 'SMM'];
    checkFields(data, spinTopFields, `${label}: top fields`);

    const resFields = ['Rands', 'MatchedLinePays', 'UpdateCash', 'TotalBet', 'TotalWin',
        'NextStage', 'WinGrade', 'FeatureSpinTotalWin', 'FeatureSpinWin',
        'RemainFreeSpinCount', 'MysteryMultiple', 'MatchedBonus',
        'CollectWin', 'AddSpinCount', 'InitReel'];
    checkFields(res, resFields, `${label}: Res fields`);

    // Rands
    check(`${label}: Rands is array[5]`, Array.isArray(res.Rands) && res.Rands.length === 5, `len=${res.Rands?.length}`);

    const reelLens = opts.isFreeSpin ? FREE_SPIN_REEL_LENGTHS : NORMAL_REEL_LENGTHS;
    if (res.Rands?.length === 5) {
        for (let i = 0; i < 5; i++) {
            check(`${label}: Rands[${i}] < ${reelLens[i]}`, res.Rands[i] >= 0 && res.Rands[i] < reelLens[i], `=${res.Rands[i]}`);
        }
    }

    // TotalBet validation
    const validBets = new Set();
    for (const b of VALID_BETS) for (const cv of VALID_COIN_VALUES) validBets.add(Math.round(b * cv * 1000) / 1000);
    check(`${label}: TotalBet valid`, validBets.has(Math.round(res.TotalBet * 1000) / 1000), `TotalBet=${res.TotalBet}`);

    // NextStage
    if (opts.expectedNextStage !== undefined) {
        check(`${label}: NextStage = ${opts.expectedNextStage}`, res.NextStage === opts.expectedNextStage, `actual=${res.NextStage}`);
    }

    // Before/After
    check(`${label}: Before is object`, typeof data.Before === 'object' && !Array.isArray(data.Before), `type=${typeof data.Before}`);
    check(`${label}: After is object`, typeof data.After === 'object' && !Array.isArray(data.After), `type=${typeof data.After}`);

    // WinGrade
    if (res.WinGrade !== null) {
        const validGrades = ['Normal', 'Big', 'Super', 'Mega', 'Invalid'];
        check(`${label}: WinGrade valid`, validGrades.includes(res.WinGrade), `="${res.WinGrade}"`);
    }

    // MatchedLinePays
    if (res.MatchedLinePays?.length > 0) {
        const lpFields = ['Feature', 'FeatureParam', 'MatchedSymbols', 'MatchedSymbolsCount', 'PayLineIndex', 'Payout', 'ReelCnt', 'ContainsWild', 'MatchedSymbolsIndices'];
        for (let i = 0; i < res.MatchedLinePays.length; i++) {
            checkFields(res.MatchedLinePays[i], lpFields, `${label}: LinePay[${i}] fields`);
        }
    }

    // Scatter check
    if (opts.expectedScatter) {
        const hasScatter = res.MatchedLinePays?.some(lp => lp.MatchedSymbols?.includes(PS_SCATTER_ID));
        check(`${label}: Contains Scatter(${PS_SCATTER_ID})`, !!hasScatter, `found=${!!hasScatter}`);
        check(`${label}: NextStage=3 (FREE_SPIN_START)`, res.NextStage === 3, `actual=${res.NextStage}`);
    }

    // Jackpot check
    if (opts.expectedJackpotId) {
        const hasJp = res.MatchedLinePays?.some(lp => lp.MatchedSymbols?.includes(opts.expectedJackpotId));
        check(`${label}: Contains JackpotID(${opts.expectedJackpotId})`, !!hasJp, `found=${!!hasJp}`);
        check(`${label}: TotalWin > 0`, res.TotalWin > 0, `TotalWin=${res.TotalWin}`);
    }

    // FreeSpin checks
    if (opts.isFreeSpin) {
        check(`${label}: UpdateCash=false`, res.UpdateCash === false, `actual=${res.UpdateCash}`);
        check(`${label}: RemainFreeSpinCount>=0`, res.RemainFreeSpinCount >= 0, `=${res.RemainFreeSpinCount}`);
    }

    // Print grid
    if (res.Rands?.length === 5) {
        const ps = loadPSStrips();
        const strips = opts.isFreeSpin ? ps.FreeSpinReel.Strips : ps.Reel.Strips;
        printGrid(res.Rands, strips, label);
    }
}

function validateClaim(data, label) {
    console.log(`\n── ${label} ──`);
    checkFields(data, ['ClaimResponse', 'WinCash', 'Cash', 'SMM'], `${label}: fields`);
    check(`${label}: Cash > 0`, data.Cash > 0, `Cash=${data.Cash}`);
    check(`${label}: WinCash > 0`, data.WinCash > 0, `WinCash=${data.WinCash}`);
    if (data.ClaimResponse) {
        check(`${label}: NextStage=0`, data.ClaimResponse.NextStage === 0, `=${data.ClaimResponse.NextStage}`);
    }
}

function validateJackpot(data, label) {
    console.log(`\n── ${label} ──`);
    checkFields(data, ['Wins', 'WinMsgs', 'ReqRace', 'CR', 'SMM', 'UTC'], `${label}: fields`);
    check(`${label}: Wins is array[4]`, Array.isArray(data.Wins) && data.Wins.length === 4, `len=${data.Wins?.length}`);
    check(`${label}: Wins all numbers`, data.Wins?.every(v => typeof v === 'number'), `=${JSON.stringify(data.Wins)}`);
}

// ═══════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║   SUPERNOVA MOCK DATA VALIDATION                        ║');
console.log('╠══════════════════════════════════════════════════════════╣');
console.log('║   Verifying all mock JSONs match PS.json rules          ║');
console.log('╚══════════════════════════════════════════════════════════╝');

const mockDir = path.resolve(__dirname, 'mock');

// 1. Enter
const enterData = loadJson('mock/mock_enter.json');
if (enterData) validateEnter(enterData, 'mock_enter');

// 2. Spin Normal
const spinNormal = loadJson('mock/mock_spin_normal.json');
if (spinNormal) validateSpin(spinNormal, 'mock_spin_normal');

// 3. Spin No Win
const spinNoWin = loadJson('mock/mock_spin_no_win.json');
if (spinNoWin) validateSpin(spinNoWin, 'mock_spin_no_win');

// 4. Spin Trigger FreeSpin
const spinTrigger = loadJson('mock/mock_spin_trigger_free.json');
if (spinTrigger) validateSpin(spinTrigger, 'mock_spin_trigger_free', { expectedNextStage: 3, expectedScatter: true });

// 5. Spin FreeSpin (using FreeSpinReel)
const spinFS = loadJson('mock/mock_spin_freespin.json');
if (spinFS) validateSpin(spinFS, 'mock_spin_freespin', { isFreeSpin: true, expectedNextStage: 4 });

// 6. Spin FreeSpin End
const spinFSEnd = loadJson('mock/mock_spin_freespin_end.json');
if (spinFSEnd) validateSpin(spinFSEnd, 'mock_spin_freespin_end', { isFreeSpin: true, expectedNextStage: 101 });

// 7. Spin Re-trigger
const spinRetrigger = loadJson('mock/mock_spin_retrigger_free.json');
if (spinRetrigger) validateSpin(spinRetrigger, 'mock_spin_retrigger_free', { isFreeSpin: true, expectedNextStage: 5 });

// 8. Spin Jackpot (Grand)
const spinJP = loadJson('mock/mock_spin_jackpot.json');
if (spinJP) validateSpin(spinJP, 'mock_spin_jackpot', { expectedJackpotId: PS_GRAND_JACKPOT_ID });

// 9. Spin Big Win
const spinBig = loadJson('mock/mock_spin_big_win.json');
if (spinBig) validateSpin(spinBig, 'mock_spin_big_win');

// 10. Spin Multi-line
const spinMulti = loadJson('mock/mock_spin_multi_line.json');
if (spinMulti) validateSpin(spinMulti, 'mock_spin_multi_line');

// 11. Claim
const claimData = loadJson('mock/mock_claim.json');
if (claimData) validateClaim(claimData, 'mock_claim');

// 12. Jackpot
const jackpotData = loadJson('mock/mock_jackpot.json');
if (jackpotData) validateJackpot(jackpotData, 'mock_jackpot');

// ─── SUMMARY ───

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log(`║   RESULT: ${totalPass} PASSED, ${totalFail} FAILED${totalFail === 0 ? '  ✅ ALL GREEN!' : '  ⚠ FIX REQUIRED!'}          `);
console.log('╚══════════════════════════════════════════════════════════╝');

if (totalFail > 0) process.exit(1);
