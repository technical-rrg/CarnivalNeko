#!/usr/bin/env node
/**
 * convert-localization-xlsx.js
 *
 * Chuyển đổi file Excel ngôn ngữ từ đối tác → locale .ts files cho game.
 *
 * ★ CÁCH DÙNG:
 *   node tools/convert-localization-xlsx.js <path-to-xlsx>
 *
 *   Ví dụ:
 *   node tools/convert-localization-xlsx.js "SuperNova_LocalizationStringTable_20260409.xlsx"
 *
 * ★ OUTPUT:
 *   - Ghi đè assets/scripts/data/locales/{en,ko,zh-cn,zh-tw,fil,ja,th,sg,ms,vi}.ts
 *   - Tạo assets/scripts/data/locales/locale-online.json (dùng cho online mode)
 *
 * ★ FORMAT XLSX:
 *   Row 0 (header): Key | 사용위치 | English(en) | Korean(ko) | zh-Hans | zh-Hant | fil-PH | ja | th
 *   Row 1+: key | location | en_value | ko_value | ...
 *
 * ★ KEY NAMING:
 *   File Excel dùng keys kiểu UI_START_LOADING_1, UI_POPUP_SYSTEM_OK, ...
 *   Game hiện tại dùng keys kiểu good_luck, win_amount, ...
 *   Tool GIỮA NGUYÊN cả 2 bộ keys — LocalizationManager.getText() tra bất kỳ key nào.
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ───

/** Column index → language code (khớp với header Excel) */
const COL_MAP = {
    2: 'en',
    3: 'ko',
    4: 'zh-cn',
    5: 'zh-tw',
    6: 'fil',
    7: 'ja',
    8: 'th',
    9: 'sg',
    10: 'ms',
    11: 'vi',
};

/** Constant names cho export (LOCALE_EN, LOCALE_KO, ...) */
const CONST_MAP = {
    'en': 'LOCALE_EN',
    'ko': 'LOCALE_KO',
    'zh-cn': 'LOCALE_ZH_CN',
    'zh-tw': 'LOCALE_ZH_TW',
    'fil': 'LOCALE_FIL',
    'ja': 'LOCALE_JA',
    'th': 'LOCALE_TH',
    'sg': 'LOCALE_SG',
    'ms': 'LOCALE_MS',
    'vi': 'LOCALE_VI',
};

/** Language display names */
const LANG_NAMES = {
    'en': 'English (en)',
    'ko': 'Korean (ko) — 한국어',
    'zh-cn': 'Simplified Chinese (zh-cn) — 简体中文',
    'zh-tw': 'Traditional Chinese (zh-tw) — 繁體中文',
    'fil': 'Filipino (fil)',
    'ja': 'Japanese (ja) — 日本語',
    'th': 'Thai (th) — ภาษาไทย',
    'sg': 'Singapore English (sg)',
    'ms': 'Malay (ms) — Bahasa Melayu',
    'vi': 'Vietnamese (vi) — Tiếng Việt',
};

/** Keys cũ từ game hiện tại — GIỮA LẠI, merge với keys mới từ Excel */
const LEGACY_KEYS = {
    'en': {
        good_luck:              'GOOD LUCK!',
        no_win:                 'Better luck next time!',
        normal_spin:            'NORMAL SPIN',
        free_spin_mode:         'FREE SPIN x{count}',
        win_amount:             'WIN ${amount}',
        grand_jackpot:          'GRAND JACKPOT',
        major_jackpot:          'MAJOR JACKPOT',
        minor_jackpot:          'MINOR JACKPOT',
        mini_jackpot:           'MINI JACKPOT',
        big_win:                'BIG WIN',
        super_win:              'SUPER WIN',
        epic_win:               'EPIC WIN',
        mega_win:               'MEGA WIN',
        free_spin_awarded:      '{count} FREE SPINS AWARDED',
        free_spin_title:        'FREE SPINS',
        congratulations:        'CONGRATULATIONS\nYOU WON',
        in_free_spins:          'IN {count} FREE SPINS',
        press_to_continue:      'PRESS ANYWHERE TO CONTINUE',
        total_win:              'TOTAL WIN',
        settings:               'SETTINGS',
        sound_fx:               'SOUND FX',
        music:                  'MUSIC',
        language:               'LANGUAGE',
        game_rules:             'GAME RULES',
        how_to_play:            'HOW TO PLAY',
        bet:                    'BET',
        total_bet:              'TOTAL BET',
        credit:                 'CREDIT',
        coin_value:             'COIN VALUE',
        autoplay:               'AUTOPLAY',
        autoplay_setting:       'AUTOPLAY SETTING',
        start_autoplay:         'START AUTOPLAY ({count})',
        turbo_spin:             'TURBO SPIN',
        auto_spins_left:        'AUTO SPINS LEFT',
        spin:                   'SPIN',
        stop:                   'STOP',
        collect:                'COLLECT',
        currency_symbol:        '$',
    },
    'ko': {
        good_luck:              '행운을 빕니다!',
        no_win:                 '다음 기회에!',
        normal_spin:            '일반 스핀',
        free_spin_mode:         '프리 스핀 x{count}',
        win_amount:             '당첨 ${amount}',
        grand_jackpot:          '그랜드 잭팟',
        major_jackpot:          '메이저 잭팟',
        minor_jackpot:          '마이너 잭팟',
        mini_jackpot:           '미니 잭팟',
        big_win:                '빅 윈',
        super_win:              '슈퍼 윈',
        epic_win:               '에픽 윈',
        mega_win:               '메가 윈',
        free_spin_awarded:      '프리 스핀 {count}회 획득',
        free_spin_title:        '프리 스핀',
        congratulations:        '축하합니다\n당첨되었습니다',
        in_free_spins:          '프리 스핀 {count}회 중',
        press_to_continue:      '계속하려면 아무 곳이나 터치하세요',
        total_win:              '총 당첨',
        settings:               '설정',
        sound_fx:               '효과음',
        music:                  '음악',
        language:               '언어',
        game_rules:             '게임 규칙',
        how_to_play:            '게임 방법',
        bet:                    '베팅',
        total_bet:              '총 베팅',
        credit:                 '크레딧',
        coin_value:             '코인 값',
        autoplay:               '자동 플레이',
        autoplay_setting:       '자동 플레이 설정',
        start_autoplay:         '자동 플레이 시작 ({count})',
        turbo_spin:             '터보 스핀',
        auto_spins_left:        '남은 자동 스핀',
        spin:                   '스핀',
        stop:                   '정지',
        collect:                '수령',
        currency_symbol:        '$',
    },
};

