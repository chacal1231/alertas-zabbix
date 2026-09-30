import test from 'node:test';
import assert from 'node:assert/strict';
import {formatMessage,normalize,Store} from '../src/store.js';
const p={event_id:'505',event_value:'1',event_nseverity:'4',Host:'PE-LAB-01',Event:'Texto original de Zabbix',event_date:'2026.09.30',event_time:'18:30:32',event_opdata:'Current state: down (0)'};
test('cada severidad tiene su encabezado y conserva el texto recibido',()=>{
 const headings=['⚪ *EVENTO SIN CLASIFICAR*','🔵 *INFORMACIÓN*','🟡 *ADVERTENCIA*','🟠 *ALERTA DE PRIORIDAD MEDIA*','🔴 *ALERTA DE PRIORIDAD ALTA*','🚨 *ALERTA CRÍTICA*'];
 headings.forEach((h,i)=>{const m=formatMessage(normalize({...p,event_nseverity:String(i)}));assert.ok(m.startsWith(h));assert.ok(m.includes('*Evento:* '+p.Event));assert.ok(m.includes('*Detalle:* '+p.event_opdata));assert.ok(m.includes('30/09/2026 · 18:30:32'));assert.ok(m.endsWith('Referencia: #505'));});
});
test('recuperación conserva la severidad original guardada y omite detalle redundante',()=>{
 const s=new Store(':memory:');s.saveConfig({groups:['1@g.us'],minSeverity:0,hostContains:'',tag:'',updates:true});s.accept(p);s.accept({...p,event_value:'0',event_nseverity:'2',event_duration:'2m 0s',event_recovery_date:'2026.09.30',event_recovery_time:'18:32:32'});
 const m=s.snapshot().jobs[0].message;assert.ok(m.startsWith('✅ *PROBLEMA RECUPERADO*'));assert.ok(m.includes('*Severidad original:* Alta'));assert.ok(m.includes('*Duración:* 2m 0s'));assert.ok(m.includes('*Recuperación:* 30/09/2026 · 18:32:32'));assert.ok(!m.includes('Current state'));s.db.close();
});
test('actualización preserva el mensaje y los campos vacíos se omiten',()=>{
 const m=formatMessage(normalize({...p,event_update_status:'1',problem_status:'Operador: enlace en revisión.'}));assert.ok(m.startsWith('📝 *ACTUALIZACIÓN · ALTA*'));assert.ok(m.includes('*Actualización:* Operador: enlace en revisión.'));assert.ok(!m.includes('*Fecha:*'));
 const empty=formatMessage(normalize({...p,event_date:'',event_time:'',event_opdata:''}));assert.ok(!empty.includes('*Detalle:*'));assert.ok(!empty.includes('*Inicio:*'));
});
