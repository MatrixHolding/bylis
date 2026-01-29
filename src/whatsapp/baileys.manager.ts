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

// Always use debug level for better visibility
const logger = pino({ level: 'debug' });

console.log('[BAILEYS] Module loaded - Baileys Manager initializing...');

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
  // forceNewQR: true to clear existing auth and generate fresh QR
  async createSession(
    agencyId: string,
    options: { project?: Project; webhookUrl?: string; forceNewQR?: boolean } = {}
  ): Promise<{ sessionId: string; qrCode: string | null; status: string }> {
    const project = options.project || 'aiod';
    const webhookUrl = options.webhookUrl || null;
    const forceNewQR = options.forceNewQR ?? false;

    console.log(`[BAILEYS] === createSession START ===`);
    console.log(`[BAILEYS] Entity ID: ${agencyId}`);
    console.log(`[BAILEYS] Project: ${project}`);
    console.log(`[BAILEYS] Force new QR: ${forceNewQR}`);
    console.log(`[BAILEYS] Webhook URL: ${webhookUrl || 'none'}`);

    // Check if entity exists based on project
    let entityExists = false;

    if (project === 'wakhaflow') {
      // For WakhaFlow, we auto-accept any valid UUID
      // WakhaFlow has its own Supabase instance, so we can't check stores table from here
      // The WakhaFlow edge function already validated the store exists before calling us
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRegex.test(agencyId)) {
        console.log(`[BAILEYS] Auto-accepting WakhaFlow store: ${agencyId}`);
        entityExists = true;
      } else {
        console.log(`[BAILEYS] Invalid store_id format: ${agencyId}`);
      }
    } else {
      // For AIOD, check agencies table (original behavior)
      const { data: agency, error } = await this.supabase
        .from('agencies')
        .select('id, name')
        .eq('id', agencyId)
        .single();

      entityExists = !error && !!agency;
      if (error) {
        console.log(`[BAILEYS] Agency lookup error: ${error.message}`);
      }
    }

    if (!entityExists) {
      console.log(`[BAILEYS] Entity not found, throwing error`);
      throw new Error(project === 'wakhaflow' ? 'Invalid store_id format' : 'Agency not found');
    }

    const sessionId = `baileys_${agencyId}`;
    const authPath = path.join(this.authDir, agencyId);

    // IMPORTANT: Cleanup existing session first
    const existingSession = this.sessions.get(agencyId);
    if (existingSession) {
      console.log(`[BAILEYS] Cleaning up existing session for ${agencyId}`);
      try {
        if (existingSession.socket) {
          existingSession.socket.ev.removeAllListeners('connection.update');
          existingSession.socket.ev.removeAllListeners('creds.update');
          existingSession.socket.ev.removeAllListeners('messages.upsert');
          existingSession.socket.end(undefined);
        }
      } catch (e) {
        console.log(`[BAILEYS] Cleanup error (ignored): ${e}`);
      }
      this.sessions.delete(agencyId);
    }

    // If forceNewQR, clear existing auth state
    if (forceNewQR && fs.existsSync(authPath)) {
      console.log(`[BAILEYS] Clearing existing auth state for fresh QR`);
      try {
        fs.rmSync(authPath, { recursive: true, force: true });
      } catch (e) {
        console.log(`[BAILEYS] Auth cleanup error: ${e}`);
      }
    }

    // Ensure auth path exists
    if (!fs.existsSync(authPath)) {
      console.log(`[BAILEYS] Creating auth directory: ${authPath}`);
      fs.mkdirSync(authPath, { recursive: true });
    }

    // Check if auth already exists (will reconnect instead of QR)
    const authFiles = fs.readdirSync(authPath);
    const hasExistingAuth = authFiles.length > 0;
    console.log(`[BAILEYS] Auth directory contents: ${authFiles.length} files`);
    console.log(`[BAILEYS] Has existing auth: ${hasExistingAuth}`);

    // Initialize session object
    const session: Session = {
      socket: null,
      qrCode: null,
      status: 'connecting',
      phoneNumber: null,
      verifiedName: null,
      createdAt: new Date(),
      project,
      webhookUrl
    };

    this.sessions.set(agencyId, session);

    // Setup auth state
    console.log(`[BAILEYS] Setting up auth state...`);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    console.log(`[BAILEYS] Auth state loaded`);

    // Create socket with browser name based on project
    const browserName = project === 'wakhaflow' ? 'WakhaFlow' : 'AIOD';
    console.log(`[BAILEYS] Creating WASocket with browser: ${browserName}`);

    try {
      const socket = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: logger as any,
        browser: [browserName, 'Chrome', '120.0.0']
      });

      session.socket = socket;
      console.log(`[BAILEYS] Socket created successfully`);

      // Handle connection events
      socket.ev.on('connection.update', async (update) => {
        console.log(`[BAILEYS] connection.update event:`, JSON.stringify(update, null, 2));
        await this.handleConnectionUpdate(agencyId, update);
      });

      // Handle credentials update
      socket.ev.on('creds.update', () => {
        console.log(`[BAILEYS] creds.update event - saving credentials`);
        saveCreds();
      });

      // Handle incoming messages
      socket.ev.on('messages.upsert', async (m) => {
        await this.handleMessagesUpsert(agencyId, m);
      });

    } catch (socketError: any) {
      console.error(`[BAILEYS] Socket creation FAILED:`, socketError);
      session.status = 'disconnected';
      throw new Error(`Failed to create WhatsApp socket: ${socketError.message}`);
    }

    // Wait for QR code or connection
    console.log(`[BAILEYS] Waiting for QR code or connection (max 90s)...`);
    return new Promise((resolve) => {
      let resolved = false;

      const checkInterval = setInterval(() => {
        const currentSession = this.sessions.get(agencyId);
        if (currentSession && !resolved) {
          console.log(`[BAILEYS] Polling: status=${currentSession.status}, hasQR=${!!currentSession.qrCode}`);

          if (currentSession.qrCode || currentSession.status === 'connected') {
            resolved = true;
            clearInterval(checkInterval);
            console.log(`[BAILEYS] Resolving with status: ${currentSession.status}`);
            resolve({
              sessionId,
              qrCode: currentSession.qrCode,
              status: currentSession.status
            });
          }
        }
      }, 1000); // Check every 1 second instead of 500ms

      // Timeout after 90 seconds (increased from 60)
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          clearInterval(checkInterval);
          const currentSession = this.sessions.get(agencyId);
          console.log(`[BAILEYS] TIMEOUT - Resolving with current state: status=${currentSession?.status}, hasQR=${!!currentSession?.qrCode}`);
          resolve({
            sessionId,
            qrCode: currentSession?.qrCode || null,
            status: currentSession?.status || 'timeout'
          });
        }
      }, 90000);
    });
  }

  // Handle connection updates
  private async handleConnectionUpdate(agencyId: string, update: Partial<ConnectionState>) {
    const session = this.sessions.get(agencyId);
    if (!session) {
      console.log(`[BAILEYS] handleConnectionUpdate: No session found for ${agencyId}`);
      return;
    }

    const { connection, lastDisconnect, qr } = update;
    console.log(`[BAILEYS] handleConnectionUpdate for ${agencyId}:`, {
      connection,
      hasQR: !!qr,
      qrLength: qr?.length,
      lastDisconnectReason: (lastDisconnect?.error as Boom)?.output?.statusCode
    });

    // Log event to Supabase (non-blocking)
    this.logEvent(agencyId, 'connection.update', update).catch(e =>
      console.log(`[BAILEYS] Event log error (ignored): ${e}`)
    );

    // QR Code received
    if (qr) {
      console.log(`[BAILEYS] === QR CODE RECEIVED ===`);
      console.log(`[BAILEYS] QR string length: ${qr.length}`);
      console.log(`[BAILEYS] QR preview: ${qr.substring(0, 50)}...`);

      try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        session.qrCode = qrDataUrl;
        session.status = 'pending';
        console.log(`[BAILEYS] QR DataURL generated successfully (length: ${qrDataUrl.length})`);
        console.log(`[BAILEYS] QR DataURL preview: ${qrDataUrl.substring(0, 80)}...`);

        // Update session in DB (non-blocking)
        this.updateSessionInDB(agencyId, {
          status: 'pending',
          qr_code: qrDataUrl
        }).catch(e => console.log(`[BAILEYS] Session DB update error: ${e}`));
      } catch (err: any) {
        console.error('[BAILEYS] QR generation FAILED:', err);
        console.error('[BAILEYS] QR generation error details:', err.stack || err.message);
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
        console.log(`[BAILEYS] Reconnecting ${agencyId} (project: ${session.project})...`);
        // Clean up old socket to prevent memory leak
        if (session.socket) {
          try {
            session.socket.end(undefined);
          } catch (e) {
            // Ignore cleanup errors
          }
          session.socket = null;
        }
        // Pass the same project and webhook options for reconnection
        setTimeout(() => this.createSession(agencyId, {
          project: session.project,
          webhookUrl: session.webhookUrl || undefined
        }), 5000);
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
        // For WakhaFlow, notify via webhook instead of direct DB update
        // (WakhaFlow uses a different Supabase instance)
        if (session.webhookUrl) {
          try {
            await fetch(session.webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                source: 'baileys',
                type: 'connection_update',
                project: 'wakhaflow',
                store_id: agencyId,
                status: 'connected',
                phone_number: phoneNumber ? `+${phoneNumber}` : null
              })
            });
            console.log(`[BAILEYS] Notified WakhaFlow of connection for ${agencyId}`);
          } catch (err) {
            console.error('[BAILEYS] Failed to notify WakhaFlow:', err);
          }
        }
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
