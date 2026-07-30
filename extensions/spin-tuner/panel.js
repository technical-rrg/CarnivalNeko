'use strict';

/**
 * spin-tuner — panel.js (Electron renderer / panel UI)
 *
 * CC3 panel rules:
 *   - Only properties inside `methods: {}` are merged onto `this` and callable
 *     as this.xxx() from ready().
 *   - ready(), close(), template, style, $ are the other known top-level keys.
 *   - Everything else at the top level of module.exports is IGNORED by the framework.
 */

// ─── Default values (must match SlotMachineController class defaults) ─────────

const DEFAULTS = {
    normal: {
        spinSpeed:               7000,
        minSpinDuration:         0.25,
        minSpinDurationFreeSpin: 0.5,
        decelDuration:           0.15,
        decelDurationFreeSpin:   0.27,
        longSpinDelay:           2,
        skipLaunchBounce:        false,
        noStopDelay:             false,
    },
    quick: {
        spinSpeed:               7000,
        minSpinDuration:         0.2,
        minSpinDurationFreeSpin: 0.3,
        decelDuration:           0.15,
        decelDurationFreeSpin:   0.27,
        longSpinDelay:           1.5,
        skipLaunchBounce:        true,
        noStopDelay:             true,
    },
    turbo: {
        spinSpeed:               10000,
        minSpinDuration:         0.125,
        minSpinDurationFreeSpin: 0.2,
        decelDuration:           0.05,
        decelDurationFreeSpin:   0.09,
        longSpinDelay:           1.5,
        skipLaunchBounce:        true,
        noStopDelay:             true,
    },
};

// ─── Field definitions ────────────────────────────────────────────────────────

const FIELDS = [
    {
        key:   'spinSpeed',
        label: 'Spin Speed',
        desc:  'Reel scroll speed while spinning (pixels / sec). Higher = faster visual.',
        type:  'number',
        step:  500,
        min:   0,
    },
    {
        key:   'minSpinDuration',
        label: 'Min Spin Duration',
        desc:  'Minimum time the reel must spin before it can stop — Normal Spin (sec).',
        type:  'number',
        step:  0.025,
        min:   0,
    },
    {
        key:   'minSpinDurationFreeSpin',
        label: 'Min Spin Duration (FS)',
        desc:  'Same as above but during Free Spin — usually slightly longer (sec).',
        type:  'number',
        step:  0.025,
        min:   0,
    },
    {
        key:   'decelDuration',
        label: 'Decel Duration',
        desc:  'How long the reel decelerates to a stop — Normal Spin (sec). Shorter = snappier.',
        type:  'number',
        step:  0.01,
        min:   0,
    },
    {
        key:   'decelDurationFreeSpin',
        label: 'Decel Duration (FS)',
        desc:  'Deceleration time during Free Spin (sec).',
        type:  'number',
        step:  0.01,
        min:   0,
    },
    {
        key:   'longSpinDelay',
        label: 'Long Spin Delay',
        desc:  'Extra wait before reel 3 decelerates on Long Spin — the anticipation window (sec).',
        type:  'number',
        step:  0.1,
        min:   0,
    },
    {
        key:   'skipLaunchBounce',
        label: 'Skip Launch Bounce',
        desc:  'Skip the upward bounce animation at spin start. ON for QUICK and TURBO.',
        type:  'boolean',
    },
    {
        key:   'noStopDelay',
        label: 'No Stop Delay',
        desc:  'All reels decelerate simultaneously (stopDelay=0). When OFF, each reel waits reelIndex x stopInterval (stagger). ON for QUICK and TURBO.',
        type:  'boolean',
    },
];

const MODES = ['normal', 'quick', 'turbo'];

// ─── Panel definition ─────────────────────────────────────────────────────────

