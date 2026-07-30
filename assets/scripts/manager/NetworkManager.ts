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
    NwCashRaceInfoDetail,
    NwCashRaceRankerSimple,
    ServerFeatureItemGetResponse,
    ServerFeatureItemBuyResponse,
    ServerBalanceGetResponse,
    SelectFeatureResponse,
    TopupReelSlot,
    TopupReelType,
    PickGameState,
    PS_TO_CLIENT,
    SECRET_TREASURE_FREE_SPIN_TIERS,
    FREE_SPIN_TIER_REEL_INDICES,
    isFreeSpinTierReelIndex,
    StickyCell,
    ForceFeatureEntryData,
    FEATURE_ENTRY_REQUIRED_STICKY,
    pickForcedStickyValue,
    isSticky,
    gaugeStageFromAccumulated,
} from '../data/SlotTypes';
import { MockDataProvider, TestScenario } from '../data/MockDataProvider';
import { WaysPayCalculator } from '../data/WaysPayCalculator';
import { GameData } from '../data/GameData';
import { USE_REAL_API, ENABLE_DEBUG_TOOLS, ServerConfig, TestLoginConfig, MOCK_SPIN_SCENARIO, DEBUG_RANDS, MOCK_RESUME_SCENARIO } from '../data/ServerConfig';
import {
    SCENARIO_NO_WIN, SCENARIO_NORMAL_WIN, SCENARIO_MULTI_LINE, SCENARIO_BIG_WIN,
    SCENARIO_LONG_SPIN, SCENARIO_JACKPOT, FULL_FREE_SEQUENCE, FULL_FREE_JACKPOT_SEQUENCE, FULL_FREE_RETRIGGER_SEQUENCE, DEFAULT_SEQUENCE,
    BUY_FREE_SPIN_SEQUENCE, FORCE_FEATURE_ENTRY_SEQUENCE,
    MOCK_RESUME_NORMAL_SPIN, MOCK_RESUME_FREE_SPIN_MID, MOCK_RESUME_FREE_SPIN_NEED_CLAIM,
    MOCK_RESUME_FREE_SPIN_JACKPOT_MID, MOCK_RESUME_BUY_FREE_SPIN_MID, MOCK_RESUME_BUY_FREE_SPIN_NEED_CLAIM,
    MOCK_RESUME_TOPUP_MID, MOCK_RESUME_TOPUP_NEED_CLAIM, MOCK_RESUME_PICK_GAME,
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
    /** Select Topup / FreeSpin after FEATURE_SELECT */
    sendSelectFeature(nextStage: SlotStageType, reelIndex?: number): Promise<SelectFeatureResponse>;
    /** Pick Game — gửi PickIndex khi người chơi bấm ô */
    sendPickRequest(pickIndex: number): Promise<ServerPickResponse>;
    /** Claim winnings (free spin kết thúc, pick game, etc.) */
    sendClaimRequest(): Promise<{ balance: number; winCash?: number; winGrade?: string; claimTotalWin?: number; topLevelWinCash?: number }>;
    /** Poll jackpot values (mỗi 2 giây) */
    pollJackpot(): Promise<ServerJackpotResponse>;
    /** HeartBeat (mỗi 10 giây) */
    sendHeartBeat(): Promise<void>;
    /** Notify server immediately when bet/coinValue changes */
    sendGameOptChange(betIndex: number, coinValueIndex: number): Promise<void>;
    /** Toggle server win broadcast reception on/off */
    sendBroadcastOptionChange(enabled: boolean): Promise<void>;
    /** Lấy danh sách gói Feature (Buy Bonus) */
    sendFeatureItemGet(): Promise<FeatureItem[]>;
    /** Mua gói Feature (Buy Bonus) — onOff: true = activate, false = cancel (itemId=0) */
    sendFeatureItemBuy(itemId: number, onOff: boolean): Promise<{ isSuccess: boolean; remainCash: number; res: any | null }>;
    /** Refresh balance từ partner callback (dùng khi insufficient funds, e.g. top-up) */
    sendBalanceGet(): Promise<{ balance: number; currency: string }>;
    /** Lấy thông tin Cash Race + bảng xếp hạng */
    sendCashRaceMyRankGetFirst(): Promise<CashRaceMyRankGetFirstResponse | null>;
}

// ─── Gauge API field helpers (StickyAccumulated / StickyEarned) ─────────────
/** Normal-spin only. Sticky* là nguồn chính; PotCount/WildCount chỉ fallback legacy. */
const GAUGE_ACCUMULATED_KEYS = [
    'StickyAccumulated', 'stickyAccumulated',
    'PotCount', 'potCount',
] as const;
const GAUGE_EARNED_KEYS = [
    'StickyEarned', 'stickyEarned', 'StickyEarnedCount', 'stickyEarnedCount',
    'WildCount', 'wildCount',
] as const;

interface GaugePick {
    value: number;
    key: string;
    sourceIndex: number;
}

function _pickGaugeNumberWithKey(src: any, keys: readonly string[]): { value: number; key: string } | undefined {
    if (!src || typeof src !== 'object') return undefined;
    for (const k of keys) {
        const v = src[k];
        if (typeof v === 'number' && Number.isFinite(v)) return { value: v, key: k };
        if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
            return { value: Number(v), key: k };
        }
    }
    return undefined;
}

function _pickGaugeNumber(src: any, keys: readonly string[]): number | undefined {
    return _pickGaugeNumberWithKey(src, keys)?.value;
}

/** Dump mọi key liên quan gauge trong object (để đối chiếu raw server). */
function _dumpGaugeRelatedKeys(src: any, label: string): string {
    if (!src || typeof src !== 'object') return `${label}=<null>`;
    const hits: string[] = [];
    for (const k of Object.keys(src)) {
        if (/pot|wild|sticky|gauge|lighting|earned|accumul/i.test(k)) {
            hits.push(`${k}=${JSON.stringify(src[k])}`);
        }
    }
    return hits.length ? `${label}{${hits.join(', ')}}` : `${label}{<no pot/wild/sticky keys>}`;
}

/** Ưu tiên nguồn đầu tiên có giá trị: Res → LastSpinResponse → Ack root. */
function resolveGaugeApiFields(...sources: any[]): {
    /** StickyAccumulated (cumulative Red Sticky) — drive 10 ô gauge. */
    stickyAccumulated?: number;
    /** StickyEarned (Red Sticky landed this spin). */
    stickyEarned?: number;
    accumulatedPick?: GaugePick;
    earnedPick?: GaugePick;
    /** @deprecated alias — giữ tương thích call site cũ. */
    potCount?: number;
    /** @deprecated alias — giữ tương thích call site cũ. */
    wildCount?: number;
    potPick?: GaugePick;
    wildPick?: GaugePick;
} {
    let accumulatedPick: GaugePick | undefined;
    let earnedPick: GaugePick | undefined;
    for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        if (!accumulatedPick) {
            const p = _pickGaugeNumberWithKey(src, GAUGE_ACCUMULATED_KEYS);
            if (p) accumulatedPick = { ...p, sourceIndex: i };
        }
        if (!earnedPick) {
            const w = _pickGaugeNumberWithKey(src, GAUGE_EARNED_KEYS);
            if (w) earnedPick = { ...w, sourceIndex: i };
        }
        if (accumulatedPick && earnedPick) break;
    }
    return {
        stickyAccumulated: accumulatedPick?.value,
        stickyEarned: earnedPick?.value,
        accumulatedPick,
        earnedPick,
        potCount: accumulatedPick?.value,
        wildCount: earnedPick?.value,
        potPick: accumulatedPick,
        wildPick: earnedPick,
    };
}

