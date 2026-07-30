'use strict';

/**
 * localization-tools — Cocos Creator 3.x Editor Extension
 *
 * Chuyển đổi LocalizationStringTable.xlsx → locale .ts files + locale-online.json
 * Cùng logic với tools/convert-localization-xlsx.js nhưng chạy ngay trong Editor.
 *
 * Để Enable extension: Extensions → Extension Manager → bật "localization-tools"
 * Để dùng:            Extensions → 🌐 Update Localization from Excel
 */

const path = require('path');
const fs   = require('fs');

// ─── Extension lifecycle ──────────────────────────────────────────────────────

/** Project root = 2 levels up từ extensions/localization-tools/ */
let projectRoot = '';

exports.load = function () {
    projectRoot = path.join(__dirname, '..', '..');
    console.log('[LocalizationTools] Loaded. Project root:', projectRoot);
};

exports.unload = function () {};

// ─── Message handler ──────────────────────────────────────────────────────────

exports.methods = {
    updateLocalization() {
        const xlsxFile = path.join(projectRoot, 'LocalizationStringTable.xlsx');

        // 1. Kiểm tra file Excel tồn tại
        if (!fs.existsSync(xlsxFile)) {
            Editor.Dialog.error(
                `Không tìm thấy file:\n${xlsxFile}\n\nĐặt file LocalizationStringTable.xlsx vào thư mục gốc của project.`,
                { title: 'Localization Tools — Lỗi' }
            );
            return;
        }

        // 2+3. Load xlsx - tự động npm install nếu chưa có, rồi convert
        const { exec: _exec } = require('child_process');

        function _doConvert(XLSX) {
            try {
                const result = convertXlsxToLocales(XLSX, xlsxFile, projectRoot);
                Editor.Dialog.info(
                    `✅ Cập nhật thành công!\n\n` +
                    `Đã ghi ${result.langCount} ngôn ngữ, ${result.keyCount} keys.\n\n` +
                    `Output:\n${result.outputFiles.join('\n')}`,
                    { title: 'Localization Tools — Hoàn tất' }
                );
                console.log('[LocalizationTools] Done:', result);
            } catch (err) {
                Editor.Dialog.error(
                    `Lỗi khi convert:\n${err.message || err}`,
                    { title: 'Localization Tools — Lỗi' }
                );
                console.error('[LocalizationTools] Error:', err);
            }
        }

        let XLSX;
        try {
            XLSX = require(path.join(projectRoot, 'node_modules', 'xlsx'));
            _doConvert(XLSX);
        } catch (_) {
            console.log('[LocalizationTools] xlsx chưa được cài — đang chạy npm install tự động...');
            _exec('npm install', { cwd: projectRoot }, (err, stdout, stderr) => {
                if (err) {
                    Editor.Dialog.error(
                        `Tự động cài đặt thất bại:\n${(stderr || err.message).trim()}\n\nChạy thủ công:\n  npm install`,
                        { title: 'Localization Tools — Lỗi' }
                    );
                    return;
                }
                console.log('[LocalizationTools] npm install hoàn tất.');
                try {
                    XLSX = require(path.join(projectRoot, 'node_modules', 'xlsx'));
                    _doConvert(XLSX);
                } catch (e2) {
                    Editor.Dialog.error(
                        `npm install xong nhưng không load được "xlsx":\n${e2.message}`,
                        { title: 'Localization Tools — Lỗi' }
                    );
                }
            });
        }
    },

    generateCdnManifest() {
        try {
            const result = runGenerateCdnManifest(projectRoot);

            if (result.missing.length > 0) {
                Editor.Dialog.warn(
                    `⚠️ Hoàn tất nhưng thiếu ${result.missing.length} file:\n${result.missing.join('\n')}\n\n` +
                    `cdn-manifest.json đã được ghi (không có các file thiếu).`,
                    { title: 'CDN Manifest — Cảnh báo' }
                );
                return;
            }

            const changedLines   = result.details.filter(d =>  d.changed).map(d => `  🔄 ${d.label}  →  v=${d.version}`).join('\n');
            const unchangedLines = result.details.filter(d => !d.changed).map(d => `  ✅ ${d.label}  (v=${d.version})`).join('\n');

            if (result.changedCount === 0) {
                // Vẫn export folder (luôn cần locale-online.json để upload đủ bộ)
                const exported = exportCdnFiles(projectRoot, result);

                Editor.Dialog.info(
                    `Tất cả files không thay đổi.\n` +
                    `Không cần upload CDN (trừ khi CDN server chưa có file).\n\n` +
                    `${unchangedLines}\n\n` +
                    `📁 Folder export (để dùng nếu cần):\n${exported.exportDir}\n\n` +
                    `Files trong folder (${exported.copied.length}):\n${exported.copied.map(f => `  • ${f}`).join('\n')}`,
                    { title: 'CDN Manifest — Không có gì mới' }
                );
                return;
            }

            // Export files cần gửi ra ngoài project
            const exported = exportCdnFiles(projectRoot, result);

            Editor.Dialog.info(
                `✅ cdn-manifest.json đã được tạo và export!\n\n` +
                `Files đã thay đổi (${result.changedCount}):\n${changedLines}\n\n` +
                `Files giữ nguyên (${result.unchangedCount}):\n${unchangedLines}\n\n` +
                `📁 Folder export:\n${exported.exportDir}\n\n` +
                `Files trong folder (${exported.copied.length}):\n${exported.copied.map(f => `  • ${f}`).join('\n')}\n\n` +
                `★ Upload fonts/locale TRƯỚC, cdn-manifest.json SAU CÙNG.`,
                { title: 'CDN Manifest — Hoàn tất' }
            );
            console.log('[LocalizationTools] CDN manifest generated. Export dir:', exported.exportDir);
        } catch (err) {
            Editor.Dialog.error(
                `Lỗi khi tạo manifest:\n${err.message || err}`,
                { title: 'CDN Manifest — Lỗi' }
            );
            console.error('[LocalizationTools] CDN manifest error:', err);
        }
    },
};