module.exports = {

    template: `
<div class="spin-tuner">
  <div class="header">
    <div class="header-title">Spin Speed Tuner</div>
    <div class="header-sub">Edit NORMAL / QUICK / TURBO speed settings and write directly to Base.prefab</div>
  </div>
  <div class="toolbar">
    <button id="btn-load">Load from Prefab</button>
    <button id="btn-reset">Reset to Defaults</button>
    <div class="spacer"></div>
    <span id="status" class="status"></span>
    <button id="btn-save" class="primary">Save to Prefab</button>
  </div>
  <div class="table-wrap">
    <table id="settings-table">
      <thead>
        <tr>
          <th class="col-label">Parameter</th>
          <th class="col-desc">Description</th>
          <th class="col-mode col-normal">NORMAL</th>
          <th class="col-mode col-quick">QUICK</th>
          <th class="col-mode col-turbo">TURBO</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <div class="footer">
    Values are written to <strong>assets/bundle/Base.prefab</strong>. The editor will auto-reimport on save.
  </div>
</div>
`,

    style: `
* { box-sizing: border-box; margin: 0; padding: 0; }
.spin-tuner {
  display: flex; flex-direction: column; height: 100%;
  font-family: var(--font-family, 'Segoe UI', sans-serif);
  font-size: 13px; color: var(--color-normal, #ccc);
  background: var(--color-normal-bg, #252526);
  gap: 10px; padding: 14px;
}
.header { padding-bottom: 6px; border-bottom: 1px solid var(--color-normal-border, #3a3a3a); }
.header-title { font-size: 15px; font-weight: 700; color: var(--color-focus, #e8e8e8); margin-bottom: 4px; }
.header-sub { font-size: 11px; color: var(--color-normal-sub, #888); }
.toolbar { display: flex; gap: 8px; align-items: center; }
.spacer  { flex: 1; }
button {
  padding: 5px 13px; border-radius: 4px;
  border: 1px solid var(--color-normal-border, #555);
  background: var(--color-normal-fill, #3c3c3c);
  color: var(--color-normal, #ccc); cursor: pointer; font-size: 12px; white-space: nowrap;
}
button:hover { background: var(--color-hover-fill, #4c4c4c); }
button.primary { background: #4d78cc; border-color: #4d78cc; color: #fff; font-weight: 600; }
button.primary:hover { background: #5a8ae0; }
.status { font-size: 12px; max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status.ok  { color: #6dbf67; }
.status.err { color: #e06c75; }
.table-wrap { flex: 1; overflow-y: auto; border: 1px solid var(--color-normal-border, #3a3a3a); border-radius: 5px; }
table { width: 100%; border-collapse: collapse; }
th {
  position: sticky; top: 0; z-index: 1;
  background: var(--color-normal-bg-2, #2d2d30);
  padding: 7px 10px; font-size: 12px; font-weight: 700;
  border-bottom: 2px solid var(--color-normal-border, #444); white-space: nowrap;
}
th.col-label, th.col-desc { text-align: left; }
th.col-mode  { text-align: center; min-width: 100px; }
th.col-normal { color: #abb2bf; } th.col-quick { color: #e5c07b; } th.col-turbo { color: #e06c75; }
td { padding: 6px 10px; border-bottom: 1px solid var(--color-normal-border, #323232); vertical-align: middle; }
tr:last-child td { border-bottom: none; }
tr:hover td { background: rgba(255,255,255,.03); }
td.col-label { font-weight: 600; white-space: nowrap; min-width: 170px; color: var(--color-focus, #ddd); }
td.col-desc  { font-size: 11px; color: var(--color-normal-sub, #888); line-height: 1.4; min-width: 220px; }
td.col-mode  { text-align: center; }
input[type=number] {
  width: 84px; padding: 4px 6px;
  background: var(--color-normal-fill, #1e1e1e);
  border: 1px solid var(--color-normal-border, #555);
  border-radius: 3px; color: var(--color-normal, #ccc); font-size: 12px; text-align: center;
}
input[type=number]:focus { outline: none; border-color: #4d78cc; box-shadow: 0 0 0 2px rgba(77,120,204,.25); }
input[type=checkbox] { width: 15px; height: 15px; cursor: pointer; accent-color: #4d78cc; }
.footer { font-size: 11px; color: var(--color-normal-sub, #666); padding-top: 4px; border-top: 1px solid var(--color-normal-border, #333); }
`,

    $: {
        btnLoad:  '#btn-load',
        btnSave:  '#btn-save',
        btnReset: '#btn-reset',
        status:   '#status',
        tbody:    '#tbody',
    },

    // ALL helpers must be inside methods{} so CC3 merges them onto `this`
    methods: {

        buildTable() {
            const tbody = this.$.tbody;
            tbody.innerHTML = '';
            for (const field of FIELDS) {
                const tr = document.createElement('tr');

                const tdLabel = document.createElement('td');
                tdLabel.className = 'col-label';
                tdLabel.textContent = field.label;
                tr.appendChild(tdLabel);

                const tdDesc = document.createElement('td');
                tdDesc.className = 'col-desc';
                tdDesc.textContent = field.desc;
                tr.appendChild(tdDesc);

                for (const mode of MODES) {
                    const td = document.createElement('td');
                    td.className = 'col-mode col-' + mode;
                    const input = document.createElement('input');
                    if (field.type === 'number') {
                        input.type  = 'number';
                        input.step  = String(field.step);
                        input.min   = String(field.min);
                        input.value = String(DEFAULTS[mode][field.key]);
                    } else {
                        input.type    = 'checkbox';
                        input.checked = !!DEFAULTS[mode][field.key];
                    }
                    input.id = 'inp_' + field.key + '_' + mode;
                    td.appendChild(input);
                    tr.appendChild(td);
                }
                tbody.appendChild(tr);
            }
        },

        applySettings(settings) {
            for (const field of FIELDS) {
                for (const mode of MODES) {
                    const src = settings[mode];
                    if (!src || src[field.key] === undefined) continue;
                    const el = document.getElementById('inp_' + field.key + '_' + mode);
                    if (!el) continue;
                    if (field.type === 'number') {
                        el.value = src[field.key];
                    } else {
                        el.checked = !!src[field.key];
                    }
                }
            }
        },

        collectSettings() {
            const out = { normal: {}, quick: {}, turbo: {} };
            for (const field of FIELDS) {
                for (const mode of MODES) {
                    const el = document.getElementById('inp_' + field.key + '_' + mode);
                    if (!el) continue;
                    out[mode][field.key] = field.type === 'number'
                        ? parseFloat(el.value)
                        : el.checked;
                }
            }
            return out;
        },

        setStatus(msg, cls) {
            this.$.status.textContent = msg;
            this.$.status.className   = 'status ' + (cls || '');
        },

        async loadFromPrefab() {
            this.setStatus('Loading...', '');
            this.$.btnLoad.disabled = true;
            let result;
            try {
                result = await Editor.Message.request('spin-tuner', 'get-settings');
            } catch (e) {
                this.setStatus('IPC error: ' + e.message, 'err');
                this.$.btnLoad.disabled = false;
                return;
            }
            this.$.btnLoad.disabled = false;
            if (result && result.error) {
                this.setStatus('Error: ' + result.error, 'err');
                return;
            }
            this.applySettings(result);
            this.setStatus('Loaded from Base.prefab', 'ok');
        },

        async saveToPrefab() {
            this.setStatus('Saving...', '');
            this.$.btnSave.disabled = true;
            const settings = this.collectSettings();
            let result;
            try {
                result = await Editor.Message.request('spin-tuner', 'save-settings', settings);
            } catch (e) {
                this.setStatus('IPC error: ' + e.message, 'err');
                this.$.btnSave.disabled = false;
                return;
            }
            this.$.btnSave.disabled = false;
            if (result && result.error) {
                this.setStatus('Error: ' + result.error, 'err');
            } else {
                this.setStatus('Saved to Base.prefab - reimporting...', 'ok');
            }
        },

        resetToDefaults() {
            this.applySettings(JSON.parse(JSON.stringify(DEFAULTS)));
            this.setStatus('Reset to defaults (not yet saved)', '');
        },
    },

    ready() {
        this.buildTable();
        this.$.btnLoad.addEventListener('click',  () => this.loadFromPrefab());
        this.$.btnSave.addEventListener('click',  () => this.saveToPrefab());
        this.$.btnReset.addEventListener('click', () => this.resetToDefaults());
        this.loadFromPrefab();
    },

    close() {},
};
