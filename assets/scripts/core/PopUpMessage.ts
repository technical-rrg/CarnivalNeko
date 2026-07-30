import { L } from './LocalizationManager';

// ─── Payload cho event SHOW_SYSTEM_POPUP ─────────────────────────────────────
export interface SystemPopupPayload {
    popupCase: PopupCase;
    /** Callback khi player nhấn Confirm (chỉ cho popup loại confirm) */
    onConfirm?: () => void;
    /** Callback khi player nhấn Cancel (chỉ cho popup loại confirm) */
    onCancel?: () => void;
}

// ─── Các trường hợp hiển thị popup trong game ────────────────────────────────
export enum PopupCase {
    /** gp token đã hết hạn hoặc đã dùng (ReqWebLinkLogin → ERR_EXPIRED_GAME_LINK) */
    EXPIRED_LINK = 'EXPIRED_LINK',

    /** Dữ liệu request đăng nhập không hợp lệ / thiếu thông tin (ERR_INVALID_REQUEST_DATA) */
    INVALID_REQUEST = 'INVALID_REQUEST',

    /** Mất kết nối server — API trả về CODE != 0 hoặc timeout hết số lần thử lại */
    DISCONNECTED = 'DISCONNECTED',

    /** Lỗi SEQ — session hết hạn, cần đăng nhập lại */
    RELOGIN = 'RELOGIN',

    /** Số dư không đủ để spin / mua bonus */
    INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',

    /** ParSheet Symbol ID không khớp — mất kết nối */
    WRONG_PARSHEET = 'WRONG_PARSHEET',
}

export interface PopupData {
    title: string;
    message: string;
}

// ─── Class tổng quát trả về nội dung popup theo từng trường hợp ───────────────
export class PopUpMessage {
    static get(popupCase: PopupCase): PopupData {
        switch (popupCase) {
            case PopupCase.EXPIRED_LINK:
                return {
                    title: '',
                    message: L('System_Warning_Server_ExpiredLink'),
                };
            case PopupCase.INVALID_REQUEST:
                return {
                    title: '',
                    message: L('System_Warning_Server_InvalidRequest'),
                };
            case PopupCase.DISCONNECTED:
                return {
                    title: L('UI_POPUP_SYSTEM_TEXT1_TITLE'),
                    message: L('UI_POPUP_SYSTEM_TEXT1_MESSAGE'),
                };
            case PopupCase.RELOGIN:
                return {
                    title: L('UI_POPUP_SYSTEM_TEXT2_TITLE'),
                    message: L('UI_POPUP_SYSTEM_TEXT2_MESSAGE'),
                };
            case PopupCase.INSUFFICIENT_BALANCE:
                return {
                    title: L('UI_POPUP_SYSTEM_TEXT3_TITLE'),
                    message: L('UI_POPUP_SYSTEM_TEXT3_MESSAGE'),
                };
            case PopupCase.WRONG_PARSHEET:
                return {
                    title: L('UI_POPUP_SYSTEM_TEXT4_TITLE'),
                    message: L('UI_POPUP_SYSTEM_TEXT4_MESSAGE'),
                };
        }
    }

    /**
     * Các PopupCase cần 2 nút (Confirm + Cancel).
     * Các case còn lại chỉ cần 1 nút OK.
     */
    static isConfirmType(popupCase: PopupCase): boolean {
        return popupCase === PopupCase.INSUFFICIENT_BALANCE;
    }

    /**
     * Map server error code (từ response packet[5]) sang PopupCase.
     * Dựa trên Return Code List trong API guide.
     */
    static popupCaseFromServerCode(code: number): PopupCase {
        switch (code) {
            case 11003: return PopupCase.EXPIRED_LINK;       // ERR_EXPIRED_GAME_LINK
            case 11000:                                       // ERR_INVALID_REQUEST_DATA
            case 11004: return PopupCase.INVALID_REQUEST;    // ERR_INVALID_GAME_LINK_FORMAT
            case 10101:                                       // ERR_RELOGIN_REQUIRED
            case 10102:                                       // ERR_RELOGIN_REQUIRED_DUPLICATED
            case 10106: return PopupCase.RELOGIN;            // ERR_INVALID_SESSION
            default:    return PopupCase.DISCONNECTED;
        }
    }

    /**
     * Trích xuất server error code từ message của Error do _checkResponseCode throw.
     * Format: "Server error [code]: msg"
     * Trả về 0 nếu không parse được (lỗi network/timeout).
     */
    static extractServerCode(err: Error): number {
        const m = err.message.match(/\[(\d+)\]/);
        return m ? parseInt(m[1], 10) : 0;
    }

    /**
     * Xác định PopupCase từ Error bắt được trong catch block.
     */
    static popupCaseFromError(err: Error): PopupCase {
        const code = PopUpMessage.extractServerCode(err);
        if (code === 0) return PopupCase.DISCONNECTED; // network/timeout error
        return PopUpMessage.popupCaseFromServerCode(code);
    }
}
