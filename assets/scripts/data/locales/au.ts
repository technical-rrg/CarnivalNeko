/**
 * Australia English (au) — AUD / A$
 *
 * Dùng chung text English; chỉ khác ký hiệu tiền tệ.
 * Không cần font riêng (dùng default Latin font).
 */
import { LocaleData } from './LocaleTypes';
import { LOCALE_EN } from './en';

export const LOCALE_AU: LocaleData = {
    ...LOCALE_EN,
    currency_symbol: 'A$',
    CLIENT_CURRENENCY_SYMBOL: 'A$',
};
