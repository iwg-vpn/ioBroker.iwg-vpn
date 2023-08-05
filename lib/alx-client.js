const AdapterProvider = require('./adapter-provider');
const HttpClient = require('./http-client');

const API_VERSION = process.env.ALX_API_VERSION;

class AlexaClient {
    static subscriptions = [];
    static endpoints = [];
    static async start() {
        AdapterProvider.get().on('stateChange', AlexaClient.stateChangeHandler);
        this.log = AdapterProvider.get().log;
        // fetch the endpoints
        AlexaClient.endpoints = await this.collectEndpoints();
        await this.updateSubscriptions();
    }

    static async collectEndpoints() {
        try {
            const response = await HttpClient.post(HttpClient.composeAbsoluteUrl(`/clients/${AdapterProvider.id}/endpoints`, API_VERSION),
                {
                    objects: await this.allObjects(),
                    enums: await this.allEnums(),
                    lang: (await AdapterProvider.getObject('system.config'))?.common?.language || 'en'
                }
            );
            this.log.silly(`collected endpoints: ${JSON.stringify(response?.data?.endpoints)}`);
            return response?.data?.endpoints || [];
        } catch (error) {
            this.log.error(error);
            return [];
        }
    }

    static async fetchEndpoints() {
        try {
            const response = await HttpClient.get(HttpClient.composeAbsoluteUrl(`/clients/${AdapterProvider.id}/endpoints`, API_VERSION));
            this.log.silly(`fetched endpoints: ${JSON.stringify(response?.data?.endpoints)}`);

            // const endpoints = response?.data?.endpoints.map(endpoint => {
            //     id: endpoints.id,
            //         friendly_name: endpoint.friendlyName,
            //             children: endpoint.controls
            // });

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
    }

    static async allEnums() {
        const result = await AdapterProvider.get().getObjectViewAsync('system', 'enum', {});
        return result.rows.map(row => row.value);
    }

    static cleanup() {
        if (AlexaClient.subscriptions.length > 0) {
            AdapterProvider.get().unsubscribeForeignStates(this.subscriptions);
            this.subscriptions.length = 0;
        }
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
        AdapterProvider.get().subscribeForeignStates(this.subscriptions);
        this.log.debug(`updated watched states to ${JSON.stringify(this.subscriptions)}`);
    }
}

module.exports = AlexaClient;