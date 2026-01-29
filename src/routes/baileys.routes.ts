// src/routes/baileys.routes.ts
// Routes API pour Baileys

import { Router, Request, Response } from 'express';
import { baileysManager } from '../whatsapp/baileys.manager';

const router = Router();

// POST /api/baileys/session - Créer/reconnecter une session
// Supports both AIOD (agencies) and WakhaFlow (stores)
router.post('/session', async (req: Request, res: Response) => {
  try {
    const { agency_id, store_id, project, webhook_url, force_new_qr } = req.body;

    // Support both agency_id (AIOD) and store_id (WakhaFlow)
    const entityId = store_id || agency_id;
    const detectedProject = store_id ? 'wakhaflow' : (project || 'aiod');

    if (!entityId) {
      console.log('[API] Missing entity ID');
      return res.status(400).json({ error: 'Missing agency_id or store_id' });
    }

    console.log(`[API] === SESSION CREATE REQUEST ===`);
    console.log(`[API] Entity ID: ${entityId}`);
    console.log(`[API] Project: ${detectedProject}`);
    console.log(`[API] Force new QR: ${force_new_qr || false}`);
    console.log(`[API] Webhook URL: ${webhook_url || 'none'}`);

    const result = await baileysManager.createSession(entityId, {
      project: detectedProject as 'aiod' | 'wakhaflow',
      webhookUrl: webhook_url,
      forceNewQR: force_new_qr === true
    });

    console.log(`[API] Session created:`, {
      sessionId: result.sessionId,
      status: result.status,
      hasQR: !!result.qrCode
    });

    res.json(result);
  } catch (error: any) {
    console.error('[API] Session error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/baileys/session/:agencyId - Obtenir le statut d'une session
router.get('/session/:agencyId', (req: Request, res: Response) => {
  try {
    const { agencyId } = req.params;
    const status = baileysManager.getSessionStatus(agencyId);
    res.json(status);
  } catch (error: any) {
    console.error('[API] Status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/baileys/session/:agencyId - Déconnecter une session
router.delete('/session/:agencyId', async (req: Request, res: Response) => {
  try {
    const { agencyId } = req.params;
    await baileysManager.disconnectSession(agencyId);
    res.json({ success: true, message: 'Session disconnected' });
  } catch (error: any) {
    console.error('[API] Disconnect error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/baileys/send - Envoyer un message
router.post('/send', async (req: Request, res: Response) => {
  try {
    const { agency_id, to, text } = req.body;

    if (!agency_id || !to || !text) {
      return res.status(400).json({ error: 'Missing agency_id, to, or text' });
    }

    console.log(`[API] Sending message from ${agency_id} to ${to}`);
    const result = await baileysManager.sendMessage(agency_id, to, text);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: any) {
    console.error('[API] Send error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/baileys/health - Health check
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'bylis',
    timestamp: new Date().toISOString()
  });
});

export default router;
