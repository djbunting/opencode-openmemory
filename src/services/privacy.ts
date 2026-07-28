export function containsPrivateTag(content: string): boolean {
  return /<private>[\s\S]*?<\/private>/i.test(content);
}

export function stripPrivateContent(content: string): string {
  return content.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");
}

export function isFullyPrivate(content: string): boolean {
  // Remove every redaction marker rather than comparing against a single
  // one: adjacent private blocks strip to "[REDACTED][REDACTED]", which
  // an equality check would wrongly treat as having real content left.
  const remaining = stripPrivateContent(content).replace(/\[REDACTED\]/g, "").trim();
  return remaining === "";
}
