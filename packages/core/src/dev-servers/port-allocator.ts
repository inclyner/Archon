/**
 * Deterministic port allocator for per-conversation dev servers.
 *
 * For a given conversation id and member list, returns the same {member →
 * port} mapping every time. Stability matters: the user's browser tabs and
 * any cross-repo env wiring (e.g. `NEXT_PUBLIC_API_URL=http://localhost:N`)
 * point at specific ports, and a restart of the Archon server shouldn't
 * shuffle them.
 *
 * Strategy: hash the conversation id into a base port, then assign each
 * member sequentially. Different conversations land in different blocks
 * with overwhelmingly high probability — collisions only matter when the
 * user has 100+ live conversations on the same group, which isn't a thing
 * anyone does in practice.
 *
 * Range: 3100–4099 (1000 ports). Each conversation reserves a contiguous
 * block of `members.length × stride` ports inside the range. Stride is 10
 * by default — most members need 1 port (front-end → 3100, api → 3101,
 * etc.) but .NET in particular sometimes wants two (http + https), so we
 * leave slack.
 */

const RANGE_START = 3100;
const RANGE_SIZE = 1000;
const STRIDE = 10;

/**
 * Hash a string into a non-negative 32-bit integer. djb2-ish; not
 * cryptographic, just deterministic and well-distributed enough for port
 * spreading.
 */
function hashConversationId(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = (h * 33) ^ id.charCodeAt(i);
  }
  return h >>> 0; // coerce to unsigned 32-bit
}

export interface AllocatedMemberPorts {
  /** codebase id of the member */
  codebaseId: string;
  /** primary port (the one the member's dev server should bind to) */
  port: number;
  /**
   * Spare ports inside this member's stride slot, for codebases that need
   * more than one (e.g. .NET http + https). Always `STRIDE - 1` entries.
   */
  extraPorts: number[];
}

/**
 * Allocate ports for every member of a group conversation.
 *
 * Pure: same conversationId + same member list (regardless of order, since
 * we sort) → same output.
 */
export function allocateConversationPorts(
  conversationId: string,
  memberCodebaseIds: readonly string[]
): AllocatedMemberPorts[] {
  if (memberCodebaseIds.length === 0) return [];

  const sorted = [...memberCodebaseIds].sort();

  // Conversations with N members need N×STRIDE ports. We modulo into the
  // range with that block size in mind so the WHOLE block stays inside the
  // window even when the hash lands near the upper bound.
  const blockSize = sorted.length * STRIDE;
  if (blockSize > RANGE_SIZE) {
    throw new Error(
      `Group has ${sorted.length} members but the port range only supports ${Math.floor(
        RANGE_SIZE / STRIDE
      )}. Bump RANGE_SIZE or reduce members.`
    );
  }
  const usableSlots = RANGE_SIZE - blockSize;
  const baseOffset = hashConversationId(conversationId) % (usableSlots + 1);
  const basePort = RANGE_START + baseOffset;

  return sorted.map((codebaseId, i) => {
    const slotStart = basePort + i * STRIDE;
    const extraPorts: number[] = [];
    for (let k = 1; k < STRIDE; k++) extraPorts.push(slotStart + k);
    return { codebaseId, port: slotStart, extraPorts };
  });
}
