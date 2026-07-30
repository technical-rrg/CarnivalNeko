/**
 * DebugEnv — kiểm tra môi trường cho debug panel / shortcuts.
 *
 * Bật/tắt qua ENABLE_DEBUG_TOOLS trong ServerConfig (mọi build, kể cả release).
 */

import { ENABLE_DEBUG_TOOLS } from '../data/ServerConfig';

/** Debug panel + keyboard shortcuts có được phép không. */
export function isDebugToolsEnabled(): boolean {
    return ENABLE_DEBUG_TOOLS;
}
