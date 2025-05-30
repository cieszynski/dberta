// MIT License

// Copyright (c) 2025 Stephan Cieszynski

Object.defineProperty(globalThis, 'dberta', {

    value: globalThis?.dberta ?? new class dberta {

        open = (dbName, schema) => new Promise((resolve, reject) => {
            if (!schema) return reject(new DOMException(
                `database '${dbName}' no schema found`,
                "NotFoundError"
            ));

            const request = indexedDB.open(dbName, Object.keys(schema).at(-1));
            request.onerror = () => reject(request.error);
            request.onblocked = () => { reject(request.error); }
            request.onupgradeneeded = (event) => {
                console.debug('onupgradeneeded');

                const db = request.result;

                for (let v = event.oldVersion + 1; v <= event.newVersion; v++) {
                    Object.entries(schema[v]).forEach(([storeName, definition]) => {

                        // forbidden storename
                        if (['transaction'].includes(storeName)) {
                            return reject(new DOMException(
                                `store name '${storeName}' not allowed`,
                                'NotAllowedError'));
                        }

                        if (Array.from(db.objectStoreNames).includes(storeName)) {
                            db.deleteObjectStore(storeName)
                        }

                        const [keypath, ...indexes] = definition.split(/\s*(?:,)\s*/);

                        const store = db.createObjectStore(storeName, {
                            // if keyPath.length is 0 return undefined
                            keyPath: keypath.replace(/[\@]/, '') || undefined,
                            autoIncrement: /^[\@]/.test(keypath)
                        });

                        indexes.forEach(indexName => {

                            store.createIndex(
                                indexName.replace(/[\*!]/, ''),
                                indexName
                                    .split(/\+/)
                                    // at this point every keypath is an array
                                    .map(elem => elem.replace(/[\*!]/, ''))
                                    .reduce((prev, cur, idx) => {
                                        switch (idx) {
                                            case 0:
                                                // indexName is keyPath:
                                                return cur;
                                            case 1:
                                                // indexName is compound key
                                                return [prev, cur];
                                            default:
                                                return [...prev, cur];
                                        }
                                    }),
                                {
                                    multiEntry: /^\*/.test(indexName),
                                    unique: /^\!/.test(indexName)
                                });


                            console.debug("index '%s' created", indexName);
                        }); // indexes.forEach
                    }); // Object.entries(schema[v])
                } // for loop
            } // onupgradeneeded

            request.onsuccess = (event) => {
                const db = event.target.result;

                const transactionBegin = (readOnly = false, ...storeNames) => {

                    let transaction;

                    return new Promise(async (resolve, reject) => {
                        try {
                            transaction = db.transaction(storeNames, readOnly ? 'readonly' : 'readwrite');

                            resolve(storeNames.reduce((obj, storeName) => {
                                const store = transaction.objectStore(storeName);

                                // Find all lowercase and uppercase
                                // combinations of a string
                                // called from ingnoreCase
                                const permutation = (permutable) => {

                                    const arr = [];
                                    const permute = (str, tmp = '') => {
                                        if (str.length == 0) {

                                            arr.push(tmp);
                                        } else {
                                            permute(str.substring(1), tmp + str[0].toLowerCase());
                                            if (isNaN(str[0])) {
                                                permute(str.substring(1), tmp + str[0].toUpperCase());
                                            }
                                        }
                                    }

                                    permute(permutable);

                                    // sort from ABC -> abc
                                    return arr.sort();
                                }

                                // called from 
                                // add, count, delete, get,  
                                // getKey, getAll, getAllKeys, put
                                const execute = (verb, ...args) => {
                                    return new Promise(async (resolve, reject) => {
                                        try {
                                            store[verb](...args).onsuccess = (event) => {
                                                resolve(event.target.result);
                                            };
                                        } catch (err) {
                                            if (transaction) { transaction.abort(); }
                                            reject(err);
                                        }
                                    });
                                }

                                // called from execute_and, execute_or
                                const execute_cursor_query = (cursor, result) => {
                                    result.push(cursor.value);
                                }

                                // called from execute_and, execute_or
                                const execute_cursor_update = (cursor, result, payload) => {
                                    // only {} records reach this, so we can merge
                                    cursor
                                        .update(Object.assign(cursor.value, payload))
                                        .onsuccess = (event) => {
                                            // add the key of the updated record
                                            result.push(event.target.result);
                                        };
                                }

                                // called from execute_and, execute_or
                                const execute_cursor_delete = (cursor, result) => {
                                    cursor
                                        .delete()
                                        // onsuccess result is always 'undefined', so
                                        // insert number of deleted records
                                        .onsuccess = () => { result.push(result.length + 1); }
                                }

                                // called from queryAnd, updateAnd, deleteAnd
                                const execute_and = (verb, ...args) => {

                                    return new Promise(async (resolve, reject) => {
                                        try {
                                            const result = []

                                            const payload = /^(update)/.test(verb)
                                                ? args.pop()
                                                : undefined;

                                            const indexName = args.shift();
                                            const keyRange = args.shift();

                                            const request = store
                                                .index(indexName)
                                                .openCursor(keyRange);
                                            request.onsuccess = (event) => {
                                                const cursor = event.target.result;

                                                if (cursor) {

                                                    // check more conditions
                                                    // to fullfill every condition must passed
                                                    for (let n = 0; n < args.length; n += 2) {
                                                        const indexName = args[n];
                                                        const keyRange = args[n + 1];

                                                        if (!keyRange.includes(cursor.value[indexName])) {
                                                            cursor.continue();
                                                            return;
                                                        }
                                                    }

                                                    switch (verb) {
                                                        case 'query':
                                                            execute_cursor_query(cursor, result);
                                                            break;
                                                        case 'update':
                                                            execute_cursor_update(cursor, result, payload);
                                                            break;
                                                        case 'delete':
                                                            execute_cursor_delete(cursor, result);
                                                            break;
                                                        default:
                                                            console.error('unknown verb ', verb);
                                                    }

                                                    cursor.continue();
                                                } else {
                                                    resolve(result);
                                                }
                                            }
                                        } catch (err) {
                                            if (transaction) { transaction.abort(); }
                                            reject(err);
                                        }
                                    });
                                }

                                // called from queryOr, updateOr, deleteOr
                                const execute_or = (verb, ...args) => {

                                    return new Promise(async (resolve, reject) => {
                                        try {
                                            const result = new class extends Array {
                                                push(obj) {
                                                    // Objects are only stringified the same, Set() won't work
                                                    if (!this.some(entry => JSON.stringify(entry) === JSON.stringify(obj))) {
                                                        super.push(obj);
                                                    }
                                                }
                                            }

                                            const payload = /^(update)/.test(verb)
                                                ? args.pop()
                                                : undefined;

                                            let count = args.length / 2;

                                            while (args.length) {
                                                const indexName = args.shift();
                                                const keyRange = args.shift();

                                                const request = store
                                                    .index(indexName)
                                                    .openCursor(keyRange);
                                                request.onsuccess = (event) => {
                                                    const cursor = event.target.result;

                                                    if (cursor) {
                                                        switch (verb) {
                                                            case 'query':
                                                                execute_cursor_query(cursor, result);
                                                                break;
                                                            case 'update':
                                                                execute_cursor_update(cursor, result, payload);
                                                                break;
                                                            case 'delete':
                                                                execute_cursor_delete(cursor, result);
                                                                break;
                                                            default:
                                                                console.error('unknown verb ', verb);
                                                        }

                                                        cursor.continue();
                                                    }

                                                    // 
                                                    if (!args.length && result.length === count) {
                                                        resolve(result)
                                                    }
                                                }
                                            }
                                        } catch (err) {
                                            if (transaction) { transaction.abort(); }
                                            reject(err);
                                        }
                                    });
                                }

                                obj[storeName] = {
                                    add(obj, key) { return execute('add', obj, key); },

                                    count(keyOrKeyRange) { return execute('count', keyOrKeyRange); },

                                    delete(keyOrKeyRange) { return execute('delete', keyOrKeyRange); },

                                    get(keyOrKeyRange) { return execute('get', keyOrKeyRange); },

                                    getKey(keyOrKeyRange) { return execute('getKey', keyOrKeyRange); },

                                    getAll(keyRange, limit) { return execute('getAll', keyRange, limit); },

                                    getAllKeys(keyRange, limit) { return execute('getAllKeys', keyRange, limit); },

                                    put(obj, key) { return execute('put', obj, key); },

                                    where(indexName, keyRange, limit = 0, direction = 'next') {

                                        return new Promise(async (resolve, reject) => {
                                            try {
                                                const result = [];

                                                const request = store.index(indexName)
                                                    .openCursor(keyRange, direction);

                                                request.onsuccess = () => {
                                                    const cursor = request.result;

                                                    if (cursor) {
                                                        result.push(cursor.value);

                                                        if (!(limit && result.length >= limit)) {
                                                            cursor.continue();
                                                            return;
                                                        }
                                                    }
                                                    resolve(result);

                                                };
                                            } catch (err) {
                                                if (transaction) { transaction.abort(); }
                                                reject(err);
                                            }
                                        });
                                    }, // END where

                                    queryAnd(...args) { return execute_and('query', ...args) },
                                    updateAnd(...args) { return execute_and('update', ...args) },
                                    deleteAnd(...args) { return execute_and('delete', ...args) },

                                    queryOr(...args) { return execute_or('query', ...args) },
                                    updateOr(...args) { return execute_or('update', ...args) },
                                    deleteOr(...args) { return execute_or('delete', ...args) },

                                    ignoreCase(indexName, str, startsWith = false) {
                                        let n = 0;
                                        const permutations = permutation(str);

                                        return new Promise(async (resolve, reject) => {
                                            try {
                                                const result = [];

                                                const request = store
                                                    .index(indexName)
                                                    .openCursor();
                                                request.onsuccess = (event) => {
                                                    const cursor = event.target.result;

                                                    if (cursor) {

                                                        const value = cursor.value[indexName];
                                                        const length = startsWith
                                                            ? permutations[0].length
                                                            : value.length;

                                                        // find cursor.value[indexName] > permutation
                                                        while (value.substring(0, length) > permutations[n]) {

                                                            // there are no more permutations
                                                            if (++n >= permutations.length) {
                                                                resolve(result);
                                                                return;
                                                            }
                                                        }

                                                        if ((startsWith && value.indexOf(permutations[n]) === 0)
                                                            || value === permutations[n]) {

                                                            result.push(cursor.value);
                                                            cursor.continue();
                                                        } else {
                                                            cursor.continue(permutations[n]);
                                                        }
                                                    }
                                                }
                                            } catch (err) {
                                                if (transaction) { transaction.abort(); }
                                                reject(err);
                                            }
                                        });
                                    } // END ignoreCase
                                }

                                return obj;
                            }, { // to access from outside
                                transaction: transaction
                            }));
                        } catch (err) {
                            if (transaction) { transaction.abort(); }
                            reject(err);
                        }
                    });
                } // END transactionBegin

                resolve({
                    write(...args) { return transactionBegin(false, ...args); },
                    read(...args) { return transactionBegin(true, ...args); },
                    close() { db.close(); },
                    db: db // to access from outside
                });
            } // request.onsuccess
        }); // END open

        delete = (dbName) => new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(dbName);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        }); // END delete

        // functions to build keyranges
        eq = (z) => IDBKeyRange.only(z);
        le = (y) => IDBKeyRange.upperBound(y);
        lt = (y) => IDBKeyRange.upperBound(y, true);
        ge = (x) => IDBKeyRange.lowerBound(x);
        gt = (x) => IDBKeyRange.lowerBound(x, true);
        between = (x, y, bx, by) => IDBKeyRange.bound(x, y, bx, by);
        startsWith = (s) => IDBKeyRange.bound(s, s + '\uffff', true, true);
    }
}); // Object.defineProperty