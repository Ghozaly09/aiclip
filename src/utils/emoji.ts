// Indonesian & English keywords for contextual emoji suggestions
export function getKeywordEmoji(word: string): string | undefined {
  const clean = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['halo', 'hai', 'hello', 'hi', 'selamat'].includes(clean)) return '👋';
  if (['lucu', 'ketawa', 'ngakak', 'wkwk', 'haha', 'lawak', 'funny', 'laugh'].includes(clean)) return '🤣';
  if (['kaget', 'astaga', 'shock', 'wow', 'omg'].includes(clean)) return '😱';
  if (['keren', 'mantap', 'hebat', 'hot', 'viral', 'fire', 'api'].includes(clean)) return '🔥';
  if (['uang', 'duit', 'cuan', 'kaya', 'bisnis', 'money'].includes(clean)) return '💸';
  if (['obat', 'dokter', 'resep', 'herbal', 'sehat'].includes(clean)) return '💊';
  if (['polisi', 'komandan', 'aparat', 'hukum'].includes(clean)) return '👮';
  if (['brewok', 'kumis', 'janggut', 'rambut'].includes(clean)) return '🧔';
  if (['ai', 'robot', 'teknologi', 'komputer', 'tech'].includes(clean)) return '🤖';
  if (['target', 'tujuan', 'fokus', 'goal'].includes(clean)) return '🎯';
  if (['penting', 'rahasia', 'peringatan', 'awas'].includes(clean)) return '⚠️';
  if (['cepat', 'kilat', 'listrik', 'energi'].includes(clean)) return '⚡';
  if (['ide', 'tips', 'trik', 'paham'].includes(clean)) return '💡';
  return undefined;
}
