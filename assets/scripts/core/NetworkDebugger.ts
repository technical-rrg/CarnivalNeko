/**
 * NetworkDebugger - Component kiểm tra logic mã hóa/giải nén của NetworkManager.
 *
 * ★ CÁCH DÙNG:
 *   1. Gắn Script này vào bất kỳ Node nào trong Scene.
 *   2. Bật Cocos Preview → mở Console (F12) → xem kết quả.
 *   3. Hoặc gọi networkDebugger.runAllTests() từ Inspector button.
 *
 * ★ CÁC TEST:
 *   - testAES128()  : Encrypt/Decrypt với AES_LOGIN_KEY (pre-login)
 *   - testAES256()  : Encrypt/Decrypt với Aky giả (post-login)
 *   - testPS()      : Pack object → Base64 → decryptPS() → so sánh
 *   - runAllTests() : Chạy cả 3, in tổng kết
 *
 * ★ LÝ DO DÙNG MODULE RIÊNG (CryptoUtils.ts):
 *   Các hàm trong RealNetworkAdapter là private nên không thể truy cập
 *   trực tiếp từ bên ngoài. Giải pháp sạch nhất là tách logic mã hóa
 *   thành module CryptoUtils.ts được export — cả NetworkManager lẫn
 *   NetworkDebugger đều import từ đó, không cần hack private access.
 */

import { _decorator, Component } from 'cc';
import {
    encryptAES128, decryptAES128,
    encryptAES256, decryptAES256,
    decryptPS, makeFakePS,
} from '../core/CryptoUtils';
import { Log } from './Logger';

const { ccclass, property } = _decorator;

// ─── Fake Aky (32 bytes Base64 = Key[16] ‖ IV[16]) ─────────────────────────
// Dùng cho test post-login AES mà không cần server thật.
// Key = "TestKey_16bytes!" (16 bytes ASCII)
// IV  = "TestIV__16bytes!" (16 bytes ASCII)
const FAKE_AKY = btoa('TestKey_16bytes!TestIV__16bytes!');

@ccclass('NetworkDebugger')
export class NetworkDebugger extends Component {

    // ═══════════════════════════════════════════════════════════
    //  LIFECYCLE
    // ═══════════════════════════════════════════════════════════

    start(): void {
        this.runAllTests();
    }

    // ═══════════════════════════════════════════════════════════
    //  PUBLIC: CHẠY TẤT CẢ TEST
    // ═══════════════════════════════════════════════════════════

    /**
     * Chạy cả 3 test và in tổng kết.
     * Gọi từ Inspector button hoặc tự chạy trong start().
     */
    runAllTests(): void {
        Log.d('════════════════════════════════════════════');
        Log.d('  NetworkDebugger — Bắt đầu kiểm tra');
        Log.d('════════════════════════════════════════════');

        const results: { name: string; passed: boolean; error?: string }[] = [];

        results.push(this._run('AES-128 (pre-login)',  () => this.testAES128()));
        results.push(this._run('AES-128 (post-login)', () => this.testAES256()));
        results.push(this._run('PS decode (msgpackr)', () => this.testPS()));

        const passed = results.filter(r => r.passed).length;
        const total  = results.length;

        Log.d('────────────────────────────────────────────');
        results.forEach(r => {
            const icon = r.passed ? '✅' : '❌';
            const msg  = r.passed ? 'Thành công' : `Thất bại — ${r.error}`;
            Log.d(`  ${icon} ${r.name}: ${msg}`);
        });
        Log.d('────────────────────────────────────────────');
        Log.d(`  Kết quả: ${passed}/${total} test PASSED`);
        Log.d('════════════════════════════════════════════');
    }

    // ═══════════════════════════════════════════════════════════
    //  TEST 1: AES-128 PRE-LOGIN
    // ═══════════════════════════════════════════════════════════

    /**
     * Kiểm tra AES-128 dùng AES_LOGIN_KEY (pre-login).
     * Yêu cầu: AES_LOGIN_KEY phải đã được điền trong ServerConfig.ts.
     * Flow: JSON → encryptAES128 → decryptAES128 → so sánh với gốc.
     */
    testAES128(): void {
        const original = JSON.stringify({
            PlatformId: 'testuser01',
            DeviceToken: '',
            PartnerId: 1,
            Currency: 'USD',
            IsPractice: false,
        });

        const encrypted = encryptAES128(original);
        const decrypted = decryptAES128(encrypted);

        if (decrypted !== original) {
            throw new Error(`Dữ liệu sau decrypt không khớp.\n  Gốc: ${original}\n  Sau: ${decrypted}`);
        }

        Log.d('  [AES128] Original :', original);
        Log.d('  [AES128] Encrypted:', encrypted);
        Log.d('  [AES128] Decrypted:', decrypted);
    }

