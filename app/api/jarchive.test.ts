/**
 * Route handler tests for GET /api/jarchive — fetch is mocked throughout, so
 * these never touch the network (CLAUDE.md's single-URL-on-request policy is
 * about live fetches, not about what a test may stub).
 *
 * The 200 path also exercises the real cached game-9501 fixture, so a
 * regression in the shared parser (app/src/lib/jarchive.ts) or in how this
 * route shapes its response would fail here too.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import handler from './jarchive';
import type { JArchiveGameResponse } from '../src/lib/jarchive';

const FIXTURE_PATH = resolve(__dirname, '../../data/jarchive-cache/game-9501.html');

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  status: (code: number) => FakeRes;
  json: (body: unknown) => FakeRes;
  send: (body: string) => FakeRes;
  setHeader: (key: string, value: string) => void;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    headers: {},
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
    send(body) { res.body = body; return res; },
    setHeader(key, value) { res.headers[key] = value; },
  };
  return res;
}

function makeReq(query: Record<string, string | string[] | undefined>) {
  return { query } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/jarchive', () => {
  it('400s when game is missing', async () => {
    const res = makeRes();
    await handler(makeReq({}), res as never);
    expect(res.statusCode).toBe(400);
  });

  it('400s when game is a list, not a single id', async () => {
    const res = makeRes();
    await handler(makeReq({ game: ['9501', '9502'] }), res as never);
    expect(res.statusCode).toBe(400);
  });

  it('400s when game is not a positive integer', async () => {
    for (const bad of ['abc', '-5', '0', '1.5']) {
      const res = makeRes();
      await handler(makeReq({ game: bad }), res as never);
      expect(res.statusCode).toBe(400);
    }
  });

  it('502s when the upstream fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 } as Response)));
    const res = makeRes();
    await handler(makeReq({ game: '9501' }), res as never);
    expect(res.statusCode).toBe(502);
  });

  it('502s when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const res = makeRes();
    await handler(makeReq({ game: '9501' }), res as never);
    expect(res.statusCode).toBe(502);
  });

  it("422s with \"couldn't parse\" when checkpoint validation fails", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => '<html><body>not a real game page</body></html>',
    } as Response)));
    const res = makeRes();
    await handler(makeReq({ game: '1' }), res as never);
    expect(res.statusCode).toBe(422);
    expect(String(res.body)).toMatch(/couldn't parse/i);
  });

  it('200s with the parsed game, DDs, and a day-long cache header for the real fixture', async () => {
    const html = readFileSync(FIXTURE_PATH, 'utf8');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => html } as Response)));

    const res = makeRes();
    await handler(makeReq({ game: '9501' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('public, s-maxage=86400');

    const body = res.body as JArchiveGameResponse;
    expect(body.players).toEqual(['Sam', 'Grace', 'Joey']);
    expect(body.validation.mismatches).toEqual([]);
    expect(body.contestants).toHaveLength(3);
    expect(body.contestants.find(c => c.name === 'Grace')).toMatchObject({
      correct: 25, wrong: 3, coryat: 20200,
    });
    expect(body.dailyDoubles).toHaveLength(3);
    expect(body.dailyDoubles[2]).toMatchObject({
      round: 'DJ', who: 'Grace', wager: 10000, correct: true,
      allScoresBefore: [7800, 19200, 7000],
    });
  });
});
