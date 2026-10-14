import { fa } from './fa';

let current = 'fa';
export const lang = () => current;
export function setLang(l: string) {
  current = l === 'en' ? 'en' : 'fa';
  document.documentElement.lang = current;
  document.documentElement.dir = current === 'fa' ? 'rtl' : 'ltr';
  document.title = current === 'fa' ? 'همصحبت' : 'Hamsohbat';
}

/** English text is the key; Persian comes from the dictionary. `{name}` placeholders are filled from vars. */
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = current === 'fa' ? fa[key] ?? key : key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll('{' + k + '}', String(v));
  return s;
}
