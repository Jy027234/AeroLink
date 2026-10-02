import { describe, expect, it } from 'vitest';
import { hasUnsafeInquiryAttachmentContent, isSafeInquiryAttachmentFilename } from './inquiryAttachmentSafety.js';

describe('inquiry attachment upload safety', () => {
  it('binds safe extensions to their declared MIME type and rejects dangerous extensions', () => {
    expect(isSafeInquiryAttachmentFilename('offer.PDF', 'application/pdf')).toBe(true);
    expect(isSafeInquiryAttachmentFilename('spec.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
    expect(isSafeInquiryAttachmentFilename('sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(true);
    expect(isSafeInquiryAttachmentFilename('quote.csv', 'text/csv')).toBe(true);
    expect(isSafeInquiryAttachmentFilename('payload.exe', 'application/pdf')).toBe(false);
    expect(isSafeInquiryAttachmentFilename('macro.xlsm', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(false);
    expect(isSafeInquiryAttachmentFilename('page.html', 'text/csv')).toBe(false);
    expect(isSafeInquiryAttachmentFilename('picture.svg', 'image/png')).toBe(false);
  });

  it('rejects Office macro markers and HTML disguised as CSV', () => {
    expect(hasUnsafeInquiryAttachmentContent(
      'macro.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      Buffer.from('PK\x03\x04word/vbaProject.bin'),
    )).toBe(true);
    expect(hasUnsafeInquiryAttachmentContent(
      'macro.xls', 'application/vnd.ms-excel', Buffer.from('_VBA_PROJECT_CUR', 'utf16le'),
    )).toBe(true);
    expect(hasUnsafeInquiryAttachmentContent('body.csv', 'text/csv', Buffer.from('<!doctype html><html>'))).toBe(true);
    expect(hasUnsafeInquiryAttachmentContent('normal.csv', 'text/csv', Buffer.from('partNumber,quantity\nPN-1,2'))).toBe(false);
  });
});
