export function validateGroupNames(names) {
  if (!Array.isArray(names) || names.length > 100 || names.some(n => typeof n !== 'string' || !n.trim() || n.length > 200 || /[\r\n]/.test(n))) throw new Error('Escribe un nombre de grupo por línea (máximo 100).');
  return [...new Set(names.map(n => n.trim()))];
}
export function resolveGroupNames(names, available) {
  return validateGroupNames(names).map(name => {
    const matches = available.filter(g => g.name.normalize('NFC') === name.normalize('NFC') || g.id === name);
    const unique = [...new Map(matches.map(g => [g.id, g])).values()];
    if (!unique.length) throw new Error(`No se encontró el grupo «${name}». Comprueba el nombre y que la cuenta vinculada pertenezca al grupo.`);
    if (unique.length > 1) throw new Error(`Hay varios grupos llamados «${name}». Usa un nombre único en WhatsApp.`);
    return unique[0];
  });
}
