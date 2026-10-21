/**
 * Server maintenance display — PLATFORM_SPEC D12 (user instruction 2026-10-20/21, same in every game).
 * Behaviour follows the Blast Rocket original (CommonNetworkHandler.cs, commit 3d78e86e0
 * "서버 점검 팝업 관련 로직 변경"). The original Cocos game parsed SMM but showed nothing.
 *
 * Every server response may carry SMM { Title, Line1, Line2, RemainMinutes, DurationMinutes, Step }.
 * All text comes from the server — nothing is hard-coded here. `{0}` is the number, `{{` / `}}` braces.
 *
 *   Step 1 Notice   → scrolling band at the top: Title + " " + Line1({0} = RemainMinutes).
 *   Step 2 Block    → band closed, popup without any button (Title / Line1({0} = RemainMinutes)) that
 *                     the player cannot close; later Block responses only refresh its text. Auto spin
 *                     stops, spin and bonus purchase are refused locally, heartbeat goes on.
 *   Step 3 Shutdown → band closed, the popup shows Title / Line1 + blank line + Line2({0} =
 *                     DurationMinutes), heartbeat and polling stop.
 *   Step 4 Canceled → band closed; after Block the popup is closed here (the player cannot).
 *   Heartbeat without SMM → release only when the band is open or in Block (also stops auto spin).
 *   Other responses without SMM change nothing.
 *   Heartbeat every 3 s while Notice / Block / Shutdown, otherwise the normal interval.
 *
 *   CODE 10015 (ERR_SERVER_MAINTENANCE):
 *    - login refused: the response Data may carry SMM → stop auto spin and handle that step;
 *      without SMM → popup (no title, cannot be closed) with the MSG text after its last "|".
 *    - any request after login (enter, spin, claim, pick, …): no disconnect popup — stop auto spin
 *      and send one heartbeat now; its SMM drives the display.
 *    - heartbeat answered 10015 with nothing to decrypt → the MSG popup.
 *
 * Differs from Blast Rocket on purpose: Block → back to Notice (maintenance postponed) closes the Block
 * popup and shows the band again (BR leaves the popup up while spins are allowed again).
 *
 * Cocos games only: the reels start before the spin answer, and the original left a failed spin / pick /
 * claim to the disconnect popup. Without that popup a refused play request would leave the game
 * mid-spin, so once nothing blocks any more (no SMM, Notice, Canceled, Block released) the page
 * reloads; in Block it waits, after Shutdown nothing.
 *
 * No engine imports: UI and network side effects are injected as handlers
 * (controller/MaintenanceView.ts, NetworkManager).
 */

export const MaintenanceStep = {
    None: 0,
    Notice: 1,
    Block: 2,
    Shutdown: 3,
    Canceled: 4,
} as const;

/** Server return code for "server under maintenance". */
export const ERR_SERVER_MAINTENANCE = 10015;

/** Heartbeat interval while maintenance is announced (BR _notiWaitForSeconds). */
export const MAINTENANCE_HEARTBEAT_MS = 3000;

/** SMM as sent by the server (PascalCase). */
export interface MaintenanceMessage {
    Title?: string | null;
    Line1?: string | null;
    Line2?: string | null;
    RemainMinutes?: number | null;
    DurationMinutes?: number | null;
    Step: number;
}

/** .NET string.Format with one argument: `{0}` (optionally `{0:…}`) → arg, `{{` → `{`, `}}` → `}`. */
export function formatOne(fmt: string | null | undefined, arg0: number | null | undefined): string {
    if (fmt == null) return '';
    return fmt.replace(/\{\{|\}\}|\{0(?::[^}]*)?\}/g, (m) => {
        if (m === '{{') return '{';
        if (m === '}}') return '}';
        return String(arg0 ?? 0);
    });
}

/** Band text — Title + " " + Line1 with {0} = RemainMinutes. */
export function noticeText(smm: MaintenanceMessage): string {
    return (smm.Title ?? '') + ' ' + formatOne(smm.Line1, smm.RemainMinutes);
}

/** Block popup — title / body. */
export function blockTitle(smm: MaintenanceMessage): string {
    return smm.Title ?? '';
}
export function blockBody(smm: MaintenanceMessage): string {
    return formatOne(smm.Line1, smm.RemainMinutes);
}

/** Shutdown popup — title / body (Line1, blank line, Line2 with {0} = DurationMinutes). */
export function shutdownTitle(smm: MaintenanceMessage): string {
    return smm.Title ?? '';
}
export function shutdownBody(smm: MaintenanceMessage): string {
    return (smm.Line1 ?? '') + '\n\n' + formatOne(smm.Line2, smm.DurationMinutes);
}

/**
 * Text to show from a server error MSG ("API|code|ERROR_NAME|text" on the development server, the text
 * only in production): what follows the last "|" (BR ExtractMaintenanceNotice).
 */
export function serverMessageText(msg: string | null | undefined): string {
    if (!msg) return '';
    const lastBar = msg.lastIndexOf('|');
    return lastBar >= 0 && lastBar + 1 < msg.length ? msg.substring(lastBar + 1) : msg;
}

/** UI / network side effects, wired by MaintenanceView (UI) and NetworkManager (network). */
export interface MaintenanceHandlers {
    /** Show or refresh the scrolling band. */
    noticeOpen(text: string): void;
    noticeClose(): void;
    /** Block popup — no button, cannot be closed by the player; called again to refresh its text. */
    openBlockPopup(title: string, body: string): void;
    /** Close the Block popup (maintenance cancelled / postponed). */
    closeBlockPopup(): void;
    /** Shutdown / server MSG popup — no button, never closed (replaces the Block popup). */
    openLockedPopup(title: string, body: string): void;
    stopAutoSpin(): void;
    /** Send one heartbeat now. */
    requestHeartbeat(): void;
    /** Stop heartbeat and polling. */
    disconnect(): void;
    /** Restart the game — a refused play request left it mid-action. */
    reloadGame(): void;
}

