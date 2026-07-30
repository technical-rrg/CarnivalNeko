/**
 * ResponseLogger — Lưu toàn bộ server response (đã decrypt) để debug.
 *
 * Mỗi API call sẽ được lưu vào mảng entries.
 * Gọi ResponseLogger.downloadAll() để tải file JSON chứa tất cả.
 * Gọi ResponseLogger.downloadLast() để tải response gần nhất.
 *
 * Tự động skip Jackpot polling và HeartBeat (quá nhiều) trừ khi cần.
 */
import { Log } from './Logger';

export class ResponseLogger {
    private static _entries: ResponseEntry[] = [];
    private static _spinCount: number = 0;

    /**
     * Ghi nhận 1 response.
     * @param api   Tên API (Login, Enter, Spin, Claim, Jackpot, HeartBeat)
     * @param data  Object đã decrypt (raw JSON trước khi client convert)
     * @param extra Dữ liệu bổ sung (request body, packet header, PS parsed, ...)
     */
    static log(api: string, data: any, extra?: Record<string, any>): void {
        // Disabled for production performance: skip entirely.
        return;
    }

    /** Tổng số entries đã ghi */
    static get count(): number { return this._entries.length; }
    static get spinCount(): number { return this._spinCount; }

    /** Lấy entry cuối cùng */
    static get last(): ResponseEntry | null {
        return this._entries.length > 0 ? this._entries[this._entries.length - 1] : null;
    }

    /** Lấy tất cả entries */
    static get all(): ResponseEntry[] { return this._entries; }

    /**
     * Tải file JSON chứa TẤT CẢ responses.
     * Dùng trong browser preview (Blob + download link).
     */
    static downloadAll(): void {
        const content = JSON.stringify(this._entries, this._bigIntReplacer, 2);
        this._download(content, `supernova-responses-all-${this._fileTimestamp()}.json`);
        Log.d(`[ResponseLog] Downloaded ALL ${this._entries.length} entries`);
    }

    /**
     * Tải file JSON chứa response gần nhất.
     */
    static downloadLast(): void {
        const entry = this.last;
        if (!entry) { Log.w('[ResponseLog] No entries to download'); return; }
        const content = JSON.stringify(entry, this._bigIntReplacer, 2);
        this._download(content, `supernova-${entry.api}-${this._fileTimestamp()}.json`);
    }

    /**
     * Tải file JSON chỉ chứa PS (ParSheet) đã decode.
     */
    static downloadPS(): void {
        const enterEntry = this._entries.find(e => e.api === 'Enter');
        if (!enterEntry?.extra?.ps) {
            Log.w('[ResponseLog] No PS data found. Did Enter succeed?');
            return;
        }
        const content = JSON.stringify(enterEntry.extra.ps, this._bigIntReplacer, 2);
        this._download(content, `supernova-PS-${this._fileTimestamp()}.json`);
        Log.d('[ResponseLog] Downloaded PS');
    }

    /**
     * Tải file JSON chứa chỉ các Spin responses.
     */
    static downloadSpins(): void {
        const spins = this._entries.filter(e => e.api === 'Spin');
        if (spins.length === 0) { Log.w('[ResponseLog] No spin entries'); return; }
        const content = JSON.stringify(spins, this._bigIntReplacer, 2);
        this._download(content, `supernova-spins-${this._fileTimestamp()}.json`);
        Log.d(`[ResponseLog] Downloaded ${spins.length} spin entries`);
    }

    /** Clear all entries */
    static clear(): void {
        this._entries = [];
        this._spinCount = 0;
        Log.d('[ResponseLog] Cleared all entries');
    }

    // ─── Internal ───

    private static _download(content: string, filename: string): void {
        try {
            const blob = new Blob([content], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            // Fallback: log to console if download fails (e.g., non-browser env)
            Log.d(`[ResponseLog] Download failed, logging content for "${filename}":`);
            Log.d(content);
        }
    }

    private static _fileTimestamp(): string {
        const d = new Date();
        return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}`;
    }

    /** JSON replacer that handles BigInt */
    private static _bigIntReplacer(_key: string, value: any): any {
        return typeof value === 'bigint' ? value.toString() + 'n' : value;
    }
}

interface ResponseEntry {
    seq: number;
    api: string;
    timestamp: string;
    data: any;
    extra?: Record<string, any>;
}

// ═══ Expose to browser console for easy access ═══
// Gõ trong Console:
//   __RL.downloadAll()     → tải tất cả
//   __RL.downloadPS()      → tải PS
//   __RL.downloadSpins()   → tải các spin
//   __RL.downloadLast()    → tải response cuối
//   __RL.all               → xem tất cả entries
//   __RL.last              → xem entry cuối
if (typeof window !== 'undefined') {
    (window as any).__RL = ResponseLogger;
}
