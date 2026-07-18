import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { sendBoardMessage, setBoardMenuButton } from './boardBot.js';

// Pure unit tests: global fetch stubbed, no network. Asserts the exact Bot API
// URL + JSON body each wrapper builds, and that {ok:false} surfaces as a throw.
const TOKEN = '7000000004:BOARD-bot-suite-token';
let prevToken: string | undefined;
let prevUrl: string | undefined;

beforeEach(() => {
  prevToken = process.env.BOARD_BOT_TOKEN;
  prevUrl = process.env.BOARD_PUBLIC_URL;
  process.env.BOARD_BOT_TOKEN = TOKEN;
  process.env.BOARD_PUBLIC_URL = 'https://spine.example.com/'; // trailing slash on purpose
});

afterEach(() => {
  if (prevToken === undefined) delete process.env.BOARD_BOT_TOKEN;
  else process.env.BOARD_BOT_TOKEN = prevToken;
  if (prevUrl === undefined) delete process.env.BOARD_PUBLIC_URL;
  else process.env.BOARD_PUBLIC_URL = prevUrl;
  vi.restoreAllMocks();
});

const okFetch = () =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

describe('setBoardMenuButton', () => {
  test('posts a web_app menu button at BOARD_PUBLIC_URL/board (trailing slash trimmed)', async () => {
    const fetchMock = okFetch();
    await setBoardMenuButton();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/setChatMenuButton`);
    expect(JSON.parse(init.body as string)).toEqual({
      menu_button: {
        type: 'web_app',
        text: 'Open board',
        web_app: { url: 'https://spine.example.com/board' },
      },
    });
  });

  test('missing env is refused before any network call', async () => {
    const fetchMock = okFetch();
    delete process.env.BOARD_PUBLIC_URL;
    await expect(setBoardMenuButton()).rejects.toThrow(/BOARD_PUBLIC_URL/);
    delete process.env.BOARD_BOT_TOKEN;
    process.env.BOARD_PUBLIC_URL = 'https://spine.example.com';
    await expect(setBoardMenuButton()).rejects.toThrow(/BOARD_BOT_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendBoardMessage', () => {
  test('posts sendMessage with chat_id + text', async () => {
    const fetchMock = okFetch();
    await sendBoardMessage('900000123', 'Your Thursday changed.');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: '900000123',
      text: 'Your Thursday changed.',
    });
  });

  test('{ok:false} responses throw with Telegram description; non-JSON bodies throw too', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked' }), {
        status: 403,
      }),
    );
    await expect(sendBoardMessage('900000123', 'x')).rejects.toThrow(/Forbidden: bot was blocked/);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('gateway woe', { status: 502 }));
    await expect(sendBoardMessage('900000123', 'x')).rejects.toThrow(/HTTP 502/);
  });
});
