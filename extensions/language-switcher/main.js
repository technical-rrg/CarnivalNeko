'use strict';

/**
 * language-switcher — Cocos Creator 3.x Editor Extension
 *
 * Thay đổi ngôn ngữ game nhanh cho mục đích testing.
 * Ghi vào ServerConfig.ts → DEV_FORCE_LANG (override localStorage khi khởi động game).
 *
 * Để Enable:  Extensions → Extension Manager → bật "language-switcher"
 * Để dùng:    Extensions → 🌐 Language Switcher → chọn ngôn ngữ
 *
 * "Auto (clear override)" → DEV_FORCE_LANG = null → game dùng localStorage như bình thường.
 */

const path = require('path');
const fs   = require('fs');

// ─── Constants ────────────────────────────────────────────────────────────────

const LANGUAGES = [
    { code: 'en',    label: 'English',                  native: 'English',        flag: '🇺🇸' },
    { code: 'ko',    label: 'Korean',                   native: '한국어',           flag: '🇰🇷' },
    { code: 'zh-cn', label: 'Simplified Chinese',       native: '简体中文',         flag: '🇨🇳' },
    { code: 'zh-tw', label: 'Traditional Chinese',      native: '繁體中文',         flag: '🇹🇼' },
    { code: 'fil',   label: 'Filipino',                 native: 'Filipino',       flag: '🇵🇭' },
    { code: 'ja',    label: 'Japanese',                 native: '日本語',           flag: '🇯🇵' },
    { code: 'th',    label: 'Thai',                     native: 'ภาษาไทย',        flag: '🇹🇭' },
    { code: 'sg',    label: 'Singapore',                native: 'English (SG)',   flag: '🇸🇬' },
    { code: 'ms',    label: 'Malay',                    native: 'Bahasa Melayu',  flag: '🇲🇾' },
    { code: 'vi',    label: 'Vietnamese',               native: 'Tiếng Việt',      flag: '🇻🇳' },
    { code: 'au',    label: 'Australia',                native: 'English (AU)',   flag: '🇦🇺' },
    { code: 'hk',    label: 'Hong Kong',                native: 'English (HK)',   flag: '🇭🇰' },
];

// ─── Extension lifecycle ──────────────────────────────────────────────────────

let projectRoot = '';

exports.load = function () {
    projectRoot = path.join(__dirname, '..', '..');
    console.log('[LanguageSwitcher] Loaded. Project root:', projectRoot);
};

exports.unload = function () {};

// ─── Message handlers ─────────────────────────────────────────────────────────

exports.methods = {
    setLangEn()    { _setLang('en'); },
    setLangKo()    { _setLang('ko'); },
    setLangZhCn()  { _setLang('zh-cn'); },
    setLangZhTw()  { _setLang('zh-tw'); },
    setLangFil()   { _setLang('fil'); },
    setLangJa()    { _setLang('ja'); },
    setLangTh()    { _setLang('th'); },
    setLangSg()    { _setLang('sg'); },
    setLangMs()    { _setLang('ms'); },
    setLangVi()    { _setLang('vi'); },
    setLangAu()    { _setLang('au'); },
    setLangHk()    { _setLang('hk'); },
    setLangAuto()  { _setLang(null); },
};

// ─── Core logic ───────────────────────────────────────────────────────────────

function _setLang(code) {
    const configPath = path.join(projectRoot, 'assets', 'scripts', 'data', 'ServerConfig.ts');

    if (!fs.existsSync(configPath)) {
        Editor.Dialog.error(
            `Không tìm thấy ServerConfig.ts:\n${configPath}`,
            { title: 'Language Switcher — Lỗi' }
        );
        return;
    }

    let content;
    try {
        content = fs.readFileSync(configPath, 'utf8');
    } catch (e) {
        Editor.Dialog.error(
            `Không đọc được ServerConfig.ts:\n${e.message}`,
            { title: 'Language Switcher — Lỗi' }
        );
        return;
    }

    // Regex replace: export const DEV_FORCE_LANG: string | null = <value>;
    const newValue = code === null ? 'null' : `'${code}'`;
    const updated = content.replace(
        /(export const DEV_FORCE_LANG:\s*string\s*\|\s*null\s*=\s*)(?:'[^']*'|null)(;)/,
        `$1${newValue}$2`
    );

    if (updated === content) {
        Editor.Dialog.error(
            'Không tìm thấy dòng DEV_FORCE_LANG trong ServerConfig.ts.\nHãy kiểm tra file đã có dòng:\n  export const DEV_FORCE_LANG: string | null = null;',
            { title: 'Language Switcher — Lỗi' }
        );
        return;
    }

    try {
        fs.writeFileSync(configPath, updated, 'utf8');
    } catch (e) {
        Editor.Dialog.error(
            `Không ghi được ServerConfig.ts:\n${e.message}`,
            { title: 'Language Switcher — Lỗi' }
        );
        return;
    }

    // Read back to confirm
    const verified = fs.readFileSync(configPath, 'utf8');
    const match = verified.match(/export const DEV_FORCE_LANG:\s*string\s*\|\s*null\s*=\s*([^;]+);/);
    const actual = match ? match[1].trim() : '(unknown)';

    if (code === null) {
        Editor.Dialog.info(
            `✅ Đã xóa override ngôn ngữ.\n\nDEV_FORCE_LANG = null\n\nGame sẽ dùng ngôn ngữ đã lưu trong localStorage (hoặc English mặc định).`,
            { title: 'Language Switcher — Hoàn tất' }
        );
    } else {
        const langInfo = LANGUAGES.find(l => l.code === code);
        const display = langInfo
            ? `${langInfo.flag}  ${langInfo.label} — ${langInfo.native}`
            : code;

        Editor.Dialog.info(
            `✅ Đã chuyển ngôn ngữ sang:\n\n${display}\n\nDEV_FORCE_LANG = ${actual}\n\nKhởi động lại Preview để áp dụng.`,
            { title: 'Language Switcher — Hoàn tất' }
        );
    }

    console.log('[LanguageSwitcher] DEV_FORCE_LANG →', actual);
}
