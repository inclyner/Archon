import { describe, it, expect } from 'bun:test';
import { allocateConversationPorts } from './port-allocator';

describe('allocateConversationPorts', () => {
  it('is deterministic across calls', () => {
    const a = allocateConversationPorts('conv-abc-123', ['cb-1', 'cb-2', 'cb-3']);
    const b = allocateConversationPorts('conv-abc-123', ['cb-1', 'cb-2', 'cb-3']);
    expect(a).toEqual(b);
  });

  it('is order-independent — sorting the member list happens internally', () => {
    const a = allocateConversationPorts('conv-x', ['cb-2', 'cb-1', 'cb-3']);
    const b = allocateConversationPorts('conv-x', ['cb-3', 'cb-1', 'cb-2']);
    expect(a).toEqual(b);
  });

  it('returns no allocations for an empty member list', () => {
    expect(allocateConversationPorts('conv-x', [])).toEqual([]);
  });

  it('keeps every allocated port in the configured 3100–4099 range', () => {
    // Exhaustively probe ~200 ids to make sure the modulo never lets the
    // last member fall out of the window.
    for (let i = 0; i < 200; i++) {
      const id = `conv-${i}-${(i * 7919).toString(16)}`;
      const out = allocateConversationPorts(id, ['cb-a', 'cb-b', 'cb-c', 'cb-d']);
      for (const m of out) {
        expect(m.port).toBeGreaterThanOrEqual(3100);
        expect(m.port + m.extraPorts.length).toBeLessThan(4100);
      }
    }
  });

  it('gives each member STRIDE-1 spare ports (for HTTPS dual-bind etc.)', () => {
    const out = allocateConversationPorts('conv-x', ['cb-1', 'cb-2']);
    for (const m of out) {
      expect(m.extraPorts.length).toBe(9);
      // Spare ports are sequential after the primary.
      expect(m.extraPorts[0]).toBe(m.port + 1);
      expect(m.extraPorts[8]).toBe(m.port + 9);
    }
  });

  it('different conversations land in different blocks (low collision)', () => {
    // Generate 50 distinct ids; check that NO two end up with the same
    // primary port for member 1. This is a weak collision check but enough
    // to catch a hash that's just modulo-by-10.
    const seen = new Set<number>();
    let collisions = 0;
    for (let i = 0; i < 50; i++) {
      const out = allocateConversationPorts(`conv-${i}`, ['only-cb']);
      const port = out[0].port;
      if (seen.has(port)) collisions++;
      seen.add(port);
    }
    // With 50 ids in a 1000-port window, expected collisions ~1.2 (birthday).
    // Allow up to 5 to keep the test stable.
    expect(collisions).toBeLessThanOrEqual(5);
  });

  it('throws when the member count would exceed the port window', () => {
    // 1000 / 10 = 100 max members. 101 should throw.
    const tooMany = Array.from({ length: 101 }, (_, i) => `cb-${i}`);
    expect(() => allocateConversationPorts('conv', tooMany)).toThrow(/port range/);
  });
});
