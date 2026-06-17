// IndexedDB 存储工具 - 用于存储大量图片数据
// localStorage 有5MB限制，IndexedDB 没有硬性限制

interface StorageTask {
  id: number;
  prompt: string;
  imageUrls: string[];
  imagePreviews: string[];
  status: string;
  videoUrl: string;
  taskId: string;
  model: string;
}

const DB_NAME = 'VideoTasksDB';
const DB_VERSION = 1;
const STORE_NAME = 'tasks';

let db: IDBDatabase | null = null;

export async function initDB(): Promise<IDBDatabase> {
  if (db) return db;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

export async function saveTasks(tasks: StorageTask[]): Promise<void> {
  const database = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    // 先清空旧数据
    store.clear();
    
    // 保存所有任务
    tasks.forEach(task => {
      store.put(task);
    });

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function loadTasks(): Promise<StorageTask[] | null> {
  const database = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function clearTasks(): Promise<void> {
  const database = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    store.clear();

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// 估算对象大小（字节）
export function estimateSize(obj: any): number {
  const str = JSON.stringify(obj);
  return str.length * 2; // 每个字符约2字节（UTF-16）
}
