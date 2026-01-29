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
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

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

// Store last N log entries for debugging
const debugLogs: { timestamp: string; message: string; data?: any }[] = [];
const MAX_DEBUG_LOGS = 100;

function debugLog(message: string, data?: any) {
  const entry = {
    timestamp: new Date().toISOString(),
    message,
    data
  };
  debugLogs.push(entry);
  if (debugLogs.length > MAX_DEBUG_LOGS) {
    debugLogs.shift();
  }
  console.log(`[BAILEYS] ${message}`, data ? JSON.stringify(data) : '');
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
    debugLog(`Creating WASocket with browser: ${browserName}`);
    debugLog(`makeWASocket START`);

    // Setup proxy if configured
    // Supports: SOCKS5 (socks5://host:port) or HTTPS (https://host:port)
    const proxyUrl = process.env.PROXY_URL;
    let agent: any = undefined;
    let fetchAgent: any = undefined;

    if (proxyUrl) {
      debugLog(`Using proxy: ${proxyUrl.replace(/:[^:@]+@/, ':***@')}`); // Hide password in logs
      if (proxyUrl.startsWith('socks')) {
        agent = new SocksProxyAgent(proxyUrl);
        fetchAgent = new SocksProxyAgent(proxyUrl);
      } else {
        agent = new HttpsProxyAgent(proxyUrl);
        fetchAgent = new HttpsProxyAgent(proxyUrl);
      }
    } else {
      debugLog(`No proxy configured - using direct connection`);
    }

    // FIX for 405 error: Hardcode WhatsApp version to avoid version mismatch
    // See: https://github.com/WhiskeySockets/Baileys/issues/1939
    const WHATSAPP_VERSION: [number, number, number] = [2, 3000, 1027934701];

    let socket: WASocket;
    try {
      socket = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: logger as any,
        browser: [browserName, 'Chrome', '120.0.0'],
        version: WHATSAPP_VERSION,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        qrTimeout: 60000,
        retryRequestDelayMs: 500,
        markOnlineOnConnect: false,
        agent,
        fetchAgent
      });

      debugLog(`makeWASocket DONE`, { socketType: typeof socket, hasEv: !!socket?.ev });
      session.socket = socket;

      // Handle connection events
      debugLog(`Attaching connection.update listener`);
      socket.ev.on('connection.update', async (update) => {
        debugLog(`EVENT: connection.update`, update);
        await this.handleConnectionUpdate(agencyId, update);
      });

      // Handle credentials update
      socket.ev.on('creds.update', () => {
        debugLog(`EVENT: creds.update`);
        saveCreds();
      });

      // Handle incoming messages
      socket.ev.on('messages.upsert', async (m) => {
        await this.handleMessagesUpsert(agencyId, m);
      });

      debugLog(`All event listeners attached successfully`);

    } catch (socketError: any) {
      console.error(`[BAILEYS] Socket creation FAILED:`, socketError);
      console.error(`[BAILEYS] Error stack:`, socketError.stack);
      session.status = 'disconnected';
      throw new Error(`Failed to create WhatsApp socket: ${socketError.message}`);
    }

    // Wait for QR code or connection
    // Note: We DON'T resolve on 'disconnected' as Baileys may reconnect and generate QR
    console.log(`[BAILEYS] Waiting for QR code or connection (max 90s)...`);
    return new Promise((resolve) => {
      let resolved = false;
      let pollCount = 0;
      const maxPolls = 90; // 90 seconds with 1s interval

      const checkInterval = setInterval(() => {
        pollCount++;
        const currentSession = this.sessions.get(agencyId);

        if (currentSession && !resolved) {
          // Only log every 5 polls to reduce noise
          if (pollCount % 5 === 0) {
            console.log(`[BAILEYS] Polling #${pollCount}: status=${currentSession.status}, hasQR=${!!currentSession.qrCode}`);
          }

          // SUCCESS: Got QR code or connected
          if (currentSession.qrCode) {
            resolved = true;
            clearInterval(checkInterval);
            console.log(`[BAILEYS] SUCCESS - Got QR code after ${pollCount}s`);
            resolve({
              sessionId,
              qrCode: currentSession.qrCode,
              status: 'pending'
            });
          } else if (currentSession.status === 'connected') {
            resolved = true;
            clearInterval(checkInterval);
            console.log(`[BAILEYS] SUCCESS - Connected after ${pollCount}s`);
            resolve({
              sessionId,
              qrCode: null,
              status: 'connected'
            });
          }

          // Max polls reached
          if (pollCount >= maxPolls && !resolved) {
            resolved = true;
            clearInterval(checkInterval);
            console.log(`[BAILEYS] TIMEOUT after ${pollCount}s - Final state: status=${currentSession.status}`);
            resolve({
              sessionId,
              qrCode: currentSession.qrCode || null,
              status: currentSession.status || 'timeout'
            });
          }
        }
      }, 1000);

      // Safety timeout after 95 seconds
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          clearInterval(checkInterval);
          const currentSession = this.sessions.get(agencyId);
          console.log(`[BAILEYS] SAFETY TIMEOUT - status=${currentSession?.status}`);
          resolve({
            sessionId,
            qrCode: currentSession?.qrCode || null,
            status: currentSession?.status || 'timeout'
          });
        }
      }, 95000);
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
      const errorMessage = (lastDisconnect?.error as Error)?.message;
      const errorStack = (lastDisconnect?.error as Error)?.stack;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;

      debugLog(`=== CONNECTION CLOSED ===`, {
        agencyId,
        reason,
        errorMessage,
        errorStack: errorStack?.substring(0, 500),
        disconnectReasons: {
          loggedOut: DisconnectReason.loggedOut,
          restartRequired: DisconnectReason.restartRequired,
          connectionClosed: DisconnectReason.connectionClosed,
          connectionLost: DisconnectReason.connectionLost,
          connectionReplaced: DisconnectReason.connectionReplaced,
          timedOut: DisconnectReason.timedOut,
          badSession: DisconnectReason.badSession
        },
        shouldReconnect
      });
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

  // Get debug logs
  getDebugLogs(limit: number = 50): typeof debugLogs {
    return debugLogs.slice(-limit);
  }

  // Get all sessions info
  getAllSessions(): { id: string; status: string; project: string; createdAt: Date }[] {
    const result: { id: string; status: string; project: string; createdAt: Date }[] = [];
    this.sessions.forEach((session, id) => {
      result.push({
        id,
        status: session.status,
        project: session.project,
        createdAt: session.createdAt
      });
    });
    return result;
  }
}

export const baileysManager = new BaileysManager();
