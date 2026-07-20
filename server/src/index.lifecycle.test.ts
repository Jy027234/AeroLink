import { afterAll, describe, expect, it } from 'vitest';
import { app, httpServer } from './index.js';

describe('API entrypoint lifecycle', () => {
  afterAll(() => {
    httpServer.close();
  });

  it('exports an unbound app when imported by tests', () => {
    expect(app).toBeDefined();
    expect(httpServer.listening).toBe(false);
  });
});
