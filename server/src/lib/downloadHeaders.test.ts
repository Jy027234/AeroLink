import { describe, expect, it } from 'vitest';
import { validateHeaderValue } from 'node:http';
import { buildContentDisposition } from './downloadHeaders.js';

describe('buildContentDisposition', () => {
  it('should keep an ASCII fallback and include UTF-8 filename encoding', () => {
    const header = buildContentDisposition('销售合同 - SO-20260512-ABCD.pdf');

    expect(header).toContain('attachment;');
    expect(header).toContain('filename="_ - SO-20260512-ABCD.pdf"');
    expect(header).toContain("filename*=UTF-8''%E9%94%80%E5%94%AE%E5%90%88%E5%90%8C%20-%20SO-20260512-ABCD.pdf");
    expect(() => validateHeaderValue('Content-Disposition', header)).not.toThrow();
  });
});