// src/routes/baileys.routes.ts
// Routes API pour Baileys

import { Router, Request, Response } from 'express';
import { baileysManager } from '../whatsapp/baileys.manager';

const router = Router();

// POST /api/baileys/session - Créer/reconnecter une session
router.post('/session', async (req: Request, res: Response) => {
  try {
    const { agency_id } = req.body;

    if (!agency_id) {
      return res.status(400).json({ error: 'Missing agency_id' });
    }

    console.log(`[API] Creating session for agency ${agency_id}`);
    const result = await baileysManager.createSession(agency_id);

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
