// src/index.ts
// Point d'entrée pour le serveur Baileys (bylis)

import express from 'express';
import baileysRoutes from './routes/baileys.routes';

console.log('=============================================');
console.log('[BYLIS] Starting Baileys WhatsApp Gateway...');
console.log(`[BYLIS] Node version: ${process.version}`);
console.log(`[BYLIS] Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`[BYLIS] Time: ${new Date().toISOString()}`);
console.log('=============================================');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// CORS simple
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Routes
app.use('/api/baileys', baileysRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'bylis',
    description: 'Baileys WhatsApp Gateway for AIOD & WakhaFlow',
    version: '1.1.0',
    supportedProjects: ['aiod', 'wakhaflow'],
    endpoints: {
      health: 'GET /api/baileys/health',
      createSession: 'POST /api/baileys/session (body: agency_id OR store_id, optional: project, webhook_url)',
      getSession: 'GET /api/baileys/session/:entityId',
      deleteSession: 'DELETE /api/baileys/session/:entityId',
      sendMessage: 'POST /api/baileys/send'
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log('=============================================');
  console.log(`[BYLIS] Server running on port ${PORT}`);
  console.log(`[BYLIS] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[BYLIS] Supabase URL: ${process.env.SUPABASE_URL ? 'configured' : 'MISSING!'}`);
  console.log(`[BYLIS] Supabase Key: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'configured' : 'MISSING!'}`);
  console.log(`[BYLIS] Auth Dir: ${process.env.BAILEYS_AUTH_DIR || './data/baileys'}`);
  console.log('=============================================');
  console.log('[BYLIS] Ready to handle WhatsApp sessions!');
});
