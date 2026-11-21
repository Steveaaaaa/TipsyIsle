import type { MediaHandle } from '../../../packages/plugin-sdk/index.js';

export interface StoredMedia extends MediaHandle { owner: string; readers: string[] }
let opening: Promise<IDBDatabase> | undefined;
export const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});
export const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
});
export function backgroundDb() {
    return opening ??= (() => {
        const request = indexedDB.open('tipsy-plugin-background', 2);
        request.onupgradeneeded = event => {
            const db = request.result;
            if (event.oldVersion < 1) {
                db.createObjectStore('media', { keyPath: 'id' }).createIndex('owner', 'owner');
                db.createObjectStore('blobs');
                db.createObjectStore('index', { keyPath: ['owner', 'collection', 'id'] });
            }
            db.createObjectStore('memory-vectors', { keyPath: ['collection', 'id'] });
            db.createObjectStore('memory-payloads', { keyPath: ['collection', 'id'] });
            db.createObjectStore('memory-snapshots');
        };
        return requestResult(request).then(db => { db.onversionchange = () => { db.close(); opening = undefined; }; return db; })
            .catch(error => { opening = undefined; throw error; });
    })();
}
