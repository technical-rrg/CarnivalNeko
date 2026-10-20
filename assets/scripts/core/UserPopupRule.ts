/**
 * User popups vs. spin — user instruction for all games (PLATFORM_SPEC D8, 2026-10-16).
 *
 * 1. Spin pressed while a user popup is open:
 *    - mini menu, currency bubble: stay open, the spin goes through. Their outside-touch
 *      checks ask isSpinButtonTouch() (UIController registers its spin button).
 *    - bet / auto-setting / settings: the touch lands on their overlay — it is an outside
 *      touch, so they close and no spin starts (original overlay behaviour, no exception).
 * 2. Auto spin moving to the next round never closes a user popup.
 * 3. Popups the game opens by itself (free spin, jackpot, …) emit POPUP_OPENED with
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
