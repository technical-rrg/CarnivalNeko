/**
 * CashRaceMockAPI.ts
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * API Service cho há»‡ thá»‘ng Cash Race.
 *   - USE_REAL_API = true  â†’ gá»i server tháº­t qua NetworkManager
 *   - USE_REAL_API = false â†’ tráº£ mock data (dÃ¹ng khi dev offline / cheat test)
 *
 * â˜… API thá»±c táº¿:
 *   - POST /Slot/{slotId}/Jackpot                â†’ CR: NwCashRaceSimpleForUser (má»—i 2s)
 *   - POST /Slot/{slotId}/CashRaceMyRankGetFirst â†’ Race, MyRank, TopRanks, BottomRanks
 *
 * CashRaceRule:  0=WIN | 1=BET | 2=LOSE
 * CashRaceState: 0=none | 1=wait | 2=notice | 3=running | 4=closing | 5=closed
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 */

import { USE_REAL_API } from './ServerConfig';
import { NetworkManager } from '../manager/NetworkManager';
import { CashRaceMyRankGetFirstResponse, NwCashRaceSimpleForUser } from './SlotTypes';
import { Log } from '../core/Logger';
import { GameData } from './GameData';

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  INTERFACES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

export interface RaceInfo {
    prizePool: number;
    timeLeft: number;       // giÃ¢y cÃ²n láº¡i
    rule: 'BET' | 'WIN' | 'LOSE';
    myRank: number;
    totalUsers: number;
    rewardUsers: number;
    isNotice: boolean;
    eventName: string;
    startTime: string;
    endTime: string;
}

