/**
 * WalletManager - Quản lý balance người chơi.
 * Singleton, thông báo UI qua EventBus khi balance thay đổi.
 */

import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';

export class WalletManager {
    private static _instance: WalletManager;

    static get instance(): WalletManager {
        if (!this._instance) {
            this._instance = new WalletManager();
        }
        return this._instance;
    }

    get balance(): number {
        return GameData.instance.player.balance;
    }

    set balance(value: number) {
        GameData.instance.player.balance = Math.max(0, value);
        EventBus.instance.emit(GameEvents.BALANCE_UPDATED, this.balance);
    }

    canAfford(amount: number): boolean {
        return this.balance >= amount;
    }

    deduct(amount: number): boolean {
        if (!this.canAfford(amount)) return false;
        this.balance -= amount;
        return true;
    }

    add(amount: number): void {
        this.balance += amount;
    }
}
