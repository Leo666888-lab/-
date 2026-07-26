const MAINLAND_MOBILE = /^1[3-9]\d{9}$/;
const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizePhone(value: string): string | null {
  const compact = value.normalize("NFKC").replace(/[\s().-]/gu, "");
  const mainland = compact.match(/^(?:\+86|0086|86)?(1[3-9]\d{9})$/)?.[1];
  if (mainland && MAINLAND_MOBILE.test(mainland)) return mainland;
  return E164.test(compact) ? compact : null;
}

export function phoneForAliyun(value: string): string {
  const normalized = normalizePhone(value);
  if (!normalized) throw new TypeError("invalid SMS phone number");
  return normalized.startsWith("+") ? normalized.slice(1) : normalized;
}
