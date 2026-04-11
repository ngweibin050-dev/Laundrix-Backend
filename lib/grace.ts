/**
 * lib/grace.ts
 *
 * Single source of truth for starting a grace period.
 * Used by: api/queue.ts, api/release.ts, api/cron.ts, api/grace-timeout.ts
 *
 * RTDB structure:
 *   gracePeriods/{machineId}/
 *     machineId   : string
 *     userId      : string
 *     userName    : string
 *     startedAt   : ISO string
 *     expiresAt   : ISO string  (startedAt + 5 min)
 *     warningAt   : ISO string  (startedAt + 2 min)
 *     warningSent : boolean
 *     status      : "active" | "claimed" | "expired"
 *     perUser/
 *       {uid}/
 *         ringSilenced : boolean   ← each user's own alarm state
 *         dismissed    : boolean   ← each user's own modal state
 *
 * Per-user flags are NEVER written by the backend — only the frontend writes them.
 * The backend only ever writes the top-level grace object.
 */

import { rtdb } from './firebase';
import type { GracePeriod } from './types';

/**
 * Start a fresh 5-minute grace period for `userId` on `machineId`.
 * Completely overwrites any existing grace period node.
 */
export async function startGracePeriod(
  machineId: string,
  userId: string,
  userName: string
): Promise<void> {
  const now       = new Date();
  const warningAt = new Date(now.getTime() + 2 * 60 * 1000);  // +2 min
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);  // +5 min

  const gracePeriod: GracePeriod = {
    machineId,
    userId,
    userName,
    startedAt:   now.toISOString(),
    warningAt:   warningAt.toISOString(),
    expiresAt:   expiresAt.toISOString(),
    warningSent: false,
    status:      'active',
    // NOTE: no ringSilenced / dismissed at root level.
    // Per-user state lives under perUser/{uid}/ and is managed by the frontend only.
  };

  await rtdb.ref(`gracePeriods/${machineId}`).set(gracePeriod);
  console.log(`[grace] Started for ${userId} (${userName}) on ${machineId}, expires ${expiresAt.toISOString()}`);
}

/**
 * Mark grace period as claimed (scan successful).
 * Frontend listens for status !== "active" to dismiss modal + stop alarm.
 */
export async function claimGracePeriod(machineId: string): Promise<void> {
  await rtdb.ref(`gracePeriods/${machineId}`).update({
    status:    'claimed',
    claimedAt: new Date().toISOString(),
  });
  console.log(`[grace] Claimed on ${machineId}`);
}

/**
 * Mark grace period as expired and remove it after a short delay.
 */
export async function expireGracePeriod(machineId: string): Promise<void> {
  await rtdb.ref(`gracePeriods/${machineId}`).update({
    status:    'expired',
    expiredAt: new Date().toISOString(),
  });
  // Remove after 3s so clients have time to react
  setTimeout(() => {
    rtdb.ref(`gracePeriods/${machineId}`).remove().catch(() => {});
  }, 3000);
  console.log(`[grace] Expired on ${machineId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Clothes Collection Grace
// RTDB path: clothesGrace/{machineId}
// Triggered when IoT machine state = 'Clothes Inside'
// ─────────────────────────────────────────────────────────────────────────────

export async function startClothesGrace(
  machineId: string,
  userId: string,
  userName: string
): Promise<void> {
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);  // 5 min

  await rtdb.ref(`clothesGrace/${machineId}`).set({
    machineId,
    userId,
    userName,
    startedAt:   now.toISOString(),
    expiresAt:   expiresAt.toISOString(),
    warningSent: false,
    status:      'active',
  });
  console.log(`[clothesGrace] Started for ${userId} (${userName}) on ${machineId}`);
}

export async function markClothesCollecting(machineId: string): Promise<void> {
  await rtdb.ref(`clothesGrace/${machineId}`).update({
    status:      'collecting',
    collectingAt: new Date().toISOString(),
  });
}

export async function expireClothesGrace(machineId: string): Promise<void> {
  await rtdb.ref(`clothesGrace/${machineId}`).update({
    status:    'expired',
    expiredAt: new Date().toISOString(),
  });
  setTimeout(() => {
    rtdb.ref(`clothesGrace/${machineId}`).remove().catch(() => {});
  }, 3000);
}
