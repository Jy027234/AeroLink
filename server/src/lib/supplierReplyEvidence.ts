/**
 * Exclude recognizable quoted history from extraction input/evidence only.
 * The persisted original email is never changed. Inline replies inside quoted
 * blocks and unrecognized mail-client formats still require human review.
 */
export function supplierReplyBody(body: string): string {
  let reply = body;
  // Outlook/Gmail quoted containers typically contain the remainder of history.
  const container = /<(?:div|section)\b[^>]*(?:\bid\s*=\s*["']divRplyFwdMsg["']|\bclass\s*=\s*["'][^"']*\bgmail_quote\b[^"']*["'])[^>]*>/i.exec(reply);
  if (container?.index != null) reply = reply.slice(0, container.index);
  // Remove nested blockquotes without treating nested closing tags as new text.
  const tags = /<\/?blockquote\b[^>]*>/gi;
  let depth = 0;
  let cursor = 0;
  let unquoted = '';
  for (const tag of reply.matchAll(tags)) {
    const index = tag.index!;
    if (!tag[0].startsWith('</')) {
      if (depth++ === 0) unquoted += reply.slice(cursor, index);
    } else if (depth > 0 && --depth === 0) {
      cursor = index + tag[0].length;
    }
  }
  reply = depth > 0 ? unquoted : unquoted + reply.slice(cursor);
  // Common top-posted plaintext reply/forward delimiters, including Chinese.
  const history = /^\s*(?:-{2,}\s*(?:Original Message|Forwarded message|原始邮件|转发邮件)\s*-*|On [^\r\n]+ wrote:|在[^\r\n]+写道[:：]|(?:From|发件人)\s*[:：][^\r\n]+\r?\n\s*(?:Sent|Date|发送时间|日期)\s*[:：])/im.exec(reply);
  if (history?.index != null) reply = reply.slice(0, history.index);
  return reply.split(/\r?\n/).filter(line => !/^\s*>/.test(line)).join('\n');
}

const nonOfferQuantity = /库存|需求(?:数量)?|询价(?:数量)?|\bstock\b|\binventory\b|\b(?:requested|required|demand)\s*(?:qty|quantity)?\b/i;

/** Conservative quantity check; ambiguous availability stays a reviewable draft. */
export function evidencedOfferQuantity(
  quantity: number | null | undefined,
  evidence: string,
): boolean {
  if (quantity == null) return true;
  const value = String(quantity).replace('.', '\\.');
  const explicitCommitment = new RegExp(`(?:报价数量|承诺数量|可供数量|供货数量|供应数量|(?:can\\s+)?(?:offer|supply|provide)(?:ed|ing)?|quoted?\\s+(?:qty|quantity))\\s*[:：=]?\\s*${value}(?![\\d.])`, 'i');
  if (explicitCommitment.test(evidence)) return true;
  const unambiguousClauses = evidence.split(/[\r\n;；,，]/).filter(clause => !nonOfferQuantity.test(clause));
  const commitment = new RegExp(`(?:报价数量|承诺数量|可供数量|供货数量|供应数量|(?:can\\s+)?(?:offer|supply|provide)(?:ed|ing)?|(?:quoted?\\s+)?(?:qty|quantity)|数量)\\s*[:：=]?\\s*${value}(?![\\d.])`, 'i');
  const withUnit = new RegExp(`(?<![\\w.])${value}\\s*(?:ea|pcs?|pieces?|units?|sets?|件|个|套)(?![a-z])`, 'i');
  return unambiguousClauses.some(clause => commitment.test(clause) || withUnit.test(clause));
}
