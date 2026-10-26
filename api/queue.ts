/**
 * POST /api/queue
 *
 * FIXES:
 *  1. Removed dynamic import inside handleJoin — now static at top level
 *  2. Wrapped startGracePeriod + storeNotification in try-catch inside handleJoin
 *     so they can't bubble up to the outer catch and cause "Internal server error"
 *  3. addUserToQueue now uses tx.set({ merge:true }) instead of tx.update()
 *     so it doesn't throw NOT_FOUND when the Firestore machines doc is missing
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleCors } from '../lib/cors';
import {
  getMachine,
  getUser,
  addUserToQueue,
  isUserInQueue,
  updateNextUserId,
  removeUserFromQueue,
} from '../lib/queue';
import { sendNotification, storeNotification } from '../lib/fcm';
import { machinesRef, queuesRef } from '../lib/firebase';   // ← static import, was dynamic
import { startGracePeriod } from '../lib/grace';

interface QueueRequest {
  action: 'join' | 'leave';
  machineId: string;
  userId: string;
  userName?: string;
  idempotencyKey?: string;
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

  const { action, machineId, userId, userName, idempotencyKey } =
    req.body as QueueRequest;

  if (!action || !machineId || !userId) {
    res.status(400).json({ success: false, error: 'Missing action, machineId, or userId' });
    return;
  }

  try {
    if (action === 'join')  return await handleJoin(req, res, machineId, userId, userName, idempotencyKey);
    if (action === 'leave') return await handleLeave(req, res, machineId, userId);
    res.status(400).json({ success: false, error: 'Invalid action. Use "join" or "leave"' });
  } catch (error: any) {
    console.error(`[queue/${action}] unhandled error:`, error?.message ?? error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Join ─────────────────────────────────────────────────────────────────────

async function handleJoin(
  _req: VercelRequest,
  res: VercelResponse,
  machineId: string,
  userId: string,
  userName?: string,
  idempotencyKey?: string
): Promise<void> {

  // ── 1. Fetch all prerequisite data in parallel ────────────────────────────
  const [machine, user, allMachinesSnap, allQueuesSnap] = await Promise.all([
    getMachine(machineId),
    getUser(userId),
    machinesRef.where('currentUserId', '==', userId).get(),   // ← uses static import
    queuesRef.get(),                                           // ← uses static import
  ]);

  if (!machine) { res.status(404).json({ success: false, error: 'Machine not found' }); return; }
  if (!user)    { res.status(404).json({ success: false, error: 'User not found' }); return; }

  if (machine.currentUserId === userId) {
    res.status(400).json({ success: false, error: 'You are currently using this machine', code: 'ALREADY_CURRENT_USER' });
    return;
  }

  // ── 2. Check already-in-queue for THIS machine ───────────────────────────
  const thisQueueDoc   = allQueuesSnap.docs.find((d: any) => d.id === machineId);
  const thisQueueUsers = (thisQueueDoc?.data()?.users ?? []) as any[];
  if (thisQueueUsers.some((u: any) => u.userId === userId)) {
    res.status(400).json({ success: false, error: 'Already in queue for this machine', code: 'ALREADY_IN_QUEUE' });
    return;
  }

  // ── 3. Check already USING another machine ───────────────────────────────
  if (!allMachinesSnap.empty) {
    const otherMachineId = allMachinesSnap.docs[0].id;
    res.status(400).json({ success: false, error: `You are already using Machine ${otherMachineId}.`, code: 'ALREADY_USING_MACHINE' });
    return;
  }

  // ── 4. Check already in queue for ANOTHER machine ───────────────────────
  for (const qDoc of allQueuesSnap.docs) {
    if (qDoc.id === machineId) continue;
    const users = (qDoc.data()?.users ?? []) as any[];
    if (users.some((u: any) => u.userId === userId)) {
      res.status(400).json({ success: false, error: `Already in queue for Machine ${qDoc.id}.`, code: 'ALREADY_IN_OTHER_QUEUE' });
      return;
    }
  }

  // ── 5. Add to queue ───────────────────────────────────────────────────────
  const resolvedName = userName || (user as any).displayName || (user as any).name || 'Unknown';

  const queueUser = await addUserToQueue(
    machineId,
    userId,
    resolvedName,
    (user as any).photoURL || (user as any).avatar || null,
    idempotencyKey
  );

  if (!queueUser) {
    res.status(500).json({ success: false, error: 'Failed to add to queue. Please try again.' });
    return;
  }

  const isMachineFree  = !machine.currentUserId;
  const isFirstInQueue = queueUser.position === 1;

  // ── 6. Grace period + notifications (wrapped — never cause 500) ──────────
  // These are best-effort: if they fail, the user is still in the queue.
  // We AWAIT storeNotification (in-app list) but never let it kill the response.
  try {
    const tasks: Promise<any>[] = [
      storeNotification(
        userId, 'queue_joined', '✅ Joined Queue',
        `You are #${queueUser.position} in line for Machine ${machineId}.`,
        { machineId, position: queueUser.position.toString() }
      ),
    ];

    if (isMachineFree && isFirstInQueue) {
      tasks.push(
        startGracePeriod(machineId, userId, resolvedName),
        storeNotification(
          userId, 'your_turn', '🎉 Your Turn!',
          `Machine ${machineId} is ready! You have 5 minutes to scan in.`,
          { machineId }
        )
      );
    } else if (!isFirstInQueue) {
      tasks.push(updateNextUserId(machineId));
    }

    await Promise.all(tasks);
  } catch (notifErr: any) {
    // Log but don't fail the request — user is already in queue
    console.warn('[queue/join] non-critical task failed:', notifErr?.message ?? notifErr);
  }

  console.log(`User ${userId} joined queue for ${machineId} at position ${queueUser.position}`);
  res.status(200).json({
    success: true,
    message: `Joined queue at position ${queueUser.position}`,
    data: {
      position:   queueUser.position,
      queueToken: queueUser.queueToken,
      joinedAt:   queueUser.joinedAt,
    },
  });

  // ── 7. FCM push AFTER response — fire-and-forget ─────────────────────────
  Promise.all([
    sendNotification({
      userId, type: 'queue_joined', title: '✅ Joined Queue',
      body: `You are #${queueUser.position} in line for Machine ${machineId}.`,
      data: { machineId, position: queueUser.position.toString() },
    }),
    ...(isMachineFree && isFirstInQueue ? [
      sendNotification({
        userId, type: 'your_turn', title: '🎉 Your Turn!',
        body: `Machine ${machineId} is ready! You have 5 minutes to scan in.`,
        data: { machineId }, sound: 'alarm', priority: 'high',
      }),
    ] : []),
  ]).catch(err => console.error('[queue/join] FCM error:', err?.message ?? err));
}

// ─── Leave ────────────────────────────────────────────────────────────────────

async function handleLeave(
  _req: VercelRequest,
  res: VercelResponse,
  machineId: string,
  userId: string
): Promise<void> {
  const userInQueue = await isUserInQueue(machineId, userId);
  if (!userInQueue) {
    res.status(400).json({ success: false, error: 'Not in queue for this machine' });
    return;
  }

  const removed = await removeUserFromQueue(machineId, userId);
  if (!removed) {
    res.status(500).json({ success: false, error: 'Failed to leave queue' });
    return;
  }

  // Best-effort notification — never kill the leave response
  try {
    await Promise.all([
      updateNextUserId(machineId),
      storeNotification(
        userId, 'queue_left', '👋 Left Queue',
        `You've left the queue for Machine ${machineId}.`,
        { machineId }
      ),
    ]);
  } catch (err: any) {
    console.warn('[queue/leave] non-critical task failed:', err?.message ?? err);
  }

  console.log(`User ${userId} left queue for ${machineId}`);
  res.status(200).json({ success: true, message: 'Successfully left the queue' });

  // FCM push after response
  sendNotification({
    userId, type: 'queue_left', title: '👋 Left Queue',
    body: `You've left the queue for Machine ${machineId}.`,
    data: { machineId },
  }).catch(err => console.error('[queue/leave] FCM error:', err?.message ?? err));
}