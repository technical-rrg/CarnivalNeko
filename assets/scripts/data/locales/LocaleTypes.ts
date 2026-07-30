/**
 * Shared locale types — tách riêng để tránh circular dependency với LocalizationManager.
 */

export interface LocaleData {
    [key: string]: string;
}
