import sanitizeHtml from 'sanitize-html';

// Certificate templates are user-managed HTML. Keep the allowlist deliberately
// small: template formatting is supported, while executable/embed-capable HTML
// is removed before it can be persisted or rendered by another consumer.
const ALLOWED_TAGS = [
  'a', 'article', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
  'div', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'section', 'small', 'span',
  'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'u', 'ul',
];

const ALLOWED_ATTRIBUTES = {
  '*': ['aria-label', 'class', 'data-field', 'id', 'title'],
  a: ['href', 'rel', 'target'],
  img: ['alt', 'height', 'src', 'width'],
  td: ['align', 'colspan', 'rowspan', 'valign'],
  th: ['align', 'colspan', 'rowspan', 'valign'],
};

export function sanitizeTemplateHtml(value: string | null | undefined): string | null {
  if (value == null) return null;

  return sanitizeHtml(value, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    enforceHtmlBoundary: true,
  });
}

export function requireSanitizedTemplateHtml(value: string | null | undefined, fieldName: string): string {
  const sanitized = sanitizeTemplateHtml(value);
  if (!sanitized || !sanitized.trim()) {
    throw new Error(`${fieldName} 不能为空或仅包含不允许的 HTML`);
  }
  return sanitized;
}

