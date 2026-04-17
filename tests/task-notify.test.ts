/**
 * Task notification helper — Gmail API + webhook (fetch).
 */

import type { AppConfig } from '../src/config';
import { gmailSendMock } from './mocks/googleapis.stub';
import { notifyTaskOutcome } from '../src/task-notify';

describe('task-notify', () => {
  const baseConfig = {
    notifyEmail: undefined,
    gmailSender: undefined,
    gmailOAuthClientId: undefined,
    gmailOAuthClientSecret: undefined,
    gmailRefreshToken: undefined,
    notifyWebhookUrl: undefined,
  } as Pick<
    AppConfig,
    | 'notifyEmail'
    | 'gmailSender'
    | 'gmailOAuthClientId'
    | 'gmailOAuthClientSecret'
    | 'gmailRefreshToken'
    | 'notifyWebhookUrl'
  >;

  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
    global.fetch = fetchMock as unknown as typeof fetch;
    gmailSendMock.mockClear();
    gmailSendMock.mockResolvedValue({ data: {} });
  });

  it('does nothing when no notify env is configured', async () => {
    await notifyTaskOutcome(baseConfig as AppConfig, {
      taskName: 'dry-start',
      devicesTotal: 2,
      devicesSucceeded: 2,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gmailSendMock).not.toHaveBeenCalled();
  });

  it('calls Gmail API when all mail OAuth fields are set', async () => {
    const cfg = {
      ...baseConfig,
      notifyEmail: 'to@example.com',
      gmailSender: 'from@example.com',
      gmailOAuthClientId: 'cid',
      gmailOAuthClientSecret: 'csec',
      gmailRefreshToken: 'rtok',
    } as AppConfig;

    await notifyTaskOutcome(cfg, {
      taskName: 'dry-stop',
      devicesTotal: 3,
      devicesSucceeded: 2,
      detail: 'maxRH=65.0',
    });

    expect(gmailSendMock).toHaveBeenCalledTimes(1);
    const req = gmailSendMock.mock.calls[0][0] as { requestBody?: { raw?: string } };
    expect(req.requestBody?.raw).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs JSON to webhook when NOTIFY_WEBHOOK_URL is set', async () => {
    const cfg = {
      ...baseConfig,
      notifyWebhookUrl: 'https://hooks.example.com/x',
    } as AppConfig;

    await notifyTaskOutcome(cfg, {
      taskName: 'dry-start',
      devicesTotal: 1,
      devicesSucceeded: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.example.com/x');
    const body = JSON.parse(init?.body as string);
    expect(body.source).toBe('daikin-humidity-control');
    expect(body.event).toBe('dry-start');
    expect(body.devicesSucceeded).toBe(1);
  });
});
