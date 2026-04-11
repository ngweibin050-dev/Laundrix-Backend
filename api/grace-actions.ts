/**
 * POST /api/grace-actions
 *
 * Unified endpoint replacing three small grace/alarm endpoints:
 *   - /api/claim-grace      → action: "claim"
 *   - /api/dismiss-alarm    → action: "dismiss-alarm"
 *   - /api/clothes-collect  → action: "collect-clothes"
 *
 * Merging these saves 2 Vercel function slots (free tier = 12 max).
 *
 * Body: { action: "claim" | "dismiss-alarm" | "collect-clothes", machineId: string, userId: string }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import { rtdb, getCommandsRef, db } from '../lib/firebase';
import { getMachine, getNextUser } from '../lib/queue';
import { claimGracePeriod, markClothesCollecting, startClothesGrace } from '../lib/grace';
import { sendNotification, storeNotification } from '../lib/fcm';
import type { GracePeriod, ApiResponse } from '../lib/types';

type GraceAction = 'claim' | 'dismiss-alarm' | 'collect-clothes' | 'start-clothes';

interface GraceActionRequest {
  action: GraceAction;
  machineId: string;
  userId: string;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed' });
    return;
  }

  const { action, machineId, userId } = req.body as GraceActionRequest;

  if (!action || !machineId || !userId) {
    res.status(400).json({ success: false, error: 'Missing action, machineId, or userId' });
    return;
  }

  try {
    switch (action) {

      // ── claim ──────────────────────────────────────────────────────────────
      // Was: /api/claim-grace
      // Called when nextUserId successfully scans QR during grace period.
      // Sets status → "claimed" so ALL clients dismiss modals and stop alarms.
      case 'claim': {
        const snap = await rtdb.ref(`gracePeriods/${machineId}`).get();
        if (!snap.exists()) {
          res.status(200).json({ success: true, message: 'No active grace period', data: { cleared: false } });
          return;
        }
        const gp = snap.val() as GracePeriod;
        if (gp.userId !== userId) {
          res.status(403).json({ success: false, error: 'Grace period is for a different user' });
          return;
        }
        if (gp.status !== 'active') {
          res.status(200).json({ success: true, message: `Grace already ${gp.status}`, data: { cleared: false } });
          return;
        }
        await claimGracePeriod(machineId);
        console.log(`[grace-actions/claim] ${userId} claimed grace on ${machineId}`);
        res.status(200).json({ success: true, message: 'Grace period cleared.', data: { cleared: true } });
        return;
      }

      // ── dismiss-alarm ──────────────────────────────────────────────────────
      // Was: /api/dismiss-alarm
      // Dismisses the buzzer/alarm on a machine.
      // Only currentUserId or nextUserId may dismiss.
      case 'dismiss-alarm': {
        const machine = await getMachine(machineId);
        if (!machine) {
          res.status(404).json({ success: false, error: 'Machine not found' });
          return;
        }
        const nextUser      = await getNextUser(machineId);
        const isCurrentUser = machine.currentUserId === userId;
        const isNextUser    = nextUser?.userId === userId;
        if (!isCurrentUser && !isNextUser) {
          res.status(403).json({ success: false, error: 'Only current or next user can dismiss the alarm' });
          return;
        }
        await getCommandsRef(machineId).update({
          buzzer:      false,
          dismissAlarm: true,
          dismissedAt:  new Date().toISOString(),
          dismissedBy:  userId,
        });
        console.log(`[grace-actions/dismiss-alarm] ${machineId} dismissed by ${userId}`);
        res.status(200).json({ success: true, message: 'Alarm dismissed.', data: { dismissed: true } });
        return;
      }

      // ── collect-clothes ────────────────────────────────────────────────────
      // Was: /api/clothes-collect
      // Transitions clothesGrace/{machineId} status: 'active' → 'collecting'.
      // Queue screen reacts: "Preparing to collect" → "Collecting clothes".
      case 'collect-clothes': {
        const snap = await rtdb.ref(`clothesGrace/${machineId}`).get();
        if (!snap.exists()) {
          res.status(404).json({ success: false, error: 'No active clothes grace for this machine' });
          return;
        }
        const data = snap.val();
        if (data.userId !== userId) {
          res.status(403).json({ success: false, error: 'Not your clothes grace' });
          return;
        }
        if (data.status !== 'active') {
          res.status(200).json({ success: true, message: `Already ${data.status}` });
          return;
        }
        await markClothesCollecting(machineId);
        console.log(`[grace-actions/collect-clothes] ${machineId} collecting by ${userId}`);
        res.status(200).json({ success: true, message: 'Clothes collection acknowledged.' });
        return;
      }

      // ── start-clothes ──────────────────────────────────────────────────────
      // Called by the FRONTEND instantly when it detects iot/{machineId}/state
      // === 'Clothes Inside' via its own RTDB listener (zero cron latency).
      // Idempotent — if a clothesGrace already exists and is active/collecting,
      // returns success immediately so duplicate calls are harmless.
      case 'start-clothes': {
        const existing = await rtdb.ref(`clothesGrace/${machineId}`).get();
        if (existing.exists()) {
          const d = existing.val();
          if (d.status === 'active' || d.status === 'collecting') {
            // Already started — idempotent
            res.status(200).json({ success: true, message: 'Clothes grace already active', data: { started: false } });
            return;
          }
        }

        // Fetch the current user for this machine
        const iotSnap = await rtdb.ref(`iot/${machineId}`).get();
        const currentUserId = iotSnap.val()?.currentUserId;
        if (!currentUserId) {
          res.status(400).json({ success: false, error: 'No current user for this machine' });
          return;
        }

        const userSnap = await db.collection('users').doc(currentUserId).get();
        if (!userSnap.exists) {
          res.status(404).json({ success: false, error: 'Current user not found' });
          return;
        }
        const userData = userSnap.data()!;
        const userName = userData.displayName || userData.name || 'Unknown';

        await startClothesGrace(machineId, currentUserId, userName);

        // Notify the current user — alarm.mp3
        await storeNotification(currentUserId, 'clothes_ready',
          '👕 Clothes Ready!',
          `Your laundry at Machine ${machineId} is done. Please collect within 5 minutes.`,
          { machineId });
        sendNotification({
          userId: currentUserId, type: 'clothes_ready',
          title: '👕 Clothes Ready!',
          body: `Your laundry at Machine ${machineId} is done. Please collect within 5 minutes.`,
          data: { machineId }, sound: 'alarm', priority: 'high',
        }).catch(() => {});

        // Notify all admins
        const adminsSnap = await db.collection('users').where('role', '==', 'admin').get();
        await Promise.all(adminsSnap.docs
          .filter(doc => doc.id !== currentUserId)
          .map(async doc => {
            await storeNotification(doc.id, 'clothes_collecting',
              `👁️ Clothes Ready – Machine ${machineId}`,
              `${userName}'s laundry is done. They have 5 minutes to collect.`,
              { machineId, userId: currentUserId, userName });
            sendNotification({
              userId: doc.id, type: 'clothes_collecting',
              title: `👁️ Clothes Ready – Machine ${machineId}`,
              body: `${userName}'s laundry is done. They have 5 minutes to collect.`,
              data: { machineId, userId: currentUserId, userName }, priority: 'high',
            }).catch(() => {});
          })
        );

        console.log(`[grace-actions/start-clothes] Started for ${currentUserId} on ${machineId}`);
        res.status(200).json({ success: true, message: 'Clothes grace started.', data: { started: true, userId: currentUserId } });
        return;
      }

      default:
        res.status(400).json({
          success: false,
          error: `Invalid action "${action}". Use: claim | dismiss-alarm | collect-clothes`,
        });
    }
  } catch (error) {
    console.error(`[grace-actions/${action}] error:`, error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
