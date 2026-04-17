/**
 * Optional outbound notifications after device-control tasks succeed (or partially succeed).
 * Used by routes.ts for dry-start, dry-stop, and humidity-driven transitions.
 *
 * Configure via NOTIFY_EMAIL + Gmail OAuth (all required to send mail) and/or NOTIFY_WEBHOOK_URL.
 * If nothing is set, calls are no-ops. Never log refresh tokens or full webhook bodies.
 */

import { google } from 'googleapis';
import type { AppConfig } from './config';
import logger from './logger';

export type TaskNotifyPayload = {
  /** Task route name, e.g. dry-start, dry-stop */
  taskName: string;
  devicesTotal: number;
  devicesSucceeded: number;
  /** Extra line for humidity-driven runs (e.g. max RH). */
  detail?: string;
};

function buildSubject(payload: TaskNotifyPayload): string {
  const { taskName, devicesSucceeded, devicesTotal } = payload;
  return `[Daikin humidity] ${taskName}: ${devicesSucceeded}/${devicesTotal} devices OK`;
}

function buildTextBody(payload: TaskNotifyPayload): string {
  const lines = [
    `Task: ${payload.taskName}`,
    `Devices: ${payload.devicesSucceeded} succeeded of ${payload.devicesTotal}`,
    `Time: ${new Date().toISOString()}`,
  ];
  if (payload.detail) {
    lines.push(`Detail: ${payload.detail}`);
  }
  return lines.join('\n');
}

function rfc2047EncodeSubject(subject: string): string {
  if (/^[\x20-\x7E]*$/.test(subject)) {
    return subject;
  }
  const b64 = Buffer.from(subject, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

async function sendGmail(config: AppConfig, payload: TaskNotifyPayload): Promise<void> {
  const to = config.notifyEmail;
  const from = config.gmailSender;
  const clientId = config.gmailOAuthClientId;
  const clientSecret = config.gmailOAuthClientSecret;
  const refreshToken = config.gmailRefreshToken;
  if (!to || !from || !clientId || !clientSecret || !refreshToken) {
    return;
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, 'urn:ietf:wg:oauth:2.0:oob');
  oauth2.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  const subject = rfc2047EncodeSubject(buildSubject(payload));
  const body = buildTextBody(payload);
  const mime = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
  ].join('\r\n');

  const raw = Buffer.from(mime)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
}

async function postWebhook(config: AppConfig, payload: TaskNotifyPayload): Promise<void> {
  const url = config.notifyWebhookUrl;
  if (!url) {
    return;
  }

  const body = {
    source: 'daikin-humidity-control',
    event: payload.taskName,
    devicesSucceeded: payload.devicesSucceeded,
    devicesTotal: payload.devicesTotal,
    detail: payload.detail ?? null,
    ts: new Date().toISOString(),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    logger.warn(
      { task: payload.taskName, status: res.status },
      'Notify webhook returned non-success',
    );
  }
}

/**
 * Fire-and-forget safe: catches errors and logs; does not throw to callers.
 */
export async function notifyTaskOutcome(config: AppConfig, payload: TaskNotifyPayload): Promise<void> {
  const hasGmail =
    Boolean(config.notifyEmail?.length) &&
    Boolean(config.gmailSender?.length) &&
    Boolean(config.gmailOAuthClientId?.length) &&
    Boolean(config.gmailOAuthClientSecret?.length) &&
    Boolean(config.gmailRefreshToken?.length);
  const hasWebhook = Boolean(config.notifyWebhookUrl?.length);

  if (!hasGmail && !hasWebhook) {
    return;
  }

  try {
    if (hasGmail) {
      await sendGmail(config, payload);
    }
    if (hasWebhook) {
      await postWebhook(config, payload);
    }
    logger.info(
      { task: payload.taskName, channels: { gmail: hasGmail, webhook: hasWebhook } },
      'Task notify sent',
    );
  } catch (err) {
    logger.warn({ task: payload.taskName, err }, 'Task notify failed (ignored)');
  }
}
