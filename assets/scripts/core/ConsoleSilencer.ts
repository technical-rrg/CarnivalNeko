const noop = (..._args: any[]): void => {};

const c: any = (typeof console !== 'undefined') ? console : null;
if (c) {
  c.log = noop;
  c.info = noop;
  c.debug = noop;
  c.warn = noop;
  c.trace = noop;
}

export const consoleSilenced: boolean = true;
