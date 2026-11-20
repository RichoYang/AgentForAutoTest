import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkedReceipt } from './fixtures/requirement-release/delivery-proof.mjs';

test('release delivery normalizes only absent text digest and rejects invalid readbacks', () => {
  const expected = { rootId:'root', threadId:'thread', appId:'app', text:'synthetic conclusion',
    attachments:['a'.repeat(64),'b'.repeat(64)], messageIds:['message-1','message-2','message-3'] };
  const receipt = { verified:true, messages:expected.messageIds.map((messageId,index) => {
    const sha256 = expected.attachments[index-1];
    const readback = index === 0 ? { bodyHash:createHash('sha256').update(expected.text).digest('hex') }
      : { sha256, fileKey:messageId };
    return { messageId, sha256, link:'https://applink.feishu.cn/client/message/open?message_id='+messageId,
      readback:{ ...readback, messageId, rootId:expected.rootId, threadId:expected.threadId,
        sender:{ sender_type:'app', id:expected.appId } } };
  }) };
  const stored = JSON.parse(JSON.stringify(receipt));
  assert.deepEqual(checkedReceipt(receipt,expected),checkedReceipt(stored,expected));
  for (const corrupt of [
    value => delete value.messages[1].sha256,
    value => { value.messages[2].readback.sha256 = 'c'.repeat(64); },
    value => delete value.messages[0].readback.bodyHash,
    value => { value.messages[0].readback.sender.id = 'other'; },
    value => { value.messages[0].readback.threadId = 'other'; },
    value => { value.messages[2].messageId = value.messages[1].messageId; },
    value => value.messages.push(value.messages[2]),
  ]) {
    const modified = structuredClone(stored);
    corrupt(modified);
    assert.throws(() => checkedReceipt(modified,expected));
  }
});
