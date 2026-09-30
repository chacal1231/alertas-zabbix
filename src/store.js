import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export function normalize(p) {
  if (!p || Array.isArray(p) || typeof p !== 'object') throw new Error('JSON inválido');
  if (String(p.event_source ?? '0') !== '0') throw new Error('Solo se admiten eventos de triggers');
  const id = String(p.event_id ?? '');
  if (!/^\d+$/.test(id)) throw new Error('event_id debe ser el ID original del problema');
  let kind = p.notification_type;
  if (!kind) kind = p.problem_status === 'Resolved' ? 'recovery' : String(p.event_update_status) === '1' ? 'update' : String(p.event_value) === '0' ? 'recovery' : String(p.event_value) === '1' ? 'problem' : '';
  if (!['problem', 'recovery', 'update'].includes(kind)) throw new Error('Tipo de notificación inválido');
  const host = String(p.Host ?? '').slice(0, 500);
  const name = String(p.Event ?? '').slice(0, 2000);
  if (!host || !name) throw new Error('Host y Event son obligatorios');
  const severity = Number(p.event_nseverity);
  if (!Number.isInteger(severity) || severity < 0 || severity > 5) throw new Error('Severidad inválida');
  let tags = p.event_tags ?? [];
  if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { tags = []; } }
  if (!Array.isArray(tags)) tags = [];
  const revision = kind === 'update' ? [p.event_update_date, p.event_update_time, p.problem_status] : [kind];
  const key = createHash('sha256').update(JSON.stringify([id, kind, revision])).digest('hex');
  return { id, kind, host, name, severity, tags, key, p };
}

