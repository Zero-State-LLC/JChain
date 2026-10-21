const PATTERNS = [
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /<\s*\/?\s*tool\b/i,
  /\btool_call\b/i,
  /\bfunction_call\b/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/,
  /\bapi[_-]?key\b/i,
];

export function likelyInjection(caption: string, altText: string | null): boolean {
  const haystack = altText === null || altText === "" ? caption : `${caption}\n${altText}`;
  return PATTERNS.some((pattern) => pattern.test(haystack));
}
