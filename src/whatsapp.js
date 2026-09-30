import whatsapp from 'whatsapp-web.js';
import QRCode from 'qrcode';
const { Client, LocalAuth } = whatsapp;
export class WhatsApp {
  constructor(dataDir) { this.dataDir=dataDir; this.status='starting'; this.qr=null; this.client=null; this.starting=false; }
  async start() {
    if(this.starting) return;
    this.starting=true; this.status='starting'; this.qr=null;
    try {
      if(this.client) { this.client.removeAllListeners(); await this.client.destroy().catch(()=>{}); }
      const client = new Client({authStrategy:new LocalAuth({dataPath:`${this.dataDir}/session`}), webVersionCache:{type:'local',path:`${this.dataDir}/web-cache`}, puppeteer:{headless:true, executablePath:process.env.CHROMIUM_PATH || undefined, args:process.env.CHROMIUM_NO_SANDBOX==='true'?['--no-sandbox']:[]}});
      this.client=client;
      client.on('qr',qr=>{ this.status='qr'; this.qr=qr; });
      client.on('authenticated',()=>{ this.status='authenticated'; this.qr=null; });
      client.on('ready',()=>{ this.status='ready'; this.qr=null; });
      client.on('auth_failure',()=>{ this.status='auth_failure'; this.qr=null; });
      client.on('disconnected',()=>{ this.status='disconnected'; this.qr=null; });
      await client.initialize();
    } catch(error) { this.status='error'; console.error('WhatsApp:',error.message); }
    finally { this.starting=false; }
  }
  async state() { return {status:this.status,qr:this.qr?await QRCode.toDataURL(this.qr):null}; }
  async groups() {
    if(this.status!=='ready') throw new Error('WhatsApp no está conectado. Vincula la cuenta antes de guardar los grupos.');
    try {
      // Leer únicamente nombres e IDs: getChats serializa también contactos y
      // participantes, que pueden fallar aunque el grupo esté disponible.
      return await this.client.pupPage.evaluate(() => {
        const chats = window.require('WAWebCollections').Chat.getModelsArray();
        return chats.filter(c => c.id?._serialized?.endsWith('@g.us')).map(c => ({
          id:c.id._serialized, name:String(c.name || c.formattedTitle || c.groupMetadata?.subject || '')
        }));
      });
    } catch(error) {
      console.error('Consulta de nombres de grupos:', error?.message || String(error));
      throw new Error('No se pudieron consultar los nombres de WhatsApp. Espera a que termine de sincronizar o reconecta la cuenta.');
    }
  }
  async send(destination,message) { if(this.status!=='ready') throw new Error('WhatsApp no está conectado'); await this.client.sendMessage(destination,message,{sendSeen:false}); }
}
