import { describe, expect, it } from 'vitest';
import { requireSanitizedTemplateHtml, sanitizeTemplateHtml } from './templateSanitizer.js';

describe('templateSanitizer', () => {
  it('removes executable markup and unsafe attributes while preserving formatting', () => {
    const sanitized = sanitizeTemplateHtml('<p onclick="alert(1)">safe</p><script>alert(2)</script><a href="javascript:alert(3)">link</a>');

    expect(sanitized).toContain('<p>safe</p>');
    expect(sanitized).not.toContain('onclick');
    expect(sanitized).not.toContain('<script');
    expect(sanitized).not.toContain('javascript:');
  });

  it('rejects an empty body after sanitization', () => {
    expect(() => requireSanitizedTemplateHtml('<script>alert(1)</script>', '正文模板')).toThrow('正文模板');
  });
});
