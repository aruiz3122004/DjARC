/**
 * Almacenamiento binario masivo en OPFS (Origin Private File System).
 * Permite almacenar cientos de canciones (MP3, WAV, M4A, FLAC, OGG) localmente
 * sin cargar la memoria RAM ni depender de la cuota de caché HTTP del navegador.
 * Incluye respaldo automático en IndexedDB solo si OPFS no está disponible
 * (por ejemplo, navegación privada en navegadores antiguos).
 */

const OPFS_DIR_NAME = 'gradmix-audio';
const FALLBACK_DB_NAME = 'gradmix-audio-fallback';
const FALLBACK_STORE_NAME = 'files';

export interface StorageUsageInfo {
  supportedOpfs: boolean;
  usageBytes: number;
  quotaBytes: number;
  persisted: boolean;
}

function isOpfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.storage) &&
    typeof navigator.storage.getDirectory === 'function'
  );
}

function openFallbackDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FALLBACK_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FALLBACK_STORE_NAME)) {
        db.createObjectStore(FALLBACK_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function writeFallbackBlob(key: string, data: Blob): Promise<void> {
  const db = await openFallbackDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FALLBACK_STORE_NAME, 'readwrite');
    tx.objectStore(FALLBACK_STORE_NAME).put(data, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function readFallbackArrayBuffer(key: string): Promise<ArrayBuffer> {
  const db = await openFallbackDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FALLBACK_STORE_NAME, 'readonly');
    const req = tx.objectStore(FALLBACK_STORE_NAME).get(key);
    req.onsuccess = async () => {
      const val = req.result as Blob | ArrayBuffer | undefined;
      db.close();
      if (!val) {
        reject(new Error(`Audio no encontrado en respaldo local: ${key}`));
        return;
      }
      if (val instanceof ArrayBuffer) {
        resolve(val);
      } else {
        resolve(await val.arrayBuffer());
      }
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

async function deleteFallbackBlob(key: string): Promise<void> {
  const db = await openFallbackDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FALLBACK_STORE_NAME, 'readwrite');
    tx.objectStore(FALLBACK_STORE_NAME).delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function getAudioDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR_NAME, { create: true });
}

/**
 * Solicita almacenamiento persistente al sistema operativo para evitar que
 * el navegador borre la música durante la fiesta por falta de espacio.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    // Algunos navegadores ignoran o restringen persist()
  }
  return false;
}

/**
 * Guarda un archivo de audio en OPFS haciendo streaming directo desde el File
 * para no duplicar picos de memoria durante cargas masivas.
 */
export async function saveAudioFile(opfsKey: string, file: File): Promise<void> {
  if (isOpfsSupported()) {
    try {
      const dir = await getAudioDirectory();
      const handle = await dir.getFileHandle(opfsKey, { create: true });

      if (typeof handle.createWritable === 'function') {
        const writable = await handle.createWritable();
        await file.stream().pipeTo(writable);
        return;
      }

      // Safari iOS puede requerir fallback si createWritable no está disponible en el hilo principal
      const buffer = await file.arrayBuffer();
      const blob = new Blob([buffer], { type: file.type || 'audio/mpeg' });
      await writeFallbackBlob(opfsKey, blob);
      return;
    } catch {
      // Respaldo transparente a IndexedDB si OPFS falla (ej. modo incógnito)
    }
  }

  await writeFallbackBlob(opfsKey, file);
}

export async function readAudioBlob(opfsKey: string, mimeType = 'audio/mpeg'): Promise<Blob> {
  if (isOpfsSupported()) {
    try {
      const dir = await getAudioDirectory();
      const handle = await dir.getFileHandle(opfsKey, { create: false });
      const file = await handle.getFile();
      if (file.type) return file;
      return new Blob([file], { type: mimeType });
    } catch {
      // Fallback a IndexedDB
    }
  }

  const buf = await readFallbackArrayBuffer(opfsKey);
  return new Blob([buf], { type: mimeType });
}

/**
 * Lee un archivo desde OPFS como ArrayBuffer únicamente bajo demanda
 * (cuando la pista entra en la ventana de 2 búferes de RAM).
 */
export async function readAudioArrayBuffer(opfsKey: string): Promise<ArrayBuffer> {
  if (isOpfsSupported()) {
    try {
      const dir = await getAudioDirectory();
      const handle = await dir.getFileHandle(opfsKey, { create: false });
      const file = await handle.getFile();
      return await file.arrayBuffer();
    } catch {
      // Si no está en OPFS (por ejemplo, guardado en respaldo), intentamos el fallback
    }
  }

  return readFallbackArrayBuffer(opfsKey);
}

/**
 * Elimina un archivo individual de OPFS y libera espacio en disco.
 */
export async function deleteAudioFile(opfsKey: string): Promise<void> {
  if (isOpfsSupported()) {
    try {
      const dir = await getAudioDirectory();
      await dir.removeEntry(opfsKey);
    } catch {
      // Ignorar si no existía en OPFS
    }
  }

  try {
    await deleteFallbackBlob(opfsKey);
  } catch {
    // Ignorar si no existía en fallback
  }
}

/**
 * Limpia todos los archivos de audio almacenados localmente.
 */
export async function clearAllAudioFiles(): Promise<void> {
  if (isOpfsSupported()) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(OPFS_DIR_NAME, { recursive: true });
    } catch {
      // Ignorar si no existía
    }
  }

  try {
    const db = await openFallbackDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(FALLBACK_STORE_NAME, 'readwrite');
      tx.objectStore(FALLBACK_STORE_NAME).clear();
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
    // Ignorar
  }
}

export async function getStorageUsage(): Promise<StorageUsageInfo> {
  const supportedOpfs = isOpfsSupported();
  let usageBytes = 0;
  let quotaBytes = 0;
  let persisted = false;

  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      usageBytes = est.usage ?? 0;
      quotaBytes = est.quota ?? 0;
    }
    if (navigator.storage?.persisted) {
      persisted = await navigator.storage.persisted();
    }
  } catch {
    // Ignorar errores de cuota
  }

  return { supportedOpfs, usageBytes, quotaBytes, persisted };
}

export function buildSafeOpfsKey(id: string, originalFileName: string): string {
  const extMatch = originalFileName
    .toLowerCase()
    .match(/\.(mp3|wav|wave|m4a|m4b|m4p|m4r|mp4|aac|ogg|oga|opus|flac|webm|weba|3gp|3gpp|amr|aif|aiff|aifc|caf|wma|alac|ac3|mka)$/);
  const ext = extMatch ? extMatch[0] : '.audio';
  return `${id}${ext}`;
}