function logFeatureGauge(
    stickyAccumulated?: number,
    stickyEarned?: number,
    detail?: {
        accumulatedPick?: GaugePick;
        earnedPick?: GaugePick;
        potPick?: GaugePick;
        wildPick?: GaugePick;
        sources?: any[];
        sourceLabels?: string[];
    },
): void {
    const accPick = detail?.accumulatedPick ?? detail?.potPick;
    const earnPick = detail?.earnedPick ?? detail?.wildPick;
    const accSrc = accPick
        ? ` from ${detail?.sourceLabels?.[accPick.sourceIndex] ?? `src[${accPick.sourceIndex}]`}.${accPick.key}`
        : ' (missing)';
    const earnSrc = earnPick
        ? ` from ${detail?.sourceLabels?.[earnPick.sourceIndex] ?? `src[${earnPick.sourceIndex}]`}.${earnPick.key}`
        : ' (missing)';
    const stage = stickyAccumulated != null ? gaugeStageFromAccumulated(stickyAccumulated) : 'n/a';
    Log.e(
        `[FeatureGauge] StickyAccumulated=${stickyAccumulated ?? 'n/a'}${accSrc}` +
        ` | StickyEarned=${stickyEarned ?? 'n/a'}${earnSrc}` +
        ` | stage=${stage}/10`
    );
    if (detail?.sources?.length) {
        const labels = detail.sourceLabels ?? detail.sources.map((_, i) => `src[${i}]`);
        const dumps = detail.sources.map((s, i) => _dumpGaugeRelatedKeys(s, labels[i] ?? `src[${i}]`));
        Log.e(`[FeatureGauge] RAW keys: ${dumps.join(' || ')}`);
    }
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

    /** Log gauge từ mock SpinResponse (stickyAccumulated / stickyEarned). */
    private _finishMockSpin(resp: SpinResponse): SpinResponse {
        if (GameData.instance.currentMode === 'normal' && (resp.reelIndex ?? 0) === 0) {
            const g = resolveGaugeApiFields(resp);
            logFeatureGauge(g.stickyAccumulated, g.stickyEarned, {
                accumulatedPick: g.accumulatedPick,
                earnedPick: g.earnedPick,
                sources: [resp],
                sourceLabels: ['MockSpin'],
            });
        }
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
            case 'feature_respin':      this._queue = [...FULL_FREE_SEQUENCE];           break;
            case 'feature_freespin':    this._queue = [...FULL_FREE_JACKPOT_SEQUENCE];   break;
            case 'force_feature_entry': this._queue = [...FORCE_FEATURE_ENTRY_SEQUENCE]; break;
            case 'pot_win':             this._queue = [...FULL_FREE_RETRIGGER_SEQUENCE]; break;
            case 'wild_trail':          this._queue = [];                                break; // dùng ForcedMockAdapter một spin riêng
            case 'grand_jackpot':       this._queue = [SCENARIO_JACKPOT];               break;
            case 'sequence':            this._queue = [...DEFAULT_SEQUENCE];             break;
            default:                    this._queue = [];                                break; // 'random'
        }
        this._queueIdx = 0;
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
            Log.d(`[MockAdapter] BuyFreeSpin #${this._buyQueueIdx}/${this._buyQueue.length} — nextStage=${resp.nextStage}, remain=${resp.remainFreeSpinCount}`);
            if (this._buyQueueIdx >= this._buyQueue.length) {
                Log.d('[MockAdapter] Buy Free Spin queue hết — reset');
                this._buyQueue = [];
                this._buyQueueIdx = 0;
            }
            return resp;
        }

        // ★ KHI DANG FREE SPIN: luôn dùng generateSpinResponse để đảm bảo nextStage đúng
        // (FREE_SPIN/FREE_SPIN_END theo freeSpinRemaining hiện tại).
        // Queue từ MOCK_SPIN_SCENARIO có thể chứa nextStage=SPIN (no_win/normal_win/jackpot...)
        // → nếu dùng queue trong free spin sẽ gây thoát free spin mode sớm/sai.
        if (isFreeSpin) {
            const resp = MockDataProvider.generateSpinResponse(true);
            Log.d(`[MockAdapter] FreeSpin (generateResponse) — nextStage=${resp.nextStage}, remain=${resp.remainFreeSpinCount}, win=${resp.totalWin}`);
            return resp;
        }

        // ★ TopUp / Re-Spin: KHÔNG dùng queue — luôn generateRespin() để đảm bảo
        // nextStage=TOPUP_SPIN/TOPUP_SPIN_END đúng và stickyCells được tạo đúng.
        // Queue chứa NORMAL spin responses (nextStage=SPIN) sẽ làm TopUp freeze.
        if (GameData.instance.currentMode === 'respin' || GameData.instance.currentMode === 'matsuri') {
            const resp = MockDataProvider.generateSpinResponse(false);
            Log.d(`[MockAdapter] ${GameData.instance.currentMode} — nextStage=${resp.nextStage}, remain=${resp.remainRespinCount}, win=${resp.totalWin}`);
            return resp;
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

        // ★ wild_trail: mỗi spin build fresh WILD_TRAIL_ONE (1 wild, nextStage=SPIN) để test tích lũy Pot
        if (MOCK_SPIN_SCENARIO === 'wild_trail') {
            return this._finishMockSpin(MockDataProvider.buildScenario(TestScenario.WILD_TRAIL_ONE));
        }

        // Fallback: tạo ngẫu nhiên (MOCK_SPIN_SCENARIO = 'random')
        return this._finishMockSpin(MockDataProvider.generateSpinResponse(false));
    }

    async sendSelectFeature(nextStage: SlotStageType, reelIndex: number = 0): Promise<SelectFeatureResponse> {
        await this._delay(50);
        const remain = nextStage === SlotStageType.TOPUP_SPIN_START
            ? 6
            : (reelIndex >= 2 && reelIndex <= 6 ? 20 - (reelIndex - 2) * 2 : 8);
        return { nextStage, remainFeatureSpinCount: remain, reelIndex };
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

        const psSymMap: Record<number, number> = {
            [SymbolId.JP_GRAND]: 82, [SymbolId.JP_MAJOR]: 83,
            [SymbolId.JP_MINOR]: 84, [SymbolId.JP_MINI]:  85,
        };

        // Build full PickGame array (12 server symbol IDs) — giống real API
        const pickGameIds: number[] = [];
        for (let i = 0; i < pickState.grid.length; i++) {
            const clientSym = pickState.grid[i];
            const serverSymId = psSymMap[clientSym] ?? 85;
            pickGameIds.push(serverSymId);
        }

        // Accumulate revealed coins (server-side state)
        const revealed = (pickState.revealed ?? []).concat(pickIndex);
        pickState.revealed = revealed;

        const tierCounts: Record<number, number> = {};
        for (const idx of revealed) {
            const s = pickState.grid[idx];
            if (s != null) tierCounts[s] = (tierCounts[s] ?? 0) + 1;
        }
        const isJackpot = Object.values(tierCounts).some(c => c >= 3);
        const jpIndexMap: Record<number, number> = {
            [SymbolId.JP_MINI]: 0, [SymbolId.JP_MINOR]: 1,
            [SymbolId.JP_MAJOR]: 2, [SymbolId.JP_GRAND]: 3,
        };
        const wonSym = isJackpot ? Object.entries(tierCounts).find(([, c]) => c >= 3)?.[0] : undefined;
        const jackpotIndex = wonSym ? (jpIndexMap[Number(wonSym)] ?? 0) : 0;

        // ★ Persist wonTier nếu jackpot — để progressive win / claim xử lý đúng
        const symToTierName: Record<number, 'GRAND' | 'MAJOR' | 'MINOR' | 'MINI'> = {
            [SymbolId.JP_GRAND]: 'GRAND',
            [SymbolId.JP_MAJOR]: 'MAJOR',
            [SymbolId.JP_MINOR]: 'MINOR',
            [SymbolId.JP_MINI]: 'MINI',
        };
        if (isJackpot && wonSym != null) {
            pickState.wonTier = symToTierName[Number(wonSym)];
        }

        // PickWin mock = meter jackpot hiện tại từ API/poll (không hardcode multiplier)
        const jpIdx = wonSym != null ? (jpIndexMap[Number(wonSym)] ?? -1) : -1;
        const meter = jpIdx >= 0 ? (GameData.instance.jackpotValues[jpIdx] ?? 0) : 0;
        const winCash = isJackpot && meter > 0 ? meter : 0;

        return {
            PickGame: pickGameIds,
            IsJackpot: isJackpot,
            JackpotIndex: jackpotIndex,
            NextStage: isJackpot ? SlotStageType.PICK_END : SlotStageType.PICK,
            PickWin: winCash,
        };
    }

    async sendClaimRequest(): Promise<{ balance: number; winCash?: number; winGrade?: string; claimTotalWin?: number; topLevelWinCash?: number }> {
        await this._delay(100);
        const data = GameData.instance;
        const winCash = data.currentMode === 'respin' ? data.respinTotalWin : data.freeSpinTotalWin;

        // Nếu freeSpinTotalWin được restore từ server (resume scenario), số đó đã bao gồm
        // toàn bộ tiền thắng trước khi tắt game. Chỉ cộng vào balance 1 lần ở đây.
        // _onFreeSpinEndPopupClosed sẽ KHÔNG add lại (vì flag = true).
        const newBalance = data.player.balance + winCash;

        // Reset buy queue + normal queue khi claim xong
        this._buyQueue = [];
        this._buyQueueIdx = 0;
        this._queueIdx = this._savedQueueIdx;
        Log.d(`[MockAdapter] Claim: winCash=${winCash}, newBalance=${newBalance}, wasRestoredFromServer=${data.freeSpinTotalWinRestoredFromServer}`);
        return { balance: newBalance, winCash, claimTotalWin: winCash, topLevelWinCash: winCash };
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
        // Mock: no-op
    }

    async sendBroadcastOptionChange(_enabled: boolean): Promise<void> {
        // Mock: no-op
    }

    async sendFeatureItemGet(): Promise<FeatureItem[]> {
        await this._delay(200);
        const totalBet = GameData.instance.totalBet;
        // Mock: PriceRatio = 100 × totalBet ÷ totalBet = 100
        return [{
            itemId:      101,
            name:        'Free Spin Buy',
            title:       'BUY FREE SPINS',
            desc:        'Pay to trigger the FREE SPINS feature.',
            priceRatio:  100,
            effectType:  1,
            imgUrl:      '',
            addSpinValue: 10,
        }];
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
        const cost = totalBet * 100;
        const newBalance = data.player.balance - cost;
        if (newBalance < 0) {
            Log.d(`[MockAdapter] FeatureItemBuy FAILED: balance=${data.player.balance} < cost=${cost}`);
            return { isSuccess: false, remainCash: data.player.balance, res: null };
        }

        // Inject buy free spin queue — 10 vòng mock
        this._savedQueueIdx = this._queueIdx;
        this._buyQueue = [...BUY_FREE_SPIN_SEQUENCE];
        this._buyQueueIdx = 0;
        Log.d(`[MockAdapter] FeatureItemBuy SUCCESS: cost=${cost}, newBalance=${newBalance}, injected ${this._buyQueue.length} buy spins`);

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

        const enterResp: ServerEnterResponse = {
            cash: raw.Cash,
            slotName: raw.SlotName,
            ps: raw.PS,
            betIndex: raw.BetIndex,
            coinValueIndex: raw.CoinValueIndex,
            lastSpinResponse: raw.LastSpinResponse,
            isPractice: raw.IsPractice,
            memberIdx: raw.MemberIdx,
            smm: raw.SMM ? this._parseSMM(raw.SMM) : null,
        };

        data.isEntered = true;
        data.player.balance = enterResp.cash;
        data.player.betIndex = enterResp.betIndex;
        // Lưu raw lastSpinResponse để GameManager detect Free Spin resume.
        // Field names có thể là camelCase (stageType) theo API doc 5.1.
        data.rawEnterLastSpinResponse = raw.LastSpinResponse ?? null;

        // ─── SYNC POT + GAUGE từ Enter response ───
        const ls = raw.LastSpinResponse;
        const enterPotVisualLevel = (raw as any).PotVisualLevel ?? ls?.PotVisualLevel;
        const enterStickyAccumulated = ls?.StickyAccumulated ?? (ls as any)?.stickyAccumulated;
        const enterGauge = resolveGaugeApiFields(ls, raw);
        logFeatureGauge(enterGauge.stickyAccumulated, enterGauge.stickyEarned, {
            accumulatedPick: enterGauge.accumulatedPick,
            earnedPick: enterGauge.earnedPick,
            sources: [ls, raw],
            sourceLabels: ['LastSpinResponse', 'EnterRoot'],
        });

        if (enterPotVisualLevel != null) {
            data.potLevel = Math.max(0, Math.min(6, enterPotVisualLevel as number));
        }
        const enterAccumulated = enterGauge.stickyAccumulated ?? enterStickyAccumulated ?? null;
        if (enterAccumulated != null) {
            data.featureGaugeAccumulated = enterAccumulated as number;
            data.featureGaugeStage = gaugeStageFromAccumulated(data.featureGaugeAccumulated);
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

        const requestData = {
            BetIndex: data.player.betIndex,
            BetLines: 0,
            CoinValueIndex: data.config.coinValues.indexOf(data.player.coinValue),
            DebugArray: debugRands ?? [],
            SlotId: ServerConfig.SLOT_ID,
            Dbg: '',
        };

        // ═══ LOG REQUEST (FreeSpin quan trọng: xác nhận endpoint và DebugArray) ═══
        Log.e(
            `[SPIN-REQ] isFreeSpin=${_isFreeSpin}` +
            ` | Endpoint=${ServerConfig.getEndpoint(ServerConfig.API.SPIN)}` +
            ` | BetIndex=${requestData.BetIndex}` +
            ` | CoinValueIndex=${requestData.CoinValueIndex}` +
            ` | DebugArray=${JSON.stringify(requestData.DebugArray)}` +
            ` | CurrentStage(client)=${data.freeSpinRemaining > 0 ? 'FreeSpin(remain=' + data.freeSpinRemaining + ')' : 'NormalSpin'}`
        );

        if (debugRands) {
            Log.e(`[SPIN-REQ] Force DebugRands=${JSON.stringify(debugRands)}`);
        }

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

        this._checkResponseCode(responsePacket);
        data.updateSeq(responsePacket[4]);

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
        const prevJackpot = data.jackpotValues?.slice?.() ?? [];
        const jackpotBefore = _normalizeJackpotValues(raw.Before);
        if (jackpotBefore) {
            data.jackpotValuesBefore = jackpotBefore;
            Log.e(`[Jackpot] Spin Before=[${jackpotBefore.join(',')}]`);
        } else if (raw.Before) {
            Log.e(`[Jackpot] Spin Before parse fail raw.Before=${JSON.stringify(raw.Before)}`);
        }

        const jackpotAfter = _normalizeJackpotValues(raw.After);
        if (jackpotAfter) {
            const changed = jackpotAfter.some((v, i) => v !== prevJackpot[i]);
            data.jackpotValues = jackpotAfter;
            Log.e(
                `[Jackpot] Spin After=[${jackpotAfter.join(',')}] prev=[${prevJackpot.join(',')}]` +
                ` changed=${changed} Before=${raw.Before == null ? 'null' : JSON.stringify(raw.Before)}`
            );
            EventBus.instance.emit(GameEvents.JACKPOT_VALUES_UPDATED, jackpotAfter);
        } else if (raw.After) {
            Log.e(`[Jackpot] Spin After parse fail raw.After=${JSON.stringify(raw.After)}`);
        } else {
            Log.e('[Jackpot] Spin — server không gửi After');
        }

        // Convert server format → internal SpinResponse
        let result: SpinResponse;
        try {
            result = this._convertSpinResponse(raw);
        } catch (convertErr: any) {
            Log.e(`[Network] ❌ _convertSpinResponse failed: ${convertErr?.message} | raw.Res keys=${Object.keys(raw?.Res ?? {}).join(',')}`, convertErr);
            throw convertErr;
        }

        // ═══ SPIN LOG ═══
        const res = raw.Res;
        const rawRands = res.Rands as number[];
        const matchedLines = res.MatchedLinePays || [];
        Log.e(
            `[SPIN-RESP] Rands=[${rawRands.join(',')}] TotalWin=$${res.TotalWin} Balance=$${raw.RemainCash} WinGrade=${res.WinGrade ?? 'null'}` +
            (matchedLines.length > 0
                ? ` Lines=[${matchedLines.map((l: any) => `L${l.PayLineIndex}:$${l.Payout}`).join(',')}]`
                : ' (no wins)')
        );

        // ─── DEBUG: Rands → raw PS strip window (row -1, 0, +1 per reel) ───
        {
            const strips = GameData.instance.rawPsStrips;
            const clientStrips = GameData.instance.config.reelStrips;
            const symName = (clientId: number) => {
                if (clientId === -1) return 'EMPTY';
                if (clientId === -2 || clientId === undefined) return '???';
                return Object.keys(SymbolId).find(n => (SymbolId as any)[n] === clientId) ?? `?${clientId}`;
            };
            if (strips && strips.length > 0 && rawRands.length === strips.length) {
                const rows: string[] = ['TOP r+1', 'MID r  ', 'BOT r-1'];
                const offsets = [1, 0, -1];
                Log.e(`[SPIN-REEL] Rands=[${rawRands.join(',')}]`);
                for (let off = 0; off < offsets.length; off++) {
                    const cells = rawRands.map((rand, reel) => {
                        const strip = strips[reel];
                        if (!strip || strip.length === 0) return `R${reel}:?`;
                        const idx = ((rand + offsets[off]) % strip.length + strip.length) % strip.length;
                        const psId = strip[idx];
                        const clientStrip = clientStrips[reel];
                        const clientId = clientStrip ? clientStrip[idx] : -2;
                        return `${psId}(${symName(clientId)})`;
                    });
                    Log.e(`[SPIN-REEL] ${rows[off]}: ${cells.map((c, i) => `Reel${i}=${c}`).join(' | ')}`);
                }
            } else {
                Log.e(`[SPIN-REEL] strips.length=${strips?.length ?? 'N/A'} rands.length=${rawRands.length} — mismatch or not loaded`);
            }
        }

        // ═══ DEBUG MULTIPLIER ═══
        // Log.d(`%c[MULTIPLIER DEBUG] FeatureMultiple=${result.featureMultiple} (từ server: FreeSpinMultiplier=${raw.Res.FreeSpinMultiplier} | FeatureMultiple=${raw.Res.FeatureMultiple} | MysteryMultiple=${raw.Res.MysteryMultiple})`, 'color:#f80;font-weight:bold');

        return result;
    }

    async sendSelectFeature(nextStage: SlotStageType, reelIndex: number = 0): Promise<SelectFeatureResponse> {
        const data = GameData.instance;
        const session = data.serverSession!;
        const apiPath = ServerConfig.API.SELECT_FEATURE;
        const requestData = {
            NextStage: nextStage,
            ReelIndex: reelIndex,
            SlotId: ServerConfig.SLOT_ID,
        };

        Log.e(`[SelectFeature] SEND request=${JSON.stringify(requestData)} seq=${data.currentSeq} url=${this._getUrl(apiPath)}`);

        const encrypted = this._encryptAES256(JSON.stringify(requestData), session.aky);
        const packet = this._buildPacket(
            apiPath,
            session.memberIdx,
            session.sessionKey,
            data.currentSeq,
            encrypted
        );

        const responsePacket = await this._sendRequestWithRetry(
            this._getUrl(apiPath),
            packet
        );

        // ★ updateSeq TRƯỚC _checkResponseCode để SEQ luôn đồng bộ ngay cả khi server trả lỗi.
        // Nếu server trả CODE != 0, SEQ trong response vẫn là SEQ tiếp theo hợp lệ.
        // Không updateSeq trước → request tiếp theo dùng SEQ cũ → thất bại dây chuyền.
        data.updateSeq(responsePacket[4]);
        this._checkResponseCode(responsePacket);

        const decrypted = this._decryptAES256(responsePacket[8], session.aky);
        const raw = JSON.parse(decrypted);
        Log.e(`[SelectFeature] request=${JSON.stringify(requestData)} ack=${JSON.stringify(raw)}`);

        if (raw.SMM) {
            EventBus.instance.emit(GameEvents.SERVER_MAINTENANCE, this._parseSMM(raw.SMM));
        }

        return {
            nextStage: raw.NextStage ?? nextStage,
            remainFeatureSpinCount: raw.RemainFeatureSpinCount ?? raw.RemainFreeSpinCount ?? 0,
            reelIndex: raw.ReelIndex ?? reelIndex,
        };
    }

    // ─── CLAIM ───

    async sendPickRequest(pickIndex: number): Promise<ServerPickResponse> {
        const data = GameData.instance;
        const session = data.serverSession!;
        const requestData = { PickIndex: pickIndex, SlotId: ServerConfig.SLOT_ID };
        Log.e(`[Pick] SEND PickIndex=${pickIndex} seq=${data.currentSeq}`);
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
        Log.e(`[Pick] FULL OUTER RESPONSE: ${JSON.stringify(outer)}`);
        // Server can return either {RemainCash, Res: GFPickResponse}
        // or {RemainCash, Res: {GFPickResponse}} depending on backend version.
        const res = outer.Res ?? outer;
        const pickRes = res.GFPickResponse ?? res.gFPickResponse ?? res.PickResponse ?? res;
        const raw: ServerPickResponse = {
            ...pickRes,
            PickGame: pickRes.PickGame ?? pickRes.pickGame ?? [],
            PickResults: pickRes.PickResults ?? pickRes.pickResults,
            PickStage: pickRes.PickStage ?? pickRes.pickStage,
            PickWin: pickRes.PickWin ?? pickRes.pickWin ?? pickRes.WinCash ?? pickRes.winCash ?? 0,
            IsJackpot: pickRes.IsJackpot ?? pickRes.isJackpot ?? false,
            JackpotIndex: pickRes.JackpotIndex ?? pickRes.jackpotIndex ?? -1,
            NextStage: pickRes.NextStage ?? pickRes.nextStage ?? 0,
        };
        Log.e(`[Pick] ACK IsJackpot=${raw.IsJackpot} JackpotIndex=${raw.JackpotIndex} NextStage=${raw.NextStage} PickWin=${raw.PickWin ?? 0}`);
        ResponseLogger.log('Pick', raw);
        return raw;
    }

    async sendClaimRequest(): Promise<{ balance: number; winCash?: number; winGrade?: string; claimTotalWin?: number; topLevelWinCash?: number }> {
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

        this._checkResponseCode(responsePacket);
        data.updateSeq(responsePacket[4]);

        const decrypted = this._decryptAES256(responsePacket[8], session.aky);
        const raw: ServerClaimResponse = JSON.parse(decrypted);

        // ═══ LOG RESPONSE ═══
        ResponseLogger.log('Claim', raw);

        const claimResponse = (raw as any).ClaimResponse ?? (raw as any).claimResponse ?? {};
        const claimWinGrade: string | undefined = claimResponse.WinGrade ?? claimResponse.winGrade ?? undefined;
        const claimTotalWin = claimResponse.TotalWin ?? claimResponse.totalWin;
        const topLevelWinCash = (raw as any).WinCash ?? (raw as any).winCash;
        const cash = (raw as any).Cash ?? (raw as any).cash ?? (raw as any).Balance ?? (raw as any).balance;
        const winCash = claimTotalWin ?? topLevelWinCash;

        Log.e(`[Claim] parsed balance=${cash} totalWin=${winCash} (ClaimResponse.TotalWin=${claimTotalWin ?? 'n/a'}, WinCash=${topLevelWinCash ?? 'n/a'}) WinGrade=${claimWinGrade ?? 'n/a'}`);
        return { balance: cash, winCash, winGrade: claimWinGrade, claimTotalWin, topLevelWinCash };
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
            const prev = data.jackpotValues?.slice?.() ?? [];
            const changed = raw.Wins.some((v, i) => v !== prev[i]);
            data.jackpotValues = raw.Wins;
            if (changed) {
                Log.e(`[Jackpot] Poll Wins changed [${prev.join(',')}] → [${raw.Wins.join(',')}]`);
            }
            EventBus.instance.emit(GameEvents.JACKPOT_VALUES_UPDATED, raw.Wins);
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

    async sendGameOptChange(betIndex: number, coinValueIndex: number): Promise<void> {
        const data = GameData.instance;
        const session = data.serverSession!;

        const requestData = {
            SlotId: ServerConfig.SLOT_ID,
            Opt: 0,
            NewVal: 0,
        };

        const encrypted = this._encryptAES256(JSON.stringify(requestData), session.aky);
        const packet = this._buildPacket(
            ServerConfig.API.GAME_OPT_CHANGE,
            session.memberIdx,
            session.sessionKey,
            data.currentSeq,
            encrypted
        );

        try {
            const responsePacket = await this._sendRequest(
                this._getUrl(ServerConfig.API.GAME_OPT_CHANGE),
                packet
            );
            this._checkResponseCode(responsePacket);
            data.updateSeq(responsePacket[4]);
        } catch (err) {
            Log.w('[GameOptChange] Failed:', err);
        }
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
        return items.map((item: ServerFeatureItem) => ({
            itemId:       item.Id,
            name:         item.Name,
            title:        item.Title || item.Name,
            desc:         item.Desc || '',
            priceRatio:   item.PriceRatio,
            effectType:   item.EffectType,
            imgUrl:       item.ImgUrl || '',
            addSpinValue: item.AddSpinValue ?? undefined,
        }));
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

        // Doc: HeartBeat Data — LID (Int32, Country Code Table)
        const requestData = { LID: this._getLangId() };
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
                reelCnt: lp.ReelCnt ?? 3,
                matchedSymbolsIndices: indices,
            };
        });

        Log.e(
            `[SV-ERR] SERVER-RAW ReelIndex=${res.ReelIndex} Rands=${JSON.stringify(res.Rands)}` +
            ` TotalBet=${res.TotalBet} TotalWin=${res.TotalWin} NextStage=${res.NextStage}` +
            ` RemainFreeSpin=${res.RemainFreeSpinCount ?? 'null'} RemainFeatureSpin=${(res as any).RemainFeatureSpinCount ?? 'null'} WinGrade=${res.WinGrade ?? 'null'}` +
            ` MatchedLinePays=${JSON.stringify((res.MatchedLinePays || []).map((lp: any) => ({
                PayLineIndex: lp.PayLineIndex,
                Payout: lp.Payout,
                MatchedSymbols: lp.MatchedSymbols,
                ContainsWild: lp.ContainsWild,
                ReelCnt: lp.ReelCnt,
            })))}`
        );

        // ─── GoF STICKY DEBUG: dump toàn bộ các field liên quan STICKY_RED ───
        // Log này luôn in (qua SV-ERR whitelist) để xác định field name thực tế server trả về.
        {
            const anyRes = res as any;
            const knownSticky = {
                StickyCells:    anyRes.StickyCells,
                StickyList:     anyRes.StickyList,
                CollectSymbols: anyRes.CollectSymbols,
                RedCount:       anyRes.RedCount,
                StickyRedCount: anyRes.StickyRedCount,
                RedReels:       anyRes.RedReels,
                NextStage:      anyRes.NextStage,
                RemainReSpinCount: anyRes.RemainReSpinCount,
                RemainRespinCount: anyRes.RemainRespinCount,
                RemainFeatureSpinCount: anyRes.RemainFeatureSpinCount,
                TopupReel: anyRes.TopupReel,
                NormalSpinLinkReel: anyRes.NormalSpinLinkReel,
                NoramlSpinLinkReel: anyRes.NoramlSpinLinkReel,
            };
            // In tất cả key của res để không bỏ sót field lạ
            const allKeys = Object.keys(anyRes).filter(k =>
                !['Rands','MatchedLinePays','TotalBet','TotalWin','UpdateCash',
                  'NextStage','ReelIndex','RemainFreeSpinCount','WinGrade',
                  'FreeSpinMultiplier','FeatureMultiple','FeatureSpinTotalWin'].includes(k)
            );
            Log.e(`[SV-ERR] GoF sticky fields: ${JSON.stringify(knownSticky)}` +
                  `\n  extra keys in res: [${allKeys.join(', ')}]`);
        }

        // ═══ PURCHASE DEBUG — kiểm tra ReelIndex server trả có khớp với isPurchaseReelActive ═══
        // if (data.isPurchaseReelActive && res.ReelIndex !== 2) {
        //     Log.e(
        //         `%c[PURCHASE-MISMATCH] isPurchaseReelActive=true BUT server ReelIndex=${res.ReelIndex} (expected 2!)` +
        //         ` → client sẽ override dùng purchaseReelStrips`,
        //         'color:#f00;font-weight:bold;font-size:14px'
        //     );
        // }
        // Log.e(
        //     `[SPIN-RESULT-REEL] ReelIndex=${res.ReelIndex} isPurchaseActive=${data.isPurchaseReelActive}` +
        //     ` Rands=[${res.Rands}] → client sẽ dùng strip: ${res.ReelIndex === 2 ? 'Purchase' : res.ReelIndex === 1 ? 'FreeSpin' : (data.isPurchaseReelActive ? 'Purchase(override)' : 'Normal')}`
        // );

        // ═══ PURCHASE STRIP POSITION DEBUG — in symbol tại vị trí rand ═══
        // if (data.isPurchaseReelActive || res.ReelIndex === 2) {
        //     const SN = ['7','77','777','BAR','BB','3X','BNS','R⚡','B⚡'];
        //     const fmtS = (id: number) => id < 0 ? '___' : (SN[id] ?? `?${id}`);
        //     const strips = data.config.purchaseReelStrips;
        //     const rawStrips = data.rawPsPurchaseReelStrips;
        //     const normalStrips = data.config.reelStrips;
        //     const rands = res.Rands as number[];
        //     for (let c = 0; c < 3; c++) {
        //         const strip = strips[c] ?? [];
        //         const rawStrip = rawStrips[c] ?? [];
        //         const nStrip = normalStrips[c] ?? [];
        //         const len = strip.length;
        //         const nLen = nStrip.length;
        //         const center = ((rands[c] % len) + len) % len;
        //         const topIdx = ((center - 1) % len + len) % len;
        //         const botIdx = (center + 1) % len;
        //         // Normal strip with same rand (for comparison)
        //         const nCenter = ((rands[c] % nLen) + nLen) % nLen;
        //         const nTopIdx = ((nCenter - 1) % nLen + nLen) % nLen;
        //         const nBotIdx = (nCenter + 1) % nLen;
        //         Log.e(
        //             `[PURCHASE-STRIP-POS] Reel${c}: rand=${rands[c]}` +
        //             ` | PURCHASE(len=${len}) center=${center}: top[${topIdx}]=${fmtS(strip[topIdx])}(raw:${rawStrip[topIdx]})` +
        //             ` mid[${center}]=${fmtS(strip[center])}(raw:${rawStrip[center]})` +
        //             ` bot[${botIdx}]=${fmtS(strip[botIdx])}(raw:${rawStrip[botIdx]})` +
        //             ` | NORMAL(len=${nLen}) center=${nCenter}: top[${nTopIdx}]=${fmtS(nStrip[nTopIdx])}` +
        //             ` mid[${nCenter}]=${fmtS(nStrip[nCenter])}` +
        //             ` bot[${nBotIdx}]=${fmtS(nStrip[nBotIdx])}`
        //         );
        //     }
        //     // Check: is purchaseStrip === normalStrip (reference equality)?
        //     const sameRef = strips === normalStrips;
        //     const sameLen = strips.length === normalStrips.length && strips.every((s, i) => s.length === normalStrips[i]?.length);
        //     Log.e(`[PURCHASE-STRIP-CHECK] sameReference=${sameRef} sameLengths=${sameLen}`);
        // }

        // Rands dùng trực tiếp cho Normal/FreeSpin.
        // TopUp cần đủ 5 rands vì visual đang quay 5 reel bằng respinReelStrips.
        // Một số response real API chỉ trả 3 rands hoặc không trả TopupReel, khiến reel 3/4 dừng lặp index 0.
        const isTopUpMode = data.currentMode === 'respin';
        const rands = isTopUpMode
            ? this._normalizeTopupRands(res.Rands as number[])
            : (res.Rands as number[]);

        // ═══ TOPUP FULL SERVER DUMP ═══
        if (isTopUpMode) {
            Log.e(`[NM-TOPUP] ══ _convertSpinResponse (TopUp) ══`);
            Log.e(`[NM-TOPUP] currentMode="${data.currentMode}" ReelIndex=${res.ReelIndex} isTopUpMode=${isTopUpMode}`);
            Log.e(`[NM-TOPUP] RAW res.Rands: ${JSON.stringify(res.Rands)}`);
            Log.e(`[NM-TOPUP] Normalized rands (5-reel): [${rands.join(',')}]`);
            Log.e(`[NM-TOPUP] res.TopupReel: ${JSON.stringify((res as any).TopupReel)}`);
            Log.e(`[NM-TOPUP] res.NormalSpinLinkReel: ${JSON.stringify((res as any).NormalSpinLinkReel)}`);
            Log.e(`[NM-TOPUP] res.NoramlSpinLinkReel: ${JSON.stringify((res as any).NoramlSpinLinkReel)}`);
            Log.e(`[NM-TOPUP] res.RemainFeatureSpinCount: ${(res as any).RemainFeatureSpinCount}`);
            Log.e(`[NM-TOPUP] res.RemainReSpinCount: ${(res as any).RemainReSpinCount}`);
            Log.e(`[NM-TOPUP] res.TotalWin: ${res.TotalWin} res.FeatureSpinTotalWin: ${(res as any).FeatureSpinTotalWin}`);
            Log.e(`[TOPUP-CREDIT][NET] rawTotals TotalWin=${res.TotalWin} FeatureSpinTotalWin=${(res as any).FeatureSpinTotalWin ?? 'n/a'} RemainFeatureSpinCount=${(res as any).RemainFeatureSpinCount ?? 'n/a'} RemainReSpinCount=${(res as any).RemainReSpinCount ?? 'n/a'}`);
            // Log ALL keys in res to catch any unknown field names
            try {
                const resKeys = Object.keys(res as object);
                Log.e(`[NM-TOPUP] ALL res keys (${resKeys.length}): ${resKeys.join(', ')}`);
                // Log any key that contains "reel" or "link" or "spin" or "sticky" case-insensitive
                const interestingKeys = resKeys.filter(k => /reel|link|spin|sticky|rand|remain|topup/i.test(k));
                if (interestingKeys.length) {
                    Log.e(`[NM-TOPUP] Interesting keys+values: ${interestingKeys.map(k => `${k}=${JSON.stringify((res as any)[k])}`).join(' | ')}`);
                }
            } catch (_) {}
        }
        // ═══ END TOPUP FULL SERVER DUMP ═══
        // Secret Treasure: FS tiers dùng ReelIndex 2–6 (không chỉ legacy 1).
        // TopUp (respin) cũng có thể ReelIndex=2 → không được coi là Free Spin.
        const reelIdx = (res.ReelIndex as number) ?? 0;
        const isFreeSpin =
            data.currentMode === 'freespin'
            || data.currentMode === 'freespin_gold'
            || (data.currentMode !== 'respin' && (reelIdx === 1 || isFreeSpinTierReelIndex(reelIdx)));
        const grid = data.getBaseGrid(rands, isFreeSpin, reelIdx);
        const waysPayWins = res.TotalWin > 0
            ? WaysPayCalculator.calculate(grid, res.TotalBet as number, isFreeSpin)
            : [];
        const spinResp: SpinResponse = {
            rands,
            matchedLinePays,
            waysPayWins,
            totalBet: res.TotalBet,
            totalWin: res.TotalWin,
            updateCash: res.UpdateCash,
            nextStage: res.NextStage,
            reelIndex: res.ReelIndex,
            featureMultiple: res.FreeSpinMultiplier ?? res.FeatureMultiple ?? res.MysteryMultiple,
            remainCash: raw.RemainCash,
            remainFreeSpinCount: Math.max(0, res.RemainFreeSpinCount ?? 0),
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
            remainRespinCount: (res as any).RemainFeatureSpinCount ?? (res as any).RemainReSpinCount ?? (res as any).RemainRespinCount ?? undefined,
            topupReel: this._parseTopupReel((res as any).TopupReel ?? (res as any).NormalSpinLinkReel ?? (res as any).NoramlSpinLinkReel),
        };

        // ★ FEATURE ENTRY LOGIC ADDED — phát hiện Force Feature Entry + cập nhật gauge
        this._applyFeatureEntryLogic(spinResp, res, grid, raw);

        return spinResp;
    }

    /**
     * ★ FEATURE ENTRY LOGIC ADDED
     * Phát hiện "Force Feature Entry" (Sticky tự nhiên < 6 nhưng server cho vào
     * Feature) và tính dữ liệu gauge (chữ tượng hình 2 cột).
     *
     * - naturalStickyCount: đếm Sticky (Red/Yellow/Green) thực sự trên grid spin này.
     * - isForcedFeatureEntry: server flag, hoặc suy luận (nextStage=FEATURE_SELECT
     *   ở Normal Spin, naturalCount < 6, nhưng tổng stickyCells >= 6).
     * - forceFeatureEntry: chia existing (tự nhiên) / fill (đổ thêm) + gán credit.
     * - gauge: StickyAccumulated → 10 UI đèn; StickyEarned → earned/spin (normal only).
     *   PotVisualLevel chỉ dùng cho Pot UI, KHÔNG dùng cho gauge.
     * - force entry: IsForceFeatureEnter; NoramlSpinLinkReel chứa đủ 6 ô + credit.
     */
    private _applyFeatureEntryLogic(
        resp: SpinResponse,
        res: ServerSpinResponse['Res'],
        grid: number[][],
        rawOuter?: ServerSpinResponse,
    ): void {
        const anyRes = res as any;
        const isNormalSpin = (resp.reelIndex ?? 0) === 0 && GameData.instance.currentMode === 'normal';

        // 1) Đếm Sticky tự nhiên trên grid (5 reel × 3 row)
        let naturalCount = 0;
        const naturalPositions = new Set<string>();
        for (let reel = 0; reel < grid.length; reel++) {
            const col = grid[reel] ?? [];
            for (let row = 0; row < col.length; row++) {
                if (isSticky(col[row])) {
                    naturalCount++;
                    naturalPositions.add(`${reel}-${row}`);
                }
            }
        }
        resp.naturalStickyCount = naturalCount;

        // 2) Gauge: StickyAccumulated / StickyEarned từ AckSpin.Res (normal spin only).
        // StickyAccumulated → 10 ô FeatureEntryGauge; StickyEarned → earned spin này.
        // PotCount/WildCount chỉ fallback legacy (thường = 0).
        const potVisualLevel = anyRes.PotVisualLevel ?? anyRes.potVisualLevel;
        const gauge = resolveGaugeApiFields(res, rawOuter);
        const stickyAccumulated = gauge.stickyAccumulated;
        const stickyEarned = gauge.stickyEarned;
        if (isNormalSpin) {
            logFeatureGauge(stickyAccumulated, stickyEarned, {
                accumulatedPick: gauge.accumulatedPick,
                earnedPick: gauge.earnedPick,
                sources: [res, rawOuter],
                sourceLabels: ['AckSpin.Res', 'AckSpin.root'],
            });
        }
        if (potVisualLevel != null) {
            resp.potVisualLevel = potVisualLevel;
        }
        if (stickyAccumulated != null) {
            resp.stickyAccumulated = stickyAccumulated;
            resp.potCount = stickyAccumulated;
            resp.lightingStage = gaugeStageFromAccumulated(stickyAccumulated);
        }
        if (stickyEarned != null) {
            resp.stickyEarnedThisSpin = stickyEarned;
            resp.wildCount = stickyEarned;
        }

        // 3) Chỉ xét Force Feature Entry cho Normal Spin
        const enteringFeature = resp.nextStage === SlotStageType.FEATURE_SELECT
            || resp.nextStage === SlotStageType.FEATURE_SELECT_START;
        if (!isNormalSpin || !enteringFeature) return;

        const serverForced = anyRes.IsForceFeatureEnter ?? anyRes.ForceFeatureEnter ?? anyRes.IsForcedFeatureEntry;
        const linkReel = anyRes.NoramlSpinLinkReel ?? anyRes.NormalSpinLinkReel;
        const linkCells = linkReel ? this._parseMainGridLinkReelStickyCells(linkReel) : undefined;
        const cells: StickyCell[] = linkCells ?? resp.stickyCells ?? [];
        const totalSticky = cells.length;
        const inferredForced = naturalCount < FEATURE_ENTRY_REQUIRED_STICKY && totalSticky >= FEATURE_ENTRY_REQUIRED_STICKY;
        const isForced = serverForced === true || (serverForced == null && inferredForced);
        if (!isForced) return;

        // 4) Chia existing / fill: Rands có sticky = tự nhiên, còn lại trong link reel = force-fill
        const existingCells: StickyCell[] = [];
        const fillCells: StickyCell[] = [];
        for (const c of cells) {
            if (naturalPositions.has(`${c.reel}-${c.row}`)) existingCells.push(c);
            else fillCells.push(c);
        }
        for (const c of fillCells) {
            if (!(c.credit > 0)) c.credit = pickForcedStickyValue() * (resp.totalBet || 1);
        }

        const data: ForceFeatureEntryData = { existingCells, fillCells, naturalCount };
        resp.isForcedFeatureEntry = true;
        resp.forceFeatureEntry = data;
        resp.stickyCells = cells;
        Log.e(`[FEATURE-ENTRY] Force Feature Entry — natural=${naturalCount} fill=${fillCells.length} total=${totalSticky} serverFlag=${serverForced} linkReel=${!!linkReel}`);
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
        // Array format: server trả [{Index, SymbolId}]
        if (Array.isArray(raw)) {
            const grid: number[] = new Array(12).fill(SymbolId.JP_MINI);
            for (const item of raw) {
                if (item != null && item.Index != null) {
                    grid[item.Index] = PS_TO_CLIENT[item.SymbolId] ?? SymbolId.JP_MINI;
                }
            }
            return { grid, revealed: [] };
        }
        // Object format — normalize PascalCase keys
        const grid: number[] | undefined = raw.grid ?? raw.Grid;
        const revealed: number[] | undefined = raw.revealed ?? raw.Revealed ?? [];
        if (!grid) return undefined;
        return { grid, revealed };
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
                ? (item.Win ?? item.win ?? item.Credit ?? item.credit ?? item.Val ?? item.val ?? item.Value ?? item.value ?? 0)
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
            if (slot.type === TopupReelType.RED) symbolId = SymbolId.STICKY_RED;
            else if (slot.type === TopupReelType.YELLOW) symbolId = SymbolId.STICKY_YELLOW;
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

    /**
     * Parse NoramlSpinLinkReel → StickyCell[] trên lưới 5×3 (Normal Spin / Force Feature Entry).
     * Backend: khi IsForceFeatureEnter, link reel chứa đủ 6 Trail + credit; diff với Rands = fill.
     */
    private _parseMainGridLinkReelStickyCells(raw: any): StickyCell[] | undefined {
        const slots = this._parseTopupReel(raw);
        if (!slots) return undefined;

        const cells: StickyCell[] = [];
        for (let i = 0; i < Math.min(15, slots.length); i++) {
            const slot = slots[i];
            if (slot.type === TopupReelType.NONE || slot.type === TopupReelType.GRAND) continue;

            const apiRow = Math.floor(i / 5);
            const reel = i % 5;
            const row = apiRow;

            let symbolId = SymbolId.STICKY_RED;
            if (slot.type === TopupReelType.YELLOW) symbolId = SymbolId.STICKY_YELLOW;
            else if (slot.type === TopupReelType.GREEN) symbolId = SymbolId.STICKY_GREEN;

            cells.push({ reel, row, symbolId, credit: slot.win ?? 0 });
        }

        if (cells.length > 0) {
            Log.e(`[FEATURE-ENTRY] LinkReel → ${cells.length} cells: ${cells.map(c => `r${c.reel}row${c.row}=$${c.credit}`).join(', ')}`);
        }
        return cells.length > 0 ? cells : undefined;
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
            || data.currentMode === 'freespin_gold'
            || (data.currentMode !== 'respin' && (reelIndex === 1 || isFreeSpinTierReelIndex(reelIndex)));
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
                if (clientSymId !== SymbolId.STICKY_RED
                    && clientSymId !== SymbolId.STICKY_YELLOW
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
                const rawSym = item.SymbolId ?? item.Sym ?? item.symbolId ?? item.sym ?? SymbolId.STICKY_RED;
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
            // Specials (Gold of Fortune — API doc V1.0.3)
            [['WildTrailSymbolID', 'WildSymbolID'],               SymbolId.WILD],
            [['StickyRedSymbolID', 'StickyRed'],                  SymbolId.STICKY_RED],
            [['StickyYellowSymbolID', 'StickyYellow', 'TopupYellowSymbolID', 'FreeSpinTrailsymbolID'], SymbolId.STICKY_YELLOW],
            [['StickyGreenSymbolID', 'StickyGreen', 'TopupGreenSymbolID'],    SymbolId.STICKY_GREEN],
            [['PlusOneSpinSymbolID', 'PlusOneSpin', 'TopupSpinAddsymbolID'], SymbolId.PLUS_ONE_SPIN],
            // Jackpots
            [['MiniJackpotID'],  SymbolId.JP_MINI],
            [['MinorJackpotID'], SymbolId.JP_MINOR],
            [['MajorJackpotID'], SymbolId.JP_MAJOR],
            [['GrandJackpotID'], SymbolId.JP_GRAND],
            // NOTE: Trail01-06symbolID KHÔNG map tĩnh ở đây.
            // Sẽ được map động bằng cách sort theo SymbolRates (payout thấp → cao = MINOR_9 → MAJOR_SOBEK)
            // theo API doc V1.0.3 section 5.1.
        ];

        for (const [fields, clientId] of psSymbolFields) {
            for (const field of fields) {
                const psId = ps[field];
                if (typeof psId === 'number') {
                    dynMap[psId] = clientId;
                    // NOTE: no break — map ALL fields in group (e.g. StickyYellowSymbolID AND FreeSpinTrailsymbolID both → STICKY_YELLOW)
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

        // ═══ Trail01-06 (41-46) — tất cả là Đồng xu Đỏ (STICKY_RED) ═══
        // QUAN TRỌNG: Trail01-46 đều hiển thị cùng 1 hình đồng đỏ.
        // Giá trị tiền của mỗi loại = SymbolRates[id] × totalBet, render dưới dạng text.
        const _trailFields = ['Trail01symbolID','Trail02symbolID','Trail03symbolID',
                              'Trail04symbolID','Trail05symbolID','Trail06symbolID'];
        const _trailIds: number[] = _trailFields
            .map(f => ps[f])
            .filter((v): v is number => typeof v === 'number');
        if (_trailIds.length > 0) {
            for (const psId of _trailIds) {
                if (!(psId in dynMap)) dynMap[psId] = SymbolId.STICKY_RED;
            }
            Log.e(`[PS:TrailMap] All Trail IDs → STICKY_RED: ${_trailIds.map(id=>`${id}(credit_rate=${_symbolRatesMap[id]??'?'})`).join(' | ')}`);
        }

        // ═══ Normal symbols (Way Pay) — Secret Treasure PS IDs ═══
        // 1=9, 2=10, 3=J, 4=Q, 5=K, 6=A, 11=Horus, 12=Anubis, 13=Sobek, 14=Ramses, 15=Cleopatra
        {
            const _normalSymbols: Record<number, number> = {
                1:  SymbolId.MINOR_9,      2:  SymbolId.MINOR_10,     3:  SymbolId.MINOR_J,
                4:  SymbolId.MINOR_Q,      5:  SymbolId.MINOR_K,      6:  SymbolId.MINOR_A,
                11: SymbolId.MAJOR_HORUS,     12: SymbolId.MAJOR_ANUBIS,  13: SymbolId.MAJOR_SOBEK,
                14: SymbolId.MAJOR_RAMSES,   15: SymbolId.MAJOR_CLEOPATRA,
            };
            for (const [psId, clientId] of Object.entries(_normalSymbols)) {
                const id = parseInt(psId, 10);
                if (!(id in dynMap)) dynMap[id] = clientId as number;
            }
            Log.e('[PS:NormalMap] 1→9 2→10 3→J 4→Q 5→K 6→A 11→COIN 12→INGOT 13→SHIP 14→TURTLE 15→PHOENIX');
        }

        // ═══ Pick Game symbols — hardcoded từ game design document ═══
        // 81=Idle, 82=Grand, 83=Major, 84=Minor, 85=Mini
        {
            const _pickSymbols: Record<number, number> = {
                81: SymbolId.JP_IDLE,  82: SymbolId.JP_GRAND,
                83: SymbolId.JP_MAJOR, 84: SymbolId.JP_MINOR, 85: SymbolId.JP_MINI,
            };
            for (const [psId, clientId] of Object.entries(_pickSymbols)) {
                const id = parseInt(psId, 10);
                if (!(id in dynMap)) dynMap[id] = clientId as number;
            }
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
                SymbolId.STICKY_RED, SymbolId.STICKY_YELLOW, SymbolId.STICKY_GREEN,
                SymbolId.PLUS_ONE_SPIN,
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
            MINI:  ps.MiniJackpotID  ?? data.jackpotPsIds.MINI,
            MINOR: ps.MinorJackpotID ?? data.jackpotPsIds.MINOR,
            MAJOR: ps.MajorJackpotID ?? data.jackpotPsIds.MAJOR,
            GRAND: ps.GrandJackpotID ?? data.jackpotPsIds.GRAND,
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

        // ═══ FreeSpinReel.Strips — legacy fallback (Gold of Fortunes single reel) ═══
        if (ps.FreeSpinReel?.Strips && Array.isArray(ps.FreeSpinReel.Strips)) {
            const freeSpin = convertStripSet(ps.FreeSpinReel.Strips, 'FreeSpinReel');
            data.config.freeSpinReelStrips = freeSpin.converted;
            data.rawPsFreeSpinStrips = freeSpin.raw;
        } else {
            data.config.freeSpinReelStrips = data.config.reelStrips;
            data.rawPsFreeSpinStrips = data.rawPsStrips;
            Log.e('[PS] FreeSpinReel.Strips không có — dùng fallback normal strips cho FreeSpin (visual có thể sai)');
        }

        // ═══ Secret Treasure — 5 tier Free Spin reels (HighestFreeSpinReel … LowestFreeSpinReel) ═══
        const tierStrips: Record<number, number[][]> = {};
        const tierRawStrips: Record<number, number[][]> = {};
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
        data.config.freeSpinTierStrips = tierStrips;
        data.rawPsFreeSpinTierStrips = tierRawStrips;

        // ═══ TopUpGameReels.Strips — dùng khi Topup mode (ReelIndex=2 theo API V1.0.3) ═══
        // Sticky cells override vị trí đã locked; ô trống vẫn quay bằng strip TopUpGameReels.
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
        } else {
            // Fallback: Re-Spin dùng cùng strips với Normal (sticky cells sẽ override đúng vị trí)
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
        // ★ Bật log tag cho StickyAccumulated / StickyEarned debug — phải enable trước khi login/enter.
        Log.enable('featuregauge');
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
        return this._adapter.login(params);
    }

    /** Enter game — nhận config + initial state */
    enterGame(): Promise<ServerEnterResponse> {
        return this._adapter.enterGame();
    }

    sendSpinRequest(isFreeSpin: boolean): Promise<SpinResponse> {
        return this._adapter.sendSpinRequest(isFreeSpin);
    }

    sendSelectFeature(nextStage: SlotStageType, reelIndex?: number): Promise<SelectFeatureResponse> {
        return this._adapter.sendSelectFeature(nextStage, reelIndex ?? 0);
    }

    sendClaimRequest(): Promise<{ balance: number; winCash?: number; winGrade?: string; claimTotalWin?: number; topLevelWinCash?: number }> {
        return this._adapter.sendClaimRequest();
    }

    sendPickRequest(pickIndex: number): Promise<ServerPickResponse> {
        return this._adapter.sendPickRequest(pickIndex);
    }

    /** Notify server of bet/coinValue change immediately */
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

    /** Bắt đầu HeartBeat (mỗi 10 giây) */
    startHeartBeat(): void {
        this.stopHeartBeat();
        if (!USE_REAL_API) return;
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

    /** Dọn dẹp tất cả timers */
    dispose(): void {
        this.stopJackpotPolling();
        this.stopHeartBeat();
    }
}
export { USE_REAL_API };

