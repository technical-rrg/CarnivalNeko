/**
 * NetworkManager - Abstraction layer cho network request.
 *
 * ★ USE_REAL_API = false → MockNetworkAdapter (offline dev/test)
 * ★ USE_REAL_API = true  → RealNetworkAdapter (MessagePack + AES server)
 *
 * Quy trình API (theo tài liệu):
 * 1. Login (ReqWebLinkLogin hoặc ReqTestLogin)
 *    → Nhận SessionKey, MemberIdx, Seq, Aky (AES-256 key)
 * 2. Enter → Nhận ParSheet, initial state
 * 3. Spin → Gửi BetIndex, CoinValueIndex, nhận SpinResponse
 * 4. Claim → Khi nextStage >= 100 (NEED_CLAIM)
 * 5. Jackpot → Poll mỗi 2 giây
 * 6. HeartBeat → Mỗi 10 giây giữ session
 *
 * SEQ Management:
 * - SeqRequest APIs (Enter, Spin, Claim): phải gửi đúng SEQ
 * - SEQ khởi đầu từ Login response
 * - Mỗi response thành công trả SEQ mới → dùng cho request tiếp theo
 * - Timeout → retry cùng SEQ tối đa 3 lần (server trả cached response)
 */

import {
    SpinResponse,
    MatchedLinePay,
    WaysPayWin,
    ServerSession,
    ServerEnterResponse,
    ServerSpinResponse,
    ServerClaimResponse,
    ServerPickResponse,
    ServerJackpotResponse,
    ServerMatchedLinePay,
    ServerMaintenanceMessage,
    SlotConfig,
    SlotStageType,
    SymbolId,
    FeatureItem,
    ServerFeatureItem,
    CashRaceMyRankGetFirstResponse,
    CashRaceMyRankGetPageResponse,
    NwCashRaceInfoDetail,
    NwCashRaceRankerSimple,
    ServerFeatureItemGetResponse,
    ServerFeatureItemBuyResponse,
    ServerBalanceGetResponse,
    TopupReelSlot,
    TopupReelType,
    PickGameState,
    PS_TO_CLIENT,
    JackpotType,
    SECRET_TREASURE_FREE_SPIN_TIERS,
    FREE_SPIN_TIER_REEL_INDICES,
    isFreeSpinTierReelIndex,
    StickyCell,
    TrailColor,
    ClaimResult,
    cnFreeSpinStripGroupStart,
    CarnivalFeatureKind,
} from '../data/SlotTypes';
import { buildCarnivalFeatureFromSpin } from '../data/CarnivalFeatureResolve';
import { parseCnStickyCells, parseCnStickyCredit, MATSURI_GOLD_SYMBOL, clampMatsuriRows, pickMatsuriStartCoinCells, MATSURI_SPIN_COUNT } from '../data/MatsuriGridUtil';
import { MockDataProvider, TestScenario } from '../data/MockDataProvider';
import {
    buildBuyBonusMatsuriTrigger,
    carnivalKindFromBuyBonusItemId,
    carnivalKindFromBuyBonusTitle,
    priceRatioForBuyBonusItemId,
    toFeatureItems,
} from '../data/BuyBonusCatalog';
import { WaysPayCalculator } from '../data/WaysPayCalculator';
import { GameData } from '../data/GameData';
import {
    clientPickToPs,
    clientSymToJackpotType,
    computeUpgradedJackpotValues,
    isPickUpgradeSymbol,
    psPickToClient,
    resolvePickState,
    JP_TYPE_TO_TIER_NAME,
    PICK_GAME_CELL_COUNT,
} from '../data/PickGameUtil';
import { buildCarnivalTrailsFromGrid } from '../data/CarnivalTrailParse';
import {
    USE_REAL_API,
    FORCE_NORMAL_SPIN_ONLY,
    ENABLE_DEBUG_TOOLS,
    ServerConfig,
    TestLoginConfig,
    MOCK_SPIN_SCENARIO,
    DEBUG_RANDS,
    MOCK_RESUME_SCENARIO,
    MOCK_PICK_GAME_MODE,
} from '../data/ServerConfig';
import {
    SCENARIO_NO_WIN, SCENARIO_NORMAL_WIN, SCENARIO_MULTI_LINE, SCENARIO_BIG_WIN,
    SCENARIO_LONG_SPIN, SCENARIO_JACKPOT, SCENARIO_PICK_GAME, FULL_FREE_RETRIGGER_SEQUENCE, DEFAULT_SEQUENCE,
    BUY_FREE_SPIN_SEQUENCE,
    MOCK_RESUME_NORMAL_SPIN, MOCK_RESUME_FREE_SPIN_MID, MOCK_RESUME_FREE_SPIN_NEED_CLAIM,
    MOCK_RESUME_FREE_SPIN_JACKPOT_MID, MOCK_RESUME_BUY_FREE_SPIN_MID, MOCK_RESUME_BUY_FREE_SPIN_NEED_CLAIM,
    MOCK_RESUME_TOPUP_MID, MOCK_RESUME_TOPUP_NEED_CLAIM, MOCK_RESUME_PICK_GAME,
    MOCK_RESUME_MATSURI_MID, MOCK_RESUME_MATSURI_START, MOCK_RESUME_MATSURI_NEED_CLAIM,
} from '../data/mock/MockScenariosData';
import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { DebugManager } from './DebugManager';
import { Packr, addExtension } from 'msgpackr';
import * as LZ4 from 'lz4js';
import {
    encryptAES128, decryptAES128,
    encryptAES256, decryptAES256,
    decryptGateGpAES,
    decryptPS,
} from '../core/CryptoUtils';
import { ResponseLogger } from '../core/ResponseLogger';
import { PopUpMessage, PopupCase } from '../core/PopUpMessage';
import { Log } from '../core/Logger';
import { LocalizationManager } from '../core/LocalizationManager';

/**
 * ServerApiError - Error được throw khi server trả về CODE != 0 hoặc network thất bại.
 * Flag alreadyHandled = true nghĩa là popup đã được emit từ NetworkManager.
 * Caller (GameManager) chỉ cần xử lý UI state mà không cần emit popup lại.
 */
export class ServerApiError extends Error {
    readonly serverCode: number;
    readonly alreadyHandled: boolean;
    constructor(message: string, serverCode: number, alreadyHandled: boolean = true) {
        super(message);
        this.name = 'ServerApiError';
        this.serverCode = serverCode;
        this.alreadyHandled = alreadyHandled;
    }
}

const _SPIN_LOG_EPS = 1e-6;

/** Server Payout là multiplier (× totalBet) hay tiền tuyệt đối. */
function _detectServerPayoutUnit(payouts: number[], totalBet: number, totalWin: number): 'mult' | 'money' | 'mixed' {
    if (payouts.length === 0 || totalWin <= 0) return 'money';
    const sum = payouts.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - totalWin) < _SPIN_LOG_EPS) return 'money';
    if (totalBet > 0 && Math.abs(sum * totalBet - totalWin) < _SPIN_LOG_EPS) return 'mult';
    if (payouts.length === 1 && totalBet > 0) {
        const p = payouts[0];
        if (Math.abs(p - totalWin) < _SPIN_LOG_EPS) return 'money';
        if (Math.abs(p * totalBet - totalWin) < _SPIN_LOG_EPS) return 'mult';
    }
    return 'mixed';
}

function _fmt4(n: number): string {
    return Number.isFinite(n) ? n.toFixed(4) : '?';
}

function _psToClientSymbol(psId: number): number {
    const dyn = GameData.instance.psToClientMap;
    if (dyn && dyn[psId] !== undefined) return dyn[psId];
    return PS_TO_CLIENT[psId] ?? -1;
}

/**
 * Neo Ways client 1-1 với MatchedLinePays server:
 *  - bỏ way thừa (client tính thêm symbol server không trả)
 *  - synthesize way thiếu (paytable client miss / server có line)
 *  - cắt số reel theo MatchedSymbolsCount
 *  - ghi payout bằng số tiền API (Payout có thể là multiplier)
 */
function _reconcileWaysWithServerLines(
    ways: WaysPayWin[],
    lines: MatchedLinePay[],
    grid: number[][],
    totalBet: number,
    totalWin: number,
    isFreeSpin: boolean,
): WaysPayWin[] {
    // Không có line từ server → không highlight ways tự tính (tránh vẽ thắng ảo / prize lệch).
    if (lines.length === 0) {
        if (ways.length > 0 || totalWin > 0) {
            Log.e(
                `[MULTI-LINE-WIN] RECONCILE no server lines — drop client ways=${ways.length}` +
                ` totalWin=${totalWin} (non-line win không highlight grid)`
            );
        }
        return [];
    }

    const unit = _detectServerPayoutUnit(lines.map(l => l.payout), totalBet, totalWin);
    for (const line of lines) {
        line.payout = unit === 'mult' ? line.payout * totalBet : line.payout;
    }

    const unused = ways.slice();
    const aligned: WaysPayWin[] = [];
    const applied: string[] = [];
    const dropped: string[] = [];

    for (const line of lines) {
        const psId = line.matchedSymbols?.[0];
        const clientId = (psId != null) ? _psToClientSymbol(psId) : -1;
        const reelCnt = line.matchedSymbolsCount ?? line.reelCnt ?? 0;

        let idx = unused.findIndex(w =>
            w.symbolId === clientId && (reelCnt <= 0 || w.reelCount === reelCnt));
        if (idx < 0 && clientId >= 0) {
            idx = unused.findIndex(w => w.symbolId === clientId);
        }

        let way: WaysPayWin | null = null;
        let source = 'client';
        if (idx >= 0) {
            way = unused.splice(idx, 1)[0];
            if (reelCnt > 0 && way.reelCount !== reelCnt) {
                way = WaysPayCalculator.limitReelCount(way, reelCnt);
                source = `client-trim→${way.reelCount}`;
            }
        } else if (clientId >= 0) {
            way = WaysPayCalculator.calculateOne(grid, clientId, totalBet, isFreeSpin, reelCnt > 0 ? reelCnt : undefined);
            source = way ? 'synth' : 'miss';
        }

        if (way) {
            way.payout = line.payout;
            aligned.push(way);
            applied.push(
                `ps${psId}→sym${way.symbolId} src=${source} reels=${way.reelCount}` +
                ` ways=${way.ways} payout=${_fmt4(line.payout)}`
            );
        } else {
            applied.push(`ps${psId} unmatched reelCnt=${reelCnt} payout=${_fmt4(line.payout)}`);
        }
    }

    for (const extra of unused) {
        dropped.push(`sym${extra.symbolId} reels=${extra.reelCount} ways=${extra.ways}`);
    }

    const sumWays = aligned.reduce((s, w) => s + (w.payout ?? 0), 0);
    const sumLines = lines.reduce((s, l) => s + (l.payout ?? 0), 0);
    const countOk = aligned.length === lines.length;
    Log.e(
        `[MULTI-LINE-WIN] RECONCILE serverLines=${lines.length} clientIn=${ways.length}` +
        ` out=${aligned.length} count=${countOk ? 'OK' : 'MISMATCH'} unit=${unit}` +
        ` totalWin=${totalWin} sumLines=${_fmt4(sumLines)} sumWays=${_fmt4(sumWays)}` +
        ` | ${applied.join(' | ')}` +
        (dropped.length > 0 ? ` | DROPPED extra ${dropped.join(' ')}` : '')
    );
    return aligned;
}

/** Log đầy đủ kết quả spin — tag [SPIN-RESULT] nằm trong Logger whitelist. */
function logSpinResultSummary(opts: {
    source: 'server' | 'mock';
    totalBet: number;
    totalWin: number;
    matchedLinePays: MatchedLinePay[];
    waysPayWins?: WaysPayWin[];
    featureMultiple?: number;
}): void {
    const { source, totalBet, totalWin, matchedLinePays, waysPayWins, featureMultiple } = opts;
    const lineWin = matchedLinePays.length;
    const winMult = totalBet > 0 ? totalWin / totalBet : 0;
    const perLineMult = lineWin > 0 ? winMult / lineWin : 0;
    const featMult = featureMultiple ?? 1;
    const rawPayouts = matchedLinePays.map(lp => lp.payout);
    const payoutUnit = _detectServerPayoutUnit(rawPayouts, totalBet, totalWin);

    const lineParts = matchedLinePays.map((lp, i) => {
        const psSym = lp.matchedSymbols?.[0] ?? '?';
        const match = lp.matchedSymbolsCount ?? (lp.reelCnt > 0 ? lp.reelCnt : '?');
        const asMult = payoutUnit === 'money'
            ? (totalBet > 0 ? lp.payout / totalBet : 0)
            : lp.payout;
        const asMoney = payoutUnit === 'money'
            ? lp.payout
            : lp.payout * totalBet;
        return (
            `L${i + 1}[payIdx=${lp.payLineIndex} psSym=${psSym} match=${match} reelCnt=${lp.reelCnt}` +
            ` payoutRaw=${lp.payout} serverMult=${_fmt4(asMult)} lineMoney=${_fmt4(asMoney)} wild=${lp.containsWild ? 1 : 0}]`
        );
    });

    const sumLineMoney = rawPayouts.reduce((s, p) => {
        return s + (payoutUnit === 'money' ? p : p * totalBet);
    }, 0);
    const sumLineMult = rawPayouts.reduce((s, p) => {
        return s + (payoutUnit === 'money' && totalBet > 0 ? p / totalBet : p);
    }, 0);
    const sumCheck = Math.abs(sumLineMoney - totalWin) < _SPIN_LOG_EPS ? 'OK' : 'MISMATCH';

    const ways = waysPayWins ?? [];
    const totalClientWays = ways.reduce((s, w) => s + w.ways, 0);
    const clientCalcWin = ways.reduce((s, w) => s + w.payout, 0);
    const clientCheck = totalWin > 0 && ways.length > 0
        ? (Math.abs(clientCalcWin - totalWin) < _SPIN_LOG_EPS ? 'OK' : 'MISMATCH')
        : (totalWin <= 0 && ways.length === 0 ? 'OK' : ways.length === 0 ? 'n/a' : 'MISMATCH');

    const waysParts = ways.map(w => {
        const symMult = (totalBet > 0 && w.ways > 0) ? w.payout / totalBet / w.ways : 0;
        return (
            `sym${w.symbolId} ways=${w.ways} reels=${w.reelCount}` +
            ` win=${_fmt4(w.payout)} symMult=${_fmt4(symMult)}`
        );
    });

    let msg =
        `[MULTI-LINE-WIN] SPIN-RESULT ${source} | lineCount=${lineWin} totalWin=${totalWin} totalBet=${totalBet}` +
        ` winMult=${_fmt4(winMult)} perLineMult=${_fmt4(perLineMult)} featureMult=${featMult}` +
        ` payoutUnit=${payoutUnit}`;

    if (lineParts.length > 0) msg += ` | server: ${lineParts.join(' ')}`;
    if (rawPayouts.length > 0) {
        msg += ` | sumLineMult=${_fmt4(sumLineMult)} sumLineMoney=${_fmt4(sumLineMoney)}` +
            ` vsTotalWin=${sumCheck}`;
    }
    if (waysParts.length > 0) {
        msg += ` | clientWays(total=${totalClientWays} calcWin=${_fmt4(clientCalcWin)} vsServer=${clientCheck}):` +
            ` ${waysParts.join(' ')}`;
    } else {
        msg += ` | clientWays: (none)`;
    }

    Log.e(msg);
}

// ─── MSGPACK: Packr tương thích C# MessagePack ───────────────────────────────
// useRecords: false    → tắt record extension (C# không dùng)
// bundleStrings: false → tắt string bundling extension
const _packr = new Packr({ useRecords: false, bundleStrings: false });

// ─── LZ4 decompressBlock: resolve đúng function cho cả Node.js & Cocos bundler ─
// lz4js dùng CommonJS → import * as LZ4 có thể cho { default: {...} } hoặc {...}
const _lz4 = (LZ4 as any).default ?? LZ4;
function _lz4DecompressBlock(src: Uint8Array, dst: Uint8Array): number {
    const fn: Function = _lz4.decompressBlock;
    if (typeof fn !== 'function') {
        throw new Error(`[LZ4] decompressBlock not found. Available keys: ${Object.keys(_lz4)}`);
    }
    return fn(src, dst, 0, src.length, 0);
}

// ─── Helper: dump hex (only used on errors) ─────────────────────────────────

/** Fallback jackpot multipliers dùng cho mock mode (API=false) hoặc khi PS.Symbols không có jackpot IDs. */
const DEFAULT_JACKPOT_MULTS = { GRAND: 500, MAJOR: 250, MINOR: 100, MINI: 25 };
function _hexDump(buf: Uint8Array, label: string, maxBytes = 64): void {
    const slice = buf.slice(0, maxBytes);
    const hex = Array.from(slice).map(b => (b < 16 ? '0' : '') + b.toString(16)).join(' ');
    Log.e(`[MsgPack] ${label} (${buf.byteLength} bytes): ${hex}${buf.byteLength > maxBytes ? ' ...' : ''}`);
}

function _normalizeJackpotValues(raw: any): number[] | null {
    if (!raw) return null;
    if (Array.isArray(raw)) {
        const vals = raw.slice(0, 4).map((v) => Number(v) || 0);
        return vals.some((v) => v > 0) ? vals : null;
    }

    const vals: number[] = [0, 0, 0, 0];
    const setValue = (idx: number | undefined, value: any): void => {
        if (idx == null || idx < 0 || idx > 3) return;
        const num = Number(value);
        if (Number.isFinite(num)) vals[idx] = num;
    };

    for (const key in raw) {
        const normalized = String(key).toLowerCase();
        let idx: number | undefined;
        if (normalized === '0' || normalized === 'mini' || normalized.includes('mini')) idx = 0;
        else if (normalized === '1' || normalized === 'minor' || normalized.includes('minor')) idx = 1;
        else if (normalized === '2' || normalized === 'major' || normalized.includes('major')) idx = 2;
        else if (normalized === '3' || normalized === 'grand' || normalized.includes('grand')) idx = 3;
        setValue(idx, raw[key]);
    }

    return vals.some((v) => v > 0) ? vals : null;
}

/** Lấy meter jackpot từ AckPick (After/Wins trên outer, Res, hoặc CNPickResponse). */
function _extractPickJackpotValues(outer: any, res: any, pickRes: any): number[] | null {
    const bags = [pickRes, res, outer];
    const fields = [
        'After', 'after',
        'JackpotAfter', 'jackpotAfter',
        'Wins', 'wins',
        'JackpotValues', 'jackpotValues',
        'Jackpot', 'jackpot',
        'UpgradedJackpot', 'upgradedJackpot',
    ];
    for (const bag of bags) {
        if (!bag || typeof bag !== 'object') continue;
        for (const field of fields) {
            const normalized = _normalizeJackpotValues(bag[field]);
            if (normalized) return normalized;
        }
        if (bag.GRAND != null || bag.Grand != null || bag.MINI != null || bag.Mini != null) {
            const named = _normalizeJackpotValues(bag);
            if (named) return named;
        }
    }
    return null;
}

// ─── Đăng ký LZ4BlockArray ext type -1 (0xFF) ── MessagePack-CSharp v2 ──────
// Format: [uncompressedLen: int32 LE][lz4BlockData...]
addExtension({
    type: -1,
    unpack(buffer: Uint8Array): any {
        const uncompressedLen =
            buffer[0] | (buffer[1] << 8) | (buffer[2] << 16) | (buffer[3] << 24);
        const compressed = buffer.slice(4);
        const decompressed = new Uint8Array(uncompressedLen);
        _lz4DecompressBlock(compressed, decompressed);
        return _packr.unpack(decompressed);
    },
    pack(_val: any): never {
        throw new Error('[LZ4] Client không cần compress request — server config issue');
    },
});

// ─── Đăng ký ext type 99 (0x63) — Lz4BlockArray wrapper (server response) ───
//
// Theo doc: "The server uses Lz4BlockArray with MessagePack serialization."
// Server gói toàn bộ response trong ext16(type=99).
//
// Format bên trong ext-99 (xác nhận từ hex dump thực tế):
//   [uncompressedLen: msgpack int32 (d2 XX XX XX XX = 5 bytes)]
//   [lz4CompressedData: remaining bytes]
//
// Sau khi LZ4 decompress → msgpack array = CCResponseCommonPacket
addExtension({
    type: 99,
    unpack(buffer: Uint8Array): any {
        if (buffer.byteLength < 5) {
            Log.e(`[MsgPack] ext99 too small (${buffer.byteLength})`);
            return null;
        }

        // ═══ Xác định uncompressedLen và offset bắt đầu LZ4 data ═══
        let uncompressedLen: number;
        let lz4DataOffset: number;
        const b0 = buffer[0];

        if (b0 === 0xd2) {
            // msgpack int32 BE: d2 + 4 bytes big-endian
            uncompressedLen = (buffer[1] << 24 | buffer[2] << 16 | buffer[3] << 8 | buffer[4]) | 0;
            if (uncompressedLen < 0) uncompressedLen = uncompressedLen >>> 0;
            lz4DataOffset = 5;
        } else if (b0 === 0xce) {
            // msgpack uint32 BE: ce + 4 bytes
            uncompressedLen = ((buffer[1] << 24) | (buffer[2] << 16) | (buffer[3] << 8) | buffer[4]) >>> 0;
            lz4DataOffset = 5;
        } else if (b0 === 0xcd) {
            // msgpack uint16 BE: cd + 2 bytes
            uncompressedLen = (buffer[1] << 8) | buffer[2];
            lz4DataOffset = 3;
        } else if (b0 === 0xd1) {
            // msgpack int16 BE: d1 + 2 bytes
            uncompressedLen = (buffer[1] << 8) | buffer[2];
            lz4DataOffset = 3;
        } else if (b0 === 0xcc) {
            // msgpack uint8: cc + 1 byte
            uncompressedLen = buffer[1];
            lz4DataOffset = 2;
        } else if (b0 <= 0x7f) {
            // msgpack positive fixint (0-127)
            uncompressedLen = b0;
            lz4DataOffset = 1;
        } else {
            // Fallback: raw 4 bytes LE (standard Lz4BlockArray)
            uncompressedLen = buffer[0] | (buffer[1] << 8) | (buffer[2] << 16) | (buffer[3] << 24);
            lz4DataOffset = 4;
        }

        // Sanity check
        if (uncompressedLen <= 0 || uncompressedLen > 10 * 1024 * 1024) {
            Log.e(`[MsgPack] ext99: invalid uncompressedLen=${uncompressedLen}`);
            try {
                return _packr.unpack(buffer);
            } catch (e: any) {
                Log.e(`[MsgPack] ext99 raw fallback failed: ${e.message}`);
                return null;
            }
        }

        // LZ4 decompress
        const compressed = buffer.slice(lz4DataOffset);
        try {
            const decompressed = new Uint8Array(uncompressedLen);
            _lz4DecompressBlock(compressed, decompressed);
            return _packr.unpack(decompressed);
        } catch (lz4Err: any) {
            Log.e(`[MsgPack] ext99 LZ4 FAILED: ${lz4Err.message}`);
            _hexDump(compressed, 'ext99 failed compressed', 64);
            return null;
        }
    },
    pack(_val: any): never {
        throw new Error('[Ext99] Pack not supported');
    },
});

// ─── Đăng ký ext type 100 (0x64) — C# DateTimeOffset ─────────────────────────
// MessagePack-CSharp NativeDateTimeOffsetFormatter: fixext12 = ticks (8B) + offset_min (4B)
addExtension({
    type: 100,
    unpack(_buffer: Uint8Array): any {
        return null; // DateTimeOffset — not used by client
    },
    pack(_val: any): never {
        throw new Error('[Ext100] Pack not supported');
    },
});

// ─── Đăng ký ext type 175 (0xAF) — PS footer/signature ───────────────────────
// Server append một ext-175 item sau PS msgpack data (checksum hoặc version marker).
// Không cần xử lý — chỉ cần ignore để unpackMultiple không throw.
addExtension({
    type: 175,
    unpack(_buffer: Uint8Array): any {
        return null; // PS trailer — ignored
    },
    pack(_val: any): never {
        throw new Error('[Ext175] Pack not supported');
    },
});

// ─── INTERFACE ───

