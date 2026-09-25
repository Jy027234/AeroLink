import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  openBox: vi.fn(),
  closeBox: vi.fn(),
  search: vi.fn(),
  addFlags: vi.fn(),
  end: vi.fn(),
}));

vi.mock('imap-simple', () => ({
  default: { connect: mocks.connect },
}));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const account = {
  id: 'account-1',
  email: 'ops@example.com',
  displayName: 'Operations',
  imapServer: 'imap.example.com',
  imapPort: '993',
  smtpServer: 'smtp.example.com',
  smtpPort: '465',
  authCode: 'secret',
};

describe('IMAP mailbox fetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({
      openBox: mocks.openBox,
      closeBox: mocks.closeBox,
      search: mocks.search,
      addFlags: mocks.addFlags,
      end: mocks.end,
    });
    mocks.openBox.mockResolvedValue({ uidvalidity: 77 });
  });

  it('fetches only UIDs after the durable cursor without changing provider read state', async () => {
    mocks.search.mockResolvedValue([{
      attributes: { uid: 12 },
      parts: [{
        which: '',
        body: [
          'From: Buyer <buyer@example.com>',
          'To: ops@example.com',
          'Subject: RFQ ABC-123',
          'Message-ID: <message-12@example.com>',
          'Date: Wed, 22 Jul 2026 01:00:00 +0000',
          '',
          'PN: ABC-123\r\nQty: 2',
        ].join('\r\n'),
      }],
    }]);

    const { fetchMailboxMessages } = await import('./emailService.js');
    const result = await fetchMailboxMessages(account, {
      afterUid: 10,
      expectedUidValidity: '77',
      limit: 25,
    });

    expect(mocks.openBox).toHaveBeenCalledWith('INBOX');
    expect(mocks.search).toHaveBeenCalledWith(
      [['UID', '11:*']],
      expect.objectContaining({ bodies: [''], markSeen: false }),
    );
    expect(mocks.addFlags).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      uidValidity: '77',
      highestUid: 12,
      cursorReset: false,
      emails: [{ uid: 12, messageId: '<message-12@example.com>', from: 'buyer@example.com' }],
    });
  });

  it('replays the mailbox when UIDVALIDITY changes', async () => {
    mocks.search.mockResolvedValue([]);
    const { fetchMailboxMessages } = await import('./emailService.js');

    const result = await fetchMailboxMessages(account, {
      afterUid: 99,
      expectedUidValidity: '76',
    });

    expect(mocks.search).toHaveBeenCalledWith(
      ['ALL'],
      expect.objectContaining({ markSeen: false }),
    );
    expect(result.cursorReset).toBe(true);
    expect(result.highestUid).toBe(0);
  });

  it('parses reply threading headers and retains attachment bytes and content id', async () => {
    mocks.search.mockResolvedValue([{
      attributes: { uid: 13 },
      parts: [{
        which: '',
        body: [
          'From: Supplier <supplier@example.com>',
          'To: ops@example.com',
          'Subject: Quote response',
          'Message-ID: <reply-13@example.com>',
          'In-Reply-To: <outbound-12@example.com>',
          'References: <root@example.com> <outbound-12@example.com>',
          'MIME-Version: 1.0',
          'Content-Type: multipart/mixed; boundary="mail-boundary"',
          '',
          '--mail-boundary',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Please see the attached quote.',
          '--mail-boundary',
          'Content-Type: application/pdf; name="quote.pdf"',
          'Content-Transfer-Encoding: base64',
          'Content-Disposition: attachment; filename="quote.pdf"',
          'Content-ID: <quote-part@example.com>',
          '',
          'AAECAwQF',
          '--mail-boundary--',
        ].join('\r\n'),
      }],
    }]);

    const { fetchMailboxMessages } = await import('./emailService.js');
    const result = await fetchMailboxMessages(account);

    expect(result.emails[0]).toMatchObject({
      messageId: '<reply-13@example.com>',
      inReplyTo: '<outbound-12@example.com>',
      references: ['<root@example.com>', '<outbound-12@example.com>'],
      attachments: [{
        filename: 'quote.pdf',
        content: Buffer.from([0, 1, 2, 3, 4, 5]),
        contentType: 'application/pdf',
        contentId: '<quote-part@example.com>',
      }],
    });
  });
});