const NOOP_HANDLERS: MaintenanceHandlers = {
    noticeOpen: () => {},
    noticeClose: () => {},
    openBlockPopup: () => {},
    closeBlockPopup: () => {},
    openLockedPopup: () => {},
    stopAutoSpin: () => {},
    requestHeartbeat: () => {},
    disconnect: () => {},
    reloadGame: () => {},
};

export class MaintenanceState {
    private _step: number = MaintenanceStep.None;
    /** Notice / Block / Shutdown announced (BR Manager.Network.IsMaintenance). */
    private _active = false;
    private _noticeOpen = false;
    /** Shutdown or server MSG popup shown — nothing changes any more until the page is reloaded. */
    private _locked = false;
    /** A spin / pick / claim was refused with 10015 — the game is stuck mid-action until reloaded. */
    private _interrupted = false;
    private _handlers: MaintenanceHandlers = { ...NOOP_HANDLERS };

    get step(): number { return this._step; }
    get locked(): boolean { return this._locked; }
    get active(): boolean { return this._active; }

    setHandlers(h: Partial<MaintenanceHandlers>): void {
        this._handlers = { ...this._handlers, ...h };
    }

    /** Spin / bonus purchase allowed? (refused locally in Block and Shutdown, as the server does) */
    isNetworkActionValid(): boolean {
        return !this._locked && this._step !== MaintenanceStep.Block && this._step !== MaintenanceStep.Shutdown;
    }

    /** Next heartbeat delay: 3 s while maintenance is announced, otherwise `normalMs`. */
    heartbeatIntervalMs(normalMs: number): number {
        return this._active ? MAINTENANCE_HEARTBEAT_MS : normalMs;
    }

    /**
     * Handle an SMM (BR ProcessMaintenanceStep). `null` only comes from heartbeat responses — other
     * responses call this only when they carry an SMM.
     */
    process(smm: MaintenanceMessage | null | undefined): void {
        if (this._locked) return;
        this._apply(smm);
        if (this._interrupted && !this._locked && this._step !== MaintenanceStep.Block) {
            this._interrupted = false;
            this._handlers.reloadGame();
        }
    }

    private _apply(smm: MaintenanceMessage | null | undefined): void {
        const h = this._handlers;

        if (smm == null) {
            if (this._noticeOpen || this._step === MaintenanceStep.Block) {
                this._active = false;
                this._closeNotice();
                if (this._step === MaintenanceStep.Block) h.closeBlockPopup();
                this._step = MaintenanceStep.None;
                h.stopAutoSpin();
            }
            return;
        }

        switch (smm.Step) {
            case MaintenanceStep.Block:
                this._active = true;
                if (this._step === MaintenanceStep.Block) {
                    h.openBlockPopup(blockTitle(smm), blockBody(smm)); // text only
                    break;
                }
                this._closeNotice();
                h.openBlockPopup(blockTitle(smm), blockBody(smm));
                h.stopAutoSpin();
                break;
            case MaintenanceStep.Notice:
                this._active = true;
                // Postponed after Block: close the Block popup and show the band again (differs from BR).
                if (this._step === MaintenanceStep.Block) h.closeBlockPopup();
                this._noticeOpen = true;
                h.noticeOpen(noticeText(smm));
                break;
            case MaintenanceStep.Canceled:
                this._active = false;
                this._closeNotice();
                if (this._step === MaintenanceStep.Block) h.closeBlockPopup();
                break;
            case MaintenanceStep.Shutdown:
                this._active = true;
                this._locked = true;
                this._closeNotice();
                h.openLockedPopup(shutdownTitle(smm), shutdownBody(smm));
                h.stopAutoSpin();
                h.disconnect();
                break;
            default:
                return; // unknown step — keep the current state
        }
        this._step = smm.Step;
    }

    /** Login refused with 10015 (BR TryProcessLoginMaintenance / CheckResponsePacket before login). */
    onLoginRejected(smm: MaintenanceMessage | null | undefined, msg: string | null | undefined): void {
        if (this._locked) return;
        if (smm) {
            this._handlers.stopAutoSpin();
            this.process(smm);
        } else {
            this.showServerMessage(msg);
        }
    }

    /**
     * A request after login refused with 10015 (BR CheckResponsePacket): stop auto spin, heartbeat now.
     * `play` — spin / pick / claim / feature choice: the game is left mid-action.
     */
    onRequestRejected(play = false): void {
        if (this._locked) return;
        if (play) this._interrupted = true;
        this._handlers.stopAutoSpin();
        this._handlers.requestHeartbeat();
    }

    /** Heartbeat answered 10015 with nothing to decrypt (BR RequestHeartBeat). */
    onHeartbeatRejected(msg: string | null | undefined): void {
        this.showServerMessage(msg);
    }

    /** Popup without title with the server MSG text; heartbeat and polling stop. */
    showServerMessage(msg: string | null | undefined): void {
        if (this._locked) return;
        this._locked = true;
        this._step = MaintenanceStep.Shutdown;
        const h = this._handlers;
        this._closeNotice();
        h.openLockedPopup('', serverMessageText(msg));
        h.stopAutoSpin();
        h.disconnect();
    }

    private _closeNotice(): void {
        this._noticeOpen = false;
        this._handlers.noticeClose();
    }
}

/** One state per page. */
export const maintenance = new MaintenanceState();