export interface INetworkAdapter {
    /** Login (test hoặc weblink) */
    login(params?: any): Promise<ServerSession>;
    /** Enter slot game → nhận config + initial state */
    enterGame(): Promise<ServerEnterResponse>;
    /** Spin request */
    sendSpinRequest(isFreeSpin: boolean): Promise<SpinResponse>;
    /** Pick Game — gửi PickIndex khi người chơi bấm ô */
    sendPickRequest(pickIndex: number): Promise<ServerPickResponse>;
    /** Claim winnings (free spin kết thúc, pick game, etc.) */
    sendClaimRequest(): Promise<ClaimResult>;
    /** Poll jackpot values (mỗi 2 giây) */
    pollJackpot(): Promise<ServerJackpotResponse>;
    /** HeartBeat (mỗi 10 giây) */
    sendHeartBeat(): Promise<void>;
    /**
     * @deprecated CN API V1.0.2: GameOptChange chỉ hỗ trợ UseBroadcast (Opt=0).
     * Bet/Coin sync qua /Spin (BetIndex, CoinValueIndex) — method này no-op.
     */
    sendGameOptChange(betIndex: number, coinValueIndex: number): Promise<void>;
    /** Toggle server win broadcast reception on/off (GameOptChange Opt=0) */
    sendBroadcastOptionChange(enabled: boolean): Promise<void>;
    /** Lấy danh sách gói Feature (Buy Bonus) */
    sendFeatureItemGet(): Promise<FeatureItem[]>;
    /** Mua gói Feature (Buy Bonus) — onOff: true = activate, false = cancel (itemId=0) */
    sendFeatureItemBuy(itemId: number, onOff: boolean): Promise<{ isSuccess: boolean; remainCash: number; res: any | null }>;
    /** Refresh balance từ partner callback (dùng khi insufficient funds, e.g. top-up) */
    sendBalanceGet(): Promise<{ balance: number; currency: string }>;
    /** Lấy thông tin Cash Race + bảng xếp hạng */
    sendCashRaceMyRankGetFirst(): Promise<CashRaceMyRankGetFirstResponse | null>;
    /** Cash Race rank page (Top / pagination) — API V1.0.2 */
    sendCashRaceMyRankGetPage(pageItemCnt?: number, startRank?: number): Promise<CashRaceMyRankGetPageResponse | null>;
    /** Kết thúc session — POST /Auth/ReqLogout */
    sendLogout(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════
//  MOCK ADAPTER (offline dev/test — dùng MockScenariosData)
// ═══════════════════════════════════════════════════════════

class MockNetworkAdapter implements INetworkAdapter {

    /**
     * Queue spin responses theo kịch bản đang chọn.
     * Mỗi lần sendSpinRequest() gọi → lấy phần tử tiếp theo (vòng lặp).
     * Nếu queue rỗng (scenario = 'random') → dùng MockDataProvider ngẫu nhiên.
     */
    private _queue: SpinResponse[] = [];
    private _queueIdx: number = 0;
    /** Buy bonus queue — injected khi sendFeatureItemBuy thành công, ưu tiên hơn _queue */
    private _buyQueue: SpinResponse[] = [];
    private _buyQueueIdx: number = 0;
    /** Backup queue state để restore sau khi buy free spin kết thúc */

    private _finishMockSpin(resp: SpinResponse): SpinResponse {
        logSpinResultSummary({
            source: 'mock',
            totalBet: resp.totalBet,
            totalWin: resp.totalWin,
            matchedLinePays: resp.matchedLinePays ?? [],
            waysPayWins: resp.waysPayWins,
            featureMultiple: resp.featureMultiple,
        });
        return resp;
    }
    private _savedQueueIdx: number = 0;

    constructor() {
        this._buildQueue();
        // Khởi tạo jackpotValues cho mock mode — giả lập giá trị progressive jackpot pool
        // Thứ tự: [MINI, MINOR, MAJOR, GRAND] — khớp với SCENARIO_JACKPOT.totalWin = 25000 cho GRAND
        const data = GameData.instance;
        data.jackpotValues = [
            1250,     // MINI
            5000,     // MINOR
            12500,    // MAJOR
            25000,    // GRAND — khớp với SCENARIO_JACKPOT.totalWin
        ];
    }

    private _buildQueue(): void {
        switch (MOCK_SPIN_SCENARIO) {
            case 'no_win':              this._queue = [SCENARIO_NO_WIN];                 break;
            case 'normal_win':          this._queue = [SCENARIO_NORMAL_WIN];             break;
            case 'big_win':             this._queue = [SCENARIO_BIG_WIN];               break;
            case 'long_spin':           this._queue = [SCENARIO_LONG_SPIN];             break;
            case 'pot_win':             this._queue = [...FULL_FREE_RETRIGGER_SEQUENCE]; break;
            case 'grand_jackpot':       this._queue = [SCENARIO_JACKPOT];               break;
            case 'pick_game':           this._queue = [SCENARIO_PICK_GAME];             break;
            case 'sequence':            this._queue = [...DEFAULT_SEQUENCE];             break;
            default:                    this._queue = [];                                break; // 'random'
        }
        this._queueIdx = 0;
    }

    /**
     * Mock upgrade modes: 3 lần pick đầu (chưa armed) luôn lộ Upgrade,
     * kể cả khi người chơi bấm ô không phải 0–2 — hoán đổi symbol trên grid.
     */
    private _mockEnsureUpgradeOnFirstPicks(
        pickState: PickGameState,
        pickIndex: number,
        revealed: number[],
    ): void {
        if (pickState.upgradeArmed) return;
        const mode = MOCK_PICK_GAME_MODE;
        if (mode !== 'upgrade_to_major' && mode !== 'upgrade_grand_x2') return;
        if (revealed.length > 3) return;

        const grid = pickState.grid;
        if (!grid?.length || isPickUpgradeSymbol(grid[pickIndex] ?? -1)) return;

        for (let i = 0; i < grid.length; i++) {
            if (i === pickIndex || revealed.includes(i)) continue;
            if (!isPickUpgradeSymbol(grid[i])) continue;
            const tmp = grid[pickIndex];
            grid[pickIndex] = grid[i];
            grid[i] = tmp;
            Log.d(`[MockPick] first-pick assist: cell=${pickIndex} ← Upgrade (swap from ${i})`);
            return;
        }
    }

    async login(_params?: any): Promise<ServerSession> {
        // No artificial delay — keep mock boot fast
        await this._delay(0);

        // Mock: ưu tiên TestLoginConfig.Currency nếu dev set rõ ràng.
        // Fallback theo URL gl để test đúng ký hiệu tiền tệ cho từng ngôn ngữ; cuối cùng là USD.
        const gl = (typeof window !== 'undefined' && window.location)
            ? new window.URLSearchParams(window.location.search).get('gl') ?? ''
            : '';
        const mockCurrencyByLang: Record<string, string> = {
            'en': 'USD', 'ko': 'KRW', 'zh-cn': 'CNY', 'zh-tw': 'TWD',
            'fil': 'PHP', 'ja': 'JPY', 'th': 'THB', 'sg': 'SGD',
            'ms': 'MYR', 'vi': 'VND', 'au': 'AUD', 'hk': 'HKD',
        };
        const mockCurrency = TestLoginConfig.Currency ?? mockCurrencyByLang[gl.toLowerCase()] ?? 'USD';

        return {
            nick: 'MockPlayer',
            serverTime: new Date().toISOString(),
            clientIp: '127.0.0.1',
            sessionKey: 0n,
            sessionUpdateSec: 300,
            memberIdx: 0,
            seq: 100,
            uid: 'mock-uid',
            cash: GameData.instance.player.balance,
            aky: '',
            currency: mockCurrency,
            country: 'US',
            isNewAccount: false,
            useBroadcast: false,
            smm: null,
        };
    }

    async enterGame(): Promise<ServerEnterResponse> {
        await this._delay(0);

        // Giả lập lastSpinResponse theo MOCK_RESUME_SCENARIO để test resume logic
        let lastSpinResponse: any = null;
        switch (MOCK_RESUME_SCENARIO) {
            case 'normal_spin':             lastSpinResponse = MOCK_RESUME_NORMAL_SPIN;              break;
            case 'free_spin_mid':           lastSpinResponse = MOCK_RESUME_FREE_SPIN_MID;            break;
            case 'free_spin_need_claim':    lastSpinResponse = MOCK_RESUME_FREE_SPIN_NEED_CLAIM;     break;
            case 'free_spin_jackpot_mid':   lastSpinResponse = MOCK_RESUME_FREE_SPIN_JACKPOT_MID;   break;
            case 'buy_free_spin_mid':       lastSpinResponse = MOCK_RESUME_BUY_FREE_SPIN_MID;       break;
            case 'buy_free_spin_need_claim':lastSpinResponse = MOCK_RESUME_BUY_FREE_SPIN_NEED_CLAIM;break;
            case 'topup_mid':               lastSpinResponse = MOCK_RESUME_TOPUP_MID;               break;
            case 'topup_need_claim':        lastSpinResponse = MOCK_RESUME_TOPUP_NEED_CLAIM;        break;
            case 'pick_game':               lastSpinResponse = MOCK_RESUME_PICK_GAME;               break;
            case 'matsuri_mid':             lastSpinResponse = MOCK_RESUME_MATSURI_MID;             break;
            case 'matsuri_start':           lastSpinResponse = MOCK_RESUME_MATSURI_START;           break;
            case 'matsuri_need_claim':      lastSpinResponse = MOCK_RESUME_MATSURI_NEED_CLAIM;      break;
            default:                        lastSpinResponse = null;                                 break; // 'none'
        }
        if (lastSpinResponse) {
            Log.d(`[MockAdapter] Resume scenario: "${MOCK_RESUME_SCENARIO}" — NextStage=${lastSpinResponse.NextStage}, remain=${lastSpinResponse.RemainFreeSpinCount ?? lastSpinResponse.RemainFeatureSpinCount}, totalWin=${lastSpinResponse.FeatureSpinTotalWin}`);
        }

        const data = GameData.instance;
        data.isEntered = true;
        data.rawEnterLastSpinResponse = lastSpinResponse;

        return {
            cash: GameData.instance.player.balance,
            slotName: 'Carnival Neko',
            ps: '',
            betIndex: 0,
            coinValueIndex: 0,
            lastSpinResponse,
            isPractice: false,
            memberIdx: 0,
            smm: null,
        };
    }

    async sendSpinRequest(isFreeSpin: boolean): Promise<SpinResponse> {
        // ★ MOCK: Mạng ổn định, không delay — giá lập tức
        // Real API tự có latency, không cần thêm.
        const delay = 0.03;
        await this._delay(delay);

        // Buy free spin queue — luôn ưu tiên (kể cả khi isFreeSpin=true)
        if (this._buyQueue.length > 0 && this._buyQueueIdx < this._buyQueue.length) {
            const resp = this._buyQueue[this._buyQueueIdx];
            this._buyQueueIdx++;
            if (this._buyQueueIdx >= this._buyQueue.length) {
                this._buyQueue = [];
                this._buyQueueIdx = 0;
            }
            return this._finishMockSpin(resp);
        }

        // ★ KHI DANG FREE SPIN: luôn dùng generateSpinResponse để đảm bảo nextStage đúng
        // (FREE_SPIN/FREE_SPIN_END theo freeSpinRemaining hiện tại).
        // Queue từ MOCK_SPIN_SCENARIO có thể chứa nextStage=SPIN (no_win/normal_win/jackpot...)
        // → nếu dùng queue trong free spin sẽ gây thoát free spin mode sớm/sai.
        if (isFreeSpin) {
            return this._finishMockSpin(MockDataProvider.generateSpinResponse(true));
        }

        // ★ TopUp / Re-Spin: KHÔNG dùng queue — luôn generateRespin() để đảm bảo
        // nextStage=TOPUP_SPIN/TOPUP_SPIN_END đúng và stickyCells được tạo đúng.
        // Queue chứa NORMAL spin responses (nextStage=SPIN) sẽ làm TopUp freeze.
        if (GameData.instance.currentMode === 'respin' || GameData.instance.currentMode === 'matsuri') {
            return this._finishMockSpin(MockDataProvider.generateSpinResponse(false));
        }

        // Normal spin: dùng queue nếu có, fallback random
        // Bỏ qua các response dành cho free spin mid-state (FREESPIN_3/2/END còn sót trong queue
        // sau khi vừa kết thúc 1 chuỗi free spin — chúng dùng generateSpinResponse chứ không dùng queue)
        if (this._queue.length > 0) {
            for (let guard = 0; guard < this._queue.length; guard++) {
                const resp = this._queue[this._queueIdx % this._queue.length];
                this._queueIdx++;
                const isMidFreeSpin = resp.nextStage === SlotStageType.FREE_SPIN
                    || resp.nextStage === SlotStageType.FREE_SPIN_RE_TRIGGER
                    || resp.nextStage === SlotStageType.FREE_SPIN_END
                    || resp.nextStage === SlotStageType.BUY_FREE_SPIN_END;
                if (!isMidFreeSpin) return this._finishMockSpin(resp);
                Log.d(`[MockAdapter] Queue skip FS-mid entry (nextStage=${resp.nextStage}) → advance`);
            }
            // Tất cả entries đều là free spin mid → fallback random
        }

        // Fallback: tạo ngẫu nhiên (MOCK_SPIN_SCENARIO = 'random')
        return this._finishMockSpin(MockDataProvider.generateSpinResponse(false));
    }

    async sendPickRequest(pickIndex: number): Promise<ServerPickResponse> {
        await this._delay(80);
        const data = GameData.instance;
        let pickState = data.pickGameState ?? data.lastSpinResponse?.pickGame;

        // ★ Fallback: nếu chưa có PickGame state (resume hoặc init thiếu), build mock mới
        if (!pickState?.grid) {
            pickState = MockDataProvider.buildPickGame();
            data.pickGameState = pickState;
            if (data.lastSpinResponse) {
                (data.lastSpinResponse as any).pickGame = pickState;
            }
            Log.d(`[MockAdapter] sendPickRequest → built fresh PickGameState (grid len=${pickState.grid.length})`);
        }

        const revealed = (pickState.revealed ?? []).concat(pickIndex);
        pickState.revealed = revealed;

        this._mockEnsureUpgradeOnFirstPicks(pickState, pickIndex, revealed);

        const resolved = resolvePickState(pickState.grid, revealed, !!pickState.upgradeArmed);
        pickState.upgradeCount = resolved.upgradeCount;
        pickState.upgradeArmed = resolved.upgradeArmed;
        pickState.doubleGrand = resolved.doubleGrand;

        if (resolved.isJackpot) {
            pickState.wonTier = JP_TYPE_TO_TIER_NAME[resolved.paidTier];
        }

        // CN V1.0.2: Mini 10x / Minor 20x / Major 50x / Grand 300x (× TotalBet); GrandUpgrade ×2
        let winCash = 0;
        if (resolved.isJackpot) {
            const meter = data.getJackpotWinAmount(resolved.paidTier);
            const betFallback = (() => {
                const mult = data.config.jackpotMultipliers;
                const map: Partial<Record<JackpotType, number>> = {
                    [JackpotType.MINI]: mult?.MINI ?? 10,
                    [JackpotType.MINOR]: mult?.MINOR ?? 20,
                    [JackpotType.MAJOR]: mult?.MAJOR ?? 50,
                    [JackpotType.GRAND]: mult?.GRAND ?? 300,
                };
                return (map[resolved.paidTier] ?? 10) * data.totalBet;
            })();
            winCash = meter > 0 ? meter : betFallback;
        }

        // CNPickResponse: -1 = unselected; positive = revealed PS ID
        const pickGameIds: number[] = [];
        for (let i = 0; i < PICK_GAME_CELL_COUNT; i++) {
            pickGameIds.push(
                revealed.includes(i) ? clientPickToPs(pickState.grid[i] ?? 0) : -1,
            );
        }
        const pickResults = clientPickToPs(pickState.grid[pickIndex]);
        const jackpotName = resolved.isJackpot
            ? (JP_TYPE_TO_TIER_NAME[resolved.paidTier] ?? '')
            : '';

        Log.d(
            `[PickGame] PICK cell=${pickIndex} resultPsId=${pickResults}`
            + ` serverJackpot=${jackpotName || 'none'}`,
        );
        if (resolved.isJackpot) {
            const matchedCells: number[] = [];
            const matchedPsIds: number[] = [];
            for (const idx of revealed) {
                if (clientSymToJackpotType(pickState.grid[idx]) !== resolved.matchedTier) continue;
                matchedCells.push(idx);
                matchedPsIds.push(clientPickToPs(pickState.grid[idx]));
                if (matchedPsIds.length >= 3) break;
            }
            Log.d(
                `[PickGame] WIN matchedPsIds=[${matchedPsIds.join(',')}]`
                + ` cells=[${matchedCells.join(',')}]`
                + ` serverJackpot=${jackpotName}`
                + ` paidTier=${JackpotType[resolved.paidTier]}`
                + ` pickWin=${winCash}`,
            );
        }

        const jackpotAfter = resolved.upgradeJustCompleted
            ? computeUpgradedJackpotValues(data.jackpotValues)
            : undefined;
        if (jackpotAfter) {
            Log.d(`[PickGame] MOCK Upgrade×3 JackpotAfter=[${jackpotAfter.join(',')}]`);
        }

        return {
            PickGame: pickGameIds,
            PickResults: pickResults,
            PickStage: revealed.length,
            IsJackpot: false,
            JackpotIndex: -1,
            JackpotName: jackpotName || undefined,
            NextStage: resolved.isJackpot ? SlotStageType.PICK_END : SlotStageType.PICK,
            PickWin: winCash,
            UpgradeCount: resolved.upgradeCount,
            IsUpgradeComplete: resolved.upgradeJustCompleted,
            DoubleGrand: resolved.doubleGrand,
            JackpotAfter: jackpotAfter,
        };
    }

    async sendClaimRequest(): Promise<ClaimResult> {
        await this._delay(100);
        const data = GameData.instance;
        const winCash = (data.currentMode === 'respin' || data.currentMode === 'matsuri')
            ? data.respinTotalWin
            : (data.pickGameWinAmount > 0 ? data.pickGameWinAmount : data.freeSpinTotalWin);

        // Nếu freeSpinTotalWin được restore từ server (resume scenario), số đó đã bao gồm
        // toàn bộ tiền thắng trước khi tắt game. Chỉ cộng vào balance 1 lần ở đây.
        // _onFreeSpinEndPopupClosed sẽ KHÔNG add lại (vì flag = true).
        const newBalance = data.player.balance + winCash;

        // Ultra/Supreme/Ultimate: PICK_END Claim → FREE_SPIN_START (Pick → FS).
        // Mighty/Mega/Super / Red-only: Claim → SPIN.
        const inMatsuri = data.currentMode === 'matsuri';
        const pendingFs = data.pendingCarnivalMatsuri;
        const fsAfterPick = !inMatsuri && !!(
            pendingFs?.freeSpinAfterJackpot
            || data.lastSpinResponse?.carnivalFeature?.freeSpinAfterJackpot
        );

        let nextStage = SlotStageType.SPIN;
        let currentFeatureType: number | undefined;
        let featureRows: number | undefined;
        let starterCoins: StickyCell[] | undefined;
        let allStickies: StickyCell[] | undefined;
        let featureEntryJackpotWin: number | undefined;
        let featureEntryJackpotName: string | undefined;
        let remainFeatureSpinCount: number | undefined;

        if (fsAfterPick) {
            const feature = pendingFs ?? data.lastSpinResponse?.carnivalFeature;
            const rows = clampMatsuriRows(feature?.matsuriRows ?? 3);
            const startCount = feature?.startCoins ?? 6;
            const starter = pickMatsuriStartCoinCells(rows, startCount, data.totalBet);
            nextStage = SlotStageType.FREE_SPIN_START;
            currentFeatureType = feature
                ? feature.kind - CarnivalFeatureKind.MIGHTY
                : 3;
            featureRows = rows;
            starterCoins = starter;
            allStickies = starter;
            featureEntryJackpotWin = data.pickGameWinAmount;
            remainFeatureSpinCount = MATSURI_SPIN_COUNT;
        }

        // Reset buy queue + normal queue khi claim xong
        this._buyQueue = [];
        this._buyQueueIdx = 0;
        this._queueIdx = this._savedQueueIdx;
        Log.d(
            `[MockAdapter] Claim: winCash=${winCash}, newBalance=${newBalance}` +
            ` nextStage=${nextStage} fsAfterPick=${fsAfterPick} inMatsuri=${inMatsuri}` +
            ` wasRestoredFromServer=${data.freeSpinTotalWinRestoredFromServer}`,
        );
        return {
            balance: newBalance,
            winCash,
            claimTotalWin: winCash,
            topLevelWinCash: winCash,
            nextStage,
            currentFeatureType,
            featureRows,
            starterCoins,
            allStickies,
            featureEntryJackpotWin,
            featureEntryJackpotName,
            remainFeatureSpinCount,
        };
    }

    async pollJackpot(): Promise<ServerJackpotResponse> {
        await this._delay(100);
        const vals = GameData.instance.jackpotValues;
        return {
            Wins: vals,
            WinMsgs: [],
            ReqRace: false,
            CR: null,
            UTC: new Date().toISOString(),
        };
    }

    async sendHeartBeat(): Promise<void> {
        // Mock: no-op
    }

    async sendGameOptChange(_betIndex: number, _coinValueIndex: number): Promise<void> {
        // CN: bet sync qua Spin — no-op
    }

    async sendBroadcastOptionChange(_enabled: boolean): Promise<void> {
        // Mock: no-op
    }

    async sendFeatureItemGet(): Promise<FeatureItem[]> {
        await this._delay(200);
        // Carnival Neko: 3 gói Mighty / Mega / Super Feature
        const items = toFeatureItems();
        Log.d(`[MockAdapter] FeatureItemGet → ${items.length} items (Mighty/Mega/Super)`);
        return items;
    }

    async sendFeatureItemBuy(_itemId: number, _onOff: boolean = false): Promise<{ isSuccess: boolean; remainCash: number; res: any | null }> {
        await this._delay(300);

        // Activate (_onOff=true) hoặc Deactivate (_itemId=0): không trừ balance
        if (_onOff || _itemId === 0) {
            Log.d(`[MockAdapter] FeatureItemBuy (activate/deactivate): itemId=${_itemId}, onOff=${_onOff} → no balance change`);
            return { isSuccess: true, remainCash: GameData.instance.player.balance, res: null };
        }

        const data = GameData.instance;
        const totalBet = data.totalBet;
        const ratio = priceRatioForBuyBonusItemId(_itemId, 100);
        const cost = totalBet * ratio;
        const newBalance = data.player.balance - cost;
        if (newBalance < 0) {
            Log.d(`[MockAdapter] FeatureItemBuy FAILED: balance=${data.player.balance} < cost=${cost}`);
            return { isSuccess: false, remainCash: data.player.balance, res: null };
        }

        // Carnival Buy Bonus → Matsuri: không inject free-spin queue
        const matsuri = buildBuyBonusMatsuriTrigger(_itemId);
        if (matsuri) {
            Log.d(`[MockAdapter] FeatureItemBuy SUCCESS (Matsuri): itemId=${_itemId} ${matsuri.featureName} 5x${matsuri.matsuriRows} cost=${cost}`);
            return {
                isSuccess: true,
                remainCash: newBalance,
                res: {
                    CarnivalKind: matsuri.kind,
                    MatsuriRows: matsuri.matsuriRows,
                    FeatureName: matsuri.featureName,
                },
            };
        }

        // Legacy fallback: Free Spin buy
        this._savedQueueIdx = this._queueIdx;
        this._buyQueue = [...BUY_FREE_SPIN_SEQUENCE];
        this._buyQueueIdx = 0;
        Log.d(`[MockAdapter] FeatureItemBuy SUCCESS (FreeSpin): cost=${cost}, newBalance=${newBalance}, injected ${this._buyQueue.length} buy spins`);

        return {
            isSuccess: true,
            remainCash: newBalance,
            res: { RemainFreeSpinCount: 10 },
        };
    }

    async sendBalanceGet(): Promise<{ balance: number; currency: string }> {
        await this._delay(200);
        // Mock: trả về balance hiện tại (không mô phỏng top-up)
        return { balance: GameData.instance.player.balance, currency: 'USD' };
    }

    async sendCashRaceMyRankGetFirst(): Promise<CashRaceMyRankGetFirstResponse | null> {
        // Mock: dùng CashRaceMockAPI để tạo data (import lazy để tránh circular)
        // Trả về null để báo hiệu 'hãy dùng mock path riêng'
        return null;
    }

    async sendCashRaceMyRankGetPage(_pageItemCnt?: number, _startRank?: number): Promise<CashRaceMyRankGetPageResponse | null> {
        return null;
    }

    async sendLogout(): Promise<void> {
        // Mock: no-op
    }

    private _delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// ═══════════════════════════════════════════════════════════
//  REAL NETWORK ADAPTER (MessagePack + AES, theo tài liệu API)
// ═══════════════════════════════════════════════════════════

/**
 * RealNetworkAdapter - Gọi server API thật.
 *
 * ◆ Protocol: MessagePack Array Format
 * ◆ Encryption:
 *   - Login: AES-128 Base64 (fixed key)
 *   - Sau login: AES-256 (Aky từ login response)
 * ◆ SEQ management: auto-increment từ server response
 *
 * ⚠ CẦN CÀI THƯ VIỆN:
 *   npm install msgpackr crypto-js
 *
 * ⚠ BigInt: SessionKey & MemberIdx là Int64.
 *   JavaScript Number chỉ chính xác đến 53-bit.
 *   Nếu giá trị vượt Number.MAX_SAFE_INTEGER, cần dùng BigInt/string.
 */
/** PS named fields in Enter can be number or string (“82”). */
function toPsId(raw: any): number | null {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw.trim());
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

class RealNetworkAdapter implements INetworkAdapter {

    /** Khi true: hết retry → block toàn bộ request, chờ reload */
    private _isDead: boolean = false;

    /**
     * URL game server hiện tại — được ghi đè sau khi gọi Gate API (GetServiceInfo).
     * Mặc định là ServerConfig.SERVER_URL (dev server).
     * Sau khi login production: _serverUrl = GameServerUrl từ Gate response.
     */
    private _serverUrl: string = ServerConfig.SERVER_URL;

    /** Trả về full URL cho 1 endpoint, dùng _serverUrl runtime (hỗ trợ Gate-resolved URL) */
    private _getUrl(api: string): string {
        return this._serverUrl + ServerConfig.getEndpoint(api);
    }

    // ─── LOGIN ───

    async login(params?: any): Promise<ServerSession> {
        const data = GameData.instance;
        const gpFromParams = typeof params?.gp === 'string' ? params.gp : '';
        const gpToken = this._normalizeGpToken(gpFromParams || this._extractGpFromLocation());
        const isTestLogin = !gpToken; // Nếu không có gp token → test login

        Log.e(`[Gate] login() start | mode=${isTestLogin ? 'TEST_LOGIN(no gp)' : 'WEB_LINK'} | hasGp=${!!gpToken} | href=${this._getCurrentHref()}`);

        let apiPath: string;
        let requestData: any;

        if (isTestLogin) {
            // Test Login (dev)
            apiPath = ServerConfig.API.TEST_LOGIN;
            requestData = {
                PlatformId: TestLoginConfig.PlatformId,
                DeviceToken: TestLoginConfig.DeviceToken,
                IsPractice: TestLoginConfig.IsPractice,
                Currency: TestLoginConfig.Currency,
                PartnerId: TestLoginConfig.PartnerId,
            };
        } else {
            // WebLink Login (production)
            // ─── Step 0: Gọi Gate API để lấy GameServerUrl + GameParam ───
            // gp từ URL được decrypt → { GateUrl, Token }
            // Gọi GateUrl?gp=Token → { GameServerUrl, GameParam }
            // GameServerUrl ghi đè _serverUrl cho toàn bộ session.
            // GameParam là Params thực sự gửi lên ReqWebLinkLogin.
            const gateResult = await this._callGateServiceInfo(gpToken);
            this._serverUrl = gateResult.GameServerUrl;
            Log.e(`%c[Gate] SERVER URL resolved: ${ServerConfig.SERVER_URL} -> ${this._serverUrl}`, 'color:#0f0;font-weight:bold');

            apiPath = ServerConfig.API.WEB_LINK_LOGIN;
            requestData = {
                Params: gateResult.GameParam,
            };
        }

        // Login dùng AES-128 fixed key
        const encryptedData = this._encryptAES128(JSON.stringify(requestData));

        // Build common packet (login: MIDX=0, SKEY=0, SEQ=0)
        const packet = this._buildPacket(apiPath, 0, 0, 0, encryptedData);
        const responsePacket = await this._sendRequest(
            this._getUrl(apiPath),
            packet
        );

        // Parse response
        // Response format: [API, PACKET_TYPE, MIDX, SKEY, SEQ, CODE, MSG, CONT_YN, EncData]
        this._checkResponseCode(responsePacket);

        // Find the encrypted data field (longest string in packet)
        let encryptedField: string = '';
        for (let i = 5; i < (responsePacket?.length ?? 0); i++) {
            if (typeof responsePacket[i] === 'string' && (responsePacket[i] as string).length > 50) {
                encryptedField = responsePacket[i] as string;
                break;
            }
        }

        const sessionJson = this._decryptAES128(encryptedField);
        const raw = JSON.parse(sessionJson);

        // ★ QUAN TRỌNG: SessionKey là Int64 (>53 bit) — JSON.parse mất precision.
        // Lấy SessionKey và MemberIdx trực tiếp từ response packet header
        // (msgpackr decode thành BigInt chính xác).
        // responsePacket = [API, PACKET_TYPE, MIDX, SKEY, SEQ, CODE, MSG, CONT_YN, Data]
        const sessionKeyBigInt: bigint = typeof responsePacket[3] === 'bigint'
            ? responsePacket[3] as bigint
            : BigInt(Math.trunc(responsePacket[3] as number));
        const memberIdxFromPacket: number = Number(responsePacket[2]);

        const session: ServerSession = {
            nick: raw.Nick,
            serverTime: raw.ServerTime,
            clientIp: raw.ClientIp,
            sessionKey: sessionKeyBigInt,  // BigInt — chính xác từ packet header
            sessionUpdateSec: raw.SessionUpdateSec,
            memberIdx:  memberIdxFromPacket, // Lấy từ packet header (chính xác)
            seq: raw.Seq,
            uid: raw.UID,
            cash: raw.Cash ?? raw.SlotCash ?? raw.BC,
            aky: raw.Aky,
            currency: raw.Currency,
            country: raw.Country,
            isNewAccount: raw.IsNewAccount,
            useBroadcast: raw.UseBroadcast,
            isPractice: raw.IsPractice,
            smm: raw.SMM ? this._parseSMM(raw.SMM) : null,
        };

        // Lưu session
        data.setServerSession(session);

        // Tính clock offset: chênh lệch giữa đồng hồ server và client
        if (raw.ServerTime) {
            const serverMs = new Date(
                raw.ServerTime.endsWith('Z') || /[+\-]\d{2}:\d{2}$/.test(raw.ServerTime)
                    ? raw.ServerTime
                    : raw.ServerTime + 'Z'
            ).getTime();
            data.clockOffsetMs = serverMs - Date.now();
            Log.e('[CashRace][Clock] ServerTime=', raw.ServerTime,
                '| clockOffsetMs=', data.clockOffsetMs,
                '(', data.clockOffsetMs > 0 ? 'client chậm hơn server' : 'client nhanh hơn server', ')');
        }

        // Cập nhật SEQ từ response packet header [4]
        data.updateSeq(responsePacket[4]);

        // ═══ LOG RESPONSE ═══
        ResponseLogger.log('Login', raw, {
            packetHeader: {
                MIDX: responsePacket[2],
                SKEY: String(responsePacket[3]),
                SEQ: responsePacket[4],
                CODE: responsePacket[5],
            },
        });

        if (session.smm) {
            EventBus.instance.emit(GameEvents.SERVER_MAINTENANCE, session.smm);
        }

        return session;
    }

    // ─── ENTER GAME ───

    async enterGame(): Promise<ServerEnterResponse> {
        const data = GameData.instance;
        const session = data.serverSession!;

        const requestData = { SlotId: ServerConfig.SLOT_ID };
        const encrypted = this._encryptAES256(JSON.stringify(requestData), session.aky);

        const packet = this._buildPacket(
            ServerConfig.API.ENTER,
            session.memberIdx,
            session.sessionKey,
            data.currentSeq,
            encrypted
        );



        const responsePacket = await this._sendRequestWithRetry(
            this._getUrl(ServerConfig.API.ENTER),
            packet
        );

        this._checkResponseCode(responsePacket);
        data.updateSeq(responsePacket[4]);

        const decrypted = this._decryptAES256(responsePacket[8], session.aky);
        const raw = JSON.parse(decrypted);

        // ─── ENTER RAW DUMP ───
        {
            const rawKeys = Object.keys(raw);
            Log.d(
                `[Enter] keys=[${rawKeys.join(', ')}] Cash=${raw.Cash} BetIndex=${raw.BetIndex}` +
                ` PS=${raw.PS != null || raw.Ps != null || raw.ps != null ? 'yes' : 'no'}`
            );
        }

        const sanitizedLast = this._sanitizeLastSpinForNormalOnly(raw.LastSpinResponse ?? null);
        if (raw.LastSpinResponse) {
            raw.LastSpinResponse = sanitizedLast;
        }

        const enterResp: ServerEnterResponse = {
            cash: raw.Cash,
            slotName: raw.SlotName,
            ps: raw.PS,
            betIndex: raw.BetIndex,
            coinValueIndex: raw.CoinValueIndex,
            lastSpinResponse: sanitizedLast,
            isPractice: raw.IsPractice,
            memberIdx: raw.MemberIdx,
            smm: raw.SMM ? this._parseSMM(raw.SMM) : null,
        };

        data.isEntered = true;
        data.player.balance = enterResp.cash;
        data.player.betIndex = enterResp.betIndex;
        // Lưu raw lastSpinResponse để GameManager detect Free Spin resume.
        // Field names có thể là camelCase (stageType) theo API doc 5.1.
        data.rawEnterLastSpinResponse = sanitizedLast;

        // ─── SYNC POT + GAUGE từ Enter response ───
        const ls = raw.LastSpinResponse;
        const lsBody = ls?.Res && typeof ls.Res === 'object' ? ls.Res : ls;
        const enterPotVisualLevel = (raw as any).PotVisualLevel ?? lsBody?.PotVisualLevel;

        // Carnival Neko: 3 pot levels từ LastSpin / Enter root
        const enterBlue = lsBody?.BluePotLevel ?? (raw as any).BluePotLevel;
        const enterRed = lsBody?.RedPotLevel ?? (raw as any).RedPotLevel;
        const enterGreen = lsBody?.GreenPotLevel ?? (raw as any).GreenPotLevel;
        if (enterBlue != null || enterRed != null || enterGreen != null) {
            data.potLevels = {
                blue: Math.max(0, Math.min(10, Number(enterBlue ?? data.potLevels.blue ?? 0))),
                red: Math.max(0, Math.min(10, Number(enterRed ?? data.potLevels.red ?? 0))),
                green: Math.max(0, Math.min(10, Number(enterGreen ?? data.potLevels.green ?? 0))),
            };
            EventBus.instance.emit(GameEvents.CARNIVAL_POT_LEVELS_CHANGED, { ...data.potLevels });
        }

        if (enterPotVisualLevel != null) {
            data.potLevel = Math.max(0, Math.min(6, enterPotVisualLevel as number));
        }

        // ─── Giải nén PS (ParSheet) và áp dụng config ───
        let parsedPS: any = null;
        if (enterResp.ps) {
            parsedPS = this._decryptPS(enterResp.ps);
            this._applyPS(parsedPS);
        }

        // ═══ LOG RESPONSE — Enter + PS decoded (ResponseLogger no-op in production) ═══
        ResponseLogger.log('Enter', raw, {
            ps: parsedPS,
        });

        if (enterResp.smm) {
            EventBus.instance.emit(GameEvents.SERVER_MAINTENANCE, enterResp.smm);
        }

        return enterResp;
    }

    // ─── SPIN ───

    async sendSpinRequest(_isFreeSpin: boolean): Promise<SpinResponse> {
        const data = GameData.instance;
        const session = data.serverSession!;

        // 🎯 Lấy DEBUG_RANDS từ DebugManager (keyboard shortcut) hoặc dùng config default
        const debugRands = DebugManager.instance.getPendingDebugRands() ?? DEBUG_RANDS;

        // ReqSpin (API V1.0.2): BetIndex, BetLines, CoinValueIndex, DebugArray, SlotId
        const requestData = {
            BetIndex: data.player.betIndex,
            BetLines: 0,
            CoinValueIndex: data.config.coinValues.indexOf(data.player.coinValue),
            DebugArray: debugRands ?? [],
            SlotId: ServerConfig.SLOT_ID,
        };

        const encrypted = this._encryptAES256(JSON.stringify(requestData), session.aky);
        const packet = this._buildPacket(
            ServerConfig.API.SPIN,
            session.memberIdx,
            session.sessionKey,
            data.currentSeq,
            encrypted
        );

        const responsePacket = await this._sendRequestWithRetry(
            this._getUrl(ServerConfig.API.SPIN),
            packet
        );

        // SEQ trước check CODE (giống Pick/SelectFeature) — lỗi vẫn đồng bộ SEQ
        data.updateSeq(responsePacket[4]);
        this._checkResponseCode(responsePacket);

        let decrypted: string;
        let raw: ServerSpinResponse;
        try {
            decrypted = this._decryptAES256(responsePacket[8], session.aky);
        } catch (decryptErr: any) {
            Log.e(`[Network] ❌ Spin decrypt failed: ${decryptErr?.message}`, decryptErr);
            throw decryptErr;
        }
        try {
            raw = JSON.parse(decrypted);
        } catch (parseErr: any) {
            Log.e(`[Network] ❌ Spin JSON.parse failed: ${parseErr?.message} | decrypted(100B)="${decrypted.substring(0, 100)}"`);
            throw parseErr;
        }

        // Check SMM (PascalCase per doc)
        if (raw.SMM) {
            EventBus.instance.emit(GameEvents.SERVER_MAINTENANCE, raw.SMM);
        }

        // Update jackpot values from Before/After (PascalCase per AckSpin doc)
        // raw.Before = pool lúc bắt đầu spin (dùng làm prize khi trúng progressive)
        // raw.After  = { MINI: n, MINOR: n, MAJOR: n, GRAND: n } — meter sau spin
        const jackpotBefore = _normalizeJackpotValues(raw.Before);
        if (jackpotBefore) {
            data.jackpotValuesBefore = jackpotBefore;
        }

        const jackpotAfter = _normalizeJackpotValues(raw.After);
        if (jackpotAfter) {
            data.jackpotValues = jackpotAfter;
            EventBus.instance.emit(GameEvents.JACKPOT_VALUES_UPDATED, jackpotAfter);
        }

        // Convert server format → internal SpinResponse
        let result: SpinResponse;
        try {
            result = this._convertSpinResponse(raw);
        } catch (convertErr: any) {
            Log.e(`[Network] ❌ _convertSpinResponse failed: ${convertErr?.message} | raw.Res keys=${Object.keys(raw?.Res ?? {}).join(',')}`, convertErr);
            throw convertErr;
        }

        const res = raw.Res;
        logSpinResultSummary({
            source: 'server',
            totalBet: res.TotalBet ?? result.totalBet,
            totalWin: res.TotalWin ?? result.totalWin,
            matchedLinePays: result.matchedLinePays ?? [],
            waysPayWins: result.waysPayWins,
            featureMultiple: result.featureMultiple,
        });

        return result;
    }

    // ─── CLAIM ───

    async sendPickRequest(pickIndex: number): Promise<ServerPickResponse> {
        const data = GameData.instance;
        const session = data.serverSession!;
        const requestData = { PickIndex: pickIndex, SlotId: ServerConfig.SLOT_ID };
        Log.d(`[PickGame] SEND cell=${pickIndex}`);
        const encrypted = this._encryptAES256(JSON.stringify(requestData), session.aky);
        const packet = this._buildPacket(
            ServerConfig.API.PICK,
            session.memberIdx,
            session.sessionKey,
            data.currentSeq,
            encrypted
        );
        const responsePacket = await this._sendRequestWithRetry(
            this._getUrl(ServerConfig.API.PICK),
            packet
        );
        data.updateSeq(responsePacket[4]);
        this._checkResponseCode(responsePacket);
        const decrypted = this._decryptAES256(responsePacket[8], session.aky);
        const outer: any = JSON.parse(decrypted);
        // Server can return either {RemainCash, Res: GFPickResponse}
        // or {RemainCash, Res: {GFPickResponse}} depending on backend version.
        const res = outer.Res ?? outer;
        const pickRes = res.CNPickResponse ?? res.cNPickResponse
            ?? res.GFPickResponse ?? res.gFPickResponse
            ?? res.PickResponse ?? res;
        const raw: ServerPickResponse = {
            ...pickRes,
            PickGame: pickRes.PickGame ?? pickRes.pickGame ?? [],
            PickResults: pickRes.PickResults ?? pickRes.pickResults,
            PickStage: pickRes.PickStage ?? pickRes.pickStage,
            PickWin: pickRes.PickWin ?? pickRes.pickWin ?? pickRes.WinCash ?? pickRes.winCash ?? 0,
            IsJackpot: pickRes.IsJackpot ?? pickRes.isJackpot ?? false,
            JackpotIndex: pickRes.JackpotIndex ?? pickRes.jackpotIndex ?? -1,
            JackpotName: pickRes.JackpotName ?? pickRes.jackpotName,
            NextStage: pickRes.NextStage ?? pickRes.nextStage ?? 0,
            UpgradeCount: pickRes.UpgradeCount ?? pickRes.upgradeCount,
            IsUpgradeComplete: pickRes.IsUpgradeComplete ?? pickRes.isUpgradeComplete,
            DoubleGrand: pickRes.DoubleGrand ?? pickRes.doubleGrand,
            JackpotAfter: _extractPickJackpotValues(outer, res, pickRes) ?? undefined,
        };
        const pickGameRaw = Array.isArray(raw.PickGame) ? raw.PickGame : [];
        const revealedRaw = pickGameRaw
            .map((id, i) => ({ i, id }))
            .filter(x => x.id != null && Number(x.id) !== -1)
            .map(x => `${x.i}=${x.id}`)
            .join(',') || 'none';
        const cellFromGrid = pickGameRaw[pickIndex];
        const pickResultsType = raw.PickResults == null ? 'null' : typeof raw.PickResults;
        Log.d(
            `[PickGame] ACK RAW cell=${pickIndex}`
            + ` PickResults=${JSON.stringify(raw.PickResults)} (${pickResultsType})`
            + ` PickGame[cell]=${cellFromGrid ?? 'n/a'}`
            + ` JackpotName=${JSON.stringify(raw.JackpotName ?? '')}`
            + ` PickWin=${raw.PickWin ?? 0} NextStage=${raw.NextStage}`
            + ` PickStage=${raw.PickStage ?? '?'}`,
        );
        Log.d(`[PickGame] ACK RAW PickGame[15]=${JSON.stringify(pickGameRaw)}`);
        Log.d(`[PickGame] ACK RAW revealed=${revealedRaw}`);
        const outerKeys = outer && typeof outer === 'object' ? Object.keys(outer).join(',') : '';
        const resKeys = res && typeof res === 'object' ? Object.keys(res).join(',') : '';
        const pickKeys = pickRes && typeof pickRes === 'object' ? Object.keys(pickRes).join(',') : '';
        Log.d(
            `[PickGame] ACK jackpot After=${raw.JackpotAfter ? `[${raw.JackpotAfter.join(',')}]` : 'none'}`
            + ` IsUpgradeComplete=${raw.IsUpgradeComplete ?? false}`
            + ` keys(outer)=${outerKeys} keys(res)=${resKeys} keys(pick)=${pickKeys}`,
        );
        ResponseLogger.log('Pick', raw);
        return raw;
    }

    async sendClaimRequest(): Promise<ClaimResult> {
        const data = GameData.instance;
        const session = data.serverSession!;

        // Claim "Request Body: None" per doc — encrypt empty JSON object
        const encrypted = this._encryptAES256('{}', session.aky);

        const packet = this._buildPacket(
            ServerConfig.API.CLAIM,
            session.memberIdx,
            session.sessionKey,
            data.currentSeq,
            encrypted
        );

        const responsePacket = await this._sendRequestWithRetry(
            this._getUrl(ServerConfig.API.CLAIM),
            packet
        );

        data.updateSeq(responsePacket[4]);
        this._checkResponseCode(responsePacket);

        const decrypted = this._decryptAES256(responsePacket[8], session.aky);
        const raw: ServerClaimResponse = JSON.parse(decrypted);

        ResponseLogger.log('Claim', raw);

        const claimResponse = (raw as any).CNClaimResponse
            ?? (raw as any).ClaimResponse
            ?? (raw as any).claimResponse
            ?? (raw as any).Res
            ?? {};
        const claimWinGrade: string | undefined = claimResponse.WinGrade ?? claimResponse.winGrade ?? undefined;
        const claimTotalWin = this._toFiniteNumber(
            claimResponse.TotalWin ?? claimResponse.totalWin,
        );
        const claimFeatureSpinTotal = this._toFiniteNumber(
            claimResponse.FeatureSpinTotalWin ?? claimResponse.featureSpinTotalWin
            ?? (raw as any).FeatureSpinTotalWin ?? (raw as any).featureSpinTotalWin,
        );
        const topLevelWinCash = this._toFiniteNumber(
            (raw as any).WinCash ?? (raw as any).winCash,
        );
        const cash = (raw as any).Cash ?? (raw as any).cash ?? (raw as any).Balance ?? (raw as any).balance;
        // CNClaimResponse.TotalWin = số trả thưởng chính thức (API §5.5).
        const winCash = claimTotalWin ?? claimFeatureSpinTotal ?? topLevelWinCash;
        const featureName = claimResponse.FeatureName ?? claimResponse.featureName;
        // JackpotName chỉ meaningful khi claim PICK_END (API V1.0.2)
        const jackpotName = claimResponse.JackpotName ?? claimResponse.jackpotName;
        const startRands = claimResponse.StartRands ?? claimResponse.startRands;
        const nextStage = claimResponse.NextStage ?? claimResponse.nextStage ?? SlotStageType.SPIN;
        const pickGame = this._parsePickGame(
            claimResponse.PickGame ?? claimResponse.pickGame ?? claimResponse.PickGameState,
        );

        const currentFeatureTypeRaw = claimResponse.CurrentFeatureType ?? claimResponse.currentFeatureType
            ?? (raw as any).CurrentFeatureType ?? (raw as any).currentFeatureType;
        const currentFeatureType = currentFeatureTypeRaw != null ? Number(currentFeatureTypeRaw) : undefined;
        const featureRowsRaw = claimResponse.FeatureRows ?? claimResponse.featureRows
            ?? (raw as any).FeatureRows ?? (raw as any).featureRows;
        const featureRows = featureRowsRaw != null ? clampMatsuriRows(Number(featureRowsRaw)) : undefined;
        const rows = featureRows ?? 3;
        const starterCoins = parseCnStickyCells(
            claimResponse.StarterCoins ?? claimResponse.starterCoins ?? (raw as any).StarterCoins,
            rows,
            MATSURI_GOLD_SYMBOL,
            data.totalBet,
        );
        const allStickies = parseCnStickyCells(
            claimResponse.AllStickies ?? claimResponse.allStickies ?? (raw as any).AllStickies,
            rows,
            MATSURI_GOLD_SYMBOL,
            data.totalBet,
        );
        const entryJpRaw = claimResponse.FeatureEntryJackpotWin ?? claimResponse.featureEntryJackpotWin
            ?? (raw as any).FeatureEntryJackpotWin ?? (raw as any).featureEntryJackpotWin;
        const featureEntryJackpotWin = entryJpRaw != null ? Number(entryJpRaw) : undefined;
        const featureEntryJackpotName = claimResponse.FeatureEntryJackpotName
            ?? claimResponse.featureEntryJackpotName
            ?? (raw as any).FeatureEntryJackpotName ?? (raw as any).featureEntryJackpotName;
        const remainRaw = claimResponse.RemainFeatureSpinCount ?? claimResponse.remainFeatureSpinCount
            ?? (raw as any).RemainFeatureSpinCount ?? (raw as any).remainFeatureSpinCount;
        const remainFeatureSpinCount = remainRaw != null ? this._toFiniteNumber(remainRaw) : undefined;

        if (jackpotName) {
            Log.d(
                `[Jackpot] CLAIM serverJackpot=${jackpotName}`
                + ` winCash=${winCash ?? 'n/a'} nextStage=${nextStage}`,
            );
        }
        Log.d(
            `[Claim] nextStage=${nextStage} type=${currentFeatureType ?? 'n/a'} rows=${featureRows ?? 'n/a'}`
            + ` starter=${starterCoins.length} all=${allStickies.length}`
            + ` entryJp=${featureEntryJackpotWin ?? 0} entryName=${featureEntryJackpotName ?? ''}`,
        );
        return {
            balance: cash,
            winCash,
            winGrade: claimWinGrade,
            claimTotalWin,
            claimFeatureSpinTotalWin: claimFeatureSpinTotal,
            topLevelWinCash,
            featureName,
            jackpotName,
            startRands: Array.isArray(startRands) ? startRands : undefined,
            nextStage: Number(nextStage),
            pickGame,
            currentFeatureType: currentFeatureType != null && Number.isFinite(currentFeatureType)
                ? currentFeatureType : undefined,
            featureRows,
            starterCoins: starterCoins.length ? starterCoins : undefined,
            allStickies: allStickies.length ? allStickies : undefined,
            featureEntryJackpotWin: featureEntryJackpotWin != null && Number.isFinite(featureEntryJackpotWin)
                ? featureEntryJackpotWin : undefined,
            featureEntryJackpotName: featureEntryJackpotName != null ? String(featureEntryJackpotName) : undefined,
            remainFeatureSpinCount,
        };
    }

    // ─── JACKPOT POLLING ───

    async pollJackpot(): Promise<ServerJackpotResponse> {
        const data = GameData.instance;
        const session = data.serverSession!;

        const requestData = {
            BetIndex: data.player.betIndex,
            BetLines: 0,
            CoinIndex: data.config.coinValues.indexOf(data.player.coinValue),
            SlotId: ServerConfig.SLOT_ID,
            ReqRace: true,
            LastWinMsgId: data.lastWinMsgId,
        };

        const encrypted = this._encryptAES256(JSON.stringify(requestData), session.aky);
        const packet = this._buildPacket(
            ServerConfig.API.JACKPOT,
            session.memberIdx,
            session.sessionKey,
            data.currentSeq,
            encrypted
        );

        // Jackpot là NormalRequest → không cần retry logic SEQ
        const responsePacket = await this._sendRequest(
            this._getUrl(ServerConfig.API.JACKPOT),
            packet
        );

        // ⚠ Jackpot là polling NormalRequest — KHÔNG dùng _checkResponseCode vì nó emit
        // SHOW_SYSTEM_POPUP (DISCONNECTED) trước khi throw, gây popup giả khi poll thất bại.
        // Xử lý lỗi thủ công: chỉ throw, không emit popup.
        const _jackpotCode = responsePacket[5] as number;
        if (_jackpotCode !== 0) {
            const _jackpotMsg = (responsePacket[6] as string) || '';
            Log.w(`[Jackpot Poll] Server error code=${_jackpotCode} msg="${_jackpotMsg}" — skipping poll`);
            throw new ServerApiError(`Server error [${_jackpotCode}]: ${_jackpotMsg}`, _jackpotCode, false);
        }

        const decrypted = this._decryptAES256(responsePacket[8], session.aky);
        // ⚠️ WinMsgs[].Seq là số 19 chữ số — vượt Number.MAX_SAFE_INTEGER.
        // JSON.parse() của JS sẽ làm tròn số này trước khi ta có thể lưu,
        // dẫn đến LastWinMsgId gửi lên server sai → server cứ gửi lại mãi.
        // Fix: dùng regex để quote Seq thành string TRƯỚC khi JSON.parse chạy.
        const sanitizedDecrypted = decrypted.replace(/"Seq"\s*:\s*(\d{10,})/g, '"Seq":"$1"');
        const raw: ServerJackpotResponse = JSON.parse(sanitizedDecrypted);

        // Update jackpot values — Wins is number[] array: [mini, minor, major, grand]
        if (raw.Wins && Array.isArray(raw.Wins) && raw.Wins.length > 0) {
            if (data.holdJackpotValues) {
                Log.d('[Jackpot] Poll skip — holdJackpotValues (Pick upgrade applied)');
            } else {
                const prev = data.jackpotValues?.slice?.() ?? [];
                const changed = raw.Wins.some((v, i) => v !== prev[i]);
                data.jackpotValues = raw.Wins;
                if (changed) {
                    Log.e(`[Jackpot] Poll Wins changed [${prev.join(',')}] → [${raw.Wins.join(',')}]`);
                }
                EventBus.instance.emit(GameEvents.JACKPOT_VALUES_UPDATED, raw.Wins);
            }
        }

        // Update last win msg ID
        if (raw.WinMsgs && raw.WinMsgs.length > 0) {
            Log.d(`[Broadcast] Server trả ${raw.WinMsgs.length} msg(s) | LastWinMsgId: ${data.lastWinMsgId}`);
            for (const msg of raw.WinMsgs) {
                Log.d(`[Broadcast] ← Seq=${msg.Seq} Nick="${msg.DisplayName || msg.Nick}" Slot="${msg.Slot}" Feature="${msg.Feature}" MX=${msg.MX}`);
                EventBus.instance.emit(GameEvents.BROADCAST_WIN_MESSAGE, msg);
            }
            const lastMsg = raw.WinMsgs[raw.WinMsgs.length - 1];
            data.lastWinMsgId = String(lastMsg.Seq);
        }

        // Emit Cash Race CR update — always emit, even when CR=null.
        // When CR=null (race ended / user never participated), the widget
        // must know so it can hide itself and stop calling CashRaceMyRankGetFirst.
        // CashRace đi kèm response Jackpot poll (field CR) — không log mỗi lần poll.
        EventBus.instance.emit(GameEvents.CASH_RACE_CR_UPDATED, raw.CR ?? null);

        if (raw.SMM) {
            EventBus.instance.emit(GameEvents.SERVER_MAINTENANCE, raw.SMM);
        }

        // ═══ LOG RESPONSE (only first poll) ═══
        if (ResponseLogger.all.filter(e => e.api === 'Jackpot').length < 2) {
            ResponseLogger.log('Jackpot', raw);
        }

        return raw;
    }

    // ─── GAME OPT CHANGE ───

    /**
     * CN API V1.0.2 §8.6: GameOptChange chỉ có Opt=0 (UseBroadcast).
     * Bet/CoinValue sync qua /Spin — không gọi API giả Opt/NewVal=0 (sẽ tắt broadcast).
     */
    async sendGameOptChange(betIndex: number, coinValueIndex: number): Promise<void> {
        Log.d(
            `[GameOptChange] skipped — CN bet sync via Spin ` +
            `(betIndex=${betIndex} coinIndex=${coinValueIndex}). Use sendBroadcastOptionChange for Opt=0.`,
        );
    }

    async sendBroadcastOptionChange(enabled: boolean): Promise<void> {
        const data = GameData.instance;
        const session = data.serverSession!;

        const requestData = {
            SlotId: ServerConfig.SLOT_ID,
            Opt: 0,
            NewVal: enabled ? 1 : 0,
        };

        const encrypted = this._encryptAES256(JSON.stringify(requestData), session.aky);
        const packet = this._buildPacket(
            ServerConfig.API.GAME_OPT_CHANGE,
            session.memberIdx,
            session.sessionKey,
            data.currentSeq,
            encrypted
        );

        const responsePacket = await this._sendRequest(
            this._getUrl(ServerConfig.API.GAME_OPT_CHANGE),
            packet
        );
        this._checkResponseCode(responsePacket);

        Log.d(`[Broadcast] Server UseBroadcast=${enabled ? 1 : 0}`);
    }

    // ─── FEATURE ITEM GET (Buy Bonus) ───

    async sendFeatureItemGet(): Promise<FeatureItem[]> {
        const data = GameData.instance;
        const session = data.serverSession!;

        // Doc: ReqFeatureItemGet — SlotId + LangID theo API guide section 4.8
        const requestData = {
            SlotId: ServerConfig.SLOT_ID,
            LangID: this._getLangId(),
        };

        Log.d(`[BuyBonus] FeatureItemGet REQUEST body: ${JSON.stringify(requestData)}`);
        Log.d(`[BuyBonus] FeatureItemGet ENDPOINT: ${this._getUrl(ServerConfig.API.FEATURE_ITEM_GET)}`);

        const encrypted = this._encryptAES256(JSON.stringify(requestData), session.aky);
        const packet = this._buildPacket(
            ServerConfig.API.FEATURE_ITEM_GET,
            session.memberIdx,
            session.sessionKey,
            data.currentSeq,
            encrypted
        );

        const responsePacket = await this._sendRequest(
            this._getUrl(ServerConfig.API.FEATURE_ITEM_GET),
            packet
        );

        this._checkResponseCode(responsePacket);

        const decrypted = this._decryptAES256(responsePacket[8], session.aky);
        const raw: ServerFeatureItemGetResponse = JSON.parse(decrypted);

        Log.d(`[BuyBonus] FeatureItemGet RESPONSE raw: ${JSON.stringify(raw)}`);

        ResponseLogger.log('FeatureItemGet', raw);

        const items: ServerFeatureItem[] = raw.Items ?? [];
        if (items.length === 0) {
            Log.w('[BuyBonus] Server trả về Items rỗng — slot chưa được cấu hình Buy Bonus');
        }

        // Map PascalCase server fields → camelCase FeatureItem
        return items.map((item: ServerFeatureItem) => {
            const title = item.Title || item.Name;
            return {
                itemId:       item.Id,
                name:         item.Name,
                title,
                desc:         item.Desc || '',
                priceRatio:   item.PriceRatio,
                effectType:   item.EffectType,
                imgUrl:       item.ImgUrl || '',
                addSpinValue: item.AddSpinValue ?? undefined,
                carnivalKind: carnivalKindFromBuyBonusItemId(item.Id)
                    ?? carnivalKindFromBuyBonusTitle(title)
                    ?? undefined,
            };
        });
    }

    // ─── FEATURE ITEM BUY (Buy Bonus) ───

    async sendFeatureItemBuy(itemId: number, onOff: boolean = false): Promise<{ isSuccess: boolean; remainCash: number; res: any | null }> {
        const data = GameData.instance;
        const session = data.serverSession!;

        const requestData = {
            SlotId: ServerConfig.SLOT_ID,
            LangID: this._getLangId(),
            ItemId: itemId,
            BetIndex: data.player.betIndex,
            BetLines: 0,
            CoinValueIndex: data.config.coinValues.indexOf(data.player.coinValue),
            OnOff: onOff,
        };

        Log.e(
            `%c[FeatureItemBuy REQ] ItemId=${itemId} | OnOff=${onOff} | BetIndex=${requestData.BetIndex} | CoinValueIndex=${requestData.CoinValueIndex} | totalBet=${data.totalBet}`,
            'color:#ff0;font-weight:bold'
        );

        const encrypted = this._encryptAES256(JSON.stringify(requestData), session.aky);
        const packet = this._buildPacket(
            ServerConfig.API.FEATURE_ITEM_BUY,
            session.memberIdx,
            session.sessionKey,
            data.currentSeq,
            encrypted
        );

        const responsePacket = await this._sendRequestWithRetry(
            this._getUrl(ServerConfig.API.FEATURE_ITEM_BUY),
            packet
        );

        this._checkResponseCode(responsePacket);
        data.updateSeq(responsePacket[4]);

        const decrypted = this._decryptAES256(responsePacket[8], session.aky);
        const raw: ServerFeatureItemBuyResponse = JSON.parse(decrypted);

        // Log.e(
        //     `%c[FeatureItemBuy RES] IsSuccess=${raw.IsSuccess} | RemainCash=${raw.RemainCash} | Res=${JSON.stringify(raw.Res ?? null)}` +
        //     ` | ExReel type=${typeof raw.ExReel} value=${raw.ExReel ? (typeof raw.ExReel === 'string' ? raw.ExReel.substring(0, 100) + '...' : JSON.stringify(raw.ExReel).substring(0, 500)) : 'null/undefined'}`,
        //     'color:#0f0;font-weight:bold'
        // );
        // ═══ EXREEL DEBUG — kiểm tra server có trả ExReel không ═══
        // ExReel theo API doc là "AES encrypted field" — cần decrypt giống PS
        if (raw.ExReel != null) {
            let exReelData: any = raw.ExReel;

            // Nếu ExReel là string (encrypted), decrypt nó
            if (typeof raw.ExReel === 'string' && raw.ExReel.length > 0) {
                try {
                    const decryptedExReel = this._decryptPS(raw.ExReel);
                    // Log.e(
                    //     `%c[EXREEL DECRYPTED!] ExReel decrypted thành công!` +
                    //     `\n  Type: ${typeof decryptedExReel}` +
                    //     `\n  Keys: ${decryptedExReel && typeof decryptedExReel === 'object' ? JSON.stringify(Object.keys(decryptedExReel)) : 'N/A'}` +
                    //     `\n  Sample: ${JSON.stringify(decryptedExReel).substring(0, 500)}`,
                    //     'color:#ff0;font-weight:bold;font-size:12px'
                    // );
                    exReelData = decryptedExReel;
                } catch (err: any) {
                    Log.e(`[EXREEL] Decrypt failed (trying as plain): ${err.message}`);
                }
            }

            // Parse: ExReel có thể là object {Strips: [...]} hoặc trực tiếp array [...]
            let strips: any[] | null = null;
            if (Array.isArray(exReelData)) {
                strips = exReelData;
            } else if (exReelData?.Strips && Array.isArray(exReelData.Strips)) {
                strips = exReelData.Strips;
            }

            if (strips && strips.length > 0) {
                // Log.e(
                //     `%c[EXREEL DETECTED!] Server trả ExReel với ${strips.length} strips!` +
                //     ` Strip lengths=[${strips.map((s: any) => ((s.Symbols ?? s) as any[]).length).join(',')}]` +
                //     `\n  Strip[0] sample: ${JSON.stringify(strips[0]).substring(0, 200)}`,
                //     'color:#f00;font-weight:bold;font-size:14px'
                // );
                // Apply ExReel as the new purchase reel strips
                this._applyExReel(strips);
            } else {
                // Log.e(`[EXREEL] ExReel exists but no valid strips found. Raw type=${typeof exReelData} | isArray=${Array.isArray(exReelData)}`);
            }
        } else {
            // Log.e(`[EXREEL] ExReel is null/undefined — dùng PurchaseReel từ PS`);
        }
        ResponseLogger.log('FeatureItemBuy', raw);

        return {
            isSuccess: raw.IsSuccess,
            remainCash: raw.RemainCash,
            res: raw.Res ?? null,
        };
    }

    /**
     * Parse ExReel từ FeatureItemBuy response và cập nhật purchaseReelStrips.
     * ExReel có thể là mảng strips (format giống PurchaseReel.Strips từ PS).
     */
    private _applyExReel(exReel: any[]): void {
        const data = GameData.instance;
        const dynMap = data.psToClientMap;
        const SYM_FMT = ['7','77','777','BAR','BB','3X','BNS','R⚡','B⚡'];
        const fmtSym = (id: number) => id === -1 ? '___' : (SYM_FMT[id] ?? `?${id}`);

        try {
            const rawAll: number[][] = [];
            const converted: number[][] = exReel.map((strip: any, idx: number) => {
                const rawSymbols: number[] = strip.Symbols ?? strip;
                rawAll.push([...rawSymbols]);
                const mapped = rawSymbols.map((psId: number) => dynMap[psId] ?? -2);
                // Log.e(
                //     `[EXREEL-PARSE] Strip${idx}: len=${rawSymbols.length}` +
                //     ` first10raw=[${rawSymbols.slice(0, 10).join(',')}]` +
                //     ` first10client=[${mapped.slice(0, 10).map(fmtSym).join(',')}]`
                // );
                return mapped;
            });

            // So sánh với strips cũ
            // const oldStrips = data.config.purchaseReelStrips;
            // Log.e(
            //     `[EXREEL-APPLY] OLD purchaseReelStrips lengths=[${oldStrips.map(s => s.length).join(',')}]` +
            //     ` → NEW lengths=[${converted.map(s => s.length).join(',')}]`
            // );

            data.config.purchaseReelStrips = converted;
            data.rawPsPurchaseReelStrips = rawAll;
            // Log.e(`%c[EXREEL-APPLY] purchaseReelStrips UPDATED from ExReel!`, 'color:#0f0;font-weight:bold;font-size:14px');
        } catch (err: any) {
            // Log.e(`[EXREEL-APPLY] Parse failed: ${err.message}`);
        }
    }

    // ─── HEARTBEAT ───

    async sendHeartBeat(): Promise<void> {
        const data = GameData.instance;
        const session = data.serverSession!;

        // API V1.0.2 ReqHeartBeat: { "Lang": "ko" } (language code string)
        const requestData = { Lang: this._getLangCode() };
        const encrypted = this._encryptAES256(JSON.stringify(requestData), session.aky);

        const packet = this._buildPacket(
            ServerConfig.API.HEARTBEAT,
            session.memberIdx,
            session.sessionKey,
            data.currentSeq,
            encrypted
        );

        try {
            const responsePacket = await this._sendRequest(
                this._getUrl(ServerConfig.API.HEARTBEAT),
                packet
            );
            // ⚠ HeartBeat là NormalRequest polling — KHÔNG dùng _checkResponseCode vì nó emit
            // SHOW_SYSTEM_POPUP (DISCONNECTED) trước khi throw, gây popup giả khi poll thất bại.
            // Xử lý lỗi thủ công: chỉ throw, không emit popup.
            const _hbCode = responsePacket[5] as number;
            if (_hbCode !== 0) {
                const _hbMsg = (responsePacket[6] as string) || '';
                Log.w(`[HeartBeat] Server error code=${_hbCode} msg="${_hbMsg}"`);
                throw new ServerApiError(`Server error [${_hbCode}]: ${_hbMsg}`, _hbCode, false);
            }
            const decrypted = this._decryptAES256(responsePacket[8], session.aky);
            const raw = JSON.parse(decrypted);
            if (raw.SMM) {
                EventBus.instance.emit(GameEvents.SERVER_MAINTENANCE, this._parseSMM(raw.SMM));
            }
        } catch (err) {
            Log.w('[HeartBeat] Failed:', err);
        }
    }

    // ─── BALANCE GET ───

    async sendBalanceGet(): Promise<{ balance: number; currency: string }> {
        const data = GameData.instance;
        const session = data.serverSession!;

        const requestData = {
            SlotId: ServerConfig.SLOT_ID,
            LID: ServerConfig.DEFAULT_LID,
        };

        const encrypted = this._encryptAES256(JSON.stringify(requestData), session.aky);
        const packet = this._buildPacket(
            ServerConfig.API.BALANCE_GET,
            session.memberIdx,
            session.sessionKey,
            data.currentSeq,
            encrypted
        );

        const responsePacket = await this._sendRequestWithRetry(
            this._getUrl(ServerConfig.API.BALANCE_GET),
            packet
        );

        this._checkResponseCode(responsePacket);
        data.updateSeq(responsePacket[4]);

        const decrypted = this._decryptAES256(responsePacket[8], session.aky);
        const raw: ServerBalanceGetResponse = JSON.parse(decrypted);

        Log.d(`%c[BalanceGet] Balance=${raw.Balance} Currency=${raw.Currency}`, 'color:#0af;font-weight:bold');
        return { balance: raw.Balance, currency: raw.Currency };
    }

    // ─── CASH RACE MY RANK GET FIRST ───

    async sendCashRaceMyRankGetFirst(): Promise<CashRaceMyRankGetFirstResponse | null> {
        const data = GameData.instance;
        const session = data.serverSession!;

        const requestData = {
            SlotId: ServerConfig.SLOT_ID,
            PageItemCnt: 5,
            PT: null,
            MX: null,
        };

        const encrypted = this._encryptAES256(JSON.stringify(requestData), session.aky);
        const packet = this._buildPacket(
            ServerConfig.API.CASH_RACE_RANK,
            session.memberIdx,
            session.sessionKey,
            data.currentSeq,
            encrypted
        );

        const responsePacket = await this._sendRequest(
            this._getUrl(ServerConfig.API.CASH_RACE_RANK),
            packet
        );

        this._checkResponseCode(responsePacket);

        const decrypted = this._decryptAES256(responsePacket[8], session.aky);
        const raw = JSON.parse(decrypted);

        ResponseLogger.log('CashRaceMyRankGetFirst', raw);

        // ── RAW LOG để theo dõi server response ──
        Log.e('[CashRace][RAW] Raw object keys:', Object.keys(raw).join(', '));
        Log.e('[CashRace][RAW] Raw full:', JSON.stringify(raw));
        Log.e('[CashRace][RAW] Race =', raw.Race);
        Log.e('[CashRace][RAW] MyRank =', raw.MyRank);
        Log.e('[CashRace][RAW] TopRanks =', raw.TopRanks);
        Log.e('[CashRace][RAW] BottomRanks =', raw.BottomRanks);
        Log.e('[CashRace][RAW] PrizeRangePercent =', raw.PrizeRangePercent);
        
        if (!raw.Race) {
            Log.e('[CashRace] ⚠️ Race = null → Không có event CashRace đang chạy');
        } else {
            Log.e('[CashRace] ✅ Race.State =', raw.Race.State, '| Rule =', raw.Race.Rule);
            Log.e('[CashRace] ✅ TotalPrize =', raw.Race.TotalPrize, '| WinnerCount =', raw.Race.WinnerCount);
            Log.e('[CashRace] ✅ ST (start) =', raw.Race.ST, '| CT (end) =', raw.Race.CT);
            Log.e('[CashRace] ✅ NT (notice) =', raw.Race.NT, '| ET (settlement end) =', raw.Race.ET);
            Log.e('[CashRace] ✅ MyRank.Rank =', raw.MyRank?.Rank);
        }

        return {
            Race:               raw.Race               ?? null,
            MyRank:             raw.MyRank             ?? null,
            TopRanks:           raw.TopRanks           ?? [],
            BottomRanks:        raw.BottomRanks        ?? [],
            PrizeRangePercent:  raw.PrizeRangePercent  ?? 0,
        } as CashRaceMyRankGetFirstResponse;
    }

    /**
     * CashRaceMyRankGetPage — API V1.0.2 §8.2 (REQ 20015).
     * Dùng cho trang Top / phân trang; body gần giống GetFirst + StartRank.
     */
    async sendCashRaceMyRankGetPage(
        pageItemCnt: number = 5,
        startRank: number = 1,
    ): Promise<CashRaceMyRankGetPageResponse | null> {
        const data = GameData.instance;
        const session = data.serverSession!;

        const requestData = {
            SlotId: ServerConfig.SLOT_ID,
            PageItemCnt: pageItemCnt,
            StartRank: startRank,
        };

        const encrypted = this._encryptAES256(JSON.stringify(requestData), session.aky);
        const packet = this._buildPacket(
            ServerConfig.API.CASH_RACE_RANK_PAGE,
            session.memberIdx,
            session.sessionKey,
            data.currentSeq,
            encrypted,
        );

        const responsePacket = await this._sendRequest(
            this._getUrl(ServerConfig.API.CASH_RACE_RANK_PAGE),
            packet,
        );
        this._checkResponseCode(responsePacket);

        const decrypted = this._decryptAES256(responsePacket[8], session.aky);
        const raw = JSON.parse(decrypted);
        ResponseLogger.log('CashRaceMyRankGetPage', raw);

        const ranks: NwCashRaceRankerSimple[] =
            raw.Ranks ?? raw.ranks ?? raw.TopRanks ?? raw.topRanks ?? [];

        return {
            Ranks: ranks,
            TopRanks: raw.TopRanks ?? raw.topRanks ?? ranks,
            BottomRanks: raw.BottomRanks ?? raw.bottomRanks ?? [],
            MyRank: raw.MyRank ?? raw.myRank ?? null,
            PrizeRangePercent: raw.PrizeRangePercent ?? raw.prizeRangePercent ?? 0,
        };
    }

    /** POST /Auth/ReqLogout — NormalRequest, body rỗng. */
    async sendLogout(): Promise<void> {
        const data = GameData.instance;
        const session = data.serverSession;
        if (!session?.aky) {
            Log.d('[Logout] skip — no session');
            return;
        }

        const encrypted = this._encryptAES256(JSON.stringify({}), session.aky);
        const packet = this._buildPacket(
            ServerConfig.API.LOGOUT,
            session.memberIdx,
            session.sessionKey,
            data.currentSeq,
            encrypted,
        );

        try {
            const responsePacket = await this._sendRequest(
                this._getUrl(ServerConfig.API.LOGOUT),
                packet,
            );
            const code = responsePacket[5] as number;
            if (code !== 0) {
                Log.w(`[Logout] server code=${code} msg=${responsePacket[6]}`);
            } else {
                Log.d('[Logout] session terminated');
            }
        } catch (err) {
            Log.w('[Logout] Failed:', err);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════

    /**
     * Build common request packet (CCRequestCommonPacket) theo tài liệu.
     * Format: MessagePack Array [PID, API, MIDX, SKEY, SEQ, AUTH_TOKEN, Ver, Data, LID, SlotID]
     */
    private _buildPacket(
        api: string,
        memberIdx: number,
        sessionKey: bigint | number,
        seq: number,
        encryptedData: string
    ): any[] {
        // sessionKey phải là BigInt để msgpackr encode thành int64 (uint64),
        // tránh encode thành float64 làm server reject.
        const skey: bigint = typeof sessionKey === 'bigint' ? sessionKey : BigInt(sessionKey);
        return [
            0,                            // [0] PID (not used)
            null,                         // [1] API (not used by server)
            memberIdx,                    // [2] MIDX
            skey,                         // [3] SKEY — BigInt → msgpackr encodes as uint64
            seq,                          // [4] SEQ
            null,                         // [5] AUTH_TOKEN (not used)
            ServerConfig.GAME_VERSION,    // [6] Ver
            encryptedData,                // [7] Data (AES encrypted)
            ServerConfig.DEFAULT_LID,     // [8] LID
            ServerConfig.SLOT_ID,         // [9] SlotID
        ];
    }

    /**
     * Gửi HTTP POST request với MessagePack body.
     *
     * ⚠ QUAN TRỌNG (theo tài liệu):
     * - Content-Type: application/json (nhưng body thực tế là MessagePack binary)
     * - Cần thư viện msgpackr để serialize/deserialize
     */
    private async _sendRequest(url: string, packet: any[]): Promise<any[]> {
        const body = _packr.pack(packet);

        // Parse API name from URL
        const apiName = url.split('/').slice(-2).join('/'); // e.g., "Slot/16/Spin"
        const isJackpotPolling = apiName.includes('Jackpot');
        const isHeartBeat = apiName.includes('HeartBeat');

        // Log 1: gửi request (skip nếu Jackpot/HeartBeat polling và LOG_JACKPOT_POLLING=false)
        if ((!isJackpotPolling && !isHeartBeat) || ServerConfig.LOG_JACKPOT_POLLING) {
            const requestDesc = this._getRequestDesc(apiName, packet);
            Log.d(`[Network] ↑ ${apiName} | ${requestDesc} | SEQ=${packet[4]} | ${body.byteLength}B`);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), ServerConfig.REQUEST_TIMEOUT);
        const startTime = Date.now();

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: body,
                signal: controller.signal,
            });

            const endTime = Date.now();
            const pingMs = endTime - startTime;

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const buffer = await response.arrayBuffer();
            const rawBytes = new Uint8Array(buffer);

            let unpacked: any;
            try {
                unpacked = _packr.unpack(rawBytes) as any[];
            } catch (unpackErr: any) {
                Log.e(`[Network] ❌ unpack failed (${apiName}):`, unpackErr.message);
                _hexDump(rawBytes, 'failed response', 64);
                throw unpackErr;
            }

            // Log 2: nhận response (skip nếu Jackpot/HeartBeat polling và LOG_JACKPOT_POLLING=false)
            if ((!isJackpotPolling && !isHeartBeat) || ServerConfig.LOG_JACKPOT_POLLING) {
                const code = unpacked[5];
                const codeMsg = code === 0 ? 'OK' : `ERROR(${code})`;
                const responseDesc = this._getResponseDesc(apiName, unpacked);
                Log.d(`[Network] ↓ ${apiName} | ${responseDesc} | CODE=${codeMsg} | PING=${pingMs}ms`);
            }

            return unpacked as any[];
        } catch (err: any) {
            const endTime = Date.now();
            const pingMs = endTime - startTime;
            Log.e(`[Network] ❌ ${apiName} failed | ${err.message} | PING=${pingMs}ms`);
            throw err;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /** Mô tả mục đích request */
    private _getRequestDesc(api: string, packet: any[]): string {
        if (api.includes('Login'))      return 'Đăng nhập';
        if (api.includes('Enter'))      return 'Vào game, yêu cầu ParSheet';
        if (api.includes('Spin'))       return 'Yêu cầu quay, tính toán kết quả';
        if (api.includes('Claim'))      return 'Nhận winnings, trả khóa Free Spin';
        if (api.includes('Jackpot'))    return 'Lấy giá trị Jackpot hiện tại';
        if (api.includes('HeartBeat'))  return 'Giữ session sống';
        return 'Request';
    }

    /** Mô tả kết quả response */
    private _getResponseDesc(api: string, packet: any[]): string {
        const code = packet[5];
        if (code !== 0) return `Error: ${packet[6]}`;

        if (api.includes('Login'))      return `Nhận SessionKey, MemberIdx=${packet[2]}`;
        if (api.includes('Enter'))      return `Cash=${packet[8]?.search?.(/Cash/) ? '✓' : '?'}, PS=${packet[8]?.length ?? 0}B`;
        if (api.includes('Spin'))       return `TotalWin=?, NextStage=?`;
        if (api.includes('Claim'))      return `NewCash=?, WinCash=?`;
        if (api.includes('Jackpot'))    return `Wins=[?,?,?,?]`;
        if (api.includes('HeartBeat'))  return `SessionOK`;
        return 'Success';
    }

    /**
     * Gửi request với retry logic (cho SeqRequest APIs).
     * Timeout → retry cùng SEQ tối đa 3 lần.
     */
    private async _sendRequestWithRetry(url: string, packet: any[]): Promise<any[]> {
        // Guard: đã dead (hết retry trước đó) → không gửi gì thêm
        if (this._isDead) {
            throw new ServerApiError('Network is dead — awaiting reload', 0, true);
        }
        let lastError: Error | null = null;
        for (let attempt = 0; attempt < ServerConfig.MAX_RETRY; attempt++) {
            try {
                return await this._sendRequest(url, packet);
            } catch (err: any) {
                // Nếu là ServerApiError (server đã trả về code != 0), không retry
                if (err instanceof ServerApiError) {
                    throw err;
                }
                lastError = err;
                Log.w(`[Network] Retry ${attempt + 1}/${ServerConfig.MAX_RETRY} for ${url}:`, err.message);
            }
        }
        // Hết lượt retry — đánh dấu dead, dừng toàn bộ polling, emit DISCONNECTED popup
        this._isDead = true;
        NetworkManager.instance.dispose();
        const networkErr = lastError ?? new Error('Request failed after retries');
        Log.e(`[Network] ❌ All retries failed — network dead: ${networkErr.message}`);
        EventBus.instance.emit(GameEvents.SHOW_SYSTEM_POPUP, { popupCase: PopupCase.DISCONNECTED });
        throw new ServerApiError(networkErr.message, 0, true);
    }

    /** Check response CODE field — 0 = success.
     * Nếu code != 0: emit SHOW_SYSTEM_POPUP ngay tại đây và throw ServerApiError.
     */
    private _checkResponseCode(packet: any[]): void {
        const code = packet[5] as number;
        const msg = (packet[6] as string) || '';
        if (code !== 0) {
            // 30034 ERR_NO_NEED_CLAIM — không phải mất mạng; caller tự xử lý (Matsuri Claim sớm).
            if (code === 30034) {
                Log.w(`[Network] 30034 ERR_NO_NEED_CLAIM msg="${msg}" — skip DISCONNECTED`);
                throw new ServerApiError(`Server error [30034]: ${msg}`, 30034, true);
            }
            const popupCase = PopUpMessage.popupCaseFromServerCode(code);
            // Log toàn bộ packet để backend biết chính xác server trả về gì
            const packetSummary = packet.map((v, i) => {
                if (i === 8 && typeof v === 'string' && v.length > 80) {
                    return `[8]="${v.substring(0, 80)}..."(${v.length}B)`;
                }
                // JSON.stringify throws on BigInt (e.g. SESSION_KEY at [3]) — use String() instead
                return `[${i}]=${typeof v === 'bigint' ? v.toString() : JSON.stringify(v)}`;
            }).join(' ');
            Log.e(`[Network] ❌ SERVER ERROR → code=${code} | msg="${msg}" | popup=${popupCase}`);
            Log.e(`[Network] ❌ RAW PACKET: ${packetSummary}`);
            // Alias để thấy khi Preview chỉ whitelist carnival
            Log.e(`[CarnivalMatsuri] SERVER ERROR code=${code} msg="${msg}" popup=${popupCase}`);
            EventBus.instance.emit(GameEvents.SHOW_SYSTEM_POPUP, { popupCase });
            throw new ServerApiError(`Server error [${code}]: ${msg}`, code, true);
        }
    }

    /**
     * Convert server SpinResponse → internal SpinResponse format.
     * Server dùng PascalCase, client dùng camelCase.
     */
    private _convertSpinResponse(raw: ServerSpinResponse): SpinResponse {
        const res = raw.Res;
        const data = GameData.instance;
        const matchedLinePays = (res.MatchedLinePays || []).map((lp: ServerMatchedLinePay) => {
            // MatchedSymbolsIndices format: [[{Item1:col, Item2:row}, ...]]
            // Inner array = 1 per matched symbol position (1 per reel)
            const rawIndices = lp.MatchedSymbolsIndices;

            // ═══ LOG RAW MatchedSymbolsIndices — tạm tắt để focus vào reelstrip debug ═══
            // Log.e(
            //     `[CONVERT] Line#${lp.PayLineIndex} MatchedSymbolsIndices raw=${JSON.stringify(rawIndices)}` +
            //     ` MatchedSymbols=${JSON.stringify(lp.MatchedSymbols)} ContainsWild=${lp.ContainsWild}`
            // );

            let indices: Array<{Item1: number; Item2: number}> | null = null;
            if (Array.isArray(rawIndices) && rawIndices.length > 0) {
                const inner = rawIndices[0];
                if (Array.isArray(inner) && inner.length > 0 && 'Item1' in inner[0]) {
                    indices = inner as Array<{Item1: number; Item2: number}>;
                } else if ('Item1' in rawIndices[0]) {
                    // Flat format (not nested)
                    indices = rawIndices as Array<{Item1: number; Item2: number}>;
                }
            }

            // if (indices) {
            //     Log.e(
            //         `[CONVERT] Line#${lp.PayLineIndex} indices parsed → ${indices.map(i => `(col=${i.Item1},row=${i.Item2})`).join(' ')}`
            //     );
            // } else {
            //     Log.e(`[CONVERT] Line#${lp.PayLineIndex} indices=null → fallback to payline config`);
            // }
            // Giữ matchedSymbols là raw PS IDs từ server.
            // PayOutDisplay sẽ so sánh trực tiếp với psWinTypeIds (real API)
            // hoặc với client SymbolId enum (mock — psWinTypeIds.oneSeven === -1).
            // Log.e(`[DEBUG MatchedSymbols] line#${lp.PayLineIndex} server raw=${JSON.stringify(lp.MatchedSymbols)} containsWild=${lp.ContainsWild}`);
            // Server PayLineIndex là 0-based, khớp với client config.paylines
            return {
                payLineIndex: lp.PayLineIndex,
                payout: lp.Payout,
                matchedSymbols: lp.MatchedSymbols as number[],
                containsWild: lp.ContainsWild,
                reelCnt: lp.ReelCnt > 0 ? lp.ReelCnt : (lp.MatchedSymbolsCount ?? 0),
                matchedSymbolsCount: lp.MatchedSymbolsCount,
                matchedSymbolsIndices: indices,
            };
        });

        // Rands dùng trực tiếp cho Normal/FreeSpin.
        // TopUp cần đủ 5 rands vì visual đang quay 5 reel bằng respinReelStrips.
        // Một số response real API chỉ trả 3 rands hoặc không trả TopupReel, khiến reel 3/4 dừng lặp index 0.
        const isTopUpMode = data.currentMode === 'respin';
        const rands = isTopUpMode
            ? this._normalizeTopupRands(res.Rands as number[])
            : (res.Rands as number[]);

        // Secret Treasure: FS tiers dùng ReelIndex 2–6 (không chỉ legacy 1).
        // TopUp (respin) cũng có thể ReelIndex=2 → không được coi là Free Spin.
        const reelIdx = (res.ReelIndex as number) ?? 0;
        // Matsuri dùng ReelIndex=1 giống FS — KHÔNG được coi là Free Spin (remainFS bị ép 0 → end feature).
        const isFreeSpin =
            data.currentMode === 'freespin'
            || (data.currentMode !== 'respin'
                && data.currentMode !== 'matsuri'
                && (reelIdx === 1 || isFreeSpinTierReelIndex(reelIdx)));
        const grid = data.getBaseGrid(rands, isFreeSpin, reelIdx);
        const rawWays = res.TotalWin > 0
            ? WaysPayCalculator.calculate(grid, res.TotalBet as number, isFreeSpin)
            : [];
        const waysPayWins = _reconcileWaysWithServerLines(
            rawWays,
            matchedLinePays,
            grid,
            res.TotalBet as number,
            res.TotalWin as number,
            isFreeSpin,
        );
        const spinResp: SpinResponse = {
            rands,
            matchedLinePays,
            waysPayWins,
            totalBet: res.TotalBet,
            totalWin: res.TotalWin,
            updateCash: res.UpdateCash,
            nextStage: Number.isFinite(Number(res.NextStage)) ? Number(res.NextStage) : res.NextStage,
            reelIndex: res.ReelIndex,
            featureMultiple: res.FreeSpinMultiplier ?? res.FeatureMultiple ?? res.MysteryMultiple,
            remainCash: raw.RemainCash,
            remainFreeSpinCount: (res.RemainFreeSpinCount != null && Number.isFinite(Number(res.RemainFreeSpinCount)))
                ? Math.max(0, Number(res.RemainFreeSpinCount))
                : 0,
            winGrade: res.WinGrade ?? undefined,
            featureSpinTotalWin: res.FeatureSpinTotalWin ?? undefined,
            // ★ Gold of Fortune fields
            redCount: (res as any).RedCount ?? (res as any).StickyRedCount ?? undefined,
            redReels: (res as any).RedReels ?? undefined,
            // GoF: server KHÔNG gửi StickyCells — tính client-side từ rawPsStrips+Rands+symbolPayouts
            // ★ TopUp spin (reelIndex=2 hoặc currentMode=respin): dùng TopupReel/NormalSpinLinkReel (15-slot grid, row=apiRow)
            // ★ Normal/Free spin: NormalSpinLinkReel là grid topup TƯƠNG LAI, không phải vị trí spin hiện tại
            //   → KHÔNG dùng _parseTopupStickyCells cho normal/freespin vì TopupReel là state grid feature, không phải spin grid thường
            //   → Luôn dùng _parseStickyWithFallback (getBaseGrid) cho normal/freespin
            stickyCells: (() => {
                // CarnivalNeko feature spin: sticky CHỈ đến từ StarterCoins / NewStickies / AllStickies
                // (gán bên dưới). Grid fallback sẽ bắt symbol 44 nằm trên free-spin strip →
                // sinh ô Green ảo không credit và làm reset remain sai.
                const isCnFeatureSpin = data.currentMode === 'matsuri'
                    || ((res as any).CurrentFeatureType != null && Number(res.ReelIndex) === 1);
                if (isCnFeatureSpin) {
                    Log.e(`[StickyRoute] CN feature spin → bỏ grid fallback (mode=${data.currentMode} ReelIndex=${res.ReelIndex})`);
                    return undefined;
                }
                const useTopup = data.currentMode === 'respin';
                let topupCells: import('../data/SlotTypes').StickyCell[] | undefined;
                if (useTopup) {
                    topupCells = this._parseTopupStickyCells((res as any).TopupReel)
                        ?? this._parseTopupStickyCells((res as any).NormalSpinLinkReel)
                        ?? this._parseTopupStickyCells((res as any).NoramlSpinLinkReel)
                        ?? this._parseTopupStickyCellsFromVisualRands(rands);
                }
                if (topupCells) {
                    Log.e(`[StickyRoute] TOPUP path → ${topupCells.length} cells (ReelIndex=${res.ReelIndex} mode=${data.currentMode})`);
                    return topupCells;
                }
                const fallbackCells = this._parseStickyWithFallback(
                    (res as any).StickyCells ?? (res as any).StickyList ?? (res as any).CollectSymbols,
                    res.Rands as number[],
                    (res.ReelIndex as number) ?? 0,
                    res.TotalBet as number,
                    (res as any).NormalSpinLinkReel ?? (res as any).NoramlSpinLinkReel,
                );
                Log.e(`[StickyRoute] FALLBACK path → ${fallbackCells?.length ?? 'null'} cells (useTopup=${useTopup} ReelIndex=${res.ReelIndex} mode=${data.currentMode} TopupReel=${(res as any).TopupReel != null} NormalSpinLinkReel=${(res as any).NormalSpinLinkReel != null})`);
                return fallbackCells;
            })(),
            wildTrailCount: (res as any).WildTrailCount ?? (res as any).WildCount ?? undefined,
            potVisualLevel: (res as any).PotVisualLevel ?? undefined,
            triggerPotWin: (res as any).TriggerPotWin ?? (res as any).IsPotWin ?? undefined,
            pickGame: this._parsePickGame((res as any).PickGame ?? (res as any).PickGameState),
            remainRespinCount: this._toFiniteNumber(
                (res as any).RemainFeatureSpinCount ?? (res as any).RemainReSpinCount ?? (res as any).RemainRespinCount,
            ),
            topupReel: this._parseTopupReel((res as any).TopupReel ?? (res as any).NormalSpinLinkReel ?? (res as any).NoramlSpinLinkReel),
        };

        // ★ Carnival Neko: Trail (PS 41/42/43) trên grid → bay Pot; pot levels từ CNSpinResponse
        this._applyCarnivalTrailFields(spinResp, res as any, grid);

        // ★ Carnival Neko CNSpinResponse → feature / sticky / envelope
        this._applyCarnivalCnSpinFields(spinResp, res as any);


        this._applyForceNormalSpinOnly(spinResp);
        return spinResp;
    }

    /**
     * Map CNSpinResponse fields → SpinResponse + carnivalFeature.
     * Remap FREE_SPIN_START (Matsuri-only) → CARNIVAL_MATSURI_START cho client burst flow.
     */
    private _applyCarnivalCnSpinFields(resp: SpinResponse, anyRes: any): void {
        const apiType = anyRes.CurrentFeatureType ?? anyRes.currentFeatureType;
        if (apiType != null) resp.currentFeatureType = Number(apiType);

        const featureRowsRaw = anyRes.FeatureRows ?? anyRes.featureRows;
        if (featureRowsRaw != null && !Number.isNaN(Number(featureRowsRaw))) {
            resp.featureRows = clampMatsuriRows(Number(featureRowsRaw));
        } else if (resp.currentFeatureType != null && resp.currentFeatureType >= 0) {
            // API §8.4: Mighty/Ultra=3, Mega/Supreme=4, Super/Ultimate=5.
            resp.featureRows = clampMatsuriRows(3 + (resp.currentFeatureType % 3));
        }

        // rows sai → Row đảo sai ô → Green land lệch chỗ + credit lookup miss.
        const rows = resp.featureRows
            ?? (GameData.instance.currentMode === 'matsuri' ? GameData.instance.matsuriRows : 3);

        const starter = parseCnStickyCells(
            anyRes.StarterCoins ?? anyRes.starterCoins,
            rows,
            MATSURI_GOLD_SYMBOL,
            resp.totalBet,
        );
        const news = parseCnStickyCells(
            anyRes.NewStickies ?? anyRes.newStickies,
            rows,
            SymbolId.STICKY_GREEN,
            resp.totalBet,
        );
        const all = parseCnStickyCells(
            anyRes.AllStickies ?? anyRes.allStickies,
            rows,
            MATSURI_GOLD_SYMBOL,
            resp.totalBet,
        );
        if (starter.length) resp.starterCoins = starter;
        if (news.length) resp.newStickies = news;
        if (all.length) resp.allStickies = all;
        const collectWin = Number(anyRes.CollectWin ?? anyRes.collectWin ?? anyRes.FeatureSpinWin ?? anyRes.featureSpinWin ?? 0);
        if (Number.isFinite(collectWin) && collectWin > 0) {
            resp.collectWin = collectWin;
            resp.featureSpinWin = collectWin;
        }
        const accSticky = Number(anyRes.AccumulatedStickyCredit ?? anyRes.accumulatedStickyCredit ?? 0);
        if (Number.isFinite(accSticky) && accSticky > 0) resp.accumulatedStickyCredit = accSticky;
        const stickyCount = Number(anyRes.StickyCount ?? anyRes.stickyCount);
        if (Number.isFinite(stickyCount) && stickyCount > 0) resp.stickyCount = stickyCount;

        const stickyKeyRe = /sticky|credit|starter|collect|featureSpin|payout/i;
        const extraSticky = Object.keys(anyRes).filter(k => stickyKeyRe.test(k));
        Log.e(
            `[GREEN-CREDIT][RAW] TotalBet=${anyRes.TotalBet ?? resp.totalBet} TotalWin=${anyRes.TotalWin ?? resp.totalWin}` +
            ` FeatureSpinTotalWin=${anyRes.FeatureSpinTotalWin ?? resp.featureSpinTotalWin ?? 'n/a'}` +
            ` AccumulatedStickyCredit=${anyRes.AccumulatedStickyCredit ?? 'n/a'}` +
            ` StickyCount=${anyRes.StickyCount ?? 'n/a'}` +
            ` parsedNew=${news.map(c => `${c.reel}-${c.row}=${c.credit}`).join(',') || 'none'}` +
            ` parsedAll=${all.map(c => `${c.reel}-${c.row}=${c.credit}`).join(',') || 'none'}` +
            `\n  extraKeys=[${extraSticky.join(', ')}]` +
            `\n  rawNew=${JSON.stringify(anyRes.NewStickies ?? anyRes.newStickies ?? null)}` +
            `\n  rawAll=${JSON.stringify(anyRes.AllStickies ?? anyRes.allStickies ?? null)}` +
            `\n  rawStarter=${JSON.stringify(anyRes.StarterCoins ?? anyRes.starterCoins ?? null)}`,
        );

        // stickyCells cho UI: enter = StarterCoins; mid = NewStickies (Green land)
        const inMatsuri = GameData.instance.currentMode === 'matsuri';
        const stage = resp.nextStage as SlotStageType;
        if (starter.length && (stage === SlotStageType.FREE_SPIN_START || stage === SlotStageType.CARNIVAL_MATSURI_START)) {
            resp.stickyCells = starter;
        } else if (news.length && (inMatsuri
            || stage === SlotStageType.FREE_SPIN
            || stage === SlotStageType.FREE_SPIN_RE_TRIGGER)) {
            resp.stickyCells = news;
        } else if (all.length && inMatsuri) {
            // Không ghi đè NewStickies nếu đã có — AllStickies dùng sync GameManager
        }

        if (anyRes.RemainFeatureSpinCount != null || anyRes.remainFeatureSpinCount != null) {
            const n = this._toFiniteNumber(
                anyRes.RemainFeatureSpinCount ?? anyRes.remainFeatureSpinCount,
            );
            if (n != null) resp.remainRespinCount = n;
        }

        // PICK_END Claim Ultra+: FeatureEntryJackpotWin/Name mang sang Free Spin.
        const entryJp = anyRes.FeatureEntryJackpotWin ?? anyRes.featureEntryJackpotWin;
        if (entryJp != null) resp.featureEntryJackpotWin = Number(entryJp);
        const entryName = anyRes.FeatureEntryJackpotName ?? anyRes.featureEntryJackpotName;
        if (entryName != null) resp.featureEntryJackpotName = String(entryName);

        const envelope = anyRes.RedEnvelopePay ?? anyRes.redEnvelopePay;
        if (envelope != null && Number(envelope) > 0) resp.redEnvelopePay = Number(envelope);

        if (anyRes.IsGridFull != null || anyRes.isGridFull != null) {
            const rawFull = anyRes.IsGridFull ?? anyRes.isGridFull;
            resp.isGridFull = rawFull === true || rawFull === 1 || rawFull === '1' || rawFull === 'true';
        }
        const gridFullWin = anyRes.GridFullGrandWin ?? anyRes.gridFullGrandWin;
        if (gridFullWin != null) resp.gridFullGrandWin = Number(gridFullWin);

        // PickGame trên PICK_START
        if (!resp.pickGame) {
            resp.pickGame = this._parsePickGame(anyRes.PickGame ?? anyRes.PickGameState);
        }

        // Chỉ map feature ENTRY. Mid-matsuri (FREE_SPIN=4) giữ NextStage server —
        // không remap → CARNIVAL_MATSURI_START (240) kẻo burst/start lại + reel kẹt.
        const feature = buildCarnivalFeatureFromSpin(anyRes, resp.nextStage);
        if (feature && !inMatsuri) {
            resp.carnivalFeature = feature;
            // Ultra+: nếu server còn gửi FREE_SPIN_START kèm PickGame → vẫn Pick trước.
            if (feature.freeSpinAfterJackpot && resp.pickGame
                && (resp.nextStage === SlotStageType.FREE_SPIN_START
                    || resp.nextStage === SlotStageType.CARNIVAL_MATSURI_START)) {
                resp.nextStage = SlotStageType.PICK_START;
                resp.triggerPotWin = true;
            }
            if (!feature.jackpotFirst
                && resp.nextStage === SlotStageType.FREE_SPIN_START) {
                resp.nextStage = SlotStageType.CARNIVAL_MATSURI_START;
            }
            // Red-only / Ultra+: PICK_START → pot burst / Pick ngay
            if (feature.jackpotFirst
                && (resp.nextStage === SlotStageType.PICK_START || resp.nextStage === SlotStageType.PICK)) {
                resp.triggerPotWin = true;
            }
            Log.e(
                `[CN-FEATURE] kind=${feature.featureName} apiType=${resp.currentFeatureType ?? 'n/a'}` +
                ` rows=${feature.matsuriRows} startCoins=${feature.startCoins}` +
                ` jackpotFirst=${feature.jackpotFirst} fsAfterJp=${feature.freeSpinAfterJackpot}` +
                ` nextStage=${resp.nextStage}` +
                ` starter=${starter.length} new=${news.length} all=${all.length}`,
            );
        } else if (inMatsuri) {
            Log.e(
                `[CarnivalMatsuri] mid-spin keep NextStage=${resp.nextStage}` +
                ` new=${news.length} all=${all.length} remain=${resp.remainRespinCount ?? 'n/a'}`,
            );
        }

        if (resp.redEnvelopePay != null && resp.redEnvelopePay > 0) {
            Log.e(`[CN-ENVELOPE] RedEnvelopePay=${resp.redEnvelopePay}`);
        }
        if (resp.isGridFull) {
            Log.e(`[CN-GRIDFULL] IsGridFull grandWin=${resp.gridFullGrandWin ?? 0}`);
        }
    }

    /**
     * CNSpinResponse → SpinResponse.trails / potLevels.
     * Trails: ô TRAIL_BLUE/GREEN/RED trên client grid (sau PS map).
     * Pot: BluePotLevel / RedPotLevel / GreenPotLevel (0–10); fallback +1 local nếu thiếu.
     */
    private _applyCarnivalTrailFields(
        resp: SpinResponse,
        anyRes: any,
        grid: number[][],
    ): void {
        const trails = buildCarnivalTrailsFromGrid(grid);
        if (trails.length > 0) {
            resp.trails = trails;
        }

        const blue = anyRes.BluePotLevel ?? anyRes.bluePotLevel;
        const red = anyRes.RedPotLevel ?? anyRes.redPotLevel;
        const green = anyRes.GreenPotLevel ?? anyRes.greenPotLevel;
        const hasServerPots = blue != null || red != null || green != null;

        if (hasServerPots) {
            const prev = GameData.instance.potLevels;
            resp.potLevels = {
                blue: Math.max(0, Math.min(10, Number(blue ?? prev.blue ?? 0))),
                red: Math.max(0, Math.min(10, Number(red ?? prev.red ?? 0))),
                green: Math.max(0, Math.min(10, Number(green ?? prev.green ?? 0))),
            };
        } else if (trails.length > 0) {
            // Server chưa gửi level → tăng local theo trail land (visual only)
            const levels = {
                blue: GameData.instance.potLevels.blue ?? 0,
                red: GameData.instance.potLevels.red ?? 0,
                green: GameData.instance.potLevels.green ?? 0,
            };
            for (const t of trails) {
                if (t.color === TrailColor.BLUE) levels.blue = Math.min(10, levels.blue + 1);
                else if (t.color === TrailColor.RED) levels.red = Math.min(10, levels.red + 1);
                else if (t.color === TrailColor.GREEN) levels.green = Math.min(10, levels.green + 1);
            }
            resp.potLevels = levels;
        }

        if (trails.length > 0) {
            const blueC = anyRes.BlueTrailCount ?? anyRes.blueTrailCount;
            const redC = anyRes.RedTrailCount ?? anyRes.redTrailCount;
            const greenC = anyRes.GreenTrailCount ?? anyRes.greenTrailCount;
            Log.e(
                `[CN-TRAIL] hits=${trails.length} ` +
                `[${trails.map(t => `r${t.reel}row${t.row}:${TrailColor[t.color]}`).join('|')}] ` +
                `counts B/R/G=${blueC ?? '-'}/${redC ?? '-'}/${greenC ?? '-'} ` +
                `pots=${resp.potLevels ? `B${resp.potLevels.blue}/R${resp.potLevels.red}/G${resp.potLevels.green}` : 'n/a'}`,
            );
        }
    }

    /** Parse số từ MessagePack/JSON (tránh Number({}) = NaN làm remain=0 / NextStage lệch). */
    private _toFiniteNumber(v: any): number | undefined {
        if (v == null || v === '') return undefined;
        if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
        if (typeof v === 'string') {
            const n = Number(v.replace(',', '.'));
            return Number.isFinite(n) ? n : undefined;
        }
        if (typeof v === 'object') {
            return this._toFiniteNumber(
                v.Value ?? v.value ?? v.m ?? v.Val ?? v.val ?? v.N ?? v.n,
            );
        }
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    }

    /**
     * Tạm (FORCE_NORMAL_SPIN_ONLY): ép NextStage=SPIN, chặn vào feature.
     * Vẫn giữ trails + potLevels để Trail bay vào Pot.
     */
    private _applyForceNormalSpinOnly(resp: SpinResponse): void {
        if (!FORCE_NORMAL_SPIN_ONLY) return;
        const prevStage = resp.nextStage;
        resp.nextStage = SlotStageType.SPIN;
        // Giữ resp.trails / resp.potLevels — CarnivalTrailController cần để fly
        resp.carnivalFeature = undefined;
        resp.pickGame = undefined;
        resp.triggerPotWin = false;
        resp.remainFreeSpinCount = 0;
        resp.remainRespinCount = undefined;
        resp.topupReel = undefined;
        resp.stickyCells = undefined;
        resp.starterCoins = undefined;
        resp.newStickies = undefined;
        resp.allStickies = undefined;
        resp.currentFeatureType = undefined;
        resp.featureRows = undefined;
        resp.redEnvelopePay = undefined;
        resp.isGridFull = undefined;
        resp.gridFullGrandWin = undefined;
        resp.redCount = undefined;
        resp.redReels = undefined;
        resp.wildTrailCount = undefined;
        GameData.instance.pendingCarnivalMatsuri = null;
        if (prevStage !== SlotStageType.SPIN) {
            Log.e(`[FORCE_NORMAL] strip feature nextStage ${prevStage} → SPIN (keep trails=${resp.trails?.length ?? 0})`);
        }
    }

    /** Enter LastSpinResponse: tránh resume vào Pick/FS/TopUp khi FORCE_NORMAL_SPIN_ONLY. */
    private _sanitizeLastSpinForNormalOnly(last: any): any {
        if (!FORCE_NORMAL_SPIN_ONLY || !last || typeof last !== 'object') return last;
        const body = last.Res && typeof last.Res === 'object' ? last.Res : last;
        const prev = body.NextStage ?? body.nextStage ?? body.stageType;
        body.NextStage = SlotStageType.SPIN;
        body.nextStage = SlotStageType.SPIN;
        body.stageType = SlotStageType.SPIN;
        if (last.Res && last.Res !== body) {
            last.NextStage = SlotStageType.SPIN;
            last.nextStage = SlotStageType.SPIN;
        }
        if (prev != null && prev !== SlotStageType.SPIN) {
            Log.e(`[FORCE_NORMAL] Enter LastSpin NextStage ${prev} → SPIN (no resume feature)`);
        }
        return last;
    }


    /**
     * Parse server PickGame data → PickGameState.
     * Server có thể trả về:
     *  - Array: [{Index: 0, SymbolId: 85}, ...] — 12 items, server PS symbol id
     *  - Object: {Grid: [...], Revealed: [...]} — already object form
     *  - Object: {grid: [...], revealed: [...]} — camelCase form
     */
    private _parsePickGame(raw: any): PickGameState | undefined {
        if (!raw) return undefined;
        // Array format: server trả [{Index, SymbolId}] hoặc number[] PS IDs
        if (Array.isArray(raw)) {
            const grid: number[] = new Array(PICK_GAME_CELL_COUNT).fill(SymbolId.JP_IDLE);
            const revealed: number[] = [];
            const first = raw[0];
            const isIdList = first == null
                || typeof first === 'number'
                || (typeof first === 'string' && toPsId(first) != null);
            if (isIdList) {
                for (let i = 0; i < Math.min(raw.length, PICK_GAME_CELL_COUNT); i++) {
                    const ps = toPsId(raw[i]);
                    if (ps == null || ps === -1) continue;
                    grid[i] = psPickToClient(ps);
                    revealed.push(i);
                }
            } else {
                for (const item of raw) {
                    if (item == null || item.Index == null) continue;
                    const ps = toPsId(item.SymbolId ?? item.symbolId) ?? -1;
                    if (ps === -1) continue;
                    grid[item.Index] = psPickToClient(ps);
                    revealed.push(item.Index);
                }
            }
            return { grid, revealed };
        }
        // Object format — normalize PascalCase keys; convert PS IDs (≥81) → client
        const rawGrid: number[] | undefined = raw.grid ?? raw.Grid;
        const revealed: number[] | undefined = raw.revealed ?? raw.Revealed ?? [];
        if (!rawGrid) return undefined;
        const looksLikePs = rawGrid.some((v) => typeof v === 'number' && v >= 81);
        const grid = looksLikePs ? rawGrid.map((ps) => psPickToClient(ps)) : rawGrid.slice();
        return {
            grid,
            revealed,
            wonTier: raw.wonTier ?? raw.WonTier,
            upgradeArmed: raw.upgradeArmed ?? raw.UpgradeArmed,
            upgradeCount: raw.upgradeCount ?? raw.UpgradeCount,
            doubleGrand: raw.doubleGrand ?? raw.DoubleGrand,
        };
    }

    private _parseTopupReel(raw: any): TopupReelSlot[] | undefined {
        if (!Array.isArray(raw) || raw.length === 0) return undefined;
        const slots: TopupReelSlot[] = [];
        for (let i = 0; i < raw.length; i++) {
            const item = raw[i];
            // typeof null === 'object' in JS — must guard against null explicitly
            const isObj = typeof item === 'object' && item !== null;
            const type = isObj ? item?.Type ?? item?.type ?? TopupReelType.NONE : TopupReelType.NONE;
            const win = isObj
                ? (parseCnStickyCredit(item) || Number(item.Win ?? item.win ?? item.Credit ?? item.credit ?? 0) || 0)
                : 0;
            const index = isObj ? item.Index ?? item.index ?? i : (typeof item === 'number' ? item : i);
            slots.push({ type, win, index });
        }
        return slots;
    }

    private _parseTopupStickyCells(raw: any): import('../data/SlotTypes').StickyCell[] | undefined {
        const slots = this._parseTopupReel(raw);
        if (!slots) return undefined;

        const strips = GameData.instance.config.respinReelStrips;
        const cells: import('../data/SlotTypes').StickyCell[] = [];
        for (let i = 0; i < Math.min(15, slots.length); i++) {
            const slot = slots[i];
            const apiRow = Math.floor(i / 5);
            const reel = i % 5;
            const row = 2 - apiRow; // Server rows are inverted against StickyOverlay/TopUp visual slots.

            let symbolId: number | null = null;
            let stripIdx = -1;
            let stripSymbol: number | null = null;
            if (slot.type === TopupReelType.YELLOW) symbolId = SymbolId.STICKY_YELLOW;
            else if (slot.type === TopupReelType.GREEN) symbolId = SymbolId.STICKY_GREEN;
            else if (slot.type === TopupReelType.GRAND) symbolId = SymbolId.JP_GRAND;

            const strip = strips[reel] ?? [];
            if (strip.length > 0) {
                stripIdx = ((slot.index % strip.length) + strip.length) % strip.length;
                stripSymbol = strip[stripIdx];
            }

            Log.e(
                `[TOPUP-CREDIT][PARSE-SLOT] slot=${i} apiRow=${apiRow} visual=${reel}-${row}` +
                ` type=${slot.type} index=${slot.index} win=${slot.win}` +
                ` stripIdx=${stripIdx} stripSymbol=${stripSymbol == null ? 'n/a' : (SymbolId[stripSymbol] ?? stripSymbol)}` +
                ` parsed=${symbolId == null ? 'none' : (SymbolId[symbolId] ?? symbolId)}`
            );
            if (symbolId == null) continue;
            Log.e(
                `[TOPUP-CREDIT][PARSE] slot=${i} apiRow=${apiRow} visual=${reel}-${row}` +
                ` type=${slot.type} index=${slot.index} symbol=${SymbolId[symbolId] ?? symbolId} win=${slot.win}`
            );
            cells.push({ reel, row, symbolId, credit: slot.win });
        }
        Log.e(`[TopUp-PARSE] _parseTopupStickyCells: raw.length=${Array.isArray(raw) ? raw.length : 'N/A'} → ${cells.length} cells: ${cells.map(c => `r${c.reel}row${c.row}=${SymbolId[c.symbolId]}($${c.credit})`).join(', ')}`);
        return cells.length > 0 ? cells : undefined;
    }

    private _parseNormalLinkReelCredits(raw: any): Map<string, number> {
        const slots = this._parseTopupReel(raw);
        const credits = new Map<string, number>();
        if (!slots) return credits;

        for (let i = 0; i < Math.min(15, slots.length); i++) {
            const slot = slots[i];
            if (slot.type === TopupReelType.NONE) continue;
            if (slot.win == null || slot.win <= 0) continue;

            const apiRow = Math.floor(i / 5);
            const reel = i % 5;
            const row = apiRow;
            credits.set(`${reel}-${row}`, slot.win);
        }

        if (credits.size > 0) {
            Log.e(`[StickyCredit] NormalSpinLinkReel credits: ${Array.from(credits.entries()).map(([k, v]) => `${k}=${v}`).join(', ')}`);
        }
        return credits;
    }

    private _toStickyCreditFromRate(rate: number): number {
        if (rate <= 0) return 0;
        return rate < 1 ? rate * 2500 : rate;
    }

    private _normalizeTopupRands(rawRands: number[] | undefined): number[] {
        const data = GameData.instance;
        const strips = data.config.respinReelStrips;
        // Chỉ dùng đúng số reel thực tế — KHÔNG dùng strips.length vì respinReelStrips có thể
        // có 15 phần tử (5 reel × 3 row) thay vì 5, khiến hàm tạo 15 rands thay vì 5.
        const reelCount = data.config.reelCount;
        const rands: number[] = [];

        for (let reel = 0; reel < reelCount; reel++) {
            const stripLen = strips[reel]?.length ?? strips[0]?.length ?? 1;
            const raw = rawRands?.[reel];
            // raw >= 0: server gửi -1 (hoặc âm) = không có rand hợp lệ → dùng random.
            // Không dùng Number.isFinite(raw) một mình vì -1 là finite nhưng nghĩa là "invalid".
            // -1 % 38 = -1 → (-1+38)%38 = 37 = vị trí CUỐI strip → luôn ra Yellow (stripLen-1).
            if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
                rands[reel] = ((raw % stripLen) + stripLen) % stripLen;
            } else {
                rands[reel] = Math.floor(Math.random() * stripLen);
            }
        }

        if ((rawRands?.length ?? 0) < reelCount || rawRands?.some(r => r < 0)) {
            Log.e(`[TopUp-RANDS] padded TopUp rands ${JSON.stringify(rawRands ?? [])} → ${JSON.stringify(rands)} (reelCount=${reelCount} stripsLen=${strips.length})`);
        }
        return rands;
    }

    private _parseTopupStickyCellsFromVisualRands(_rands: number[]): import('../data/SlotTypes').StickyCell[] | undefined {
        const data = GameData.instance;
        if (data.currentMode !== 'respin') {
            Log.e(`[NM-TOPUP] _parseTopupStickyCellsFromVisualRands skipped: currentMode="${data.currentMode}"`);
            return undefined;
        }

        // In TopUp, sticky coins must come from the server slot Type. Inferring coins
        // from respin strip/rands can create extra Yellow/Green cells when Type=NONE.
        return undefined;
    }

    /**
     * Tính StickyCell từ rawPsStrips + Rands + symbolPayouts khi server không gửi StickyCells.
     *
     * Gold of Fortune: GFSpinResponse KHÔNG có field StickyCells/StickyList.
     * Credit của mỗi đồng xu đỏ = SymbolRates[psId] × TotalBet (PS data).
     * Fallback: nếu server gửi StickyCells (tương lai) → dùng server data.
     *
     * @param rawServerCells  raw StickyCells field từ server (thường null/undefined với GoF)
     * @param rands           Rands[5] từ spin response — center index mỗi reel trong strip
     * @param reelIndex       0=Normal, 1=FreeSpin, 2=TopupGame
     * @param totalBet        TotalBet từ spin response
     * @param noramlSpinLinkReel  NoramlSpinLinkReel từ spin response — link game grid slots
     */
    private _parseStickyWithFallback(
        rawServerCells: any,
        rands: number[],
        reelIndex: number,
        totalBet: number,
        noramlSpinLinkReel: any,
    ): import('../data/SlotTypes').StickyCell[] | undefined {
        // 1. Thử parse từ server data trước
        const serverCells = this._parseStickyCells(rawServerCells);
        if (serverCells && serverCells.length > 0) {
            Log.e(`[StickyCredit] Server sent ${serverCells.length} cells: ${JSON.stringify(serverCells)}`);
            return serverCells;
        }

        const linkCredits = this._parseNormalLinkReelCredits(noramlSpinLinkReel);

        // 2. Log NoramlSpinLinkReel để debug — đây là topup game grid state, không phải vị trí trên reel
        if (noramlSpinLinkReel != null) {
            Log.e(`[StickyCredit] NoramlSpinLinkReel (topup grid, ${(noramlSpinLinkReel as any[]).length} slots): ${JSON.stringify(noramlSpinLinkReel).substring(0, 500)}`);
        } else {
            Log.d('[StickyCredit] NoramlSpinLinkReel = null/undefined');
        }

        // 3. Tính từ grid (getBaseGrid) + API link reel/rawPsStrips để lấy credit
        //    ★ Dùng getBaseGrid để xác định VỊ TRÍ (cùng convention với visual reel).
        //    ★ Ưu tiên NormalSpinLinkReel.Win vì đây là credit tuyệt đối server gửi cho đồng xu.
        //    ★ Chỉ fallback rawPsStrips/SymbolRates khi API không có Win cho cell đó.
        //    ★ Nếu rawPsStrips không cho rate (psId không có trong payouts), vẫn tạo cell với credit=0
        //      (để CreditLabel hiển thị — hơn là ẩn hết).
        const data = GameData.instance;
        const isFreeSpin =
            data.currentMode === 'freespin'
            || (data.currentMode !== 'respin'
                && data.currentMode !== 'matsuri'
                && (reelIndex === 1 || isFreeSpinTierReelIndex(reelIndex)));
        const rawStrips = data.getRawPsStrips(isFreeSpin, reelIndex);
        const payouts = data.symbolPayouts; // {psId: rate, ...} từ PS SymbolRates

        if (!rands || rands.length === 0) {
            Log.e(`[StickyCredit] ⚠ Cannot compute — rands empty`);
            return undefined;
        }

        // Lấy grid qua getBaseGrid — nguồn chân lý cho visual positions
        const grid = data.getBaseGrid(rands, isFreeSpin, reelIndex);
        if (!grid || grid.length === 0) {
            Log.e(`[StickyCredit] ⚠ getBaseGrid returned empty grid`);
            return undefined;
        }

        // Diagnostics: so sánh rawStrip length với clientStrip length
        const clientStrips = data.getReelStrips(isFreeSpin, reelIndex);
        Log.e(
            `[StickyCredit] Computing grid-based: reelIndex=${reelIndex} mode=${data.currentMode} isFS=${isFreeSpin} totalBet=${totalBet}` +
            ` rawLens=[${rawStrips.map(s => s?.length ?? 0).join(',')}]` +
            ` clientLens=[${clientStrips.map(s => s?.length ?? 0).join(',')}]` +
            ` payouts=${JSON.stringify(payouts)}`
        );

        const cells: import('../data/SlotTypes').StickyCell[] = [];

        for (let reel = 0; reel < grid.length; reel++) {
            const reelGrid = grid[reel];
            if (!reelGrid) continue;

            const rawStrip = rawStrips[reel];
            const rawLen = rawStrip?.length ?? 0;
            const rawCenter = rawLen > 0 ? ((rands[reel] % rawLen) + rawLen) % rawLen : -1;

            for (let row = 0; row < reelGrid.length; row++) {
                const clientSymId = reelGrid[row];
                // Chỉ xử lý sticky coins
                if (clientSymId !== SymbolId.STICKY_YELLOW
                    && clientSymId !== SymbolId.STICKY_GREEN) continue;

                // row 0=top=center-1, row 1=mid=center, row 2=bot=center+1
                const offset = row - 1;
                let psId = -1;
                let rate = 0;

                if (rawCenter >= 0) {
                    const rawIdx = ((rawCenter + offset) % rawLen + rawLen) % rawLen;
                    psId = rawStrip[rawIdx];
                    rate = payouts[psId] ?? 0;
                }

                if (rate <= 0) {
                    // Diagnostics: in ra rawPsIds xung quanh center để debug
                    const rawAround = rawCenter >= 0
                        ? `raw[c-1]=${rawStrip[((rawCenter - 1) % rawLen + rawLen) % rawLen]} raw[c]=${rawStrip[rawCenter]} raw[c+1]=${rawStrip[(rawCenter + 1) % rawLen]}`
                        : 'rawStrip unavailable';
                    Log.e(
                        `[StickyCredit] ⚠ r${reel}row${row} ${SymbolId[clientSymId]} psId=${psId}` +
                        ` rate=0/missing — rands[${reel}]=${rands[reel]} rawLen=${rawLen} rawCenter=${rawCenter}` +
                        ` | ${rawAround}` +
                        ` | payoutKeys=[${Object.keys(payouts).join(',')}]`
                    );
                }

                const linkCredit = linkCredits.get(`${reel}-${row}`);
                const rateCredit = this._toStickyCreditFromRate(rate);
                const credit = linkCredit ?? rateCredit;
                const cell: any = { reel, row, symbolId: clientSymId, credit };
                if (linkCredit == null) cell._rate = rate;
                cells.push(cell);
                Log.e(`[StickyCredit] ✓ r${reel}row${row} ${SymbolId[clientSymId]??clientSymId} psId=${psId} linkWin=${linkCredit ?? 'n/a'} rate=${rate} rateCredit=${rateCredit} totalBet=${totalBet}=credit${credit}`);
            }
        }

        if (cells.length === 0) {
            Log.e(`[StickyCredit] No trail coins in visible grid. rawLens=${rawStrips.map(s=>s?.length??0).join(',')}`);
        } else {
            Log.e(`[StickyCredit] Computed ${cells.length} sticky cells from grid.`);
        }
        return cells.length > 0 ? cells : undefined;
    }

    private _parseStickyCells(raw: any): import('../data/SlotTypes').StickyCell[] | undefined {
        if (!raw || !Array.isArray(raw) || raw.length === 0) return undefined;
        const cells: import('../data/SlotTypes').StickyCell[] = [];
        const dynMap = GameData.instance.psToClientMap;

        for (const item of raw) {
            let reel: number, row: number, symbolId: number, credit: number;

            if (Array.isArray(item)) {
                // Array format: [reel, row, symbolId, credit]
                [reel, row, symbolId, credit] = item;
            } else if (typeof item === 'object') {
                // Object format (PascalCase or mixed)
                reel = item.Reel ?? item.Col ?? item.reel ?? item.col ?? 0;
                row = item.Row ?? item.row ?? 0;
                const rawSym = item.SymbolId ?? item.Sym ?? item.symbolId ?? item.sym ?? SymbolId.STICKY_YELLOW;
                symbolId = dynMap[rawSym] ?? rawSym;
                credit = item.Credit ?? item.Val ?? item.credit ?? item.val ?? item.Value ?? 0;
            } else {
                continue;
            }

            // Map PS symbol ID to client symbol ID if needed
            if (typeof symbolId === 'number' && symbolId > 20 && dynMap[symbolId] !== undefined) {
                symbolId = dynMap[symbolId];
            }

            // Lưu _rate để khi bet thay đổi có thể tính lại credit = _rate × newTotalBet
            const _rate = (credit && GameData.instance.totalBet > 0)
                ? credit / GameData.instance.totalBet
                : 0;
            cells.push({ reel, row, symbolId, credit, _rate } as any);
        }

        return cells.length > 0 ? cells : undefined;
    }

    private _encryptAES128(plainText: string): string {
        return encryptAES128(plainText);
    }

    private _decryptAES128(cipherText: string): string {
        return decryptAES128(cipherText);
    }

    private _encryptAES256(plainText: string, aky: string): string {
        return encryptAES256(plainText, aky);
    }

    private _decryptAES256(cipherText: string, aky: string): string {
        return decryptAES256(cipherText, aky);
    }

    // ─── PS (ParSheet) DECRYPTION (via CryptoUtils) ───

    private _decryptPS(psBase64: string): any {
        const aky = GameData.instance.serverSession?.aky ?? '';
        return decryptPS(psBase64, aky);
    }

    /**
     * Áp dụng ParSheet (PS) đã giải nén vào GameData.config.
     *
     * PS format (từ SuperNova PS.json):
     * {
     *   Bet: number[],
     *   CoinValue: number[],
     *   WinPopup: { Normal, Big, Super, Mega },
     *   Reel: { Strips: [ { Symbols: number[] }, ... ] },
     *   FreeSpinReel?: { Strips: [...] },
     *   GameName: string,
     *   ...
     * }
     *
     * Reel.Strips[i].Symbols chứa PS Symbol IDs (1,2,3,4,11,12,...)
     * → cần convert sang Client SymbolId (0-8) qua psToClientSymbol().
     */
    private _logWinPopupFromPS(ps: any): void {
        if (!Log.isEnabled('winpopup')) return;
        const wp = ps?.WinPopup;
        if (!wp || typeof wp !== 'object') {
            Log.e('[WinPopup] PS không có WinPopup');
            return;
        }
        const grades = Object.keys(wp).sort((a, b) => (Number(wp[a]) || 0) - (Number(wp[b]) || 0));
        const progressive = grades.filter((k) => k.toLowerCase() !== 'normal');
        Log.e(`[WinPopup] ${progressive.length} cấp progressive: ${progressive.join(', ')}`);
        for (const k of grades) {
            Log.e(`[WinPopup]   ${k}: ≥ ${wp[k]}× totalBet`);
        }
    }

    private _applyPS(ps: any): void {
        const data = GameData.instance;

        // ─── PS STRUCTURE (compact) ───
        {
            const hasReel = ps?.Reel?.Strips && Array.isArray(ps.Reel.Strips);
            const hasFSReel = ps?.FreeSpinReel?.Strips && Array.isArray(ps.FreeSpinReel.Strips);
            Log.d(
                `[PS] keys=${Object.keys(ps || {}).length}` +
                ` Reel.Strips=${hasReel ? ps.Reel.Strips.length : 'n/a'}` +
                ` FreeSpinReel=${hasFSReel ? 'yes' : 'no'}`
            );
        }
        if (ps.Bet && Array.isArray(ps.Bet)) {
            data.config.betOptions = ps.Bet;
        }

        // Coin values
        if (ps.CoinValue && Array.isArray(ps.CoinValue)) {
            data.config.coinValues = ps.CoinValue;
        }

        // Win popup thresholds — ghi đè giá trị 0 mặc định trong DEFAULT_SLOT_CONFIG
        if (ps.WinPopup) {
            data.config.bigWinThreshold     = ps.WinPopup.Big     ?? data.config.bigWinThreshold;
            data.config.megaWinThreshold    = ps.WinPopup.Mega    ?? data.config.megaWinThreshold;
            data.config.majorWinThreshold   = ps.WinPopup.Major   ?? data.config.majorWinThreshold;
            data.config.superWinThreshold   = ps.WinPopup.Super   ?? data.config.superWinThreshold;
            data.config.epicWinThreshold    = ps.WinPopup.Epic    ?? data.config.epicWinThreshold;
            data.config.ultraWinThreshold   = ps.WinPopup.Ultra   ?? data.config.ultraWinThreshold;
            data.config.monsterWinThreshold = ps.WinPopup.Monster ?? data.config.monsterWinThreshold;
            data.config.maxWinThreshold     = ps.WinPopup.Max     ?? data.config.maxWinThreshold;
        }
        this._logWinPopupFromPS(ps);

        // ═══ Build dynamic PS ID → Client SymbolId mapping từ PS JSON fields (Gold of Fortune) ═══
        const dynMap: Record<number, number> = {};

        // Gold of Fortune server schema — map tất cả PS symbol IDs → client SymbolId
        // Dùng nhiều tên khác nhau vì server PS có thể dùng format khác nhau
        const psSymbolFields: Array<[string[], number]> = [
            // Minors — Secret Treasure (PS 1–6 = 9, 10, J, Q, K, A)
            [['Minor9SymbolID', 'MinorNine', 'Symbol9'],           SymbolId.MINOR_9],
            [['Minor10SymbolID', 'MinorTen', 'Symbol10'],          SymbolId.MINOR_10],
            [['MinorJSymbolID', 'MinorJack', 'SymbolJ'],           SymbolId.MINOR_J],
            [['MinorQSymbolID', 'MinorQ', 'SymbolQ'],              SymbolId.MINOR_Q],
            [['MinorKSymbolID', 'MinorK', 'SymbolK'],              SymbolId.MINOR_K],
            [['MinorASymbolID', 'MinorA', 'SymbolA'],              SymbolId.MINOR_A],
            // Majors — Secret Treasure (PS 11–15)
            [['MajorHorusSymbolID', 'MajorHorus', 'HorusSymbolID', 'Horus', 'RaSymbolID', 'Ra', 'MajorCoinSymbolID', 'MajorCoin', 'CoinSymbolID', 'Coin'], SymbolId.MAJOR_HORUS],
            [['MajorAnubisSymbolID', 'MajorAnubis', 'AnubisSymbolID', 'Anubis', 'MajorIngotSymbolID', 'MajorIngot', 'IngotSymbolID', 'Ingot'], SymbolId.MAJOR_ANUBIS],
            [['MajorSobekSymbolID', 'MajorSobek', 'SobekSymbolID', 'Sobek', 'MajorShipSymbolID', 'MajorShip', 'ShipSymbolID', 'Ship'], SymbolId.MAJOR_SOBEK],
            [['MajorRamsesSymbolID', 'MajorRamses', 'RamsesSymbolID', 'Ramses', 'MajorTurtleSymbolID', 'MajorTurtle', 'TurtleSymbolID', 'Turtle'], SymbolId.MAJOR_RAMSES],
            [['MajorCleopatraSymbolID', 'MajorCleopatra', 'CleopatraSymbolID', 'Cleopatra', 'MajorPhoenixSymbolID', 'MajorPhoenix', 'PhoenixSymbolID', 'Phoenix'], SymbolId.MAJOR_CLEOPATRA],
            // Specials — Carnival Neko V1.0.1 (+ alias legacy)
            [['WildTrailSymbolID', 'WildSymbolID', 'WildsymbolID'], SymbolId.WILD],
            [['Sticky_01symbolID', 'Sticky01symbolID', 'StickyGreenSymbolID', 'StickyGreen'], SymbolId.STICKY_GREEN],
            [['Sticky_02symbolID', 'Sticky02symbolID', 'StickyYellowSymbolID', 'StickyYellow'], SymbolId.STICKY_YELLOW],
            // Jackpots — CN: Mini/Minor/Major/Grand/Upgrade/Idle
            [['MinijackpotSymbolID', 'MiniJackpotID', 'MiniJackpotSymbolID'], SymbolId.JP_MINI],
            [['MinorjackpotSymbolID', 'MinorJackpotID', 'MinorJackpotSymbolID'], SymbolId.JP_MINOR],
            [['MajorjackpotSymbolID', 'MajorJackpotID', 'MajorJackpotSymbolID'], SymbolId.JP_MAJOR],
            [['GrandjackpotSymbolID', 'GrandJackpotID', 'GrandJackpotSymbolID'], SymbolId.JP_GRAND],
            [['UpgradejackpotSymbolID', 'UpgradeJackpotID', 'UpgradeJackpotSymbolID'], SymbolId.JP_UPGRADE],
            [['IdlejackpotSymbolID', 'IdleJackpotID', 'IdleJackpotSymbolID'], SymbolId.JP_IDLE],
            // Trail — CN: Blue/Green/Red (không map thành STICKY_RED)
            [['Trail_01symbolID', 'Trail01symbolID'], SymbolId.TRAIL_BLUE],
            [['Trail_02symbolID', 'Trail02symbolID'], SymbolId.TRAIL_GREEN],
            [['Trail_03symbolID', 'Trail03symbolID'], SymbolId.TRAIL_RED],
        ];

        for (const [fields, clientId] of psSymbolFields) {
            for (const field of fields) {
                const psId = toPsId(ps[field]);
                if (psId != null) {
                    dynMap[psId] = clientId;
                }
            }
        }

        // TripleWild, RedWild, BlueWild — SuperNova legacy, map thành WILD
        if (typeof ps.TripleWildSymbolID === 'number' && !(ps.TripleWildSymbolID in dynMap)) {
            dynMap[ps.TripleWildSymbolID] = SymbolId.WILD;
        }
        if (typeof ps.RedWildSymbolID === 'number' && !(ps.RedWildSymbolID in dynMap)) {
            dynMap[ps.RedWildSymbolID] = SymbolId.WILD;
        }
        if (typeof ps.BlueWildSymbolID === 'number' && !(ps.BlueWildSymbolID in dynMap)) {
            dynMap[ps.BlueWildSymbolID] = SymbolId.WILD;
        }

        // Empty: map to -1 (transparent)
        const emptyPsId: number = ps.EmptySymbolID ?? 99;
        dynMap[emptyPsId] = -1;

        // ═══ Gold of Fortune: Đọc SymbolRates (credit value của mỗi loại Red Coin) ═══
        // SymbolRates = Map<int, decimal>: key=Trail PS ID (41-46), value=credit multiplier per coin
        const _symbolRatesMap: Record<number, number> = {};
        if (ps.SymbolRates && typeof ps.SymbolRates === 'object' && !Array.isArray(ps.SymbolRates)) {
            for (const [k, v] of Object.entries(ps.SymbolRates as Record<string, number>)) {
                const id = parseInt(k, 10);
                if (!isNaN(id) && typeof v === 'number') _symbolRatesMap[id] = v;
            }
        }

        // ═══ Carnival Neko Trail/Sticky defaults (PS_TO_CLIENT) nếu PS field thiếu ═══
        {
            const _cnDefaults: Record<number, number> = {
                41: SymbolId.TRAIL_BLUE,
                42: SymbolId.TRAIL_GREEN,
                43: SymbolId.TRAIL_RED,
                44: SymbolId.STICKY_GREEN,
                45: SymbolId.STICKY_YELLOW,
            };
            for (const [psId, clientId] of Object.entries(_cnDefaults)) {
                const id = parseInt(psId, 10);
                if (!(id in dynMap)) dynMap[id] = clientId;
            }
            Log.e(
                `[PS:TrailMap] CN trails/sticky: ` +
                `41→BLUE 42→GREEN 43→RED 44→STICKY_GREEN 45→STICKY_YELLOW(Gold)` +
                (_symbolRatesMap[41] != null ? ` rates=${JSON.stringify(_symbolRatesMap)}` : ''),
            );
        }

        // ═══ Normal symbols (Way Pay) — CN Low/High PS IDs ═══
        {
            const _normalSymbols: Record<number, number> = {
                1:  SymbolId.MINOR_9,      2:  SymbolId.MINOR_10,     3:  SymbolId.MINOR_J,
                4:  SymbolId.MINOR_Q,      5:  SymbolId.MINOR_K,      6:  SymbolId.MINOR_A,
                11: SymbolId.MAJOR_HORUS,     12: SymbolId.MAJOR_ANUBIS,  13: SymbolId.MAJOR_SOBEK,
                14: SymbolId.MAJOR_RAMSES,   15: SymbolId.MAJOR_CLEOPATRA,
                21: SymbolId.WILD,
            };
            for (const [psId, clientId] of Object.entries(_normalSymbols)) {
                const id = parseInt(psId, 10);
                if (!(id in dynMap)) dynMap[id] = clientId as number;
            }
            Log.e('[PS:NormalMap] CN 1–6 Low, 11–15 High, 21 Wild');
        }

        // ═══ Pick Game — 수정 후 ID (260810): 82 Grand, 83 Major, 84 Minor, 85 Mini ═══
        {
            const _pickSymbols: Record<number, number> = {
                81: SymbolId.JP_IDLE,
                82: SymbolId.JP_GRAND,
                83: SymbolId.JP_MAJOR,
                84: SymbolId.JP_MINOR,
                85: SymbolId.JP_MINI,
                86: SymbolId.JP_UPGRADE,
            };
            for (const [psId, clientId] of Object.entries(_pickSymbols)) {
                const id = parseInt(psId, 10);
                dynMap[id] = clientId as number;
            }
            Log.e('[PS:PickMap] Idle=81 Grand=82 Major=83 Minor=84 Mini=85 Upgrade=86');
        }

        // ═══ Fallback sequential: chỉ chạy khi dynMap quá ít (PS không có named fields nào) ═══
        if (Object.keys(dynMap).length <= 2 && ps.Reel?.Strips) {
            const allPsIds = new Set<number>();
            for (const strip of ps.Reel.Strips) {
                const symbols: number[] = strip.Symbols ?? strip;
                for (const id of symbols) {
                    if (id !== emptyPsId) allPsIds.add(id);
                }
            }
            const sortedIds = [...allPsIds].sort((a, b) => a - b);
            const clientSymbolOrder = [
                SymbolId.MINOR_9, SymbolId.MINOR_10, SymbolId.MINOR_J,
                SymbolId.MINOR_Q, SymbolId.MINOR_K, SymbolId.MINOR_A,
                SymbolId.MAJOR_HORUS, SymbolId.MAJOR_ANUBIS, SymbolId.MAJOR_SOBEK,
                SymbolId.MAJOR_RAMSES, SymbolId.MAJOR_CLEOPATRA, SymbolId.WILD,
                SymbolId.STICKY_YELLOW, SymbolId.STICKY_GREEN,
            ];
            for (let i = 0; i < sortedIds.length; i++) {
                const psId = sortedIds[i];
                if (!(psId in dynMap)) {
                    dynMap[psId] = clientSymbolOrder[i] ?? (i % clientSymbolOrder.length);
                }
            }
            Log.e(`[PS:SymbolMap] Fallback sequential mapping: ${sortedIds.length} unique IDs → [${sortedIds.join(',')}]`);
        }

        // ─── Log tất cả PS IDs chưa được map (để điền thủ công đúng) ───
        if (ps.Reel?.Strips) {
            const allReelIds = new Set<number>();
            for (const strip of ps.Reel.Strips) {
                const syms: number[] = strip.Symbols ?? strip;
                for (const id of syms) allReelIds.add(id);
            }
            const unmapped = [...allReelIds].filter(id => !(id in dynMap) && id !== emptyPsId).sort((a,b)=>a-b);
            const mapped   = [...allReelIds].filter(id => id in dynMap).sort((a,b)=>a-b);
            const symName  = (clientId: number) => Object.keys(SymbolId).find(n => (SymbolId as any)[n] === clientId) ?? (clientId === -1 ? 'EMPTY' : `?${clientId}`);
            Log.e(`[PS:SymbolMap] MAPPED reel IDs  : [${mapped.map(id=>`${id}→${symName(dynMap[id])}`).join(', ')}]`);
            Log.e(`[PS:SymbolMap] UNMAPPED reel IDs: [${unmapped.join(', ')}] ← cần map thủ công`);
        }

        data.psToClientMap = dynMap;

        // ═══ Store named PS symbol IDs for PayOutDisplay win-type matching ═══
        // Gold of Fortune: map PS fields (nếu có) hoặc dùng dynMap đã build
        data.psWinTypeIds = {
            oneSeven:    ps.OneSevenSymbolID    ?? -1,
            doubleSeven: ps.DoubleSevenSymbolID ?? -1,
            tripleSeven: ps.TripleSevenSymbolID ?? -1,
            anySeven:    ps.AnySevenGroupID     ?? -1,
            oneBar:      ps.OneBarSymbolID      ?? -1,
            doubleBar:   ps.DoubleBarSymbolID   ?? -1,
            anyBar:      ps.AnyBarGroupID       ?? -1,
            tripleWild:  ps.TripleWildSymbolID  ?? -1,
            redWild:     ps.RedWildSymbolID     ?? -1,
            blueWild:    ps.BlueWildSymbolID    ?? -1,
            anyWild:     ps.AnyWildGroupID      ?? -1,
        };
        // Gold of Fortune specific — WildTrailSymbolID maps to WILD
        if (ps.WildTrailSymbolID && data.psWinTypeIds.tripleWild === -1) {
            data.psWinTypeIds.tripleWild = ps.WildTrailSymbolID;
        }
        if (ps.WildSymbolID && data.psWinTypeIds.tripleWild === -1) {
            data.psWinTypeIds.tripleWild = ps.WildSymbolID;
        }
        Log.e(
            `[PS:WinTypeIds] 1x7=${data.psWinTypeIds.oneSeven} 2x7=${data.psWinTypeIds.doubleSeven} 3x7=${data.psWinTypeIds.tripleSeven} any7=${data.psWinTypeIds.anySeven}` +
            ` | 1xBAR=${data.psWinTypeIds.oneBar} 2xBAR=${data.psWinTypeIds.doubleBar} anyBAR=${data.psWinTypeIds.anyBar}` +
            ` | 3xWild=${data.psWinTypeIds.tripleWild} RWild=${data.psWinTypeIds.redWild} BWild=${data.psWinTypeIds.blueWild} anyWild=${data.psWinTypeIds.anyWild}`
        );

        // ═══ Jackpot PS Symbol IDs — từ PS JSON fields ═══
        // Server dùng các ID này trên reel strip để biểu thị jackpot symbol.
        // Client detect jackpot bằng cách so sánh rawPsStrips với các ID này.
        data.jackpotPsIds = {
            MINI:  toPsId(ps.MinijackpotSymbolID) ?? toPsId(ps.MiniJackpotSymbolID) ?? toPsId(ps.MiniJackpotID)  ?? data.jackpotPsIds.MINI,
            MINOR: toPsId(ps.MinorjackpotSymbolID) ?? toPsId(ps.MinorJackpotSymbolID) ?? toPsId(ps.MinorJackpotID) ?? data.jackpotPsIds.MINOR,
            MAJOR: toPsId(ps.MajorjackpotSymbolID) ?? toPsId(ps.MajorJackpotSymbolID) ?? toPsId(ps.MajorJackpotID) ?? data.jackpotPsIds.MAJOR,
            GRAND: toPsId(ps.GrandjackpotSymbolID) ?? toPsId(ps.GrandJackpotSymbolID) ?? toPsId(ps.GrandJackpotID) ?? data.jackpotPsIds.GRAND,
        };
        Log.d(`[PS:JackpotIDs] MINI=${data.jackpotPsIds.MINI} MINOR=${data.jackpotPsIds.MINOR} MAJOR=${data.jackpotPsIds.MAJOR} GRAND=${data.jackpotPsIds.GRAND}`);

        // ═══ Symbol Payout Multipliers (API doc V1.0.3 §5.1) ═══
        // Gold of Fortune: SymbolRates = Map<int, decimal> (JSON object, key=psId, value=rate)
        // SuperNova: Symbols = Array<{Id: int, Payout: decimal}>
        const payouts: Record<number, number> = {};
        if (ps.SymbolRates && typeof ps.SymbolRates === 'object' && !Array.isArray(ps.SymbolRates)) {
            // Gold of Fortune Map format
            for (const [k, v] of Object.entries(ps.SymbolRates as Record<string, number>)) {
                const id = parseInt(k, 10);
                if (!isNaN(id) && typeof v === 'number' && v > 0) payouts[id] = v;
            }
            Log.e(`[PS:SymbolRates] Map format count=${Object.keys(payouts).length} | ${JSON.stringify(payouts).substring(0, 400)}`);
        } else if (ps.Symbols && Array.isArray(ps.Symbols)) {
            // SuperNova Array format
            for (const sym of ps.Symbols) {
                if (typeof sym.Id === 'number') {
                    const rate = sym.Payout ?? sym.Rate ?? sym.Multiplier ?? 0;
                    if (typeof rate === 'number' && rate > 0) payouts[sym.Id] = rate;
                }
            }
            Log.e(`[PS:SymbolRates] Array format count=${Object.keys(payouts).length} | ${JSON.stringify(payouts).substring(0, 400)}`);
        } else {
            Log.e(`[PS:SymbolRates] NOT FOUND — SymbolRates type=${typeof ps.SymbolRates}, Symbols type=${typeof ps.Symbols}`);
        }
        data.symbolPayouts = payouts;
        Log.d(`[PS:SymbolPayouts] ${JSON.stringify(payouts)}`);

        // ═══ Jackpot Multipliers ═══
        {
            const jp = data.jackpotPsIds;
            const miniMult  = payouts[jp.MINI]  ?? 0;
            const minorMult = payouts[jp.MINOR] ?? 0;
            const majorMult = payouts[jp.MAJOR] ?? 0;
            const grandMult = payouts[jp.GRAND] ?? 0;
            if (miniMult > 0 || minorMult > 0 || majorMult > 0 || grandMult > 0) {
                data.config.jackpotMultipliers = {
                    MINI:  miniMult  || DEFAULT_JACKPOT_MULTS.MINI,
                    MINOR: minorMult || DEFAULT_JACKPOT_MULTS.MINOR,
                    MAJOR: majorMult || DEFAULT_JACKPOT_MULTS.MAJOR,
                    GRAND: grandMult || DEFAULT_JACKPOT_MULTS.GRAND,
                };
                Log.d(`[PS:JackpotMultipliers] MINI=${data.config.jackpotMultipliers.MINI} MINOR=${data.config.jackpotMultipliers.MINOR} MAJOR=${data.config.jackpotMultipliers.MAJOR} GRAND=${data.config.jackpotMultipliers.GRAND}`);
            } else {
                Log.w('[PS:JackpotMultipliers] Không tìm thấy trong SymbolRates — dùng fallback DEFAULT');
            }
        }

        const convertStripSet = (strips: any[], label: string, compactEmpty: boolean = false): { converted: number[][]; raw: number[][] } => {
            const rawAll: number[][] = [];
            const converted = strips.map((strip: any, idx: number) => {
                const rawSymbols: number[] = strip.Symbols ?? strip;
                const effectiveRaw = compactEmpty
                    ? rawSymbols.filter((psId: number) => psId !== emptyPsId)
                    : rawSymbols;
                rawAll.push([...effectiveRaw]);
                const mapped = effectiveRaw.map((psId: number) => dynMap[psId] ?? -2);
                const unknowns = [...new Set(rawSymbols.filter((id: number) => !(id in dynMap)))];
                if (unknowns.length > 0) {
                    Log.w(`[PS:${label}${idx}] unknown PS IDs: [${unknowns.join(',')}]`);
                }
                const empties = rawSymbols.filter((id: number) => id === emptyPsId).length;
                Log.d(`[PS:${label}${idx}] len=${rawSymbols.length} | empties=${empties} | real=${rawSymbols.length - empties} | effective=${effectiveRaw.length}${compactEmpty ? ' compacted' : ''}`);
                return mapped;
            });
            return { converted, raw: rawAll };
        };

        // ═══ Reel Strips — giữ NGUYÊN fullstrip bao gồm cả Empty ═══
        // Rand từ server index thẳng vào full strip (kể cả empty).
        // Client dùng step=1 — server trả gì vẽ đó, kể cả empty.
        if (ps.Reel?.Strips && Array.isArray(ps.Reel.Strips)) {
            const normal = convertStripSet(ps.Reel.Strips, 'Reel');
            data.config.reelStrips = normal.converted;
            data.rawPsStrips = normal.raw;

            // ─── DEBUG: dump raw strips (20 symbols / dòng để tránh truncate) ───
            const _symName = (clientId: number) => {
                if (clientId === -1) return 'EMPTY';
                if (clientId === -2 || clientId === undefined) return '???';
                return Object.keys(SymbolId).find(n => (SymbolId as any)[n] === clientId) ?? `?${clientId}`;
            };
            data.rawPsStrips.forEach((rawStrip, c) => {
                const clientStrip = data.config.reelStrips[c];
                const uniqueIds = [...new Set(rawStrip)].sort((a,b)=>a-b);
                Log.e(`[PS:STRIP:Reel${c}] len=${rawStrip.length} | unique PS IDs: [${uniqueIds.join(',')}]`);
                // Print in chunks of 20 to avoid console truncation
                for (let start = 0; start < rawStrip.length; start += 20) {
                    const chunk = rawStrip.slice(start, start + 20);
                    const part = chunk.map((psId, j) => {
                        const ci = clientStrip[start + j];
                        return `[${start+j}]${psId}(${_symName(ci)})`;
                    }).join(' ');
                    Log.e(`[PS:STRIP:Reel${c}] idx ${start}-${Math.min(start+19,rawStrip.length-1)}: ${part}`);
                }
            });

            // ─── DEBUG: in tất cả named PS symbol ID fields (Gold of Fortune specific) ───
            const psSymbolIds = [
                'WildSymbolID','FreeSpinTrailsymbolID',
                'TopupYellowSymbolID','TopupGreenSymbolID','TopupSpinAddsymbolID',
                'Trail01symbolID','Trail02symbolID','Trail03symbolID',
                'Trail04symbolID','Trail05symbolID','Trail06symbolID',
                'EmptySymbolID','ScatterSymbolID',
                'WildTrailSymbolID','TripleWildSymbolID','RedWildSymbolID','BlueWildSymbolID',
                'MiniJackpotID','MinorJackpotID','MajorJackpotID','GrandJackpotID',
            ];
            const namedIds = psSymbolIds
                .filter(f => typeof ps[f] === 'number')
                .map(f => `${f}=${ps[f]}`);
            Log.e(`[PS:NamedIDs] ${namedIds.length > 0 ? namedIds.join(' | ') : '(none found)'}`);

            // ─── SymbolRates đã được log ở phần symbolPayouts phía trên ───
        } else {
            Log.w('[PS] Không có Reel.Strips — giữ nguyên DEFAULT_REEL_STRIPS');
        }

        // ═══ FreeSpinReel.Strips ═══
        // Carnival Neko: 30 strips = 6 feature groups × 5 reels
        //   Mighty 0–4, Mega 5–9, Super 10–14, Ultra 15–19, Supreme 20–24, Ultimate 25–29
        // Legacy: <30 strips → 1 bộ FreeSpin + Secret Treasure tier keys
        const tierStrips: Record<number, number[][]> = {};
        const tierRawStrips: Record<number, number[][]> = {};

        if (ps.FreeSpinReel?.Strips && Array.isArray(ps.FreeSpinReel.Strips)) {
            const fsStripsArr = ps.FreeSpinReel.Strips as any[];
            if (fsStripsArr.length >= 30) {
                for (let apiType = 0; apiType <= 5; apiType++) {
                    const start = cnFreeSpinStripGroupStart(apiType);
                    const group = fsStripsArr.slice(start, start + 5);
                    const converted = convertStripSet(group, `FreeSpinReel[${start}..${start + 4}]`);
                    tierStrips[apiType] = converted.converted;
                    tierRawStrips[apiType] = converted.raw;
                }
                data.config.freeSpinReelStrips = tierStrips[0];
                data.rawPsFreeSpinStrips = tierRawStrips[0];
                Log.e('[PS] FreeSpinReel 30 strips → 6 CN feature groups (0–5)');
            } else {
                const freeSpin = convertStripSet(fsStripsArr, 'FreeSpinReel');
                data.config.freeSpinReelStrips = freeSpin.converted;
                data.rawPsFreeSpinStrips = freeSpin.raw;
                Log.d(`[PS] FreeSpinReel.Strips loaded (len=${fsStripsArr.length}) — legacy single set`);
            }
        } else {
            data.config.freeSpinReelStrips = data.config.reelStrips;
            data.rawPsFreeSpinStrips = data.rawPsStrips;
            Log.e('[PS] FreeSpinReel.Strips không có — dùng fallback normal strips cho FreeSpin (visual có thể sai)');
        }

        // ═══ Secret Treasure — 5 tier Free Spin reels (Highest…Lowest) nếu chưa có CN groups ═══
        if (Object.keys(tierStrips).length === 0) {
            for (const tier of SECRET_TREASURE_FREE_SPIN_TIERS) {
                for (const key of tier.psKeys) {
                    const reelData = ps[key];
                    if (reelData?.Strips && Array.isArray(reelData.Strips)) {
                        const converted = convertStripSet(reelData.Strips, key);
                        tierStrips[tier.reelIndex] = converted.converted;
                        tierRawStrips[tier.reelIndex] = converted.raw;
                        Log.d(`[PS] ${key}.Strips loaded → tier ReelIndex=${tier.reelIndex}`);
                        break;
                    }
                }
            }
            for (const reelIndex of FREE_SPIN_TIER_REEL_INDICES) {
                if (!tierStrips[reelIndex]) {
                    tierStrips[reelIndex] = data.config.freeSpinReelStrips;
                    tierRawStrips[reelIndex] = data.rawPsFreeSpinStrips;
                    Log.w(`[PS] Tier ReelIndex=${reelIndex} không có — fallback freeSpinReelStrips`);
                }
            }
        }
        data.config.freeSpinTierStrips = tierStrips;
        data.rawPsFreeSpinTierStrips = tierRawStrips;

        // ═══ TopUpGameReels / Respin — CN Matsuri ưu tiên FreeSpinReel group 0 nếu không có TopUp sheet ═══
        if (ps.TopUpGameReels?.Strips && Array.isArray(ps.TopUpGameReels.Strips)) {
            const respin = convertStripSet(ps.TopUpGameReels.Strips, 'TopUpGameReels');
            data.config.respinReelStrips = respin.converted;
            Log.d('[PS] TopUpGameReels.Strips loaded from PS');
        } else if (ps.RespinReel?.Strips && Array.isArray(ps.RespinReel.Strips)) {
            const respin = convertStripSet(ps.RespinReel.Strips, 'RespinReel');
            data.config.respinReelStrips = respin.converted;
            Log.d('[PS] RespinReel.Strips loaded from PS');
        } else if (ps.ReSpinReel?.Strips && Array.isArray(ps.ReSpinReel.Strips)) {
            const respin = convertStripSet(ps.ReSpinReel.Strips, 'ReSpinReel');
            data.config.respinReelStrips = respin.converted;
            Log.d('[PS] ReSpinReel.Strips loaded from PS');
        } else if (tierStrips[0]?.length) {
            data.config.respinReelStrips = tierStrips[0];
            Log.d('[PS] respinReelStrips ← CN FreeSpinReel group 0 (Matsuri default)');
        } else {
            data.config.respinReelStrips = data.config.reelStrips;
            Log.w('[PS] RespinReel.Strips không có — dùng reelStrips làm fallback cho Re-Spin (normal)');
        }

        // ═══ PurchaseReel.Strips — dùng khi active feature item (ReelIndex=2) ═══
        // Dùng đúng như Normal/FreeSpin: giữ nguyên full strip (kể cả empty), Rands index trực tiếp.
        // Legacy PurchaseReel: chỉ dùng cho BuyBonus cũ. Topup đã load riêng vào respinReelStrips.
        const _purchaseReelData = ps.PurchaseReel;
        if (_purchaseReelData?.Strips && Array.isArray(_purchaseReelData.Strips)) {
            // LOG: dump full PurchaseReel object keys để xem có field nào khác ngoài Strips
            // Log.e(`[PS:PurchaseReel] Keys: ${JSON.stringify(Object.keys(ps.PurchaseReel))} | Strips.length=${ps.PurchaseReel.Strips.length}`);
            // Log.e(`[PS:PurchaseReel] Strip[0] type=${typeof ps.PurchaseReel.Strips[0]} keys=${typeof ps.PurchaseReel.Strips[0] === 'object' ? JSON.stringify(Object.keys(ps.PurchaseReel.Strips[0])) : 'N/A'}`);
            // Check if PS has MULTIPLE PurchaseReel variants (PurchaseReel2, PurchaseReel3, etc.)
            // const purchaseKeys = Object.keys(ps).filter(k => k.toLowerCase().includes('purchase'));
            // if (purchaseKeys.length > 1) {
            //     Log.e(`%c[PS:PurchaseReel] ⚠ MULTIPLE PURCHASE KEYS in PS: [${purchaseKeys.join(', ')}]`, 'color:#f00;font-weight:bold');
            //     for (const pk of purchaseKeys) {
            //         const pVal = ps[pk];
            //         if (pVal?.Strips) {
            //             Log.e(`[PS:${pk}] has Strips.length=${pVal.Strips.length}, strip lengths=[${pVal.Strips.map((s: any) => (s.Symbols ?? s).length).join(',')}]`);
            //         }
            //     }
            // }
            // // If Strips.length > 3, it might contain multiple variants for different items
            // if (ps.PurchaseReel.Strips.length > 3) {
            //     Log.e(
            //         `%c[PS:PurchaseReel] ⚠ Strips.length=${ps.PurchaseReel.Strips.length} > 3!` +
            //         ` Có thể chứa NHIỀU bộ strip cho nhiều item khác nhau (mỗi item 3 strips)!` +
            //         ` Đang chỉ dùng 3 strips đầu — có thể SAI.`,
            //         'color:#f00;font-weight:bold;font-size:14px'
            //     );
            // }
            const purchase = convertStripSet(_purchaseReelData.Strips, 'PurchaseReel');
            data.config.purchaseReelStrips = purchase.converted;
            data.rawPsPurchaseReelStrips = purchase.raw;
            // Log purchase strip giống Normal strip để so sánh cấu trúc
            const SYM_FMT2 = ['7','77','777','BAR','BB','3X','BNS','R⚡','B⚡'];
            const fmtSym2 = (id: number) => id === -1 ? '___' : (SYM_FMT2[id] ?? `?${id}`);
            purchase.converted.forEach((strip, c) => {
                Log.d(`[STRIP:PurchaseReel${c}] len=${strip.length} → [${strip.slice(0, 20).map((s, i) => `${i}:${fmtSym2(s)}`).join(', ')}...]`);
            });
        } else {
            data.config.purchaseReelStrips = data.config.reelStrips;
            data.rawPsPurchaseReelStrips = data.rawPsStrips;
            Log.e('[PS] PurchaseReel.Strips không có — dùng fallback normal strips cho Purchase (visual có thể sai)');
        }

        Log.d(`[PS:Keys] ${Object.keys(ps).join(', ')}`);

        // Đặt lại coinValue về giá trị đầu tiên từ PS
        if (data.config.coinValues.length > 0) {
            data.player.coinValue = data.config.coinValues[0];
        }

        Log.d(
            `[PS] Reels=${data.config.reelStrips.length}` +
            ` (lengths: ${data.config.reelStrips.map(s => s.length).join('/')})` +
            ` | FreeSpinReels=${data.config.freeSpinReelStrips.length}` +
            ` (lengths: ${data.config.freeSpinReelStrips.map(s => s.length).join('/')})` +
            ` | PurchaseReels=${data.config.purchaseReelStrips.length}` +
            ` (lengths: ${data.config.purchaseReelStrips.map(s => s.length).join('/')})` +
            ` | Bet=[${data.config.betOptions.join(',')}]` +
            ` | CoinValue=[${data.config.coinValues.join(',')}]`
        );
    }

    /**
     * Gọi Gate API (GetServiceInfo) để lấy GameServerUrl và GameParam.
     *
     * Flow theo backend:
     *   1. Decrypt gp (AES-128) → JSON { GateUrl, Token }
     *   2. GET GateUrl?gp=Token → { GameServerUrl, GameParam }
     *
     * @param gpFromUrl - Giá trị gp lấy từ URL query parameter
     * @returns { GameServerUrl, GameParam }
     */
    private async _callGateServiceInfo(gpFromUrl: string): Promise<{ GameServerUrl: string; GameParam: string }> {
        // ─── Bước 1: Decrypt gp → { GateUrl, Token } ───
        let gateUrl: string;
        let token: string;
        try {
            Log.e(`[Gate] Decrypt gp start | gpLength=${gpFromUrl.length}`);
            const decrypted = decryptGateGpAES(gpFromUrl, ServerConfig.GATE_DECRYPT_KEY);
            const parsed = JSON.parse(decrypted);
            gateUrl = parsed.GateUrl ?? parsed.gateUrl;
            token   = parsed.Token   ?? parsed.token;
            if (!gateUrl || !token) throw new Error('Missing GateUrl or Token in decrypted gp');
            Log.e(`[Gate] Decrypt gp OK | GateUrl=${gateUrl} | tokenLength=${token.length}`);
        } catch (e: any) {
            Log.e(`[Gate] Decrypt gp failed: ${e.message}`);
            throw new ServerApiError(`[Gate] Cannot decrypt gp: ${e.message}`, 0, false);
        }

        // ─── Bước 2: GET GateUrl?gp=Token → { GameServerUrl, GameParam } ───
        const gateEndpointUrl = this._buildGateEndpointUrl(gateUrl, token);
        Log.e(`[Gate] Calling GetServiceInfo: ${gateEndpointUrl}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), ServerConfig.REQUEST_TIMEOUT);
        try {
            const response = await fetch(gateEndpointUrl, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(`Gate HTTP ${response.status}: ${response.statusText}`);
            }
            const json = await response.json();
            const payload = json.Data ?? json.data ?? json.Payload ?? json.payload ?? json.Result ?? json.result ?? json;
            const gameServerUrl: string = payload.GameServerUrl ?? payload.game_svr_url ?? payload.gameServerUrl ?? payload.GameSvrUrl;
            const gameParam: string     = payload.GameParam     ?? payload.game_param     ?? payload.gameParam     ?? payload.Param ?? payload.Params;
            if (!gameServerUrl) {
                throw new Error(`Gate response missing GameServerUrl: ${JSON.stringify(json)}`);
            }
            if (!gameParam) {
                throw new Error(`Gate response missing GameParam: ${JSON.stringify(json)}`);
            }
            Log.e(`[Gate] GetServiceInfo OK | GameServerUrl=${gameServerUrl} | gameParamLength=${gameParam.length}`);
            // Xoá trailing slash nếu có
            return {
                GameServerUrl: gameServerUrl.replace(/\/$/, ''),
                GameParam:     gameParam,
            };
        } catch (err: any) {
            Log.e(`[Gate] GetServiceInfo failed: ${err.message}`);
            throw new ServerApiError(`Gate API failed: ${err.message}`, 0, false);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private _extractGpFromLocation(): string {
        if (typeof window === 'undefined' || !window.location) return '';

        const read = (raw: string): string => {
            if (!raw) return '';
            let clean = raw.startsWith('?') || raw.startsWith('#') ? raw.slice(1) : raw;
            const nestedQueryIndex = clean.indexOf('?');
            if (nestedQueryIndex >= 0) clean = clean.slice(nestedQueryIndex + 1);
            const params = new window.URLSearchParams(clean);
            return params.get('gp') ?? params.get('GP') ?? params.get('Gp') ?? '';
        };

        return read(window.location.search)
            || read(window.location.hash)
            || read(window.location.href.split('?')[1] ?? '');
    }

    private _normalizeGpToken(gp: string): string {
        return gp.trim().replace(/ /g, '+');
    }

    private _buildGateEndpointUrl(gateUrl: string, token: string): string {
        const base = gateUrl.trim().replace(/\/$/, '');
        // Nếu GateUrl đã chứa path GetServiceInfo hoặc query string → chỉ append gp
        if (/\/Gate\/GetServiceInfo/i.test(base) || base.includes('?')) {
            const sep = base.includes('?') ? '&' : '?';
            return `${base}${sep}gp=${encodeURIComponent(token)}`;
        }
        // GateUrl là base domain → nối /Gate/GetServiceInfo?gp=Token
        return `${base}${ServerConfig.GATE_API}?gp=${encodeURIComponent(token)}`;
    }

    private _getCurrentHref(): string {
        return (typeof window !== 'undefined' && window.location) ? window.location.href : '';
    }

    /**
     * Language code string cho ReqHeartBeat ({ "Lang": "ko" }) — API V1.0.2.
     * Map locale nội bộ (zh-cn/sg/…) → mã ngắn server hay dùng.
     */
    private _getLangCode(): string {
        const lang = LocalizationManager.instance.currentLanguage || 'en';
        const MAP: Record<string, string> = {
            'en': 'en', 'sg': 'en', 'au': 'en', 'hk': 'en',
            'ja': 'ja', 'ko': 'ko', 'th': 'th', 'es': 'es',
            'de': 'de', 'fr': 'fr', 'id': 'id', 'it': 'it',
            'pt': 'pt', 'tr': 'tr', 'vi': 'vi',
            'zh-cn': 'zh', 'zh-tw': 'zh',
            'km': 'km', 'fil': 'fil', 'ms': 'ms', 'hi': 'hi',
        };
        return MAP[lang] ?? 'en';
    }

    /**
     * Map ngôn ngữ game hiện tại → Country Code (LID / LangID) theo bảng API doc.
     * Country Code Table:
     *   0=en, 1=ja, 2=ko, 3=th, 4=es, 5=de, 6=fr, 7=id, 8=it, 9=pt,
     *   10=tr, 11=vi, 12=zh-cn, 13=zh-cn, 14=zh-tw, 15=zh-tw, 16=km,
     *   17=fil, 18=ms, 19=es, 20=hi
     */
    private _getLangId(): number {
        const lang = LocalizationManager.instance.currentLanguage;
        const MAP: Record<string, number> = {
            'en':    0,   // English
            'sg':    0,   // Singapore English
            'au':    0,   // Australia English
            'hk':    0,   // Hong Kong English
            'ja':    1,   // Japanese
            'ko':    2,   // Korean
            'th':    3,   // Thai
            'es':    4,   // Spanish / Spanish Latin
            'de':    5,   // German
            'fr':    6,   // French
            'id':    7,   // Indonesian
            'it':    8,   // Italian
            'pt':    9,   // Portuguese
            'tr':    10,  // Turkish
            'vi':    11,  // Vietnamese
            'zh-cn': 12,  // Chinese Simplified
            'zh-tw': 14,  // Chinese Traditional
            'km':    16,  // Cambodia
            'fil':   17,  // Tagalog-Philippines
            'ms':    18,  // Melayu
            'hi':    20,  // Hindi-India
        };
        return MAP[lang] ?? 0;
    }

    /** Parse SMM (Server Maintenance Message) */
    private _parseSMM(raw: any): ServerMaintenanceMessage {
        return {
            ServerUtc: raw.ServerUtc,
            ShutdownUtc: raw.ShutdownUtc,
            Title: raw.Title,
            Line1: raw.Line1,
            Line2: raw.Line2,
            RemainMinutes: raw.RemainMinutes,
            DurationMinutes: raw.DurationMinutes,
            Step: raw.Step,
        };
    }
}

// ═══════════════════════════════════════════════════════════
//  NETWORK MANAGER SINGLETON
// ═══════════════════════════════════════════════════════════

export class NetworkManager {
    private static _instance: NetworkManager;
    private _adapter: INetworkAdapter;

    /** HeartBeat interval ID */
    private _heartBeatTimer: any = null;
    /** Jackpot polling interval ID */
    private _jackpotTimer: any = null;

    private constructor() {
        // ★ Log WinPopup tiers khi Enter (chỉ debug) — tag riêng 'winpopup' để không lẫn log PS khác.
        if (ENABLE_DEBUG_TOOLS) {
            Log.enable('winpopup');
        }

        // ★ Chuyển đổi Mock ↔ Real dựa trên USE_REAL_API
        if (USE_REAL_API) {
            this._adapter = new RealNetworkAdapter();
            // Log.d('[NetworkManager] Mode: REAL API');
        } else {
            this._adapter = new MockNetworkAdapter();
            // Log.d('[NetworkManager] Mode: MOCK DATA');
        }
    }

    static get instance(): NetworkManager {
        if (!this._instance) {
            this._instance = new NetworkManager();
        }
        return this._instance;
    }

    /** Cho phép inject adapter khác (forced test scenario, etc.) */
    setAdapter(adapter: INetworkAdapter): void {
        this._adapter = adapter;
    }

    get isRealAPI(): boolean {
        return USE_REAL_API;
    }

    // ─── API METHODS ───

    /**
     * Login vào server.
     * @param params - { gp: string } cho WebLink login, hoặc undefined cho test login
     */
    login(params?: any): Promise<ServerSession> {
        this._logoutSent = false;
        return this._adapter.login(params);
    }

    /** Enter game — nhận config + initial state */
    enterGame(): Promise<ServerEnterResponse> {
        return this._adapter.enterGame();
    }

    sendSpinRequest(isFreeSpin: boolean): Promise<SpinResponse> {
        const data = GameData.instance;
        const pick = data.pickGameState;
        if (pick && !pick.wonTier && !(data.pickGameWinAmount > 0)) {
            Log.e('[Network] Spin blocked — Pick Game still in progress (use /Pick)');
            return Promise.reject(new Error('Spin blocked: Pick Game in progress'));
        }
        return this._adapter.sendSpinRequest(isFreeSpin);
    }

    sendClaimRequest(): Promise<ClaimResult> {
        return this._adapter.sendClaimRequest();
    }

    sendPickRequest(pickIndex: number): Promise<ServerPickResponse> {
        return this._adapter.sendPickRequest(pickIndex);
    }

    /**
     * @deprecated CN: bet/coin sync qua /Spin. GameOptChange chỉ dùng cho broadcast
     * → gọi sendBroadcastOptionChange. Method này no-op để tránh tắt UseBroadcast nhầm.
     */
    sendGameOptChange(): Promise<void> {
        if (!USE_REAL_API) return Promise.resolve();
        const data = GameData.instance;
        const coinValueIndex = data.config.coinValues.indexOf(data.player.coinValue);
        return this._adapter.sendGameOptChange(data.player.betIndex, coinValueIndex);
    }

    /** Bật/tắt nhận Global Win Broadcast trên server (GameOptChange Opt=0 UseBroadcast) */
    sendBroadcastOptionChange(enabled: boolean): Promise<void> {
        if (!USE_REAL_API) return Promise.resolve();
        return this._adapter.sendBroadcastOptionChange(enabled);
    }

    /** Lấy danh sách gói Feature (Buy Bonus) */
    sendFeatureItemGet(): Promise<FeatureItem[]> {
        return this._adapter.sendFeatureItemGet();
    }

    /** Mua gói Feature (Buy Bonus) — SeqRequest */
    sendFeatureItemBuy(itemId: number, onOff: boolean = false): Promise<{ isSuccess: boolean; remainCash: number; res: any | null }> {
        return this._adapter.sendFeatureItemBuy(itemId, onOff);
    }

    /** Refresh balance từ partner callback (dùng khi insufficient funds, e.g. top-up) */
    sendBalanceGet(): Promise<{ balance: number; currency: string }> {
        return this._adapter.sendBalanceGet();
    }

    /** Lấy thông tin Cash Race + bảng xếp hạng (NormalRequest) */
    sendCashRaceMyRankGetFirst(): Promise<CashRaceMyRankGetFirstResponse | null> {
        return this._adapter.sendCashRaceMyRankGetFirst();
    }

    /** Cash Race rank page (Top / pagination) */
    sendCashRaceMyRankGetPage(
        pageItemCnt: number = 5,
        startRank: number = 1,
    ): Promise<CashRaceMyRankGetPageResponse | null> {
        return this._adapter.sendCashRaceMyRankGetPage(pageItemCnt, startRank);
    }

    private _logoutSent = false;

    /** Kết thúc session server (/Auth/ReqLogout) — gọi tối đa 1 lần / session. */
    sendLogout(): Promise<void> {
        if (!USE_REAL_API) return Promise.resolve();
        if (this._logoutSent) return Promise.resolve();
        this._logoutSent = true;
        return this._adapter.sendLogout();
    }

    /** Bắt đầu polling jackpot (mỗi 2 giây) */
    startJackpotPolling(): void {
        this.stopJackpotPolling();
        if (!USE_REAL_API) return; // Mock không cần poll
        const pollOnce = async () => {
            try {
                await this._adapter.pollJackpot();
            } catch (err) {
                if (PopUpMessage.popupCaseFromError(err as Error) === PopupCase.RELOGIN) {
                    Log.w('[Jackpot Poll] Session invalidated — stopping all polling.');
                    this.dispose();
                    return;
                }
                Log.w('[Jackpot Poll] Error:', err);
            }
        };
        void pollOnce();
        this._jackpotTimer = setInterval(pollOnce, ServerConfig.JACKPOT_POLL_INTERVAL);
    }

    stopJackpotPolling(): void {
        if (this._jackpotTimer) {
            clearInterval(this._jackpotTimer);
            this._jackpotTimer = null;
        }
    }

    /** Bắt đầu HeartBeat (mỗi 10 giây) + đăng ký logout khi rời trang */
    startHeartBeat(): void {
        this.stopHeartBeat();
        if (!USE_REAL_API) return;
        this._ensureLogoutOnUnload();
        this._heartBeatTimer = setInterval(async () => {
            try {
                await this._adapter.sendHeartBeat();
            } catch (err) {
                if (PopUpMessage.popupCaseFromError(err as Error) === PopupCase.RELOGIN) {
                    Log.w('[HeartBeat] Session invalidated — stopping all polling.');
                    this.dispose();
                    return;
                }
                Log.w('[HeartBeat] Error:', err);
            }
        }, ServerConfig.HEARTBEAT_INTERVAL);
    }

    stopHeartBeat(): void {
        if (this._heartBeatTimer) {
            clearInterval(this._heartBeatTimer);
            this._heartBeatTimer = null;
        }
    }

    private _logoutUnloadBound = false;
    private _onPageUnload = (): void => {
        // fire-and-forget — browser có thể kill tab trước khi await xong
        void this.sendLogout();
    };

    private _ensureLogoutOnUnload(): void {
        if (this._logoutUnloadBound || typeof window === 'undefined') return;
        this._logoutUnloadBound = true;
        window.addEventListener('pagehide', this._onPageUnload);
        window.addEventListener('beforeunload', this._onPageUnload);
    }

    /** Dọn dẹp tất cả timers (+ logout 1 lần khi dispose chủ động) */
    dispose(): void {
        this.stopJackpotPolling();
        this.stopHeartBeat();
        if (typeof window !== 'undefined' && this._logoutUnloadBound) {
            window.removeEventListener('pagehide', this._onPageUnload);
            window.removeEventListener('beforeunload', this._onPageUnload);
            this._logoutUnloadBound = false;
        }
        void this.sendLogout();
    }
}
export { USE_REAL_API };