export interface RankItem {
    rank: number;
    playerName: string;
    score: number;
    isMe: boolean;
    prize?: number;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  MOCK SCENARIO â€” chá»‰ dÃ¹ng khi USE_REAL_API = false
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

export type MockScenario = 'RANDOM' | 'TOP3' | 'NEARBY' | 'EMPTY';

/** â˜… Äá»”I GIÃ TRá»Š NÃ€Y Äá»‚ TEST (chá»‰ cÃ³ hiá»‡u lá»±c khi USE_REAL_API = false) â˜… */
/** 'EMPTY'=ẩn nút | 'RANDOM'=race ngẫu nhiên | 'TOP3'=user top3 | 'NEARBY'=user giữa bảng */
export let ACTIVE_SCENARIO: MockScenario = 'EMPTY';

export function setMockScenario(scenario: MockScenario): void {
    ACTIVE_SCENARIO = scenario;
    _mockState = null;
}

export function resetMockState(): void {
    _mockState = null;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  REAL API HELPERS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/** CashRaceRule int â†’ string */
function _mapRule(n: number): 'BET' | 'WIN' | 'LOSE' {
    if (n === 0) return 'WIN';
    if (n === 1) return 'BET';
    if (n === 2) return 'LOSE';
    return 'BET';
}

/** TÃ­nh sá»‘ giÃ¢y cÃ²n láº¡i tá»« thá»i Ä‘iá»ƒm káº¿t thÃºc race (CT) */
/** Server gui datetime khong co 'Z' suffix -> parse thanh local time -> sai.
 *  Append 'Z' de buoc JavaScript treat as UTC.
 *  Dung clockOffsetMs tu GameData de bu lai lenh dong ho may client.
 */
function _calcTimeLeft(ct: string): number {
    if (!ct) return 0;
    const utcStr = ct.endsWith('Z') || /[+\-]\d{2}:\d{2}$/.test(ct) ? ct : ct + 'Z';
    const clockOffsetMs: number = (typeof GameData !== 'undefined' && GameData.instance?.clockOffsetMs) || 0;
    const serverNow = Date.now() + clockOffsetMs;
    return Math.max(0, Math.floor((new Date(utcStr).getTime() - serverNow) / 1000));
}

/** Chuyá»ƒn NwCashRaceRankerSimple (PascalCase) â†’ RankItem */
function _mapRanker(r: any, myRankNum: number): RankItem {
    return {
        rank:       r.Rank,
        playerName: r.Nick,
        score:      r.Score,
        isMe:       r.Rank === myRankNum,
        prize:      r.Prize ?? undefined,
    };
}

// â”€â”€â”€ Cache káº¿t quáº£ CashRaceMyRankGetFirst (TTL 2s) Ä‘á»ƒ trÃ¡nh gá»i API láº·p â”€â”€â”€
let _cachedResp: CashRaceMyRankGetFirstResponse | null = null;
let _cacheTime: number = 0;
const CACHE_TTL_MS = 2000;

async function _fetchRealData(): Promise<CashRaceMyRankGetFirstResponse | null> {
    const now = Date.now();
    if (_cachedResp && now - _cacheTime < CACHE_TTL_MS) {
        Log.d('[CashRace][MyRankGetFirst] Returning cached response (TTL not expired)');
        return _cachedResp;
    }
    try {
        Log.d('%c[CashRace][MyRankGetFirst] Calling API CashRaceMyRankGetFirst...', 'color:#0cf;font-weight:bold');
        const resp = await NetworkManager.instance.sendCashRaceMyRankGetFirst();
        Log.d('%c[CashRace][MyRankGetFirst] Raw API response:', 'color:#0cf;font-weight:bold', JSON.stringify(resp, null, 2));
        if (resp) {
            Log.d('%c[CashRace][MyRankGetFirst] ✅ resp.Race =', 'color:#0f0;font-weight:bold', JSON.stringify(resp.Race));
            Log.d('%c[CashRace][MyRankGetFirst]    resp.MyRank =', 'color:#0f0', JSON.stringify(resp.MyRank));
            Log.d('%c[CashRace][MyRankGetFirst]    resp.TopRanks.length =', 'color:#0f0', resp.TopRanks?.length ?? 'N/A');
            _cachedResp = resp;
            _cacheTime = Date.now();
        } else {
            Log.w('%c[CashRace][MyRankGetFirst] ❌ Response = null — sendCashRaceMyRankGetFirst returned null', 'color:#f44');
        }
        return resp;
    } catch (err) {
        Log.w('[CashRaceAPI] sendCashRaceMyRankGetFirst FAILED with error:', err);
        return _cachedResp; // fallback to last known
    }
}

function _placeholderRaceInfo(): RaceInfo {
    return {
        prizePool: 0, timeLeft: 0, rule: 'BET', myRank: 0,
        totalUsers: 0, rewardUsers: 0, isNotice: false,
        eventName: 'Cash Race',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
    };
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  PUBLIC API FUNCTIONS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/**
 * Láº¥y thÃ´ng tin tá»•ng quan cá»§a race.
 * Real API: gá»i CashRaceMyRankGetFirst â†’ Race + MyRank.Rank
 * Mock:     dÃ¹ng MockState.
 */
/**
 * Map NwCashRaceSimpleForUser (tu Jackpot polling) -> RaceInfo.
 * Dung khi CashRaceMyRankGetFirst tra Race=null nhung Jackpot CR co data.
 * WinnerCount va Title khong co trong Simple -> dung gia tri cached neu co.
 */
export function mapCrToRaceInfo(
    cr: NwCashRaceSimpleForUser,
    cached?: RaceInfo | null,
): RaceInfo | null {
    if (!cr?.Race) return null;
    const race = cr.Race;
    const state = race.State;
    // State=2 (notice): dem nguoc den ST (luc race bat dau)
    // State>=3 (running/closing): dem nguoc den CT (luc race ket thuc)
    const timeLeft = state === 2 ? _calcTimeLeft(race.ST) : _calcTimeLeft(race.CT);
    return {
        prizePool:   race.TotalPrize,
        timeLeft,
        rule:        _mapRule(race.Rule),
        myRank:      (cr.MyRank as any) ?? 0,
        totalUsers:  cached?.totalUsers  ?? 500,
        rewardUsers: cached?.rewardUsers ?? 0,
        isNotice:    state === 2,
        eventName:   cached?.eventName   ?? 'Cash Race',
        startTime:   race.ST,
        endTime:     race.CT,
    };
}
export async function getRaceInfo(): Promise<RaceInfo | null> {
    if (!USE_REAL_API) {
        await _mockDelay();
        return getMockState().getRaceInfo();
    }

    const resp = await _fetchRealData();
    if (!resp || !resp.Race) {
        Log.d('%c[CashRace][getRaceInfo] Race = null → không có sự kiện nào đang diễn ra', 'color:#888');
        return null;
    }

    const race = resp.Race;
    const myRanker = resp.MyRank;

    // Notice (State=2): đếm ngược đến lúc race bắt đầu (ST)
    // Running/Closing (State≥3): đếm ngược đến lúc kết thúc race (CT)
    const timeLeft = race.State === 2 ? _calcTimeLeft(race.ST) : _calcTimeLeft(race.CT);

    const raceInfo: RaceInfo = {
        prizePool:   race.TotalPrize,
        timeLeft,
        rule:        _mapRule(race.Rule),
        myRank:      myRanker?.Rank ?? 0,
        totalUsers:  Math.max((myRanker?.Rank ?? 0) + 100, 500),
        rewardUsers: race.WinnerCount,
        isNotice:    race.State === 2,   // CashRaceState.notice = 2
        eventName:   race.Title,
        startTime:   race.ST,
        endTime:     race.CT,
    };
    Log.d('%c[CashRace][getRaceInfo] Mapped RaceInfo:', 'color:#0f9;font-weight:bold', JSON.stringify(raceInfo, null, 2));
    return raceInfo;
}

/**
 * Láº¥y báº£ng xáº¿p háº¡ng.
 * @param isTop3
 *   false â†’ BottomRanks (5 dÃ²ng nearby xung quanh tÃ´i)
 *   true  â†’ TopRanks   (3 dÃ²ng Ä‘áº§u)
 */
export async function getLeaderboard(isTop3: boolean): Promise<RankItem[]> {
    if (!USE_REAL_API) {
        await _mockDelay();
        return _getMockLeaderboard(isTop3);
    }

    const resp = await _fetchRealData();
    if (!resp) return [];

    const myRankNum = resp.MyRank?.Rank ?? 0;
    const rawList = isTop3 ? (resp.TopRanks ?? []) : (resp.BottomRanks ?? []);
    return rawList.map((r: any) => _mapRanker(r, myRankNum));
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  MOCK DATA (chá»‰ dÃ¹ng khi USE_REAL_API = false)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const MOCK_NAMES: string[] = [
    'DragonSlayer', 'LuckyAce', 'NeonWolf', 'StarBreaker', 'GoldFinger',
    'PhoenixRise', 'ShadowKing', 'MysticJade', 'ThunderBolt', 'CrystalHawk',
    'IronFist', 'BlazeFury', 'SilverFox', 'NightOwl', 'StormRider',
    'CosmicRay', 'DiamondEye', 'RubyQueen', 'EmeraldKnight', 'SapphireStar',
];
const RULES: Array<'BET' | 'WIN' | 'LOSE'> = ['BET', 'WIN', 'LOSE'];

function randInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}
function _mockDelay(ms = 300): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class MockState {
    readonly rule: 'BET' | 'WIN' | 'LOSE';
    readonly totalUsers: number;
    rewardUsers: number;
    readonly basePrize: number;
    readonly eventName: string;
    private _timeLeft: number;
    private _myRank: number;
    private _progressivePrize: number;

    constructor() {
        this.rule = pickRandom(RULES);
        this.totalUsers = randInt(500, 5000);
        this.basePrize = randInt(100000, 10000000);
        this._progressivePrize = randInt(0, 500000);
        // Dải rộng để test: từ 5 phút đến dưới 24 giờ (không có ngày)
        this._timeLeft = randInt(300, 86399);
        this.eventName = `Cash Race ${this.rule} Event`;

        switch (ACTIVE_SCENARIO) {
            case 'TOP3':
                this._myRank = randInt(1, 3);
                this.rewardUsers = randInt(10, 100);
                break;
            case 'NEARBY':
                this._myRank = 4;
                this.rewardUsers = 3;
                break;
            case 'EMPTY':
                this._myRank = 0;
                this.rewardUsers = randInt(10, 100);
                break;
            default:
                this._myRank = randInt(1, this.totalUsers);
                this.rewardUsers = randInt(10, 100);
        }
    }

    getRaceInfo(): RaceInfo {
        const delta = randInt(-2, 2);
        switch (ACTIVE_SCENARIO) {
            case 'TOP3':   this._myRank = Math.max(1, Math.min(3, this._myRank + delta)); break;
            case 'NEARBY': this._myRank = 4; break;
            case 'EMPTY':  this._myRank = 0; break;
            default:       this._myRank = Math.max(1, Math.min(this.totalUsers, this._myRank + randInt(-5, 5)));
        }
        this._progressivePrize += randInt(100, 5000);
        this._timeLeft = Math.max(0, this._timeLeft - randInt(1, 10));
        const isNotice = this._timeLeft > 0 && Math.random() < 0.15;
        const now = new Date();
        return {
            prizePool:   this.basePrize + this._progressivePrize,
            timeLeft:    this._timeLeft,
            rule:        this.rule,
            myRank:      this._myRank,
            totalUsers:  this.totalUsers,
            rewardUsers: this.rewardUsers,
            isNotice,
            eventName:   this.eventName,
            startTime:   now.toISOString(),
            endTime:     new Date(now.getTime() + this._timeLeft * 1000).toISOString(),
        };
    }

    get myRank(): number { return this._myRank; }
    get prizePool(): number { return this.basePrize + this._progressivePrize; }
}

let _mockState: MockState | null = null;
function getMockState(): MockState {
    if (!_mockState) _mockState = new MockState();
    return _mockState;
}

function _getMockLeaderboard(isTop3: boolean): RankItem[] {
    const state = getMockState();
    // Scenario EMPTY: cả nearby lẫn top3 đều trả về mảng rỗng
    if (ACTIVE_SCENARIO === 'EMPTY') return [];
    if (isTop3) {
        return [1, 2, 3].map(i => {
            const prizePercent = i === 1 ? 0.40 : i === 2 ? 0.25 : 0.15;
            const isMe = state.myRank === i;
            return {
                rank: i, playerName: isMe ? 'YOU' : pickRandom(MOCK_NAMES),
                score: randInt(500000, 99999999), isMe,
                prize: Math.floor(state.prizePool * prizePercent),
            };
        });
    }
    const myRank = state.myRank;
    const items: RankItem[] = [];
    for (let offset = -2; offset <= 2; offset++) {
        const rank = myRank + offset;
        if (rank < 1) continue;
        const isMe = offset === 0;
        items.push({
            rank, playerName: isMe ? 'YOU' : pickRandom(MOCK_NAMES),
            score: Math.max(0, randInt(100000, 9999999) - offset * randInt(1000, 50000)),
            isMe,
        });
    }
    while (items.length < 5) {
        const lastRank = items[items.length - 1]?.rank ?? myRank;
        items.push({ rank: lastRank + 1, playerName: pickRandom(MOCK_NAMES), score: randInt(10000, 500000), isMe: false });
    }
    return items;
}




