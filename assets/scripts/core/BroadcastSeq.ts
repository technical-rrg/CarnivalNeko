/**
 * BroadcastSeq — first broadcast poll shows only the newest message.
 *
 * Platform rule from Blast Rocket a6ff834f3 (NetworkHandler.cs / BroadcastController.SkipAndUpdateSeqID):
 *   when the request was sent with LastWinMsgId = 0 (first poll of the session), emit only the
 *   message with the highest Seq and remember that highest Seq; later polls are unchanged.
 *
 * Seq is a 19-digit Int64. pollJackpot quotes long Seq values before JSON.parse, short ones stay
 * numbers — compare as BigInt. Anything ambiguous returns null so the caller keeps the original path.
 */

const DIGITS = /^\d+$/;

/** Seq (string of digits or safe integer) → BigInt, or null when it cannot be read exactly. */
export function parseBroadcastSeq(value: unknown): bigint | null {
    if (typeof value === 'bigint') return value >= 0n ? value : null;
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
    if (typeof value === 'string') return DIGITS.test(value) ? BigInt(value) : null;
    return null;
}

/** True when the LastWinMsgId sent with this request was 0 (first poll). */
export function isFirstBroadcastRequest(sentLastWinMsgId: unknown): boolean {
    return parseBroadcastSeq(sentLastWinMsgId) === 0n;
}

/**
 * Newest message + highest Seq of a WinMsgs list. Null when a message is not an object or no
 * Seq can be read — the caller then falls back to the original "emit all" path.
 */
export function pickLatestBroadcast<T extends { Seq?: unknown }>(msgs: readonly T[]): { latest: T; maxSeq: string } | null {
    let latest: T | null = null;
    let max: bigint | null = null;
    for (const msg of msgs) {
        if (msg === null || typeof msg !== 'object') return null;
        const seq = parseBroadcastSeq(msg.Seq);
        if (seq === null) continue;
        if (max === null || seq > max) {
            max = seq;
            latest = msg;
        }
    }
    return latest !== null && max !== null ? { latest, maxSeq: max.toString() } : null;
}
