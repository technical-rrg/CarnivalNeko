/**
 * Hong Kong English (hk) — HKD / HK$
 *
 * Dùng chung text English; chỉ khác ký hiệu tiền tệ.
 * Không cần font riêng (dùng default Latin font).
 */
import { LocaleData } from './LocaleTypes';
import { LOCALE_EN } from './en';

export const LOCALE_HK: LocaleData = {
    ...LOCALE_EN,
    currency_symbol: 'HK$',
    CLIENT_CURRENENCY_SYMBOL: 'HK$',
};
