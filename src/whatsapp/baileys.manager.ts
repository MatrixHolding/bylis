// src/whatsapp/baileys.manager.ts
// Gestion des sessions Baileys (WhatsApp Web)
// Supports both AIOD (agencies table) and WakhaFlow (stores table)

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  BaileysEventMap,
  ConnectionState,
  proto
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import QRCode from 'qrcode';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const logger = pino({ level: 'warn' });

// Supported projects
type Project = 'aiod' | 'wakhaflow';

interface Session {
  socket: WASocket | null;
  qrCode: string | null;
  status: 'pending' | 'connecting' | 'connected' | 'disconnected';
  phoneNumber: string | null;
  verifiedName: string | null;
  createdAt: Date;
  project: Project;
  webhookUrl: string | null;
}

class BaileysManager {
  private sessions: Map<string, Session> = new Map();
  private supabase: SupabaseClient;
  private authDir: string;

  constructor() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    }

    this.supabase = createClient(supabaseUrl, supabaseKey);
    this.authDir = process.env.BAILEYS_AUTH_DIR || './data/baileys';

    // Ensure auth directory exists
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }
  }

  // Create or reconnect session for agency/store
  // project: 'aiod' (default) or 'wakhaflow'
  async createSession(
    agencyId: string,
    options: { project?: Project; webhookUrl?: string } = {}
  ): Promise<{ sessionId: string; qrCode: string | null; status: string }> {
    const project = options.project || 'aiod';
    const webhookUrl = options.webhookUrl || null;

    // Check if entity exists based on project
    let entityExists = false;

    if (project === 'wakhaflow') {
      // For WakhaFlow, check stores table
      const { data: store, error } = await this.supabase
        .from('stores')
        .select('id, name')
        .eq('id', agencyId)
        .single();

      entityExists = !error && !!store;

      if (!entityExists) {
        // Auto-register: WakhaFlow doesn't require pre-registration
        // Just verify the ID format is valid (UUID)
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(agencyId)) {
          console.log(`[BAILEYS] Auto-accepting WakhaFlow store: ${agencyId}`);
          entityExists = true;
        }
      }
    } else {
      // For AIOD, check agencies table (original behavior)
      const { data: agency, error } = await this.supabase
        .from('agencies')
        .select('id, name')
        .eq('id', agencyId)
        .single();

      entityExists = !error && !!agency;
    }

    if (!entityExists) {
      throw new Error(project === 'wakhaflow' ? 'Store not found' : 'Agency not found');
    }

    const sessionId = `baileys_${agencyId}`;
    const authPath = path.join(this.authDir, agencyId);

    // Ensure auth path exists
    if (!fs.existsSync(authPath)) {
      fs.mkdirSync(authPath, { recursive: true });
    }

    // Initialize session object
    const session: Session = {
      socket: null,
      qrCode: null,
      status: 'pending',
      phoneNumber: null,
      verifiedName: null,
      createdAt: new Date(),
      project,
      webhookUrl
    };

    this.sessions.set(agencyId, session);

    // Setup auth state
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    // Create socket with browser name based on project
    const browserName = project === 'wakhaflow' ? 'WakhaFlow' : 'AIOD';
    const socket = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: logger as any,
      browser: [browserName, 'Chrome', '120.0.0']
    });

    session.socket = socket;

    // Handle connection events
    socket.ev.on('connection.update', async (update) => {
      await this.handleConnectionUpdate(agencyId, update);
    });

    // Handle credentials update
    socket.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    socket.ev.on('messages.upsert', async (m) => {
      await this.handleMessagesUpsert(agencyId, m);
    });

    // Wait for QR code or connection
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const currentSession = this.sessions.get(agencyId);
        if (currentSession) {
          if (currentSession.qrCode || currentSession.status === 'connected') {
            clearInterval(checkInterval);
            resolve({
              sessionId,
              qrCode: currentSession.qrCode,
              status: currentSession.status
            });
          }
        }
      }, 500);

      // Timeout after 30 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        const currentSession = this.sessions.get(agencyId);
        resolve({
          sessionId,
          qrCode: currentSession?.qrCode || null,
          status: currentSession?.status || 'pending'
        });
      }, 30000);
    });
  }

  // Handle connection updates
  private async handleConnectionUpdate(agencyId: string, update: Partial<ConnectionState>) {
    const session = this.sessions.get(agencyId);
    if (!session) return;

    const { connection, lastDisconnect, qr } = update;

    // Log event to Supabase
    await this.logEvent(agencyId, 'connection.update', update);

    // QR Code received
    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        session.qrCode = qrDataUrl;
        session.status = 'pending';
        console.log(`[BAILEYS] QR generated for agency ${agencyId}`);

        // Update session in DB
        await this.updateSessionInDB(agencyId, {
          status: 'pending',
          qr_code: qrDataUrl
        });
      } catch (err) {
        console.error('[BAILEYS] QR generation error:', err);
      }
    }

    // Connection status
    if (connection === 'close') {
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;

      console.log(`[BAILEYS] Connection closed for ${agencyId}, reason: ${reason}`);
      session.status = 'disconnected';

      await this.updateSessionInDB(agencyId, {
        status: 'disconnected',
        disconnected_at: new Date().toISOString()
      });

      if (shouldReconnect) {
        console.log(`[BAILEYS] Reconnecting ${agencyId}...`);
        setTimeout(() => this.createSession(agencyId), 5000);
      }
    } else if (connection === 'open') {
      console.log(`[BAILEYS] Connected for ${session.project} entity ${agencyId}`);
      session.status = 'connected';
      session.qrCode = null;

      // Get phone number from socket
      const phoneNumber = session.socket?.user?.id?.split(':')[0] || null;
      const verifiedName = session.socket?.user?.name || null;

      session.phoneNumber = phoneNumber;
      session.verifiedName = verifiedName;

      // Update the appropriate table based on project
      if (session.project === 'wakhaflow') {
        // Update WakhaFlow stores table
        await this.supabase
          .from('stores')
          .update({
            bylis_session_id: agencyId,
            bylis_phone: phoneNumber ? `+${phoneNumber}` : null,
            bylis_status: 'connected'
          })
          .eq('id', agencyId);
      } else {
        // Update AIOD agencies table (original behavior)
        await this.supabase
          .from('agencies')
          .update({
            whatsapp_phone_id: phoneNumber,
            whatsapp_connection_type: 'baileys',
            whatsapp_connected_at: new Date().toISOString()
          })
          .eq('id', agencyId);
      }

      await this.updateSessionInDB(agencyId, {
        status: 'connected',
        phone_number: phoneNumber,
        verified_name: verifiedName,
        connected_at: new Date().toISOString(),
        project: session.project
      });
    }
  }

  // Handle incoming messages
  private async handleMessagesUpsert(agencyId: string, m: { messages: proto.IWebMessageInfo[], type: string }) {
    const session = this.sessions.get(agencyId);

    for (const msg of m.messages) {
      if (msg.key.fromMe) continue; // Skip outgoing messages

      const from = msg.key.remoteJid || '';
      const messageId = msg.key.id || '';
      const text = msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '';

      console.log(`[BAILEYS] Message from ${from}: ${text.substring(0, 50)}`);

      // Log to events table
      await this.logEvent(agencyId, 'messages.upsert', msg);

      // Store inbound message based on project
      if (session?.project === 'wakhaflow') {
        // WakhaFlow uses different message structure
        // Messages are stored via webhook, not directly here
      } else {
        // AIOD stores messages directly
        await this.supabase.from('messages').insert({
          agency_id: agencyId,
          wa_message_id: messageId,
          sender: 'client',
          content: text,
          raw_payload: msg,
          created_at: new Date().toISOString()
        }).then(({ error }) => {
          if (error) console.error('[BAILEYS] Message insert error:', error);
        });
      }

      // Forward to appropriate webhook
      try {
        if (session?.webhookUrl) {
          // Use custom webhook URL if provided
          await fetch(session.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source: 'baileys',
              project: session.project,
              store_id: session.project === 'wakhaflow' ? agencyId : undefined,
              agency_id: session.project === 'aiod' ? agencyId : undefined,
              message: {
                id: messageId,
                from: from.replace('@s.whatsapp.net', ''),
                text: text,
                timestamp: msg.messageTimestamp,
                type: msg.message?.imageMessage ? 'image' : 'text'
              }
            })
          });
        } else {
          // Fallback to Supabase function invoke
          await this.supabase.functions.invoke('webhook-whatsapp-messages', {
            body: {
              source: 'baileys',
              project: session?.project || 'aiod',
              store_id: session?.project === 'wakhaflow' ? agencyId : undefined,
              agency_id: agencyId,
              message: {
                id: messageId,
                from: from.replace('@s.whatsapp.net', ''),
                text: text,
                timestamp: msg.messageTimestamp,
                type: msg.message?.imageMessage ? 'image' : 'text'
              }
            }
          });
        }
      } catch (err) {
        console.error('[BAILEYS] Forward to webhook error:', err);
      }
    }
  }

  // Send message
  async sendMessage(agencyId: string, to: string, text: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const session = this.sessions.get(agencyId);

    if (!session || session.status !== 'connected' || !session.socket) {
      return { success: false, error: 'Session not connected' };
    }

    try {
      // Normalize phone number
      const jid = to.replace(/[^0-9]/g, '') + '@s.whatsapp.net';

      const result = await session.socket.sendMessage(jid, { text });

      console.log(`[BAILEYS] Message sent to ${to}`);

      // Log event
      await this.logEvent(agencyId, 'message.sent', { to, text: text.substring(0, 100), messageId: result?.key?.id });

      return { success: true, messageId: result?.key?.id || undefined };
    } catch (error: any) {
      console.error('[BAILEYS] Send message error:', error);
      return { success: false, error: error.message };
    }
  }

  // Get session status
  getSessionStatus(agencyId: string): { status: string; phoneNumber: string | null; verifiedName: string | null; qrCode: string | null } {
    const session = this.sessions.get(agencyId);

    if (!session) {
      return { status: 'not_found', phoneNumber: null, verifiedName: null, qrCode: null };
    }

    return {
      status: session.status,
      phoneNumber: session.phoneNumber,
      verifiedName: session.verifiedName,
      qrCode: session.qrCode
    };
  }

  // Log event to Supabase
  private async logEvent(agencyId: string, eventType: string, data: any) {
    try {
      await this.supabase.from('whatsapp_events').insert({
        agency_id: agencyId,
        source: 'baileys',
        event_type: eventType,
        raw_json: data,
        created_at: new Date().toISOString()
      });
    } catch (err) {
      // Table may not exist, log but continue
      console.warn('[BAILEYS] Event log warning:', err);
    }
  }

  // Update session in DB
  private async updateSessionInDB(agencyId: string, data: Record<string, any>) {
    try {
      await this.supabase.from('whatsapp_sessions').upsert({
        agency_id: agencyId,
        ...data,
        updated_at: new Date().toISOString()
      }, { onConflict: 'agency_id' });
    } catch (err) {
      console.warn('[BAILEYS] Session update warning:', err);
    }
  }

  // Disconnect session
  async disconnectSession(agencyId: string): Promise<void> {
    const session = this.sessions.get(agencyId);
    if (session?.socket) {
      await session.socket.logout();
      this.sessions.delete(agencyId);
    }
  }
}

export const baileysManager = new BaileysManager();