// ─── MAIN ───

const xlsxPath = process.argv[2];
if (!xlsxPath) {
    console.error('Usage: node tools/convert-localization-xlsx.js <path-to-xlsx>');
    process.exit(1);
}

const wb = XLSX.readFile(xlsxPath);
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

// Build per-language dictionaries from Excel
const excelData = {};
for (const lang of Object.values(COL_MAP)) {
    excelData[lang] = {};
}

for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0]) continue;
    const key = row[0];
    for (const [col, lang] of Object.entries(COL_MAP)) {
        const val = row[parseInt(col)];
        if (val !== undefined && val !== null && val !== '') {
            excelData[lang][key] = String(val);
        }
    }
}

// Merge: legacy keys + Excel keys (Excel wins on conflict)
const merged = {};
for (const lang of Object.values(COL_MAP)) {
    merged[lang] = {
        ...(LEGACY_KEYS[lang] || {}),
        ...excelData[lang],
    };
}

// ─── GENERATE .ts FILES ───

const localesDir = path.join(__dirname, '..', 'assets', 'scripts', 'data', 'locales');

for (const lang of Object.values(COL_MAP)) {
    const constName = CONST_MAP[lang];
    const langName = LANG_NAMES[lang];
    const data = merged[lang];

    // Group keys: legacy (snake_case) first, then Excel (UPPER_CASE)
    const legacyKeys = Object.keys(data).filter(k => /^[a-z]/.test(k)).sort();
    const excelKeys = Object.keys(data).filter(k => /^[A-Z]/.test(k)).sort();

    let ts = `/**\n * ${langName}\n *\n * ★ AUTO-GENERATED by tools/convert-localization-xlsx.js\n * ★ DO NOT EDIT MANUALLY — chạy lại tool khi đối tác gửi file mới.\n */\nimport { LocaleData } from './LocaleTypes';\n\nexport const ${constName}: LocaleData = {\n`;

    // Legacy keys section
    if (legacyKeys.length > 0) {
        ts += `    // ─── GAME KEYS (internal) ───\n`;
        for (const key of legacyKeys) {
            ts += `    ${quote(key)}: ${quote(data[key])},\n`;
        }
        ts += `\n`;
    }

    // Excel keys section
    if (excelKeys.length > 0) {
        ts += `    // ─── PARTNER KEYS (from Excel StringTable) ───\n`;
        for (const key of excelKeys) {
            ts += `    ${quote(key)}: ${quote(data[key])},\n`;
        }
    }

    ts += `};\n`;

    const filePath = path.join(localesDir, `${lang}.ts`);
    fs.writeFileSync(filePath, ts, 'utf-8');
    console.log(`✅ ${filePath} (${Object.keys(data).length} keys)`);
}

// ─── GENERATE ONLINE JSON (all languages in one file) ───

const onlineData = {};
for (const lang of Object.values(COL_MAP)) {
    onlineData[lang] = merged[lang];
}

const onlinePath = path.join(localesDir, 'locale-online.json');
fs.writeFileSync(onlinePath, JSON.stringify(onlineData, null, 2), 'utf-8');
console.log(`✅ ${onlinePath} (online bundle — all ${Object.keys(COL_MAP).length} languages)`);

console.log('\n🎉 Done! All locale files updated.');

// ─── HELPERS ───

function quote(str) {
    // Use single quotes, escape internal quotes and backslashes
    const escaped = str
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r\n/g, '\\n')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\n');
    return `'${escaped}'`;
}
