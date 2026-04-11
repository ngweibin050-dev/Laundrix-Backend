/**
 * POST /api/notify
 *
 * Unified notification endpoint — replaces /api/notify-call AND /api/notify-chat
 *
 * Body: { type: "call" | "chat", ...fields }
 *
 * type "call":
 *   action: "incoming" → notify recipient of incoming call
 *   action: "missed"   → notify recipient of missed call
 *   callId, callerId, callerName, recipientId, isVideo
 *
 * type "chat":
 *   machineId, senderId, senderName, message, recipientIds[]
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleCors } from "../lib/cors";
import {
  notifyIncomingVoiceCall,
  notifyIncomingVideoCall,
  notifyMissedCall,
  notifyChatMessage,
  storeNotification,
} from "../lib/fcm";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (handleCors(req, res)) return;

  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "Method not allowed" });
    return;
  }

  const { type } = req.body;

  try {
    // ── CALL NOTIFICATIONS ────────────────────────────────────────────────
    if (type === "call") {
      const {
        action,
        callId,
        callerId,
        callerName,
        callerAvatar,
        recipientId,
        isVideo,
      } = req.body as {
        action: string;
        callId: string;
        callerId: string;
        callerName: string;
        callerAvatar?: string;
        recipientId: string;
        isVideo: boolean;
      };

      if (!callerId || !callerName || !recipientId) {
        res.status(400).json({ success: false, error: "Missing required call fields" });
        return;
      }

      // ── incoming call ──
      if (action === "incoming") {
        if (!callId) {
          res.status(400).json({ success: false, error: "callId required for incoming" });
          return;
        }

        // Store notification in Firestore (for in-app overlay detection)
        await storeNotification(
          recipientId,
          isVideo ? "video_call" : "voice_call",
          isVideo ? "📹 Incoming Video Call" : "📞 Incoming Call",
          `${callerName} is ${isVideo ? "video " : ""}calling you`,
          { callId, callerId, callerName, callType: isVideo ? "video" : "voice" }
        );

        // Send push notification
        const sent = isVideo
          ? await notifyIncomingVideoCall(recipientId, callerName, callId, callerId, callerAvatar)
          : await notifyIncomingVoiceCall(recipientId, callerName, callId, callerId, callerAvatar);

        res.status(200).json({
          success: true,
          message: "Incoming call notification sent",
          data: { sent, stored: true },
        });
        return;
      }

      // ── missed call ──
      if (action === "missed") {
        const sent = await notifyMissedCall(recipientId, callerName, isVideo);
        res.status(200).json({ success: true, message: "Missed call notification sent", data: { sent, stored: true } });
        return;
      }

      // ── cancelled call (caller cancelled before answer) ──
      if (action === "cancelled") {
        await sendAndStoreNotification({
          userId:   recipientId,
          type:     isVideo ? 'missed_video' : 'missed_call',
          title:    isVideo ? '📹 Missed Video Call' : '📞 Missed Call',
          body:     `${callerName} cancelled a call`,
          data:     { callerId, callerName, type: isVideo ? 'missed_video' : 'missed_call' },
          priority: 'normal',
        });
        res.status(200).json({ success: true, message: "Cancelled call notification sent", data: { sent: true, stored: true } });
        return;
      }

      // ── ended call (for call history notification) ──
      if (action === "ended") {
        // No push notification for ended — UI handles this via real-time Firestore
        res.status(200).json({ success: true, message: "Ended call (no push)", data: { sent: false, stored: false } });
        return;
      }

      res.status(400).json({ success: false, error: "Invalid action. Use 'incoming', 'missed', 'cancelled', or 'ended'" });
      return;
    }

    // ── CHAT NOTIFICATIONS ────────────────────────────────────────────────
    if (type === "chat") {
      const {
        machineId,
        senderId,
        senderName,
        message,
        recipientIds,
      } = req.body as {
        machineId: string;
        senderId: string;
        senderName: string;
        message: string;
        recipientIds: string[];
      };

      if (!senderId || !senderName || !message || !recipientIds?.length) {
        res.status(400).json({ success: false, error: "Missing required chat fields" });
        return;
      }

      // Send push + store in Firestore (NotificationPopup listens to Firestore)
      const results = await Promise.allSettled(
        recipientIds.map(async (recipientId: string) => {
          const truncated = message.length > 50 ? message.substring(0, 50) + "..." : message;
          await Promise.all([
            notifyChatMessage(recipientId, senderName, message, machineId),
            storeNotification(
              recipientId,
              "chat_message",
              `💬 ${senderName}`,
              truncated,
              // Extra fields so NotificationPopup can navigate to the right chat
              { machineId: machineId || "", senderId, senderName }
            ),
          ]);
        })
      );

      const successful = results.filter((r) => r.status === "fulfilled").length;

      res.status(200).json({
        success: true,
        message: `Chat notification sent to ${successful}/${recipientIds.length} recipients`,
        data: { sent: successful > 0, notificationId: "batch" },
      });
      return;
    }

    res.status(400).json({ success: false, error: "Invalid type. Use 'call' or 'chat'" });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[notify] Error:", err);
    res.status(500).json({ success: false, error: "Internal server error", message });
  }
}