// ─── CDN Manifest logic ───────────────────────────────────────────────────────

/**
 * Tạo cdn-manifest.json dựa trên SHA-256 của từng file.
 * Tương đương tools/generate-cdn-manifest.js nhưng chạy trong Editor process.
 */
function runGenerateCdnManifest(root) {
    const crypto = require('crypto');

    const FONT_LANGS  = ['en', 'ko', 'zh-cn', 'zh-tw', 'fil', 'ja', 'th', 'sg', 'ms', 'vi'];
    const LOCALE_FILE = path.join(root, 'assets', 'scripts', 'data', 'locales', 'locale-online.json');
    const FONT_DIR    = path.join(root, 'assets', 'Font');
    const MANIFEST_OUT = path.join(root, 'cdn-manifest.json');
    const HASHES_CACHE = path.join(root, '.cdn-hashes.json');

    const TRACKED = [
        { key: 'locale', filePath: LOCALE_FILE, label: 'locale-online.json', lang: null },
        ...FONT_LANGS.map(lang => ({
            key:      `font_${lang}`,
            filePath: path.join(FONT_DIR, `${lang}-subset.ttf`),
            label:    `${lang}-subset.ttf`,
            lang,
        })),
    ];

    // Load caches
    function loadJson(p) {
        if (!fs.existsSync(p)) return {};
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
    }
    const oldHashes   = loadJson(HASHES_CACHE);
    const oldManifest = loadJson(MANIFEST_OUT);

    function sha256(filePath) {
        const buf = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(buf).digest('hex');
    }
    function today() {
        const d = new Date();
        return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    }
    function nextVersion(old) {
        const t = today();
        if (!old || !old.startsWith(t)) return `${t}001`;
        const seq = parseInt(old.slice(8), 10) || 0;
        return `${t}${String(seq + 1).padStart(3, '0')}`;
    }

    const newHashes = {};
    const manifest  = { locale: null, fonts: {} };
    const details   = [];
    const missing   = [];

    for (const entry of TRACKED) {
        if (!fs.existsSync(entry.filePath)) {
            missing.push(entry.label);
            continue;
        }
        const hash = sha256(entry.filePath);
        const size = fs.statSync(entry.filePath).size;
        newHashes[entry.key] = hash;

        const oldVersion = entry.lang
            ? (oldManifest?.fonts?.[entry.lang]?.v ?? null)
            : (oldManifest?.locale?.v ?? null);

        const changed = oldHashes[entry.key] !== hash;
        const version = changed ? nextVersion(oldVersion) : (oldVersion ?? nextVersion(null));

        details.push({ label: entry.label, changed, version, srcPath: entry.filePath, lang: entry.lang });

        if (!entry.lang) {
            manifest.locale = { v: version, size };
        } else {
            manifest.fonts[entry.lang] = { v: version, size };
        }
    }

    // Write outputs
    fs.writeFileSync(MANIFEST_OUT,  JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(HASHES_CACHE,  JSON.stringify(newHashes, null, 2), 'utf8');

    return {
        changedCount:   details.filter(d => d.changed).length,
        unchangedCount: details.filter(d => !d.changed).length,
        details,
        missing,
        manifestPath: MANIFEST_OUT,
    };
}

/**
 * Copy tất cả files cần gửi cho người upload vào 1 folder ngoài project.
 *
 * Cấu trúc output (mirror CDN):
 *   <project>/../supernova-cdn-export/YYYYMMDD_HHMM/
 *       cdn-manifest.json        (luôn có)
 *       locale-online.json       (luôn có)
 *       fonts/
 *           ko-subset.ttf        (nếu ko CHANGED)
 *           ...
 *
 * File gốc trong project KHÔNG bị thay đổi.
 */
function exportCdnFiles(root, result) {
    // Timestamped folder ngoài project
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;
    const exportDir = path.join(root, '..', 'supernova-cdn-export', stamp);
    const fontsDir  = path.join(exportDir, 'fonts');

    fs.mkdirSync(fontsDir, { recursive: true });

    const copied = [];

    // 1. Luôn copy cdn-manifest.json (gửi sau cùng)
    fs.copyFileSync(result.manifestPath, path.join(exportDir, 'cdn-manifest.json'));
    copied.push('cdn-manifest.json');

    // 2. locale-online.json — LUÔN LUÔN copy (bất kể changed hay không)
    //    Đảm bảo folder export luôn đủ file để upload ngay, không cần tra lại lần trước.
    const localeDetail = result.details.find(d => d.lang === null);
    if (localeDetail && localeDetail.srcPath && fs.existsSync(localeDetail.srcPath)) {
        fs.copyFileSync(localeDetail.srcPath, path.join(exportDir, 'locale-online.json'));
        copied.push('locale-online.json');
    }

    // 3. Copy TẤT CẢ fonts (bất kể changed hay không)
    //    Đảm bảo folder export luôn đủ bộ để upload một lần, không cần tra lại lần trước.
    for (const detail of result.details) {
        if (detail.lang === null) continue; // locale đã xử lý ở trên
        if (!detail.srcPath || !fs.existsSync(detail.srcPath)) continue;

        const filename = `${detail.lang}-subset.ttf`;
        fs.copyFileSync(detail.srcPath, path.join(fontsDir, filename));
        const tag = detail.changed ? ' 🔄' : '';
        copied.push(`fonts/${filename}${tag}`);
    }

    return { exportDir, copied };
}

/** Column index trong Excel → language code */
const COL_MAP = {
    2:  'en',
    3:  'ko',
    4:  'zh-cn',
    5:  'zh-tw',
    6:  'fil',
    7:  'ja',
    8:  'th',
    9:  'sg',
    10: 'ms',
    11: 'vi',
};

/** Tên constant TypeScript export */
const CONST_MAP = {
    'en':    'LOCALE_EN',
    'ko':    'LOCALE_KO',
    'zh-cn': 'LOCALE_ZH_CN',
    'zh-tw': 'LOCALE_ZH_TW',
    'fil':   'LOCALE_FIL',
    'ja':    'LOCALE_JA',
    'th':    'LOCALE_TH',
    'sg':    'LOCALE_SG',
    'ms':    'LOCALE_MS',
    'vi':    'LOCALE_VI',
};

/** Tên ngôn ngữ đầy đủ cho comment */
const LANG_NAMES = {
    'en':    'English (en)',
    'ko':    'Korean (ko) — 한국어',
    'zh-cn': 'Simplified Chinese (zh-cn) — 简体中文',
    'zh-tw': 'Traditional Chinese (zh-tw) — 繁體中文',
    'fil':   'Filipino (fil)',
    'ja':    'Japanese (ja) — 日本語',
    'th':    'Thai (th) — ภาษาไทย',
    'sg':    'Singapore English (sg)',
    'ms':    'Malay (ms) — Bahasa Melayu',
    'vi':    'Vietnamese (vi) — Tiếng Việt',
};

/** Game-internal keys (không có trong Excel) — merged vào từng ngôn ngữ */
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
        setting_title:          'SETTINGS',
        setting_volume:         'MASTER VOLUME',
        setting_music:          'MUSIC',
        setting_sound:          'SOUND FX',
        setting_intro:          'INTRO SCREEN',
        setting_broadcast:      'BROADCAST',
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
        free_spin_count:        'FREE SPINS',
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
        setting_title:          '설정',
        setting_volume:         '마스터 볼륨',
        setting_music:          '음악',
        setting_sound:          '효과음',
        setting_intro:          '인트로 화면',
        setting_broadcast:      '브로드캐스트',
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
        free_spin_count:        '프리 스핀',
    },
    'zh-cn': {
        good_luck:              '祝您好运！',
        no_win:                 '下次好运！',
        normal_spin:            '普通旋转',
        free_spin_mode:         '免费旋转 x{count}',
        win_amount:             '赢得 ${amount}',
        grand_jackpot:          '至尊彩金',
        major_jackpot:          '大彩金',
        minor_jackpot:          '小彩金',
        mini_jackpot:           '迷你彩金',
        big_win:                '大赢',
        super_win:              '超级赢',
        epic_win:               '史诗赢',
        mega_win:               '巨赢',
        free_spin_awarded:      '获得 {count} 次免费旋转',
        free_spin_title:        '免费旋转',
        congratulations:        '恭喜\n您赢了',
        in_free_spins:          '共 {count} 次免费旋转',
        press_to_continue:      '点击任意处继续',
        total_win:              '总赢额',
        setting_title:          '设置',
        setting_volume:         '主音量',
        setting_music:          '音乐',
        setting_sound:          '音效',
        setting_intro:          '开场动画',
        setting_broadcast:      '广播',
        currency_symbol:        '$',
        free_spin_count:        '免费旋转',
    },
    'zh-tw': {
        good_luck:              '祝您好運！',
        no_win:                 '下次好運！',
        normal_spin:            '普通旋轉',
        free_spin_mode:         '免費旋轉 x{count}',
        win_amount:             '贏得 ${amount}',
        grand_jackpot:          '至尊彩金',
        major_jackpot:          '大彩金',
        minor_jackpot:          '小彩金',
        mini_jackpot:           '迷你彩金',
        big_win:                '大贏',
        super_win:              '超級贏',
        epic_win:               '史詩贏',
        mega_win:               '巨贏',
        free_spin_awarded:      '獲得 {count} 次免費旋轉',
        free_spin_title:        '免費旋轉',
        congratulations:        '恭喜\n您贏了',
        in_free_spins:          '共 {count} 次免費旋轉',
        press_to_continue:      '點擊任意處繼續',
        total_win:              '總贏額',
        setting_title:          '設定',
        setting_volume:         '主音量',
        setting_music:          '音樂',
        setting_sound:          '音效',
        setting_intro:          '開場動畫',
        setting_broadcast:      '廣播',
        currency_symbol:        '$',
        free_spin_count:        '免費旋轉',
    },
    'ja': {
        good_luck:              'ラッキー！',
        no_win:                 '次回頑張ってください！',
        normal_spin:            '通常スピン',
        free_spin_mode:         'フリースピン x{count}',
        win_amount:             '当選 ${amount}',
        grand_jackpot:          'グランドジャックポット',
        major_jackpot:          'メジャージャックポット',
        minor_jackpot:          'マイナージャックポット',
        mini_jackpot:           'ミニジャックポット',
        big_win:                'ビッグウィン',
        super_win:              'スーパーウィン',
        epic_win:               'エピックウィン',
        mega_win:               'メガウィン',
        free_spin_awarded:      'フリースピン {count} 回獲得',
        free_spin_title:        'フリースピン',
        congratulations:        'おめでとう\n当選',
        in_free_spins:          '{count} 回フリースピン中',
        press_to_continue:      'どこかをタップして続ける',
        total_win:              '合計当選',
        setting_title:          '設定',
        setting_volume:         'マスター音量',
        setting_music:          '音楽',
        setting_sound:          '効果音',
        setting_intro:          'イントロ画面',
        setting_broadcast:      'ブロードキャスト',
        currency_symbol:        '$',
        free_spin_count:        'フリースピン',
    },
    'fil': {
        good_luck:              'Good luck!',
        no_win:                 'Mas swerte sa susunod!',
        normal_spin:            'Normal spin',
        free_spin_mode:         'Free spin x{count}',
        win_amount:             'Nanalo ${amount}',
        grand_jackpot:          'Grand Jackpot',
        major_jackpot:          'Major Jackpot',
        minor_jackpot:          'Minor Jackpot',
        mini_jackpot:           'Mini Jackpot',
        big_win:                'Big Win',
        super_win:              'Super Win',
        epic_win:               'Epic Win',
        mega_win:               'Mega Win',
        free_spin_awarded:      '{count} free spins ang ibinigay',
        free_spin_title:        'Free Spins',
        congratulations:        'Maligayang bati\nNanalo ka',
        in_free_spins:          'Sa {count} na free spins',
        press_to_continue:      'Pindutin kahit saan upang magpatuloy',
        total_win:              'Kabuuang panalo',
        setting_title:          'Mga Setting',
        setting_volume:         'Master Volume',
        setting_music:          'Musika',
        setting_sound:          'Tunog',
        setting_intro:          'Intro Screen',
        setting_broadcast:      'Broadcast',
        currency_symbol:        '$',
        free_spin_count:        'Free Spins',
    },
    'th': {
        good_luck:              'โชคดี!',
        no_win:                 'ขอให้โชคดีครั้งหน้า!',
        normal_spin:            'หมุนปกติ',
        free_spin_mode:         'ฟรีสปิน x{count}',
        win_amount:             'ชนะ ${amount}',
        grand_jackpot:          'แกรนด์แจ็กพอต',
        major_jackpot:          'เมเจอร์แจ็กพอต',
        minor_jackpot:          'ไมเนอร์แจ็กพอต',
        mini_jackpot:           'มินิแจ็กพอต',
        big_win:                'บิ๊กวิน',
        super_win:              'ซูเปอร์วิน',
        epic_win:               'เอปิควิน',
        mega_win:               'เมกะวิน',
        free_spin_awarded:      'ได้รับ {count} ฟรีสปิน',
        free_spin_title:        'ฟรีสปิน',
        congratulations:        'ยินดีด้วย\nคุณชนะ',
        in_free_spins:          'ใน {count} ฟรีสปิน',
        press_to_continue:      'กดที่ใดก็ได้เพื่อดำเนินการต่อ',
        total_win:              'รวมที่ชนะ',
        setting_title:          'ตั้งค่า',
        setting_volume:         'ระดับเสียงหลัก',
        setting_music:          'ดนตรี',
        setting_sound:          'เอฟเฟกต์เสียง',
        setting_intro:          'หน้าจอแนะนำ',
        setting_broadcast:      'ออกอากาศ',
        currency_symbol:        '$',
        free_spin_count:        'ฟรีสปิน',
    },
};

