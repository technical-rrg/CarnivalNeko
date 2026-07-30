/**
 * BetManager - Quản lý BetIndex và CoinValue.
 * Singleton, phát event khi bet thay đổi.
 */

import { EventBus } from '../core/EventBus';
import { GameEvents } from '../core/GameEvents';
import { GameData } from '../data/GameData';

export class BetManager {
    private static _instance: BetManager;

    static get instance(): BetManager {
        if (!this._instance) {
            this._instance = new BetManager();
        }
        return this._instance;
    }

    private get _data() { return GameData.instance; }

    get betIndex(): number {
        return this._data.player.betIndex;
    }

    get coinValue(): number {
        return this._data.player.coinValue;
    }

    get currentBet(): number {
        return this._data.config.betOptions[this.betIndex] ?? 1;
    }

    get totalBet(): number {
        return this._data.totalBet;
    }

    changeBetIndex(delta: number): void {
        const options = this._data.config.betOptions;
        let idx = this.betIndex + delta;
        idx = Math.max(0, Math.min(idx, options.length - 1));
        this._data.player.betIndex = idx;
        this._emitChange();
    }

    setBetIndex(index: number): void {
        const options = this._data.config.betOptions;
        this._data.player.betIndex = Math.max(0, Math.min(index, options.length - 1));
        this._emitChange();
    }

    changeCoinValue(delta: number): void {
        const values = this._data.config.coinValues;
        let currentIdx = values.indexOf(this.coinValue);
        if (currentIdx < 0) currentIdx = 0;
        currentIdx += delta;
        currentIdx = Math.max(0, Math.min(currentIdx, values.length - 1));
        this._data.player.coinValue = values[currentIdx];
        this._emitChange();
    }

    private _emitChange(): void {
        EventBus.instance.emit(GameEvents.BET_CHANGED, {
            betIndex: this.betIndex,
            currentBet: this.currentBet,
            coinValue: this.coinValue,
            totalBet: this.totalBet,
        });
    }
}
