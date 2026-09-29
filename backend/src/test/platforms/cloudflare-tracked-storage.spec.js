import { expect } from 'chai';
import { TrackedStorageAdapter } from '@/platforms/cloudflare/tracked-storage';

class MemoryStorage {
    constructor({ data = {}, root = {} } = {}) {
        this.data = structuredClone(data);
        this.root = structuredClone(root);
        this.commits = 0;
    }

    getData(key) {
        return this.data[key];
    }

    getRoot(key) {
        return this.root[key];
    }

    loadData() {
        return structuredClone(this.data);
    }

    commit({ replaceData, operations }) {
        this.commits += 1;
        if (replaceData !== undefined) this.data = structuredClone(replaceData);
        for (const operation of operations) {
            const bucket = operation.bucket === 'data' ? this.data : this.root;
            if (operation.type === 'delete') delete bucket[operation.key];
            else bucket[operation.key] = structuredClone(operation.value);
        }
    }
}

describe('Cloudflare tracked storage transaction', function () {
    it('does not leak implicit mutations before commit', function () {
        const storage = new MemoryStorage({
            data: { settings: { theme: 'dark' } },
        });
        const transaction = new TrackedStorageAdapter(storage);

        transaction.getData('settings').theme = 'light';

        expect(storage.data.settings.theme).to.equal('dark');
        transaction.commit();
        expect(storage.data.settings.theme).to.equal('light');
        expect(storage.commits).to.equal(1);
    });

    it('commits explicit writes and deletes as one batch', function () {
        const storage = new MemoryStorage({
            data: { stale: true },
            root: { legacy: 'value' },
        });
        const transaction = new TrackedStorageAdapter(storage);

        transaction.putData('settings', { enabled: true });
        transaction.deleteData('stale');
        transaction.deleteRoot('legacy');
        transaction.commit();

        expect(storage.data).to.deep.equal({ settings: { enabled: true } });
        expect(storage.root).to.deep.equal({});
        expect(storage.commits).to.equal(1);
    });

    it('discards every pending change after a failed request', function () {
        const storage = new MemoryStorage({ data: { count: 1 } });
        const transaction = new TrackedStorageAdapter(storage);

        transaction.putData('count', 2);
        transaction.putRoot('marker', 'pending');
        transaction.discard();

        expect(storage.data.count).to.equal(1);
        expect(storage.root).to.deep.equal({});
        expect(storage.commits).to.equal(0);
    });

    it('applies whole-database replacement and later writes atomically', function () {
        const storage = new MemoryStorage({ data: { old: true } });
        const transaction = new TrackedStorageAdapter(storage);

        transaction.replaceData({ settings: { imported: true } });
        transaction.putData('subscriptions', [{ name: 'demo' }]);
        transaction.commit();

        expect(storage.data).to.deep.equal({
            settings: { imported: true },
            subscriptions: [{ name: 'demo' }],
        });
        expect(storage.commits).to.equal(1);
    });
});
