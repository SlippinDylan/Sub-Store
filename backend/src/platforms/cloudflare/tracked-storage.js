function entryKey(bucket, key) {
    return `${bucket}\0${key}`;
}

function cloneValue(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function isTrackable(value) {
    return value !== null && typeof value === 'object';
}

export class TrackedStorageAdapter {
    constructor(storage) {
        this.storage = storage;
        this.entries = new Map();
        this.operations = new Map();
        this.replacementData = undefined;
    }

    read(bucket, key) {
        const id = entryKey(bucket, key);
        const pending = this.operations.get(id);
        if (pending) {
            return pending.type === 'delete' ? undefined : pending.value;
        }

        let value;
        if (bucket === 'data' && this.replacementData !== undefined) {
            value = this.replacementData[key];
        } else {
            value = cloneValue(
                bucket === 'data'
                    ? this.storage.getData(key)
                    : this.storage.getRoot(key),
            );
        }
        this.track(bucket, key, value);
        return value;
    }

    track(bucket, key, value) {
        const id = entryKey(bucket, key);
        if (!isTrackable(value)) {
            this.entries.delete(id);
            return value;
        }
        if (!this.entries.has(id)) {
            this.entries.set(id, {
                bucket,
                key,
                value,
                snapshot: JSON.stringify(value),
            });
        }
        return value;
    }

    put(bucket, key, value) {
        const id = entryKey(bucket, key);
        this.operations.set(id, { type: 'put', bucket, key, value });
        this.entries.delete(id);
        this.track(bucket, key, value);
        return true;
    }

    delete(bucket, key) {
        const id = entryKey(bucket, key);
        this.operations.set(id, { type: 'delete', bucket, key });
        this.entries.delete(id);
        return true;
    }

    getData(key) {
        return this.read('data', key);
    }

    putData(key, value) {
        return this.put('data', key, value);
    }

    deleteData(key) {
        return this.delete('data', key);
    }

    getRoot(key) {
        return this.read('root', key);
    }

    putRoot(key, value) {
        return this.put('root', key, value);
    }

    deleteRoot(key) {
        return this.delete('root', key);
    }

    loadData() {
        const data =
            this.replacementData === undefined
                ? cloneValue(this.storage.loadData())
                : cloneValue(this.replacementData);
        for (const operation of this.operations.values()) {
            if (operation.bucket !== 'data') continue;
            if (operation.type === 'delete') delete data[operation.key];
            else data[operation.key] = operation.value;
        }
        for (const [key, value] of Object.entries(data)) {
            this.track('data', key, value);
        }
        return data;
    }

    replaceData(data) {
        this.replacementData = cloneValue(data);
        for (const [id, operation] of this.operations) {
            if (operation.bucket === 'data') this.operations.delete(id);
        }
        for (const [id, entry] of this.entries) {
            if (entry.bucket === 'data') this.entries.delete(id);
        }
        return true;
    }

    flushImplicitWrites() {
        const changed = [];
        for (const [id, entry] of this.entries) {
            if (this.operations.has(id)) continue;
            const current = JSON.stringify(entry.value);
            if (current === entry.snapshot) continue;
            this.operations.set(id, {
                type: 'put',
                bucket: entry.bucket,
                key: entry.key,
                value: entry.value,
            });
            entry.snapshot = current;
            changed.push(`${entry.bucket}:${entry.key}`);
        }
        return changed;
    }

    commit() {
        this.flushImplicitWrites();
        this.storage.commit({
            replaceData: this.replacementData,
            operations: [...this.operations.values()],
        });
    }

    discard() {
        this.entries.clear();
        this.operations.clear();
        this.replacementData = undefined;
    }
}
