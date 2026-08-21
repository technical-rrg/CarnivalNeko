/**
 * DebugEnv — kiểm tra môi trường cho debug panel / shortcuts.
 *
 * Bật/tắt qua ENABLE_DEBUG_TOOLS trong ServerConfig (mọi build, kể cả release).
 */

import { BUILD } from 'cc/env';
import { ENABLE_DEBUG_TOOLS } from '../data/ServerConfig';

/** Debug panel + keyboard shortcuts có được phép không. */
export function isDebugToolsEnabled(): boolean {
    return ENABLE_DEBUG_TOOLS;
}

/**
 * Chỉ true khi KHÔNG phải build release.
 * Dùng !BUILD thay vì PREVIEW — PREVIEW thường false khi compile script trong Editor,
 * nên overlay không bao giờ mount. BUILD=true chỉ khi publish → build release tự strip code.
 */
export function isEditorPreview(): boolean {
    return !BUILD;
}
