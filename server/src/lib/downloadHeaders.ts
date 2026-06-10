function sanitizeAsciiFilename(filename: string): string {
  const normalized = filename
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  const asciiOnly = normalized.replace(/[^\x20-\x7E]/g, '_');
  const collapsed = asciiOnly.replace(/_+/g, '_').trim();

  return collapsed || 'download';
}

export function buildContentDisposition(filename: string): string {
  const fallback = sanitizeAsciiFilename(filename);
  const encoded = encodeURIComponent(filename)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A');

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}