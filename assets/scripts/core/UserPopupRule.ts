/**
 * User instruction (all games): a spin — normal or auto — never closes a popup the
 * user opened (mini menu, currency bubble, settings, pay table, …). Those close only
 * by their own close button or a touch on empty space, as before.
 *
 * 1. Spin-family buttons are not an "outside touch": pressing Spin / Stop / auto-stop
 *    while such a popup is open keeps it open and the spin goes through.
 *    UIController registers its spin button; popups ask isSpinButtonTouch().
 * 2. Popups the game opens by itself (free spin, jackpot, …) emit POPUP_OPENED with
 *    POPUP_SOURCE_GAME, so user popups that close "when another popup opens" skip them.
 */

import { EventTouch, Node, UITransform } from 'cc';

/** Second argument of POPUP_OPENED when the game (not the user) opened the popup. */
export const POPUP_SOURCE_GAME = 'game';

const _spinNodes: Node[] = [];

export function registerSpinButton(node: Node | null | undefined): void {
    if (node && !_spinNodes.includes(node)) _spinNodes.push(node);
}

export function unregisterSpinButton(node: Node | null | undefined): void {
    const i = node ? _spinNodes.indexOf(node) : -1;
    if (i >= 0) _spinNodes.splice(i, 1);
}

/** True when the touch lands on a visible spin-family button. */
export function isSpinButtonTouch(event: EventTouch): boolean {
    const loc = event.getLocation();
    return _spinNodes.some((n) => n.isValid && n.activeInHierarchy
        && !!n.getComponent(UITransform)?.hitTest(loc));
}
