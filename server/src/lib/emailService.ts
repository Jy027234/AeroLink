import { createTransport } from 'nodemailer';
import { simpleParser, type ParsedMail } from 'mailparser';
import { logger } from './logger.js';

export interface EmailAccountConfig {
  id: string;
  email: string;
  displayName?: string | null;
  imapServer: string;
  imapPort: string;
  smtpServer: string;
  smtpPort: string;
  authCode: string;
  accountType?: string | null;
}

export interface SyncedEmail {
  uid: number;
  uidValidity: string;
  mailbox: string;
  messageId: string | null;
  from: string;
  fromName: string;
  subject: string;
  body: string;
  receivedAt: Date;
  attachments: string[];
  rawHeaders: string;
}

export interface MailboxFetchResult {
  emails: SyncedEmail[];
  uidValidity: string;
  highestUid: number;
  cursorReset: boolean;
}

export interface MailboxFetchOptions {
  mailbox?: string;
  afterUid?: number;
  expectedUidValidity?: string | null;
  limit?: number;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  html?: string;
  attachments?: EmailAttachment[];
  /** Stable Message-ID lets downstream mail systems de-duplicate outbox retries where supported. */
  messageId?: string;
}

function getImapConfig(account: EmailAccountConfig) {
  const port = parseInt(account.imapPort, 10) || 993;
  const rejectUnauthorized = process.env.NODE_ENV === 'production';
  return {
    imap: {
      user: account.email,
      password: account.authCode,
      host: account.imapServer,
      port,
      tls: port === 993,
      tlsOptions: { rejectUnauthorized },
      authTimeout: 10000,
    },
  };
}

function getSmtpConfig(account: EmailAccountConfig) {
  const port = parseInt(account.smtpPort, 10) || 465;
  const rejectUnauthorized = process.env.NODE_ENV === 'production';
  return {
    host: account.smtpServer,
    port,
    secure: port === 465,
    auth: {
      user: account.email,
      pass: account.authCode,
    },
    tls: {
      rejectUnauthorized,
    },
  };
}

export async function testImapConnection(account: EmailAccountConfig): Promise<boolean> {
  try {
    const config = getImapConfig(account);
    const { default: imaps } = await import('imap-simple');
    const connection = await imaps.connect(config);
    await connection.openBox('INBOX');
    await connection.closeBox(true);
    connection.end();
    return true;
  } catch (error) {
    logger.warn({ error, accountId: account.id }, 'IMAP connection test failed');
    return false;
  }
}

export async function testSmtpConnection(account: EmailAccountConfig): Promise<boolean> {
  try {
    const transporter = createTransport(getSmtpConfig(account));
    await transporter.verify();
    return true;
  } catch (error) {
    logger.warn({ error, accountId: account.id }, 'SMTP connection test failed');
    return false;
  }
}

export async function fetchMailboxMessages(
  account: EmailAccountConfig,
  options: MailboxFetchOptions = {},
): Promise<MailboxFetchResult> {
  const { default: imaps } = await import('imap-simple');
  const config = getImapConfig(account);
  const mailbox = options.mailbox?.trim() || 'INBOX';
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const requestedAfterUid = Math.max(0, options.afterUid ?? 0);

  const connection = await imaps.connect(config);

  try {
    const box = await connection.openBox(mailbox);
    const uidValidity = String(box.uidvalidity ?? 'unknown');
    const cursorReset = Boolean(
      options.expectedUidValidity
      && options.expectedUidValidity !== uidValidity,
    );
    const afterUid = cursorReset ? 0 : requestedAfterUid;

    const searchCriteria = afterUid > 0
      ? [['UID', `${afterUid + 1}:*`]]
      : ['ALL'];
    const fetchOptions = {
      bodies: [''],
      struct: true,
      markSeen: false,
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    const syncedEmails: SyncedEmail[] = [];
    const orderedMessages = [...messages]
      .filter((message) => Number(message.attributes?.uid) > afterUid)
      .sort((left, right) => Number(left.attributes.uid) - Number(right.attributes.uid))
      .slice(0, limit);

    for (const message of orderedMessages) {
      const rawPart = message.parts.find((part: { which: string }) => part.which === '');
      if (!rawPart) continue;

      const raw = Buffer.isBuffer(rawPart.body)
        ? rawPart.body
        : Buffer.from(String(rawPart.body ?? ''), 'utf8');

      const parsed: ParsedMail = await simpleParser(raw);

      const fromAddress = parsed.from?.value?.[0]?.address || parsed.from?.text || 'unknown@unknown.com';
      const fromName = parsed.from?.value?.[0]?.name || parsed.from?.text || '未知发件人';

      const attachments: string[] = [];
      if (parsed.attachments && parsed.attachments.length > 0) {
        for (const att of parsed.attachments) {
          attachments.push(att.filename || 'unnamed');
        }
      }

      syncedEmails.push({
        uid: Number(message.attributes.uid),
        uidValidity,
        mailbox,
        messageId: parsed.messageId?.trim() || null,
        from: fromAddress,
        fromName,
        subject: parsed.subject || '(无主题)',
        body: parsed.text || parsed.html || '',
        receivedAt: parsed.date || new Date(),
        attachments,
        rawHeaders: raw.subarray(0, Math.max(0, raw.indexOf('\r\n\r\n')) || Math.min(raw.length, 64 * 1024)).toString('utf8'),
      });
    }

    return {
      emails: syncedEmails,
      uidValidity,
      highestUid: syncedEmails.reduce((highest, email) => Math.max(highest, email.uid), afterUid),
      cursorReset,
    };
  } finally {
    connection.end();
  }
}

export async function sendEmail(
  account: EmailAccountConfig,
  input: SendEmailInput
): Promise<{ messageId?: string | null }> {
  const transporter = createTransport(getSmtpConfig(account));

  const result = await transporter.sendMail({
    from: `"${account.displayName || account.email}" <${account.email}>`,
    to: input.to,
    subject: input.subject,
    text: input.body,
    html: input.html,
    attachments: input.attachments,
    messageId: input.messageId,
  });

  return {
    messageId: typeof result.messageId === 'string' ? result.messageId : null,
  };
}

export async function autoClassifyEmail(subject: string, body: string): Promise<string> {
  const text = `${subject} ${body}`.toLowerCase();

  if (/aog|紧急|urgent|grounded|停场|停飞/.test(text)) {
    return 'AOG';
  }
  if (/询价|quote|quotation|rfq|request for quote|price|报价/.test(text)) {
    return 'INQUIRY';
  }
  if (/广告|promotion|unsubscribe|营销|推广|spam/.test(text)) {
    return 'SPAM';
  }

  return 'STANDARD';
}
