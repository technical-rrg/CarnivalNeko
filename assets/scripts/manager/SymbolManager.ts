/**
 * SymbolManager — Carnival Neko mapping (5×3, Ways Pay).
 *
 * Hỗ trợ 2 hệ thống ID:
 *   - Client SymbolId (0–25): dùng bởi SymbolView, GameData mock strips
 *   - PS Symbol ID:            dùng bởi server API
 *
 * Quy ước đặt tên file hình riêng lẻ (trước khi pack atlas):
 *
 *   assets/bundle/newTextures/symbols/reel/
 *     ps_01.png  (Low 8)    ps_02.png  (Low 9)    ps_03.png  (Low J)
 *     ps_04.png  (Low Q)    ps_05.png  (Low K)    ps_06.png  (Low A)
 *     ps_11.png  (Raccoon)  ps_12.png  (Fish)     ps_13.png  (Crane)
 *     ps_14.png  (Fox)     ps_15.png  (Golden Neko)
 *     ps_21.png  (Wild)
 *     ps_41.png  (Trail Blue)  ps_42.png  (Trail Green)  ps_43.png  (Trail Red)
 *     ps_44.png  (Sticky Green) ps_45.png (Sticky Gold)
 *
 *   assets/bundle/newTextures/symbols/pickgame/
 *     ps_81.png  (Base Pick / Idle)
 *     ps_82.png  (Grand)  ps_83.png  (Major)  ps_84.png  (Minor)
 *     ps_85.png  (Mini)   ps_86.png  (Upgrade Coin)
 *
 * Trong Editor: kéo SpriteFrame vào SlotMachineController.symbolFrames theo Client SymbolId (index 0..24).
 */

import { SpriteFrame, resources } from 'cc';
import { SymbolId } from '../data/SlotTypes';
import { Log } from '../core/Logger';
import { GameData } from '../data/GameData';

// ═══════════════════════════════════════════════════════════
//  CLIENT SYMBOL ID → SPRITE NAME MAPPING
// ═══════════════════════════════════════════════════════════

export const CLIENT_SPRITE_MAP: Record<number, string> = {
    // ─── Low (PS 1–6) ───
    [SymbolId.MINOR_9]:        'ps_01',
    [SymbolId.MINOR_10]:       'ps_02',
    [SymbolId.MINOR_J]:        'ps_03',
    [SymbolId.MINOR_Q]:        'ps_04',
    [SymbolId.MINOR_K]:        'ps_05',
    [SymbolId.MINOR_A]:        'ps_06',
    // ─── High (PS 11–15) ───
    [SymbolId.MAJOR_HORUS]:     'ps_11',
    [SymbolId.MAJOR_ANUBIS]:    'ps_12',
    [SymbolId.MAJOR_SOBEK]:     'ps_13',
    [SymbolId.MAJOR_RAMSES]:    'ps_14',
    [SymbolId.MAJOR_CLEOPATRA]: 'ps_15',
    // ─── Wild (PS 21) ───
    [SymbolId.WILD]:           'ps_21',
    // ─── Sticky feature (PS 44/45) ───
    [SymbolId.STICKY_YELLOW]:  'ps_45',
    [SymbolId.STICKY_GREEN]:   'ps_44',
    // ─── Trail (PS 41/42/43) ───
    [SymbolId.TRAIL_NORMAL]:   'trail_normal',
    [SymbolId.TRAIL_BLUE]:     'ps_41',
    [SymbolId.TRAIL_RED]:      'ps_43',
    [SymbolId.TRAIL_GREEN]:    'ps_42',
    // ─── Pick Game (PS 81–86) ───
    [SymbolId.JP_IDLE]:        'ps_81',
    [SymbolId.JP_MINI]:        'ps_85',
    [SymbolId.JP_MINOR]:       'ps_84',
    [SymbolId.JP_MAJOR]:       'ps_83',
    [SymbolId.JP_GRAND]:       'ps_82',
    [SymbolId.JP_UPGRADE]:     'ps_86',
};
/**
 * PS Symbol ID → tên file sprite (dùng psToClientMap từ GameData).
 * Fallback 'minor_q' nếu chưa có mapping.
 */
export function getPSSpriteNameById(psId: number): string {
    const clientId = GameData.instance.psToClientMap[psId];
    if (clientId !== undefined && clientId >= 0) {
        return CLIENT_SPRITE_MAP[clientId] ?? 'minor_q';
    }
    return 'minor_q';
}

// ═══════════════════════════════════════════════════════════
//  SYMBOL MANAGER
// ═══════════════════════════════════════════════════════════

export class SymbolManager {
    private static _instance: SymbolManager;
    /** Cache SpriteFrame đã load (key = client SymbolId 0-8) */
    private _spriteCache: Map<number, SpriteFrame> = new Map();

    static get instance(): SymbolManager {
        if (!this._instance) {
            this._instance = new SymbolManager();
        }
        return this._instance;
    }

    /**
     * Lấy tên sprite cho Client SymbolId (0-8).
     */
    getSpriteName(clientSymbolId: number): string {
        return CLIENT_SPRITE_MAP[clientSymbolId] ?? 'minor_q';
    }

    /**
     * Lấy tên sprite cho PS Symbol ID — dùng dynamic psToClientMap từ GameData.
     */
    getSpriteNameByPSId(psId: number): string {
        const clientId = GameData.instance.psToClientMap[psId];
        if (clientId !== undefined && clientId >= 0) {
            return CLIENT_SPRITE_MAP[clientId] ?? 'minor_q';
        }
        return 'minor_q';
    }

    /**
     * Lấy SpriteFrame cho Client SymbolId (0-8), async + cache.
     * Load từ resources/textures/symbol/{spriteName}/spriteFrame
     */
    async getSpriteFrame(clientSymbolId: number): Promise<SpriteFrame | null> {
        const cached = this._spriteCache.get(clientSymbolId);
        if (cached) return cached;

        const spriteName = this.getSpriteName(clientSymbolId);
        const path = `textures/symbol/${spriteName}/spriteFrame`;

        return new Promise((resolve) => {
            resources.load(path, SpriteFrame, (err, spriteFrame) => {
                if (err) {
                    Log.w(`[SymbolManager] Failed to load sprite for ClientID ${clientSymbolId}: ${path}`, err);
                    resolve(null);
                    return;
                }
                this._spriteCache.set(clientSymbolId, spriteFrame);
                resolve(spriteFrame);
            });
        });
    }

    /**
     * Lấy SpriteFrame cho PS Symbol ID — dùng dynamic psToClientMap.
     */
    async getSpriteFrameByPSId(psId: number): Promise<SpriteFrame | null> {
        const clientId = GameData.instance.psToClientMap[psId];
        if (clientId !== undefined && clientId >= 0) {
            return this.getSpriteFrame(clientId);
        }
        // Unknown PS ID → return null (will show fallback)
        return null;
    }

    /** Preload tất cả symbol xuất hiện trên reel (0..15 — bỏ JP icon vì chỉ dùng Pick Game). */
    async preloadReelSymbols(): Promise<void> {
        const ids = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
        const promises = ids.map((id) => this.getSpriteFrame(id));
        await Promise.all(promises);
    }

    /** Xóa cache (khi chuyển scene hoặc hot reload) */
    clearCache(): void {
        this._spriteCache.clear();
    }
}