const severities = [
  ['⚪', 'EVENTO SIN CLASIFICAR', 'No clasificada'],
  ['🔵', 'INFORMACIÓN', 'Información'],
  ['🟡', 'ADVERTENCIA', 'Advertencia'],
  ['🟠', 'ALERTA DE PRIORIDAD MEDIA', 'Media'],
  ['🔴', 'ALERTA DE PRIORIDAD ALTA', 'Alta'],
  ['🚨', 'ALERTA CRÍTICA', 'Desastre']
];
function present(value) { return value != null && String(value).trim() !== ''; }
function dateTime(date, time) {
  const formatted = present(date) ? String(date).replace(/^(\d{4})[.-](\d{2})[.-](\d{2})$/, '$3/$2/$1') : '';
  return [formatted, time].filter(present).join(' · ');
}
export function formatMessage(e) {
  const p = e.p;
  const [icon, heading, severity] = severities[e.severity];
  const title = e.kind === 'recovery' ? '✅ *PROBLEMA RECUPERADO*'
    : e.kind === 'update' ? `📝 *ACTUALIZACIÓN · ${severity.toUpperCase()}*`
    : `${icon} *${heading}*`;
  const details = [];
  const field = (label, value) => { if (present(value)) details.push(`*${label}:* ${value}`); };
  if (e.kind === 'recovery') {
    field('Severidad original', severities[e.originalSeverity ?? e.severity][2]);
    field('Duración', p.event_duration);
    field('Recuperación', dateTime(p.event_recovery_date, p.event_recovery_time));
  } else if (e.kind === 'update') {
    field('Actualización', p.problem_status);
    field('Fecha', dateTime(p.event_update_date, p.event_update_time));
  } else {
    field('Detalle', p.event_opdata);
    field('Inicio', dateTime(p.event_date, p.event_time));
  }
  const sections = [title, `*Equipo:* ${e.host}\n*Evento:* ${e.name}`];
  if (details.length) sections.push(details.join('\n'));
  const reference = `\n\nReferencia: #${e.id}`;
  return sections.join('\n\n').slice(0, Math.max(0, 6000-reference.length)) + reference;
}

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      INSERT OR IGNORE INTO config VALUES (1, '{"groups":[],"minSeverity":0,"hostContains":"","tag":"","updates":true}');
      CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, host TEXT, name TEXT, severity INTEGER, status TEXT, destinations TEXT, opened TEXT, recovered TEXT, updated TEXT);
      CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, incident TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, received TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, event_key TEXT, incident TEXT, destination TEXT, message TEXT, status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, next_at INTEGER DEFAULT 0, error TEXT, sent_at TEXT, UNIQUE(event_key,destination));
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status,next_at);
      CREATE INDEX IF NOT EXISTS jobs_incident ON jobs(incident,destination,id);`);
  }
  config() { return JSON.parse(this.db.prepare('SELECT json FROM config WHERE id=1').get().json); }
  saveConfig(c) {
    if (!Array.isArray(c.groups) || c.groups.length > 100 || c.groups.some(g => typeof g !== 'string' || !/^[\d-]+@g\.us$/.test(g))) throw new Error('Grupos inválidos');
    if (!Number.isInteger(c.minSeverity) || c.minSeverity < 0 || c.minSeverity > 5) throw new Error('Severidad inválida');
    if (typeof c.hostContains !== 'string' || c.hostContains.length > 200 || typeof c.tag !== 'string' || c.tag.length > 200 || typeof c.updates !== 'boolean') throw new Error('Filtros inválidos');
    this.db.prepare('UPDATE config SET json=? WHERE id=1').run(JSON.stringify({...c, groups:[...new Set(c.groups)]}));
  }
  accept(p) {
    const e = normalize(p), now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT key FROM events WHERE key=?').get(e.key)) { this.db.exec('COMMIT'); return {duplicate:true}; }
      const old = this.db.prepare('SELECT * FROM incidents WHERE id=?').get(e.id), c = this.config();
      const matches = e.severity >= c.minSeverity && e.host.toLowerCase().includes(c.hostContains.toLowerCase()) && (!c.tag || e.tags.some(t => `${t.tag}=${t.value}` === c.tag));
      // Destinations are frozen on the first notification, including an empty match.
      const destinations = old ? JSON.parse(old.destinations) : matches ? c.groups : [];
      const recovered = old?.status === 'recovered' || e.kind === 'recovery';
      this.db.prepare(`INSERT INTO incidents VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, recovered=COALESCE(incidents.recovered,excluded.recovered), updated=excluded.updated`).run(e.id,e.host,e.name,e.severity,recovered?'recovered':'active',JSON.stringify(destinations),`${p.event_date ?? ''} ${p.event_time ?? ''}`.trim(),e.kind==='recovery'?`${p.event_recovery_date ?? ''} ${p.event_recovery_time ?? ''}`.trim() || now:null,now);
      this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(e.key,e.id,e.kind,JSON.stringify(p),now);
      // A delayed problem cannot reopen an already recovered incident or produce a stale alert.
      const send = !(old?.status === 'recovered' && e.kind === 'problem') && (e.kind !== 'update' || c.updates);
      if (send) for (const destination of destinations) this.db.prepare('INSERT INTO jobs(event_key,incident,destination,message) VALUES (?,?,?,?)').run(e.key,e.id,destination,formatMessage({...e,originalSeverity:old?.severity ?? e.severity}));
      this.db.exec('COMMIT');
      return {duplicate:false, status:recovered?'recovered':'active', queued:send?destinations.length:0};
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  nextJob() {
    return this.db.prepare(`SELECT j.* FROM jobs j WHERE j.status='pending' AND j.next_at<=? AND NOT EXISTS (SELECT 1 FROM jobs earlier WHERE earlier.incident=j.incident AND earlier.destination=j.destination AND earlier.id<j.id AND earlier.status='pending') ORDER BY j.id LIMIT 1`).get(Date.now());
  }
  sent(id) { this.db.prepare("UPDATE jobs SET status='sent',sent_at=?,error=NULL WHERE id=?").run(new Date().toISOString(),id); }
  failed(job, error) { const attempts=job.attempts+1; this.db.prepare('UPDATE jobs SET attempts=?,status=?,next_at=?,error=? WHERE id=?').run(attempts, attempts>=5?'failed':'pending',Date.now()+Math.min(300000,5000*2**attempts),String(error).slice(0,500),job.id); }
  retry(id) {
    const j=this.db.prepare("SELECT * FROM jobs WHERE id=? AND status='failed'").get(id);
    if (!j) throw new Error('Envío no encontrado');
    if(this.db.prepare("SELECT id FROM jobs WHERE incident=? AND destination=? AND id>? AND status='sent'").get(j.incident,j.destination,j.id)) throw new Error('No se puede reenviar un estado anterior a uno ya enviado');
    this.db.prepare("UPDATE jobs SET status='pending',attempts=0,next_at=0,error=NULL WHERE id=?").run(id);
  }
  snapshot() {
    return {incidents:this.db.prepare('SELECT * FROM incidents ORDER BY updated DESC LIMIT 200').all(),jobs:this.db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 200').all(),counts:this.db.prepare('SELECT status,COUNT(*) AS count FROM incidents GROUP BY status').all()};
  }
}
