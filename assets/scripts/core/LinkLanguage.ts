/**
 * LinkLanguage — language from the launch link when the URL has no `gl`.
 *
 * Platform rule (all RRG games): `?gl=` → launch-link Lang → 'en'.
 * The gate decrypts `gp` to { GateUrl, Token, TS, Lang }; the original only read GateUrl/Token,
 * so a link without `gl` always opened in English. After login (before Enter) we switch to the
 * link language — same mapping as `gl` — and fetch that language's CDN font like the early load does.
 * `gl` and DEV_FORCE_LANG still win.
 */

import { DEV_FORCE_LANG, ServerConfig } from '../data/ServerConfig';
import { FontManager } from '../manager/FontManager';
import { CdnAssetManager } from './CdnAssetManager';
import { LocalizationManager } from './LocalizationManager';
import { Log } from './Logger';

let linkLanguage: string | null = null;

/** Called with the `Lang` field of the decrypted gp (RealNetworkAdapter._callGateServiceInfo). */
export function setLinkLanguageHint(lang: unknown): void {
    linkLanguage = typeof lang === 'string' && lang.trim() !== '' ? lang.trim() : null;
}

function urlHasGl(): boolean {
    try {
        return typeof window !== 'undefined' && !!new URLSearchParams(window.location.search).get('gl');
    } catch {
        return false;
    }
}

/** Called right after a successful login. Never throws — login must go on. */
export function applyLinkLanguage(): void {
    if (linkLanguage === null || DEV_FORCE_LANG !== null || urlHasGl()) return;
    try {
        const lm = LocalizationManager.instance;
        const code = lm.normalizeLanguageCode(linkLanguage);
        if (code === lm.currentLanguage) return;
        lm.setLanguage(code);

        const cdnBase = ServerConfig.CDN_BASE;
        if (!cdnBase) return;
        const cdn = CdnAssetManager.instance;
        cdn.init(cdnBase);
        void cdn.loadFont(code).then((font) => {
            if (font && lm.currentLanguage === code) FontManager.instance?.applyRemoteFonts({ [code]: font });
        });
    } catch (err) {
        Log.w('[i18n] Link language apply failed:', err);
    }
}
