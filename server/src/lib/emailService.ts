import { createTransport } from 'nodemailer';
import { simpleParser, ParsedMail } from 'mailparser';
import { logger } from './logger.js';
import prisma from './prisma.js';

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
  from: string;
  fromName: string;
  subject: string;
  body: string;
  receivedAt: Date;
  attachments: string[];
  rawHeaders: string;
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

export async function syncEmails(account: EmailAccountConfig, limit = 50): Promise<SyncedEmail[]> {
  const { default: imaps } = await import('imap-simple');
  const config = getImapConfig(account);

  const connection = await imaps.connect(config);

  try {
    await connection.openBox('INBOX');

    const searchCriteria = ['UNSEEN'];
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT'],
      struct: true,
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    const syncedEmails: SyncedEmail[] = [];

    for (const message of messages.slice(0, limit)) {
      const headerPart = message.parts.find((p: { which: string }) => p.which === 'HEADER');
      const textPart = message.parts.find((p: { which: string }) => p.which === 'TEXT');

      if (!headerPart || !textPart) continue;

      const headerBody = (headerPart.body as { subject?: string[]; from?: string[]; date?: string[] }) || {};
      const textBody = typeof textPart.body === 'string' ? textPart.body : String(textPart.body ?? '');
      const raw = `Subject: ${headerBody.subject?.[0] || ''}\nFrom: ${headerBody.from?.[0] || ''}\nDate: ${headerBody.date?.[0] || ''}\n\n${textBody}`;

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
        from: fromAddress,
        fromName,
        subject: parsed.subject || '(无主题)',
        body: parsed.text || parsed.html || '',
        receivedAt: parsed.date || new Date(),
        attachments,
        rawHeaders: JSON.stringify(headerPart.body),
      });

      await connection.addFlags(message.attributes.uid, ['\\Seen']);
    }

    return syncedEmails;
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

export async function saveSyncedEmails(accountId: string, emails: SyncedEmail[]): Promise<number> {
  let savedCount = 0;

  for (const email of emails) {
    const existing = await prisma.email.findFirst({
      where: {
        accountId,
        subject: email.subject,
        from: email.from,
        receivedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });

    if (existing) continue;

    const emailType = await autoClassifyEmail(email.subject, email.body);

    await prisma.email.create({
      data: {
        from: email.from,
        fromName: email.fromName,
        subject: email.subject,
        body: email.body,
        type: emailType,
        isRead: false,
        accountId,
        attachments: email.attachments.join(','),
        receivedAt: email.receivedAt,
      },
    });

    savedCount++;
  }

  return savedCount;
}