    // ═══════════════════════════════════════════════════════════
    //  TEST 2: AES-128 POST-LOGIN (Aky)
    // ═══════════════════════════════════════════════════════════

    /**
     * Kiểm tra AES-128 dùng Aky session key (post-login).
     * Aky = Base64( Key[16] ‖ IV[16] ).
     * Flow: JSON → encryptAES256 → decryptAES256 → so sánh với gốc.
     *
     * Dùng FAKE_AKY để test offline (không cần server).
     */
    testAES256(): void {
        const original = JSON.stringify({
            BetIndex: 0,
            BetLines: 0,
            CoinValueIndex: 0,
            DebugArray: [],
            SlotId: 16,
            Dbg: '',
        });

        const encrypted = encryptAES256(original, FAKE_AKY);
        const decrypted = decryptAES256(encrypted, FAKE_AKY);

        if (decrypted !== original) {
            throw new Error(`Dữ liệu sau decrypt không khớp.\n  Gốc: ${original}\n  Sau: ${decrypted}`);
        }

        Log.d('  [AES256] FAKE_AKY :', FAKE_AKY);
        Log.d('  [AES256] Original :', original);
        Log.d('  [AES256] Encrypted:', encrypted);
        Log.d('  [AES256] Decrypted:', decrypted);
    }

    // ═══════════════════════════════════════════════════════════
    //  TEST 3: PS DECODE (msgpackr)
    // ═══════════════════════════════════════════════════════════

    /**
     * Kiểm tra giải nén ParSheet.
     * Flow:
     *   1. Tạo object PS mẫu (giống format từ SuperNova PS.json).
     *   2. makeFakePS() → pack bằng msgpackr → Base64 string.
     *   3. decryptPS() → unpack → so sánh với original.
     */
    testPS(): void {
        const fakePSObject = {
            GameName: 'SuperNova',
            Bet: [1, 2, 3, 4, 5, 10, 20, 50, 100],
            CoinValue: [0.01, 0.02, 0.05, 0.10, 0.20, 0.50, 1.00],
            WinPopup: { Normal: 5, Big: 10, Super: 30, Mega: 80 },
            Reel: {
                Strips: [
                    { Symbols: [3, 14, 2, 15, 1, 12, 3, 1, 4, 15] }, // Reel 0
                    { Symbols: [11, 1, 14, 2, 4, 12, 2, 15, 1, 11] }, // Reel 1
                    { Symbols: [1, 4, 13, 2, 14, 11, 1, 12, 2, 15] }, // Reel 2
                ],
            },
        };

        // Pack → Base64 (giả lập PS field từ server)
        const psBase64 = makeFakePS(fakePSObject);

        // Unpack → object
        const result = decryptPS(psBase64);

        // Kiểm tra các field quan trọng
        this._assert(result.GameName === fakePSObject.GameName,
            `GameName mismatch: ${result.GameName} !== ${fakePSObject.GameName}`);

        this._assert(JSON.stringify(result.Bet) === JSON.stringify(fakePSObject.Bet),
            `Bet mismatch: ${JSON.stringify(result.Bet)}`);

        this._assert(result.Reel?.Strips?.length === 3,
            `Reel.Strips.length mismatch: ${result.Reel?.Strips?.length}`);

        this._assert(
            JSON.stringify(result.Reel.Strips[0].Symbols) ===
            JSON.stringify(fakePSObject.Reel.Strips[0].Symbols),
            `Reel.Strips[0].Symbols mismatch`,
        );

        Log.d('  [PS] psBase64   :', psBase64.substring(0, 40) + '...');
        Log.d('  [PS] GameName   :', result.GameName);
        Log.d('  [PS] Bet        :', JSON.stringify(result.Bet));
        Log.d('  [PS] CoinValue  :', JSON.stringify(result.CoinValue));
        Log.d('  [PS] Reel strips:', result.Reel.Strips.length);
        Log.d('  [PS] Strip[0]   :', JSON.stringify(result.Reel.Strips[0].Symbols));
    }

    // ═══════════════════════════════════════════════════════════
    //  PRIVATE HELPERS
    // ═══════════════════════════════════════════════════════════

    private _run(name: string, fn: () => void): { name: string; passed: boolean; error?: string } {
        try {
            fn();
            return { name, passed: true };
        } catch (e: any) {
            return { name, passed: false, error: e?.message ?? String(e) };
        }
    }

    private _assert(condition: boolean, message: string): void {
        if (!condition) {
            throw new Error(message);
        }
    }
}
