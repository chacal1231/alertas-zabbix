import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveGroupNames,validateGroupNames} from '../src/group-names.js';
const groups=[{id:'1@g.us',name:'Alertas NOC'},{id:'2@g.us',name:'Redes'}];
test('nombres manuales resuelven IDs estables y eliminan duplicados',()=>{assert.deepEqual(resolveGroupNames([' Alertas NOC ','Redes','Redes'],groups),groups);});
test('nombre inexistente o ambiguo no selecciona otro grupo',()=>{assert.throws(()=>resolveGroupNames(['NOC'],groups),/No se encontró/);assert.throws(()=>resolveGroupNames(['Redes'],[...groups,{id:'3@g.us',name:'Redes'}]),/varios grupos/);});
test('validación y compatibilidad con IDs existentes',()=>{assert.throws(()=>validateGroupNames('Redes'));assert.throws(()=>validateGroupNames(['']));assert.deepEqual(resolveGroupNames(['1@g.us'],groups),[groups[0]]);});
