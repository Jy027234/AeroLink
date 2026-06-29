import prisma from './prisma.js';
import { decrypt } from './crypto.js';
import { sendEmail, type EmailAccountConfig } from './emailService.js';
import { logger } from './logger.js';

const DEFAULT_CLIENT_URL = 'http://127.0.0.1:5173';
export const MISSING_OUTBOUND_ACCOUNT_MESSAGE = '未配置可用的发件邮箱，请先在系统设置中启用默认邮箱账户';

export type AuthEmailDeliveryStatus = 'sent' | 'failed' | 'skipped';

export interface AuthEmailRecipient {
  id: string;
  name: string;
  email: string;
}

export interface AuthEmailDeliveryResult {
  link: string;
  emailDeliveryStatus: AuthEmailDeliveryStatus;
  emailDeliveryError?: string;
  outboundEmailId?: string;
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatExpiryLabel(expiresAt: Date) {
  return expiresAt.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function getPrimaryClientUrl() {
  const configured = process.env.CLIENT_URL
    ?.split(',')
    .map((origin) => origin.trim())
    .find(Boolean);

  const candidate = configured || DEFAULT_CLIENT_URL;

  try {
    return new URL(candidate).toString();
  } catch {
    logger.warn({ clientUrl: candidate }, 'Invalid CLIENT_URL detected, using default client URL');
    return DEFAULT_CLIENT_URL;
  }
}

function buildAuthLink(queryKey: 'activate' | 'reset', token: string) {
  const url = new URL(getPrimaryClientUrl());
  url.searchParams.delete('activate');
  url.searchParams.delete('reset');
  url.searchParams.set(queryKey, token);
  return url.toString();
}

export function buildActivationLink(token: string) {
  return buildAuthLink('activate', token);
}

export function buildPasswordResetLink(token: string) {
  return buildAuthLink('reset', token);
}

export function buildSupplierInviteLink(token: string) {
  const url = new URL(getPrimaryClientUrl());
  url.searchParams.delete('activate');
  url.searchParams.delete('reset');
  url.searchParams.set('supplier-invite', token);
  return url.toString();
}

function buildOutboundAccountConfig(account: {
  id: string;
  email: string;
  displayName: string | null;
  imapServer: string;
  imapPort: string;
  smtpServer: string;
  smtpPort: string;
  authCode: string;
  accountType: string | null;
}): EmailAccountConfig {
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    imapServer: account.imapServer,
    imapPort: account.imapPort,
    smtpServer: account.smtpServer,
    smtpPort: account.smtpPort,
    authCode: decrypt(account.authCode),
    accountType: account.accountType,
  };
}

function buildActionEmailHtml(params: {
  greeting: string;
  intro: string;
  actionLabel: string;
  link: string;
  expiresAtLabel: string;
  footer: string;
}) {
  const { greeting, intro, actionLabel, link, expiresAtLabel, footer } = params;

  return [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<p><a href="${link}">${escapeHtml(actionLabel)}</a></p>`,
    `<p>如按钮无法打开，请复制以下链接到浏览器地址栏：</p>`,
    `<p><a href="${link}">${escapeHtml(link)}</a></p>`,
    `<p>链接有效期至：${escapeHtml(expiresAtLabel)}</p>`,
    `<p>${escapeHtml(footer)}</p>`,
  ].join('');
}

async function createFailedOutboundEmail(params: {
  purpose: string;
  toEmail: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  errorMessage: string;
  status?: string;
}) {
  try {
    const failedEmail = await prisma.outboundEmail.create({
      data: {
        purpose: params.purpose,
        toEmail: params.toEmail,
        subject: params.subject,
        textBody: params.textBody,
        htmlBody: params.htmlBody,
        status: params.status || 'FAILED',
        errorMessage: params.errorMessage,
      },
    });

    return failedEmail.id;
  } catch (error) {
    logger.error({ error, toEmail: params.toEmail, purpose: params.purpose }, 'Failed to persist outbound email failure record');
    return undefined;
  }
}

async function sendManagedAuthEmail(params: {
  purpose: string;
  toEmail: string;
  subject: string;
  textBody: string;
  htmlBody: string;
}) {
  try {
    const accountRecord = await prisma.emailAccount.findFirst({
      where: { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });

    if (!accountRecord) {
      const outboundEmailId = await createFailedOutboundEmail({
        ...params,
        errorMessage: MISSING_OUTBOUND_ACCOUNT_MESSAGE,
        status: 'SKIPPED',
      });

      logger.warn({ toEmail: params.toEmail, purpose: params.purpose }, 'Skipped auth email delivery because no outbound account is configured');

      return {
        emailDeliveryStatus: 'skipped' as const,
        emailDeliveryError: MISSING_OUTBOUND_ACCOUNT_MESSAGE,
        outboundEmailId,
      };
    }

    const account = buildOutboundAccountConfig(accountRecord);
    const pendingEmail = await prisma.outboundEmail.create({
      data: {
        purpose: params.purpose,
        accountId: account.id,
        toEmail: params.toEmail,
        subject: params.subject,
        textBody: params.textBody,
        htmlBody: params.htmlBody,
        status: 'PENDING',
      },
    });

    try {
      const result = await sendEmail(account, {
        to: params.toEmail,
        subject: params.subject,
        body: params.textBody,
        html: params.htmlBody,
      });

      await prisma.outboundEmail.update({
        where: { id: pendingEmail.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId: result.messageId || null,
          errorMessage: null,
        },
      });

      return {
        emailDeliveryStatus: 'sent' as const,
        outboundEmailId: pendingEmail.id,
      };
    } catch (error) {
      const emailDeliveryError = error instanceof Error ? error.message : '邮件发送失败';

      await prisma.outboundEmail.update({
        where: { id: pendingEmail.id },
        data: {
          status: 'FAILED',
          errorMessage: emailDeliveryError,
        },
      });

      logger.warn({ error, toEmail: params.toEmail, purpose: params.purpose }, 'Auth email delivery failed');

      return {
        emailDeliveryStatus: 'failed' as const,
        emailDeliveryError,
        outboundEmailId: pendingEmail.id,
      };
    }
  } catch (error) {
    const emailDeliveryError = error instanceof Error ? error.message : '邮件服务暂时不可用';

    logger.error({ error, toEmail: params.toEmail, purpose: params.purpose }, 'Unexpected auth email delivery failure');

    return {
      emailDeliveryStatus: 'failed' as const,
      emailDeliveryError,
    };
  }
}

export async function sendActivationEmailToUser(
  user: AuthEmailRecipient,
  token: string,
  expiresAt: Date
): Promise<AuthEmailDeliveryResult> {
  const link = buildActivationLink(token);
  const expiresAtLabel = formatExpiryLabel(expiresAt);
  const subject = 'AeroLink 账户激活';
  const textBody = [
    `您好，${user.name}：`,
    '',
    '管理员已为您创建 AeroLink 账户，请通过下面的链接完成首次密码设置：',
    link,
    '',
    `链接有效期至：${expiresAtLabel}`,
    '',
    '如果这不是您本人的操作，请联系管理员。',
  ].join('\n');
  const htmlBody = buildActionEmailHtml({
    greeting: `您好，${user.name}：`,
    intro: '管理员已为您创建 AeroLink 账户，请点击下方链接完成首次密码设置。',
    actionLabel: '设置账户密码',
    link,
    expiresAtLabel,
    footer: '如果这不是您本人的操作，请联系管理员。',
  });

  const delivery = await sendManagedAuthEmail({
    purpose: 'USER_ACTIVATION',
    toEmail: user.email,
    subject,
    textBody,
    htmlBody,
  });

  return {
    link,
    ...delivery,
  };
}

export async function sendPasswordResetEmailToUser(
  user: AuthEmailRecipient,
  token: string,
  expiresAt: Date
): Promise<AuthEmailDeliveryResult> {
  const link = buildPasswordResetLink(token);
  const expiresAtLabel = formatExpiryLabel(expiresAt);
  const subject = 'AeroLink 密码重置';
  const textBody = [
    `您好，${user.name}：`,
    '',
    '我们收到了您的密码重置请求，请通过下面的链接设置新密码：',
    link,
    '',
    `链接有效期至：${expiresAtLabel}`,
    '',
    '如果您并未发起此请求，请忽略这封邮件。',
  ].join('\n');
  const htmlBody = buildActionEmailHtml({
    greeting: `您好，${user.name}：`,
    intro: '我们收到了您的密码重置请求，请点击下方链接设置新密码。',
    actionLabel: '重置账户密码',
    link,
    expiresAtLabel,
    footer: '如果您并未发起此请求，请忽略这封邮件。',
  });

  const delivery = await sendManagedAuthEmail({
    purpose: 'PASSWORD_RESET',
    toEmail: user.email,
    subject,
    textBody,
    htmlBody,
  });

  return {
    link,
    ...delivery,
  };
}

export async function sendSupplierInviteEmail(
  supplierName: string,
  email: string,
  token: string,
  expiresAt: Date
): Promise<AuthEmailDeliveryResult> {
  const link = buildSupplierInviteLink(token);
  const expiresAtLabel = formatExpiryLabel(expiresAt);
  const subject = 'AeroLink 供应商门户邀请';
  const textBody = [
    `您好，${supplierName}：`,
    '',
    '您已被邀请加入 AeroLink 供应商门户，请通过下面的链接完成注册：',
    link,
    '',
    `链接有效期至：${expiresAtLabel}`,
    '',
    '如果这不是您本人的操作，请忽略这封邮件。',
  ].join('\n');
  const htmlBody = buildActionEmailHtml({
    greeting: `您好，${supplierName}：`,
    intro: '您已被邀请加入 AeroLink 供应商门户，请点击下方链接完成注册。',
    actionLabel: '接受邀请并注册',
    link,
    expiresAtLabel,
    footer: '如果这不是您本人的操作，请忽略这封邮件。',
  });

  const delivery = await sendManagedAuthEmail({
    purpose: 'SUPPLIER_INVITE',
    toEmail: email,
    subject,
    textBody,
    htmlBody,
  });

  return {
    link,
    ...delivery,
  };
}
