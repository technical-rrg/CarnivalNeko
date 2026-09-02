/**
 * CryptoUtils - Các hàm mã hóa/giải mã và giải nén dùng chung.
 *
 * Được tách riêng để:
 *  1. NetworkManager.ts dùng cho request/response thật.
 *  2. NetworkDebugger.ts dùng để kiểm tra (unit test) trực tiếp.
 *
 * ★ AES-128-CBC (pre-login, Login request/response):
 *   Key = AES_LOGIN_KEY (16 bytes Base64)
 *   IV  = Random 16 bytes, prepend vào ciphertext
 *   Format: Base64( IV[16] ‖ CipherText )
 *
 * ★ AES-128-CBC (post-login, Aky):
 *   Aky = Base64( Key[16] ‖ IV[16] ) — tách Key và IV
 *   Input/Output format giống trên: Base64( IV[16] ‖ CipherText )
 *   (Tài liệu ghi AES-256 nhưng server xác nhận thực tế dùng AES-128)
 *
 * ★ PS (ParSheet) decode:
 *   Base64 string → Uint8Array → msgpackr.unpack() → JS object
 */

import * as _CryptoJSModule from 'crypto-js';
const CryptoJS: typeof import('crypto-js') = (_CryptoJSModule as any).default ?? _CryptoJSModule;
import { Packr, addExtension } from 'msgpackr';
import * as _LZ4Module from 'lz4js';
const LZ4 = (_LZ4Module as any).default ?? _LZ4Module;
import { ServerConfig } from '../data/ServerConfig';
import { Log } from './Logger';

// LZ4 decompress helper (dùng cho PS decode)
function _lz4Decompress(src: Uint8Array, uncompressedLen: number): Uint8Array {
    const dst = new Uint8Array(uncompressedLen);
    const fn: Function = (LZ4 as any).decompressBlock;
    if (typeof fn !== 'function') throw new Error('[LZ4] decompressBlock not found');
    const written = fn(src, dst, 0, src.length, 0);
    if (typeof written === 'number' && written > 0 && written !== uncompressedLen) {
        throw new Error(`[LZ4] decompressed ${written}/${uncompressedLen} bytes`);
    }
    return dst;
}

function _readMsgpackPositiveInt(bytes: Uint8Array): number {
    const b0 = bytes[0];
    if (b0 <= 0x7f) return b0;
    if (b0 === 0xcc) return bytes[1];
    if (b0 === 0xcd) return (bytes[1] << 8) | bytes[2];
    if (b0 === 0xce) return ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
    if (b0 === 0xd0) return bytes[1] << 24 >> 24;
    if (b0 === 0xd1) return bytes[1] << 24 >> 16 | bytes[2];
    if (b0 === 0xd2) return ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) | 0;
    throw new Error(`Unsupported msgpack int marker 0x${b0.toString(16)}`);
}

// Packr instance dùng riêng cho CryptoUtils (độc lập với NetworkManager)
export const cryptoPackr = new Packr({ useRecords: false, bundleStrings: false });

// Đăng ký ext type 175 (0xAF) — PS footer/signature của Gold of Fortune server.
// Phải đăng ký ở đây (trước khi NetworkManager load) để cryptoPackr nhận được.
addExtension({
    type: 175,
    unpack(_buffer: Uint8Array): any { return null; },
    pack(_val: any): never { throw new Error('[Ext175] Pack not supported'); },
});

// Đăng ký toàn bộ ext types 1–127 và 128–200 để ignore mọi trailer/metadata của server.
// Bỏ qua 175 (đã đăng ký ở trên).
for (let t = 1; t <= 200; t++) {
    if (t === 175) continue; // đã đăng ký ở trên
    addExtension({
        type: t,
        unpack(_buffer: Uint8Array): any { return null; },
        pack(_val: any): never { throw new Error(`[Ext${t}] Pack not supported`); },
    });
}

// ═══════════════════════════════════════════════════════════
//  AES-128 PRE-LOGIN (fixed key)
// ═══════════════════════════════════════════════════════════

