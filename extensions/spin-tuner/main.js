'use strict';

/**
 * spin-tuner — main.js (Node.js / extension main process)
 *
 * Handles reading and writing SpeedModeSettings from Base.prefab.
 * The panel (panel.js) calls these methods via Editor.Message.request().
 */

const path = require('path');
const fs   = require('fs');

// Path to the prefab, relative to project root
const PREFAB_REL = path.join('assets', 'bundle', 'Base.prefab');

// Asset DB URL used to notify CC3 editor to reimport after save
const PREFAB_DB_URL = 'db://assets/bundle/Base.prefab';

// Fields that belong to SpeedModeSettings (in the order they appear in the class)
const SPEED_FIELDS = [
    'spinSpeed',
    'minSpinDuration',
    'minSpinDurationFreeSpin',
    'decelDuration',
    'decelDurationFreeSpin',
    'longSpinDelay',
    'skipLaunchBounce',
    'noStopDelay',
];

let projectRoot = '';

// ─── Extension lifecycle ──────────────────────────────────────────────────────

exports.load = function () {
    projectRoot = path.join(__dirname, '..', '..');
    console.log('[SpinTuner] Loaded. Project root:', projectRoot);
};

exports.unload = function () {};

// ─── Message handlers ─────────────────────────────────────────────────────────

exports.methods = {

    /** Open the visual panel */
    openPanel() {
        Editor.Panel.open('spin-tuner.default');
    },

    /**
     * Read SpeedModeSettings (normal / quick / turbo) from Base.prefab.
     * Returns: { normal: {...}, quick: {...}, turbo: {...} }
     *       or { error: string } on failure.
     */
    async getSettings() {
        const prefabPath = path.join(projectRoot, PREFAB_REL);

        if (!fs.existsSync(prefabPath)) {
            return { error: `Prefab not found:\n${prefabPath}` };
        }

        let arr;
        try {
            arr = JSON.parse(fs.readFileSync(prefabPath, 'utf8'));
        } catch (e) {
            return { error: `Failed to parse prefab JSON: ${e.message}` };
        }

        // Find the SlotMachineController object by looking for normalModeSettings reference
        const smc = arr.find(o => o && typeof o === 'object' && o.normalModeSettings !== undefined);
        if (!smc) {
            return { error: 'Could not find SlotMachineController in prefab.\nMake sure the prefab has been saved after adding SpeedModeSettings.' };
        }

        const normalId = smc.normalModeSettings.__id__;
        const quickId  = smc.quickModeSettings.__id__;
        const turboId  = smc.turboModeSettings.__id__;

        // Extract only the known speed fields (strip internal CC keys)
        function pick(obj) {
            const out = {};
            for (const f of SPEED_FIELDS) {
                if (obj[f] !== undefined) out[f] = obj[f];
            }
            return out;
        }

        return {
            normal: pick(arr[normalId]),
            quick:  pick(arr[quickId]),
            turbo:  pick(arr[turboId]),
        };
    },

    /**
     * Write SpeedModeSettings back into Base.prefab.
     * @param {object} settings  { normal: {...}, quick: {...}, turbo: {...} }
     * Returns: { ok: true } or { error: string }
     */
    async saveSettings(settings) {
        const prefabPath = path.join(projectRoot, PREFAB_REL);

        if (!fs.existsSync(prefabPath)) {
            return { error: `Prefab not found:\n${prefabPath}` };
        }

        let arr;
        try {
            arr = JSON.parse(fs.readFileSync(prefabPath, 'utf8'));
        } catch (e) {
            return { error: `Failed to parse prefab JSON: ${e.message}` };
        }

        const smc = arr.find(o => o && typeof o === 'object' && o.normalModeSettings !== undefined);
        if (!smc) {
            return { error: 'Could not find SlotMachineController in prefab.' };
        }

        const ids = {
            normal: smc.normalModeSettings.__id__,
            quick:  smc.quickModeSettings.__id__,
            turbo:  smc.turboModeSettings.__id__,
        };

        // Apply each changed field
        for (const [mode, id] of Object.entries(ids)) {
            const src = settings[mode];
            if (!src) continue;
            for (const f of SPEED_FIELDS) {
                if (src[f] !== undefined) {
                    arr[id][f] = src[f];
                }
            }
        }

        // Write back with 2-space indent (same as CC3 default serialisation)
        try {
            fs.writeFileSync(prefabPath, JSON.stringify(arr, null, 2), 'utf8');
        } catch (e) {
            return { error: `Failed to write prefab: ${e.message}` };
        }

        // Ask CC3 asset-db to re-import the prefab so the editor reflects the change
        try {
            await Editor.Message.request('asset-db', 'refresh-asset', PREFAB_DB_URL);
        } catch (_) {
            // Non-critical — editor will detect file change on next focus
        }

        console.log('[SpinTuner] Saved SpeedModeSettings to', prefabPath);
        return { ok: true };
    },
};
