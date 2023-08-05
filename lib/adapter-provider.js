class AdapterProvider {
    /**
     * @type {Object}
     */
    static adapterInstance;

    /**
     * @param {Object} adapter
     */
    static async start(adapter) {
        this.adapterInstance = adapter;
        this._id = await this.clientId();
    }
    static get() {
        return this.adapterInstance;
    }

    static get id() {
        return this._id;
    }

    /**
    * Sets iobroker state to the passed on value
    * @async
    * @param {string} id - id of the state to write the value to
    * @param {*} value - value to set the provided state to
    * @returns {Promise<Object>} - Object returned by the iobroker setForeignStateAsync function
    */
    static async setState(id, value) {
        await AdapterProvider.get().setForeignStateAsync(id, value, false);
        AdapterProvider.get().log.silly(`set [${id}] to [${value}]`);
    }
    /**
     * @param {string} id
     * @returns {Promise<Object>} - Object's val returned by the iobroker getForeignStateAsync function
     */
    static async getState(id) {
        const state = await AdapterProvider.get().getForeignStateAsync(id);
        return state.val;
    }
    /**
     * @param {string} id
     * @returns {Promise<Object>} - Object's val returned by the iobroker getForeignStateAsync function
     */
    static async getObject(id) {
        return await AdapterProvider.get().getForeignObjectAsync(id);
    }

    static async subscribe(id) {
        await AdapterProvider.get().subscribeForeignStatesAsync(id);
    }

    static async unsubscribe(id) {
        await AdapterProvider.get().unsubscribeForeignStatesAsync(id);
    }

    static async clientId() {
        const adapter = this.get();
        if (adapter.id) {
            return adapter.id;
        }
        const promise = new Promise((resolve) => {
            adapter.getForeignObject('system.meta.uuid', (err, uuidObj) => {
                if (uuidObj && uuidObj.native && uuidObj.native.uuid) {
                    adapter.getForeignObject('system.adapter.' + adapter.namespace, (err, obj) => {
                        if (obj) {
                            adapter.log.info('Set id to: ' + uuidObj.native.uuid);
                            resolve(uuidObj.native.uuid);
                        } else {
                            adapter.log.error('Could not get system.adapter namespace');
                            resolve(null);
                        }
                    });
                } else {
                    adapter.log.error('Could not get system.meta.uuid');
                    resolve(null);
                }
            });
        });

        return await promise;
    }
}

module.exports = AdapterProvider;