// ─── Conversion function ──────────────────────────────────────────────────────

function convertXlsxToLocales(XLSX, xlsxPath, projRoot) {
    const localesDir = path.join(projRoot, 'assets', 'scripts', 'data', 'locales');

    // Ensure output directory exists
    if (!fs.existsSync(localesDir)) {
        throw new Error(`Thư mục không tồn tại: ${localesDir}`);
    }

    // Read Excel
    const wb   = XLSX.readFile(xlsxPath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (rows.length < 2) {
        throw new Error('File Excel trống hoặc không đúng format (cần ít nhất 2 hàng: header + data).');
    }

    // Build per-language dictionaries from Excel
    const excelData = {};
    for (const lang of Object.values(COL_MAP)) {
        excelData[lang] = {};
    }

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row[0]) continue;
        const key = String(row[0]).trim();
        if (!key) continue;
        for (const [col, lang] of Object.entries(COL_MAP)) {
            const val = row[parseInt(col)];
            if (val !== undefined && val !== null && val !== '') {
                excelData[lang][key] = String(val);
            }
        }
    }

    // Merge: legacy keys + Excel keys (Excel wins on conflict for UI_ keys)
    const merged = {};
    for (const lang of Object.values(COL_MAP)) {
        merged[lang] = {
            ...(LEGACY_KEYS[lang] || {}),
            ...excelData[lang],
        };
    }

    const outputFiles = [];
    let totalKeyCount = 0;

    // Write per-language .ts files
    for (const lang of Object.values(COL_MAP)) {
        const constName = CONST_MAP[lang];
        const langName  = LANG_NAMES[lang];
        const data      = merged[lang];

        // Split keys: internal (snake_case) vs Excel (UPPER_CASE)
        const legacyEntries = Object.entries(data).filter(([k]) => /^[a-z]/.test(k)).sort(([a], [b]) => a.localeCompare(b));
        const excelEntries  = Object.entries(data).filter(([k]) => /^[A-Z]/.test(k)).sort(([a], [b]) => a.localeCompare(b));

        const datePart = new Date().toISOString().slice(0, 10);

        let ts = `/**\n`;
        ts    += ` * ${langName}\n`;
        ts    += ` *\n`;
        ts    += ` * ★ AUTO-GENERATED by Localization Tools extension\n`;
        ts    += ` * ★ Source: LocalizationStringTable.xlsx (${datePart})\n`;
        ts    += ` * ★ DO NOT EDIT MANUALLY — dùng Extensions → 🌐 Update Localization from Excel\n`;
        ts    += ` */\n`;
        ts    += `import { LocaleData } from './LocaleTypes';\n\n`;
        ts    += `export const ${constName}: LocaleData = {\n`;

        if (legacyEntries.length > 0) {
            ts += `    // ─── GAME KEYS (internal) ───\n`;
            for (const [key, val] of legacyEntries) {
                ts += `    ${jsKey(key)}: ${quote(val)},\n`;
            }
            ts += `\n`;
        }

        if (excelEntries.length > 0) {
            ts += `    // ─── PARTNER KEYS (from LocalizationStringTable.xlsx) ───\n`;
            for (const [key, val] of excelEntries) {
                ts += `    ${jsKey(key)}: ${quote(val)},\n`;
            }
        }

        ts += `};\n`;

        const filePath = path.join(localesDir, `${lang}.ts`);
        fs.writeFileSync(filePath, ts, 'utf-8');
        outputFiles.push(`  ✓ ${path.relative(projRoot, filePath)}  (${Object.keys(data).length} keys)`);
        totalKeyCount = Math.max(totalKeyCount, Object.keys(data).length);
    }

    // Write locale-online.json (all languages bundled)
    const onlineData = {};
    for (const lang of Object.values(COL_MAP)) {
        onlineData[lang] = merged[lang];
    }
    const onlinePath = path.join(localesDir, 'locale-online.json');
    fs.writeFileSync(onlinePath, JSON.stringify(onlineData, null, 2), 'utf-8');
    outputFiles.push(`  ✓ ${path.relative(projRoot, onlinePath)}  (bundle)`);

    return {
        langCount: Object.keys(COL_MAP).length,
        keyCount: totalKeyCount,
        outputFiles,
    };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Trả về key hợp lệ trong TypeScript object literal */
function jsKey(key) {
    // Key có ký tự đặc biệt → dùng quotes
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `'${key}'`;
}

/** Escape string thành single-quote TypeScript literal */
function quote(str) {
    const escaped = str
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r\n/g, '\\n')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\n');
    return `'${escaped}'`;
}
