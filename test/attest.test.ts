import { describe, expect, it } from 'vitest';
import {
  buildChain,
  decodeTradeData,
  encodeTradeData,
  hashEntry,
  schemaUidFor,
  verifyChain,
  ZERO_HASH,
  type TradeAttestationData,
} from '../src/attest.js';
import { EAS } from '../src/config.js';

const SAMPLE: TradeAttestationData = {
  proposalId: '0x' + '11'.repeat(32),
  rationaleHash: '0x' + '22'.repeat(32),
  txHash: '0x' + '33'.repeat(32),
  notionalUsd: 12345n,
  exitPath: false,
  engine: 'hsk-agent-v2',
  origin: 'test',
};

describe('hash chain (pure)', () => {
  it('hashEntry is deterministic and changes with any input bit', () => {
    const h1 = hashEntry(ZERO_HASH, '{"a":1}');
    expect(hashEntry(ZERO_HASH, '{"a":1}')).toBe(h1);
    expect(hashEntry(ZERO_HASH, '{"a":2}')).not.toBe(h1);
    expect(hashEntry('0x' + 'ff'.repeat(32), '{"a":1}')).not.toBe(h1);
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('buildChain + verifyChain: valid chain verifies', () => {
    const chain = buildChain(['{"type":"signal","score":72}', '{"type":"decision","action":"no-trade"}']);
    expect(chain).toHaveLength(2);
    expect(chain[0].prevHash).toBe(ZERO_HASH);
    expect(chain[1].prevHash).toBe(chain[0].hash);
    expect(verifyChain(chain)).toEqual({ valid: true, badIndex: null, reason: null });
  });
  it('verifyChain catches a tampered entry JSON', () => {
    const chain = buildChain(['{"type":"signal","score":72}', '{"type":"decision"}']);
    const tampered = [...chain];
    tampered[1] = { ...tampered[1], entryJson: '{"type":"decision","action":"trade"}' };
    const r = verifyChain(tampered);
    expect(r.valid).toBe(false);
    expect(r.badIndex).toBe(1);
  });
  it('verifyChain catches a broken link (prevHash edited)', () => {
    const chain = buildChain(['{"a":1}', '{"b":2}']);
    const broken = [...chain];
    broken[1] = { ...broken[1], prevHash: '0x' + '99'.repeat(32) };
    const r = verifyChain(broken);
    expect(r.valid).toBe(false);
    expect(r.badIndex).toBe(1);
  });
  it('empty chain is valid', () => {
    expect(verifyChain([]).valid).toBe(true);
  });
});

describe('EAS trade data encoding', () => {
  it('encode/decode round-trips exactly', () => {
    const decoded = decodeTradeData(encodeTradeData(SAMPLE));
    expect(decoded).toEqual(SAMPLE);
  });
  it('encoding is deterministic', () => {
    expect(encodeTradeData(SAMPLE)).toBe(encodeTradeData(SAMPLE));
  });
  it('schemaUidFor reproduces Flow\'s registered UID on testnet (verified live)', () => {
    expect(
      schemaUidFor(EAS.flowSchema, '0x0000000000000000000000000000000000000000', false),
    ).toBe(EAS.flowSchemaUid);
    expect(EAS.flowSchemaUid).toBe(
      '0x1c0c01e337924a140372f0043e9a9a3125e0e276b6dae78382676b3d0e53a04f',
    );
  });
  it('different resolver/revocable -> different UID', () => {
    const a = schemaUidFor(EAS.flowSchema, '0x0000000000000000000000000000000000000000', false);
    const b = schemaUidFor(EAS.flowSchema, '0x0000000000000000000000000000000000000000', true);
    expect(a).not.toBe(b);
  });
});
