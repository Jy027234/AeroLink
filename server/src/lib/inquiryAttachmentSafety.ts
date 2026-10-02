const extensionsByMimeType: Record<string, readonly string[]> = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/gif': ['.gif'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'text/csv': ['.csv'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
};

export function isSafeInquiryAttachmentFilename(filename: string, contentType: string) {
  const normalized = filename.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';
  const extension = normalized.slice(normalized.lastIndexOf('.'));
  return Boolean(normalized && extension && extensionsByMimeType[contentType]?.includes(extension));
}

function containsAscii(content: Buffer, needle: string) {
  return Buffer.from(content.toString('latin1').toLowerCase(), 'latin1')
    .includes(Buffer.from(needle.toLowerCase(), 'ascii'));
}

function containsUtf16Le(content: Buffer, needle: string) {
  return Buffer.from(content.toString('utf16le').toLowerCase(), 'utf16le')
    .includes(Buffer.from(needle.toLowerCase(), 'utf16le'));
}

export function hasUnsafeInquiryAttachmentContent(filename: string, contentType: string, content: Buffer) {
  const extension = filename.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase().split('.').at(-1) ?? '';
  const officeMime = contentType === 'application/msword'
    || contentType === 'application/vnd.ms-excel'
    || contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (officeMime && [
    'vbaProject.bin',
    'macroEnabled',
    '_VBA_PROJECT_CUR',
    '__VBA_PROJECT',
  ].some((marker) => containsAscii(content, marker) || containsUtf16Le(content, marker))) {
    return true;
  }

  if (extension === 'csv' && contentType === 'text/csv') {
    const beginning = content.toString('utf8').replace(/^\uFEFF/, '').trimStart().slice(0, 512).toLowerCase();
    if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b|<svg\b)/.test(beginning)) return true;
  }
  return false;
}
