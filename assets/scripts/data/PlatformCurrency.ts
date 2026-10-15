/**
 * Platform currency table — ★ GENERATED, DO NOT EDIT MANUALLY.
 *
 * Generator: cocos-client/tools/br-platform/gen-currency.mjs
 * Source:    client-porting/rrg-web-template/locale-data/CURRENCIES.md
 *            (Blast Rocket a6ff834f3 — CurrencySymbols.csv official symbols, CurrencyFormatUtil.cs truncated units)
 *
 * LocalizationManager looks a code up here only when CURRENCY_SYMBOL_MAP does not have it.
 */

/** Currency code → official symbol */
export const PLATFORM_CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
    USD: "$",
    AUD: "A$",
    BDT: "৳",
    BND: "B$",
    BRL: "R$",
    CAD: "CA$",
    CNY: "¥",
    EUR: "€",
    HKD: "HK$",
    IDR: "Rp",
    INR: "₹",
    JPY: "¥",
    KES: "KSh",
    KHR: "៛",
    KRW: "₩",
    MMK: "K",
    MXN: "MX$",
    MYR: "RM",
    NGN: "₦",
    NPR: "रू",
    PHP: "₱",
    PKR: "₨",
    SGD: "S$",
    THB: "฿",
    TND: "د.ت",
    TRY: "₺",
    TWD: "NT$",
    VND: "₫",
    XAF: "FCFA",
    XOF: "CFA",
    ZAR: "R",
    ARS: "ARG$",
    COP: "COL$",
    GHS: "GH₵",
    UGX: "Ush",
    ZMW: "ZK",
    MY1: "MY1",
    IDK: "IDR",
    VNK: "VND",
    USDT: "USD₮",
};

/**
 * Truncated-unit currencies — multiples/fractions of a base currency. The server already sends
 * converted amounts, so the client only changes the display: the currency code takes the symbol slot
 * (space before the amount) and the value here is appended after the amount.
 *   IDK → IDR 333.50K · VNK → VND 333.50K · MY1 → MY1 333.50
 */
export const TRUNCATED_UNIT_SUFFIX: Readonly<Record<string, string>> = {
    IDK: "K",
    VNK: "K",
    MY1: "",
};