/**
 * AES-128-CBC encrypt cho Login request.
 * Key  = Base64.decode(AES_LOGIN_KEY) — 16 bytes.
 * IV   = Random 16 bytes mỗi lần gọi.
 * Output: Base64( IV[16] ‖ CipherText ).
 */
export function encryptAES128(plainText: string): string {
    const key = CryptoJS.enc.Base64.parse(ServerConfig.AES_LOGIN_KEY);
    const iv  = CryptoJS.lib.WordArray.random(16);
    const encrypted = CryptoJS.AES.encrypt(plainText, key, {
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
        iv: iv,
    });
    return CryptoJS.enc.Base64.stringify(iv.concat(encrypted.ciphertext));
}

/**
 * AES-128-CBC decrypt cho Login response.
 * Key  = Base64.decode(AES_LOGIN_KEY) — 16 bytes.
 * Input: Base64( IV[16] ‖ CipherText ) — tách 16 byte đầu làm IV.
 */
export function decryptAES128(cipherText: string): string {
    const key = CryptoJS.enc.Base64.parse(ServerConfig.AES_LOGIN_KEY);
    const raw = CryptoJS.enc.Base64.parse(cipherText);
    const iv  = CryptoJS.lib.WordArray.create(raw.words.slice(0, 4), 16);
    const ct  = CryptoJS.lib.WordArray.create(raw.words.slice(4), raw.sigBytes - 16);
    const decrypted = CryptoJS.AES.decrypt(
        CryptoJS.lib.CipherParams.create({ ciphertext: ct }),
        key,
        { mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7, iv: iv },
    );
    return decrypted.toString(CryptoJS.enc.Utf8);
}

// ═══════════════════════════════════════════════════════════
//  AES GP DECRYPT (Gate token từ backend)
// ═══════════════════════════════════════════════════════════

/**
 * Decrypt gp token nhận từ URL.
 * Backend dùng key dạng text 32 ký tự và IV = 16 ký tự đầu của key.
 * Input format: Base64URL(CipherText), không prepend IV.
 */
export function decryptGateGpAES(cipherText: string, keyText: string): string {
    const normalized = normalizeBase64Url(cipherText);
    const key = CryptoJS.enc.Utf8.parse(keyText);
    const iv  = CryptoJS.enc.Utf8.parse(keyText.slice(0, 16));
    const ct  = CryptoJS.enc.Base64.parse(normalized);
    const decrypted = CryptoJS.AES.decrypt(
        CryptoJS.lib.CipherParams.create({ ciphertext: ct }),
        key,
        { mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7, iv: iv },
    );
    return decrypted.toString(CryptoJS.enc.Utf8);
}

function normalizeBase64Url(value: string): string {
    let normalized = value.trim()
        .replace(/ /g, '+')
        .replace(/-/g, '+')
        .replace(/_/g, '/');
    const padding = (4 - (normalized.length % 4)) % 4;
    if (padding > 0) normalized += '='.repeat(padding);
    return normalized;
}

// ═══════════════════════════════════════════════════════════
//  AES-128 POST-LOGIN (Aky session key)
// ═══════════════════════════════════════════════════════════

/**
 * AES-128-CBC encrypt cho request sau login.
 * Aky  = Base64( Key[16] ‖ IV[16] ) — tách Key và IV từ Aky.
 * Output: Base64( IV[16] ‖ CipherText ).
 */
export function encryptAES256(plainText: string, aky: string): string {
    const akyBytes = CryptoJS.enc.Base64.parse(aky);
    const key = CryptoJS.lib.WordArray.create(akyBytes.words.slice(0, 4), 16);
    const iv  = CryptoJS.lib.WordArray.create(akyBytes.words.slice(4, 8), 16);
    const encrypted = CryptoJS.AES.encrypt(plainText, key, {
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
        iv: iv,
    });
    return CryptoJS.enc.Base64.stringify(iv.concat(encrypted.ciphertext));
}

