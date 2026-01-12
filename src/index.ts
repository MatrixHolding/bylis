// src/index.ts
// Point d'entrée pour le serveur Baileys (bylis)

import express from 'express';
import baileysRoutes from './routes/baileys.routes';

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
    description: 'Baileys WhatsApp Gateway for AIOD',
    version: '1.0.0',
    endpoints: {
      health: 'GET /api/baileys/health',
      createSession: 'POST /api/baileys/session',
      getSession: 'GET /api/baileys/session/:agencyId',
      deleteSession: 'DELETE /api/baileys/session/:agencyId',
      sendMessage: 'POST /api/baileys/send'
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`[BYLIS] Server running on port ${PORT}`);
  console.log(`[BYLIS] Environment: ${process.env.NODE_ENV || 'development'}`);
});
