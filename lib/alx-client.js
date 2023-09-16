const AdapterProvider = require('./adapter-provider');
const Deferred = require('./deferred');
const HttpClient = require('./http-client');

const API_VERSION = process.env.ALX_API_VERSION;

class AlexaClient {
    static subscriptions = [];
    static endpoints = [];
    static async start() {
        AdapterProvider.get().on('stateChange', AlexaClient.stateChangeHandler);
        AdapterProvider.get().on('objectChange', AlexaClient.objectChangeHandler);
        this.log = AdapterProvider.get().log;
        // fetch the endpoints
        AlexaClient.endpoints = await this.collectEndpoints();
        await this.updateSubscriptions();
    }

    static async collectEndpoints() {
        try {
            function removeProp(item, propName) {
                const itemKeys = Object.keys(item || {});
                for (let key of itemKeys) {
                    if (key === propName) {
                        delete item[key];
                    } else if (typeof item[key] === 'object') {
                        removeProp(item[key], propName)
                    } else if (Array.isArray(item[key])) {
                        item[key].forEach(element => {
                            removeProp(element, propName)
                        });
                    }
                }
            }

            if (!this.config) {
                let config = (await AdapterProvider.get().getObjectViewAsync('system', 'adapter', {})).rows.find(a => a.id === 'system.adapter.iot');
                this.config = {
                    functionFirst: config?.value?.native?.functionFirst || false,
                    concatWord: config?.value?.native?.concatWord || '',
                    lang: (await AdapterProvider.getObject('system.config'))?.common?.language || 'en',
                }
            }

            const knownEndpoints = JSON.stringify(AlexaClient.endpoints);
            this.log.silly(`Starting local Alexa endpoints discovery...`);
            const objects = await this.allObjects();
            const enums = await this.allEnums();

            const garbage = ['icon', 'de', 'en', 'zh-cn', 'it', 'pl', 'fr', 'pt', 'ru', 'nl', 'uk', 'es', 'desc', 'color', 'expert', 'def', 'ts', 'user', 'from'];
            garbage.splice(garbage.indexOf(this.config.lang), 1);
            for (let propName of garbage) {
                removeProp(objects, propName);
                removeProp(enums, propName);
            }

            const response = await HttpClient.post(HttpClient.composeAbsoluteUrl(`/clients/${AdapterProvider.id}/endpoints`, API_VERSION),
                {
                    objects: objects,
                    enums: enums,
                    config: {
                        lang: this.config.lang,
                        functionFirst: this.config.functionFirst,
                        concatWord: this.config.concatWord,
                    }
                }
            );

            const endpoints = response?.data?.endpoints || [];
            const discovered = JSON.stringify(endpoints)
            this.log.silly(`Discovered ${endpoints.length} endpoints: ${discovered}`);
            if (knownEndpoints !== '[]' && knownEndpoints !== discovered) {
                this.log.warn(`There are changes in Alexa devices. Trigger discovery process in your Alexa app to synchronize.`)
            }
            return endpoints;
        } catch (error) {
            this.log.error(error);
            return [];
        }
    }

    static async accounts() {
        try {
            this.log.silly(`fetching account...`)
            let response = await HttpClient.post(HttpClient.composeAbsoluteUrl(`/clients/${AdapterProvider.id}/accounts`, process.env.IWG_API_VERSION), {});
            return response.data;
        } catch (e) {
            this.log.error(`failed fetching account`)
            this.log.error(e)
        }
        return null;
    }

    static async fetchEndpoints() {
        try {
            const response = await HttpClient.get(HttpClient.composeAbsoluteUrl(`/clients/${AdapterProvider.id}/endpoints`, API_VERSION));
            this.log.silly(`fetched endpoints: ${JSON.stringify(response?.data?.endpoints)}`);
            const result = {
                endpoints: [
                    {
                        id: 1,
                        friendlyName: 'Managed by iwg-vpn',
                        children: response?.data?.endpoints
                    }
                ]
            }

            return response?.data?.endpoints || [];
        } catch (error) {
            this.log.error(error);
            return [];
        }

    }

    static async allObjects() {
        try {
            const states = await AdapterProvider.get().getObjectViewAsync('system', 'state', {});
            const channels = await AdapterProvider.get().getObjectViewAsync('system', 'channel', {});
            const devices = await AdapterProvider.get().getObjectViewAsync('system', 'device', {});
            const enums = await AdapterProvider.get().getObjectViewAsync('system', 'enum', {});
            return states.rows
                .concat(channels.rows)
                .concat(devices.rows)
                .concat(enums.rows)
                .reduce((obj, item) => (
                    obj[item.id] = {
                        common: item.value?.common,
                        type: item.value?.type,
                    }, obj), {}
                );

        } catch (error) {
            this.log.error(error);
        }
    }

    static async allEnums() {
        try {
            const result = await AdapterProvider.get().getObjectViewAsync('system', 'enum', {});
            return result.rows.map(row => row.value);                
        } catch (error) {
            this.log.error(error);
        }
    }

    static cleanup() {
        if (AlexaClient.subscriptions.length > 0) {
            AdapterProvider.get().unsubscribeForeignStates(this.subscriptions);
            this.subscriptions.length = 0;
        }

        AdapterProvider.get().unsubscribeForeignObjects('enum.functions.*');
        AdapterProvider.get().unsubscribeForeignObjects('enum.rooms.*');
    }

    static objectChangeHandler(id, obj) {
        this.log.info(`There are changes in rooms and/or functions. Restart adapter to re-discover Alexa devices and then start discovery in your Alexa App.`)
    }

    /**
    * @param {string} id
    * @param {ioBroker.State | null | undefined} state
    */
    static stateChangeHandler(id, state) {

        if (!AlexaClient.subscriptions.includes(id)) {
            return;
        }

        if (state) {
            // The state was changed
            this.log.silly(`state ${id} changed: ${state.val}(ack = ${state.ack})`);

            // report only acknowledged changes
            if (state.ack) {
                // no need to wait for the promise to be resolved here
                AlexaClient.reportStateChange(id, state.val);
            } else {
                this.log.silly(`skipped reporting state ${id} change due to ack = ${state.ack}`);
            }
        } else {
            // The state was deleted
            // log.info(`state ${id} deleted`);
        }
    }

    static async reportStateChange(address, value) {
        try {
            if (value != null) {
                value = value.toString()
            }
            this.log.silly(`reporting value ${value} for ${address}...`)
            let response = await HttpClient.put(HttpClient.composeAbsoluteUrl(`/clients/${AdapterProvider.id}/values`, API_VERSION), { id: address, value: value });
            if (response.status >= 300) {
                this.log.error(`failed reporting state change of ${address}`);
                this.log.error(`${response}`);
            }
        } catch (e) {
            this.log.error(`failed reporting state change of ${address}`)
            this.log.error(e)
        }
    }

    static async updateSubscriptions() {
        AlexaClient.cleanup();

        // @ts-ignore
        AlexaClient.subscriptions = Array.from(new Set(AlexaClient.endpoints
            // @ts-ignore
            .flatMap(e => e.controls)
            .flatMap(c => c.properties)
            .map(p => p.getId)
        ));
        try {
            AdapterProvider.get().subscribeForeignStates(this.subscriptions);
            this.log.debug(`updated watched states to ${JSON.stringify(this.subscriptions)}`);
            AdapterProvider.get().subscribeForeignObjects('enum.functions.*');
            AdapterProvider.get().subscribeForeignObjects('enum.rooms.*');

        } catch (error) {
            this.log.error(error);
        }
    }
}

module.exports = AlexaClient;