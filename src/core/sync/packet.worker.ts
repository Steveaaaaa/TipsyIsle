import { seal, unseal } from './protocol';
import { packSyncImages, unpackSyncImages } from '../snapshot-codec';

self.onmessage = async (event: MessageEvent) => {
    const { id, operation, value, secret, images } = event.data;
    try {
        const result = operation === 'seal'
            ? await seal(images ? await packSyncImages(value) : value, secret)
            : unpackSyncImages(await unseal(value, secret));
        self.postMessage({ id, result });
    } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
};
