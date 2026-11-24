import { RenderedClipRecord } from '../types.ts';

const DB_NAME = 'clip_studio_ai_db';
const DB_VERSION = 1;
const STORE_NAME = 'rendered_clips';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB tidak tersedia di browser ini.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('by_videoId', 'videoId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Gagal membuka IndexedDB.'));
  });
}

export async function saveRenderedClip(record: RenderedClipRecord): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(record);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('Gagal menyimpan hasil render ke IndexedDB.'));
    };
  });
}

export async function getRenderedClipsForVideo(videoId: string): Promise<RenderedClipRecord[]> {
  if (!videoId) return [];
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('by_videoId');
      const req = index.getAll(videoId);
      req.onsuccess = () => {
        const list = (req.result || []) as RenderedClipRecord[];
        list.sort((a, b) => a.clipNumber - b.clipNumber);
        db.close();
        resolve(list);
      };
      req.onerror = () => {
        db.close();
        reject(req.error || new Error('Gagal memuat daftar klip terender.'));
      };
    });
  } catch {
    return [];
  }
}

export async function deleteRenderedClip(videoId: string, clipId: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(`${videoId}::${clipId}`);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // ignore cleanup failure
  }
}

export async function clearRenderedClipsForVideo(videoId: string): Promise<void> {
  if (!videoId) return;
  try {
    const existing = await getRenderedClipsForVideo(videoId);
    if (existing.length === 0) return;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const item of existing) {
        store.delete(item.id);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // ignore cleanup failure
  }
}