/**
 * AES-128-CBC decrypt cho response sau login.
 * Aky  = Base64( Key[16] ‖ IV_aky[16] ) — chỉ dùng Key (bytes 0-15).
 * Input: Base64( IV[16] ‖ CipherText ) — tách 16 byte đầu làm IV.
 */
export function decryptAES256(cipherText: string, aky: string): string {
    const akyBytes = CryptoJS.enc.Base64.parse(aky);
    const key = CryptoJS.lib.WordArray.create(akyBytes.words.slice(0, 4), 16);
    const raw = CryptoJS.enc.Base64.parse(cipherText);
    const iv  = CryptoJS.lib.WordArray.create(raw.words.slice(0, 4), 16);
    const ct  = CryptoJS.lib.WordArray.create(raw.words.slice(4), raw.sigBytes - 16);
    const decrypted = CryptoJS.AES.decrypt(
        CryptoJS.lib.CipherParams.create({ ciphertext: ct }),
        key,
        { mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7, iv: iv },
    );
    return decrypted.toString(CryptoJS.enc.Utf8);
}

// ═══════════════════════════════════════════════════════════
//  PS (PARSHEET) DECRYPTION
// ═══════════════════════════════════════════════════════════

/** Helper: Base64 string → Uint8Array (dùng atob, không cần CryptoJS) */
function base64ToUint8Array(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** Helper: tìm map object đầu tiên (không phải TypedArray/Array) có key > 0 */
function _firstObj(results: any[]): any | null {
    for (const r of results) {
        if (r && typeof r === 'object' && !Array.isArray(r)
            && !(r instanceof Uint8Array) && !(ArrayBuffer.isView(r))
            && Object.keys(r).length > 0) return r;
    }
    return null;
}

function _isPSObject(value: any): boolean {
    return value && typeof value === 'object' && !Array.isArray(value)
        && !(value instanceof Uint8Array) && !(ArrayBuffer.isView(value))
        && Object.keys(value).length > 0;
}

function _unwrapPSPayload(value: any, label: string): any | null {
    if (_isPSObject(value)) return value;
    if (typeof value !== 'string') return null;

    const text = value.trim();
    Log.e(`[SV-ERR] decryptPS: ${label} decoded string len=${value.length} prefix=${JSON.stringify(text.slice(0, 80))}`);
    if (!text || (text[0] !== '{' && text[0] !== '[')) return null;

    try {
        const parsed = JSON.parse(text);
        if (_isPSObject(parsed)) return parsed;
        Log.err(`[SV-ERR] decryptPS: ${label} JSON is not PS object: ${Object.prototype.toString.call(parsed)}`);
    } catch (jsonErr: any) {
        Log.err(`[SV-ERR] decryptPS: ${label} JSON parse failed: ${jsonErr.message}`);
    }
    return null;
}

/**
 * Giải nén trường PS từ AckEnter response.
 *
 * Thứ tự thử:
 *  0. Base64 → raw bytes → msgpack trực tiếp (không AES)  ← most likely
 *  1. Base64 → raw bytes → AES decrypt → msgpack / JSON
 *  2. Cả hai path: thử skip header bytes (1,2,4,5,8,16)
 *
 * Lưu ý: msgpackr ≥1.10 throw "not reached <jsonValue>" (giá trị đã parse, không phải số byte còn lại).
 * Trim loop cũ dựa trên số byte — SAI. Đã xóa.
 *
 * @param psBase64  Chuỗi Base64 từ AckEnter.PS
 * @returns         ParSheet object (Reel, FreeSpinReel, Bet, CoinValue, WinPopup...)
 */
export function decryptPS(psBase64: string, aky: string = ''): any {
    const packr = cryptoPackr;

    // ─── Decode raw bytes (dùng cho cả Strategy 0 và để log) ───
    let rawBytes: Uint8Array;
    try {
        rawBytes = base64ToUint8Array(psBase64);
    } catch (e: any) {
        Log.err(`[SV-ERR] decryptPS: base64 decode failed: ${e.message}`);
        return {};
    }
    const rawHex8 = Array.from(rawBytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    Log.e(`[SV-ERR] decryptPS: raw(pre-AES) len=${rawBytes.length} first8=[${rawHex8}]`);

    // ─── Strategy 0: raw bytes → parse trực tiếp (KHÔNG AES) ───

    // 0a: fixarray[2] = [ext8(type=98, uncompressedLen), bin32(lz4Data)] — Gold of Fortune PS format
    // Format: 0x92 [ext8: 0xc7 <len> 0x62 <msgpack_int_uncompressedLen>] [bin32: 0xc6 <len4> <lz4bytes>]
    if (rawBytes[0] === 0x92 && rawBytes[1] === 0xc7) {
        try {
            let pos = 1;
            const extLen  = rawBytes[pos + 1];          // number of data bytes in ext8
            const extType = rawBytes[pos + 2];          // should be 98 (0x62)
            const extData = rawBytes.slice(pos + 3, pos + 3 + extLen);
            pos += 3 + extLen;
            if (extType === 98 && rawBytes[pos] === 0xc6) {
                const uncompressedLen = _readMsgpackPositiveInt(extData);
                const binLen = (rawBytes[pos+1] << 24 | rawBytes[pos+2] << 16 |
                                rawBytes[pos+3] << 8  | rawBytes[pos+4]) >>> 0;
                if (pos + 5 + binLen > rawBytes.length) {
                    throw new Error(`bin32 length out of range: binLen=${binLen}, rawLen=${rawBytes.length}, offset=${pos + 5}`);
                }
                const lz4Data = rawBytes.slice(pos + 5, pos + 5 + binLen);
                Log.e(`[SV-ERR] decryptPS: PS LZ4-array detected | extLen=${extLen} | uncompressedLen=${uncompressedLen} | lz4Len=${binLen}`);
                const decompressed = _lz4Decompress(lz4Data, uncompressedLen);
                const decoded = packr.unpack(decompressed);
                const ps = _unwrapPSPayload(decoded, 'LZ4-array');
                if (ps) {
                    Log.e(`[SV-ERR] decryptPS: LZ4-array OK | uncompressedLen=${uncompressedLen} | keys: [${Object.keys(ps).join(', ')}]`);
                    return ps;
                }
                throw new Error(`decompressed msgpack is not PS object: ${Object.prototype.toString.call(decoded)}`);
            }
            throw new Error(`unsupported PS wrapper: extType=${extType}, next=0x${(rawBytes[pos] ?? 0).toString(16)}`);
        } catch (lz4Err: any) {
            Log.err(`[SV-ERR] decryptPS: LZ4-array failed: ${lz4Err.message}`);
            return {};
        }
    }

    // 0b: unpackMultiple — xử lý PS + optional trailer ext
    try {
        const results = packr.unpackMultiple(rawBytes) as any[];
        const found = _firstObj(results);
        if (found) {
            Log.e(`[SV-ERR] decryptPS: RAW multi OK | keys: [${Object.keys(found).join(', ')}]`);
            return found;
        }
    } catch (e: any) {
        Log.err(`[SV-ERR] decryptPS: RAW multi failed: ${e.message}`);
    }

    // 0c: single unpack
    try {
        const ps = packr.unpack(rawBytes);
        if (ps && typeof ps === 'object' && !Array.isArray(ps)
            && !(ps instanceof Uint8Array) && Object.keys(ps).length > 0) {
            Log.e(`[SV-ERR] decryptPS: RAW single OK | keys: [${Object.keys(ps).join(', ')}]`);
            return ps;
        }
    } catch (e: any) {
        Log.err(`[SV-ERR] decryptPS: RAW single failed: ${e.message}`);
    }

    // ─── Strategy 1: AES decrypt → msgpack / JSON ───
    let decryptedBytes: Uint8Array;
    try {
        const akyWords = CryptoJS.enc.Base64.parse(aky);
        const key = CryptoJS.lib.WordArray.create(akyWords.words.slice(0, 4), 16);
        const rawWords = CryptoJS.enc.Base64.parse(psBase64);
        const iv = CryptoJS.lib.WordArray.create(rawWords.words.slice(0, 4), 16);
        const ct = CryptoJS.lib.WordArray.create(rawWords.words.slice(4), rawWords.sigBytes - 16);
        const decrypted = CryptoJS.AES.decrypt(
            CryptoJS.lib.CipherParams.create({ ciphertext: ct }),
            key,
            { mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7, iv: iv }
        );
        decryptedBytes = new Uint8Array(decrypted.sigBytes);
        for (let i = 0; i < decrypted.sigBytes; i++) {
            decryptedBytes[i] = (decrypted.words[i >> 2] >>> (24 - (i % 4) * 8)) & 0xFF;
        }
    } catch (e: any) {
        Log.err(`[SV-ERR] decryptPS: AES decrypt failed: ${e.message}`);
        return {};
    }

    const aesHex8 = Array.from(decryptedBytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    Log.e(`[SV-ERR] decryptPS: AES OK len=${decryptedBytes.length} first8=[${aesHex8}] isJSON=${decryptedBytes[0] === 0x7b}`);

    // 1a: JSON
    if (decryptedBytes[0] === 0x7b) {
        try {
            const ps = JSON.parse(new TextDecoder('utf-8').decode(decryptedBytes));
            Log.e(`[SV-ERR] decryptPS: AES+JSON OK | keys: [${Object.keys(ps || {}).join(', ')}]`);
            return ps;
        } catch (e: any) {
            Log.err(`[SV-ERR] decryptPS: AES+JSON failed: ${e.message}`);
            return {};
        }
    }

    // 1b: msgpack unpackMultiple
    try {
        const results = packr.unpackMultiple(decryptedBytes) as any[];
        const found = _firstObj(results);
        if (found) {
            Log.e(`[SV-ERR] decryptPS: AES+multi OK | keys: [${Object.keys(found).join(', ')}]`);
            return found;
        }
    } catch (e: any) {
        Log.err(`[SV-ERR] decryptPS: AES+multi failed: ${e.message}`);
    }

    // 1c: single unpack
    try {
        const ps = packr.unpack(decryptedBytes);
        if (ps && typeof ps === 'object' && !Array.isArray(ps) && Object.keys(ps).length > 0) {
            Log.e(`[SV-ERR] decryptPS: AES+single OK | keys: [${Object.keys(ps).join(', ')}]`);
            return ps;
        }
    } catch (e: any) {
        Log.err(`[SV-ERR] decryptPS: AES+single failed: ${e.message}`);
    }

    // 1d: skip header bytes (1,2,4,5,8,16) — AES output có thể có header trước msgpack
    for (const skip of [1, 2, 4, 5, 8, 16]) {
        if (skip >= decryptedBytes.length) break;
        const slice = decryptedBytes.slice(skip);
        try {
            const ps = packr.unpack(slice);
            if (ps && typeof ps === 'object' && !Array.isArray(ps) && Object.keys(ps).length > 2) {
                Log.e(`[SV-ERR] decryptPS: AES+skip${skip} OK | keys: [${Object.keys(ps).join(', ')}]`);
                return ps;
            }
        } catch (_) {}
        try {
            const results = packr.unpackMultiple(slice) as any[];
            const found = _firstObj(results);
            if (found && Object.keys(found).length > 2) {
                Log.e(`[SV-ERR] decryptPS: AES+skip${skip}+multi OK | keys: [${Object.keys(found).join(', ')}]`);
                return found;
            }
        } catch (_) {}
    }

    Log.err(`[SV-ERR] decryptPS: ALL FORMATS FAILED. rawLen=${rawBytes.length} aesLen=${decryptedBytes.length}`);
    return {};
}

/**
 * Tạo PS Base64 giả (chỉ dùng cho test/debug).
 * Pack một object mẫu bằng msgpackr rồi chuyển sang Base64.
 */
export function makeFakePS(obj: any): string {
    const bytes: Uint8Array = cryptoPackr.pack(obj);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
