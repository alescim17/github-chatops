import fs from 'node:fs';
import assert from 'node:assert/strict';
import { control, receiptId } from './r2-receipt.mjs';

// Loaded only into the isolated src/runner.mjs subprocess. No real credentials.
if (process.env.REPORELAY_R2_HARNESS) {
  const config = JSON.parse(fs.readFileSync(process.env.REPORELAY_R2_HARNESS, 'utf8'));
  const calls = [];
  const bus = `/repos/${control}/issues/3/comments`;
  const json = value => new Response(JSON.stringify(value));
  const newReceiptId = 6000000000;
  let newReceipt;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? 'GET';
    assert.equal(url.origin, 'https://api.github.com');
    calls.push({ path: url.pathname, method });
    if (method === 'GET') {
      assert.equal(init.headers.Authorization, 'Bearer r2-fake-control');
      if (url.pathname === bus) {
        assert.equal(url.searchParams.get('per_page'), '100');
        assert.equal(url.searchParams.has('since'), false);
        return json([config.collection, ...(newReceipt ? [newReceipt] : [])]);
      }
      assert.equal(url.pathname, `/repos/${control}/issues/comments/${receiptId}`);
      return json(config.exact);
    }
    // Only receipts for the NEW lookup may be written, always with App token.
    assert.equal(init.headers.Authorization, 'Bearer r2-fake-app');
    const body = JSON.parse(init.body).body;
    if (method === 'POST') {
      assert.equal(url.pathname, bus);
      assert.equal(newReceipt, undefined);
      newReceipt = { id: newReceiptId, body };
    } else {
      assert.equal(method, 'PATCH');
      assert.equal(url.pathname, `/repos/${control}/issues/comments/${newReceiptId}`);
      newReceipt.body = body;
    }
    return json(newReceipt);
  };
  process.on('exit', () => fs.writeFileSync(config.output, JSON.stringify({ calls, receipt: newReceipt })));
}
