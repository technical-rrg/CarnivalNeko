import { director, screen, view } from 'cc';
import { Log } from './Logger';

/**
 * Ép swapchain (render window) khớp lại screen.windowSize.
 *
 * Engine chỉ gọi root.resize khi nhận 'window-resize'. Nếu iframe đổi size lúc engine đang boot
 * (zoom fullscreen dọc trước khi loading hiện), event bị lỡ: canvas DOM đã dọc nhưng swapchain còn
 * size ngang cũ → game vẽ thu nhỏ ở góc dưới màn hình.
 *
 * @returns true nếu đã phải resize.
 */
export function syncRenderWindowSize(): boolean {
    const root = director.root;
    const win = root?.mainWindow;
    if (!root || !win) return false;

    const size = screen.windowSize;
    const w = Math.round(size.width);
    const h = Math.round(size.height);
    if (w <= 0 || h <= 0) return false;
    if (win.width === w && win.height === h) return false;

    Log.w(`[RenderWindowSync] swapchain ${win.width}x${win.height} ≠ window ${w}x${h} → resize`);
    root.resize(w, h);
    const ds = view.getDesignResolutionSize();
    view.setDesignResolutionSize(ds.width, ds.height, view.getResolutionPolicy());
    view.emit('canvas-resize');
    return true;
}
