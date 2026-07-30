/**
 * EventBus - Hệ thống giao tiếp decoupled giữa các module.
 * Sử dụng pattern Singleton + Observer.
 */
import { Log } from './Logger';

type EventCallback = (...args: any[]) => void;

interface EventEntry {
    callback: EventCallback;
    target: any;
    once: boolean;
}

export class EventBus {
    private static _instance: EventBus;
    private _listeners: Map<string, EventEntry[]> = new Map();

    static get instance(): EventBus {
        if (!this._instance) {
            this._instance = new EventBus();
        }
        return this._instance;
    }

    on(event: string, callback: EventCallback, target?: any): void {
        if (event === 'jackpot:trigger') {
            Log.d(`[EventBus] JACKPOT_TRIGGER listener registered`, {
                targetName: target?.constructor?.name ?? 'unknown',
                callbackName: callback.name,
                currentListenerCount: (this._listeners.get(event) ?? []).length + 1,
            });
        }
        this._addListener(event, callback, target, false);
    }

    once(event: string, callback: EventCallback, target?: any): void {
        this._addListener(event, callback, target, true);
    }

    off(event: string, callback: EventCallback, target?: any): void {
        const entries = this._listeners.get(event);
        if (!entries) return;
        const filtered = entries.filter(
            (e) => !(e.callback === callback && e.target === target)
        );
        if (filtered.length > 0) {
            this._listeners.set(event, filtered);
        } else {
            this._listeners.delete(event);
        }
    }

    /** Xóa toàn bộ listener của 1 target (gọi khi onDestroy) */
    offTarget(target: any): void {
        this._listeners.forEach((entries, event) => {
            const filtered = entries.filter((e) => e.target !== target);
            if (filtered.length > 0) {
                this._listeners.set(event, filtered);
            } else {
                this._listeners.delete(event);
            }
        });
    }

    emit(event: string, ...args: any[]): void {
        if (event === 'jackpot:trigger') {
            Log.d(`[EventBus] 📂 emit("${event}")`, {
                listenerCount: (this._listeners.get(event) ?? []).length,
                args: args,
                timestamp: Date.now(),
            });
        }
        const entries = this._listeners.get(event);
        if (!entries) {
            if (event === 'jackpot:trigger') {
                Log.w(`[EventBus] ⚠️  ${event} emitted but NO LISTENERS registered!`);
            }
            return;
        }
        // Clone để tránh mutation khi once tự remove
        const snapshot = [...entries];
        for (const entry of snapshot) {
            entry.callback.apply(entry.target, args);
            if (entry.once) {
                this.off(event, entry.callback, entry.target);
            }
        }
    }

    clear(): void {
        this._listeners.clear();
    }

    private _addListener(event: string, callback: EventCallback, target: any, once: boolean): void {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, []);
        }
        const entries = this._listeners.get(event)!;
        if (entries.some(e => e.callback === callback && e.target === target)) return;
        entries.push({ callback, target, once });
    }
}
