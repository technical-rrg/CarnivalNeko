/**
 * SymbolManager — ★ Secret Treasure mapping (5×3, Ways Pay).
 *
 * Hỗ trợ 2 hệ thống ID:
 *   - Client SymbolId (0–20): dùng bởi SymbolView, GameData mock strips
 *   - PS Symbol ID:           dùng bởi server API
 *
 * Quy ước đặt tên file hình (đặt trong `assets/bundle/textures/symbol/`):
 *   minor_9, minor_10, minor_j, minor_q, minor_k, minor_a   (id 0..5)
 *   major_horus, major_anubis, major_sobek, major_ramses, major_cleopatra  (id 6..10)
 *   wild_trail                                                (id 11)
 *   sticky_red, sticky_yellow, sticky_green                   (id 12/13/14)
 *   plus_one_spin                                             (id 15)
 *   jp_idle, jp_mini, jp_minor, jp_major, jp_grand           (id 16..20, Pick Game)
 */

import { SpriteFrame, resources } from 'cc';
import { SymbolId } from '../data/SlotTypes';
import { Log } from '../core/Logger';
import { GameData } from '../data/GameData';

// ═══════════════════════════════════════════════════════════
//  CLIENT SYMBOL ID → SPRITE NAME MAPPING
// ═══════════════════════════════════════════════════════════

export const CLIENT_SPRITE_MAP: Record<number, string> = {
    // ─── Minor (low pay) ───
    [SymbolId.MINOR_9]:        'minor_9',
    [SymbolId.MINOR_10]:       'minor_10',
    [SymbolId.MINOR_J]:        'minor_j',
    [SymbolId.MINOR_Q]:        'minor_q',
    [SymbolId.MINOR_K]:        'minor_k',
    [SymbolId.MINOR_A]:        'minor_a',
    // ─── Major (high pay) ───
    [SymbolId.MAJOR_HORUS]:     'major_horus',
    [SymbolId.MAJOR_ANUBIS]:    'major_anubis',
    [SymbolId.MAJOR_SOBEK]:     'major_sobek',
    [SymbolId.MAJOR_RAMSES]:    'major_ramses',
    [SymbolId.MAJOR_CLEOPATRA]: 'major_cleopatra',
    // ─── Wild Trail (reel 1/2/3) ───
    [SymbolId.WILD]:           'wild_trail',
    // ─── Sticky symbols (Feature) ───
    [SymbolId.STICKY_RED]:     'sticky_red',
    [SymbolId.STICKY_YELLOW]:  'sticky_yellow',
    [SymbolId.STICKY_GREEN]:   'sticky_green',
    [SymbolId.PLUS_ONE_SPIN]:  'plus_one_spin',
    // ─── Jackpot icons (Pick Game) ───
    [SymbolId.JP_IDLE]:        'jp_idle',
    [SymbolId.JP_MINI]:        'jp_mini',
    [SymbolId.JP_MINOR]:       'jp_minor',
    [SymbolId.JP_MAJOR]:       'jp_major',
    [SymbolId.JP_GRAND]:       'jp_grand',
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
