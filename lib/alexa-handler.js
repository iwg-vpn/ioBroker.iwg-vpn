const crypto = require('crypto');
const IwgClient = require("./iwg-client");

let log;
class AlexaHandler {
    static adapter;
    static subscriptions = [];
    static endpoints = []
    static cooldowns = new Map()
    static capabilitesWithCooldown = {
        'Alexa.DoorbellEventSource': 15
    }
    static async init(adapter) {
        AlexaHandler.adapter = adapter;
        adapter.on('stateChange', AlexaHandler.stateChangeHandler);
        log = adapter.log;

        // fetch the endpoints
        await AlexaHandler.fetchEndpoints();

        await AlexaHandler.updateSubscriptions(AlexaHandler.endpoints);
    }

    static cleanup() {
        // 
        if (AlexaHandler.subscriptions.length > 0) {
            AlexaHandler.adapter.unsubscribeForeignStates(AlexaHandler.subscriptions);
            AlexaHandler.subscriptions.length = 0;
        }
    }

    static async fetchEndpoints() {
        try {
            if (AlexaHandler.endpoints.length == 0) {
                log.silly(`fetching configured alexa devices...`)
                let response = await IwgClient.get(`/clients/${IwgClient.id}/endpoints`);
                AlexaHandler.endpoints = response.data.endpoints;
            }
        } catch (e) {
            log.error(`failed fetching configured alexa devices`)
            log.error(e)
            AlexaHandler.endpoints = []
        }

        return { endpoints: AlexaHandler.endpoints }
    }

    static async reportAllStates() {
        for(let id of AlexaHandler.subscriptions) {
            try {
                const value = (await AlexaHandler.adapter.getForeignStateAsync(id) || {}).val;
                await AlexaHandler.reportStateChange(id, value);
            } catch(e) {
                log.error(e);
            }
        }
    }

    static async postEndpoints(payload) {
        try {
            log.silly(`posting endpoints... payload: ${JSON.stringify(payload)}`);

            let response = await IwgClient.post(`/clients/${IwgClient.id}/sync_endpoints`, payload);

            if (response.status < 400) {
                // @ts-ignore
                response = {
                    status: response.status
                };

                // update local cache
                AlexaHandler.endpoints = payload.endpoints;
                // update subscriptions
                await AlexaHandler.updateSubscriptions(AlexaHandler.endpoints);
                // report last values of newly subscribed states, no need to wait for the prmose to be resolved here
                AlexaHandler.reportAllStates();
            } else {
                // @ts-ignore
                response = null;
            }

            return response;
        } catch (e) {
            log.error(`failed posting endpoints`)
            log.error(e)
        }

        return null;
    }

    static async updateSubscriptions(endpoints) {
        function flatten(arr) {
            return arr.reduce(function (flat, toFlatten) {
                return flat.concat(Array.isArray(toFlatten) ? flatten(toFlatten) : toFlatten);
            }, []);
        }

        if (AlexaHandler.subscriptions.length > 0) {
            AlexaHandler.adapter.unsubscribeForeignStates(AlexaHandler.subscriptions);
            AlexaHandler.subscriptions.length = 0;
        }

        AlexaHandler.subscriptions = flatten(flatten(flatten(endpoints.map(e => e.capabilities)).map(c => c.properties))).map(p => p.io_address);

        AlexaHandler.adapter.subscribeForeignStates(AlexaHandler.subscriptions)

        log.debug(`updated watched states to ${JSON.stringify(AlexaHandler.subscriptions)}`);
    }

    static async reportStateChange(address, value) {
        try {
            log.silly(`reporting value ${value} for ${address}...`)
            let response = await IwgClient.put(`/clients/${IwgClient.id}/values`, { address: address, value: value });
            if (response.status >= 300) {
                log.error(`failed reporting state change of ${address}`);
                log.error(`${response}`);
            } 
        } catch (e) {
            log.error(`failed reporting state change of ${address}`)
            log.error(e)
        }
    }

    /**
    * @param {string} id
    * @param {ioBroker.State | null | undefined} state
    */
    static stateChangeHandler(id, state) {

        if (!AlexaHandler.subscriptions.includes(id)) {
            return;
        }

        if (state) {
            // The state was changed
            log.silly(`state ${id} changed: ${state.val}(ack = ${state.ack})`);
            
            // report only acknowledged changes
            if (state.ack) {

                // check whether this state has a cooldown which is already running or has to be started
                let capability = null

                for(let e of AlexaHandler.endpoints) {
                    for (let c of e.capabilities) {
                        if (AlexaHandler.capabilitesWithCooldown.hasOwnProperty(c.namespace) && JSON.stringify(c.properties).includes(id)) {
                            capability = c;
                            break;
                        }
                    }
                    if (capability) {
                        break;
                    }
                }


                if (capability) {
                    let coolingDown = AlexaHandler.cooldowns.has(id) ? AlexaHandler.cooldowns.get(id) : false;
                    if (coolingDown) {
                        log.silly(`skipped reporting state ${id} change due to cooldown`);
                        return;
                    } else {
                        // start cooldown
                        AlexaHandler.cooldowns.set(id, true)
                        // reset cooldown after a predefined time
                        setTimeout(function() {
                            AlexaHandler.cooldowns.set(id, false)
                        }, AlexaHandler.capabilitesWithCooldown[capability.namespace] * 1000)
                    }
                }

                // no need to wait for the promise to be resolved here
                AlexaHandler.reportStateChange(id, state.val);
            } else {
                log.silly(`skipped reporting state ${id} change due to ack = ${state.ack}`);
            }
            
        } else {
            // The state was deleted
            // log.info(`state ${id} deleted`);
        }
    }

    static async capabilities() {
        try {
            return require('./capabilities.json')
        } catch (e) {
            log.error(`failed fetching capabilitites`)
            log.error(e)
        }
        return null;
    }

    static async accounts() {
        try {
            log.silly(`fetching account...`)
            let response = await IwgClient.post(`/clients/${IwgClient.id}/accounts`, {});
            return response.data;
        } catch (e) {
            log.error(`failed fetching account`)
            log.error(e)
        }
        return null;
    }

    static async statesTree() {

        function removeChildrenIfEmpty(root) {
            if (!root || !root.children) {
                return;
            }
            if (root.children.length == 0) {
                delete root.children;
                return;
            }
    
            for (let child of root.children) {
                removeChildrenIfEmpty(child)
            }
        }

        function getTreeItem(tree, parts) {
            if (parts.length == 0) {
                return tree
            }
    
            let first = parts.shift()
            let node = tree.children.find(e => e.friendly_name == first);
            if (node) {
                return getTreeItem(node, parts);
            } else {
                while (first) {
                    const child = {
                        friendly_name: first,
                        children: [],
                        id: crypto.randomUUID()
                    }
                    tree.children.push(child);
                    tree = child;
                    first = parts.shift()
                }
                return tree;
            }
        }

        let states = (await AlexaHandler.adapter.getObjectView('system', 'state')).rows || [];

        // // only writable states
        // states = states.filter(s => s.value.common.write);

        const tree = {
            friendly_name: 'states',
            /**
            * @type {any[]}
            */
            children: []
        }

        for (let s of states) {
            let parts = s.id.split('.');
            let item = getTreeItem(tree, parts);
            item.id = s.id;
            item.type = s.value.common.type
        }

        removeChildrenIfEmpty(tree);

        return tree;
    }
}

module.exports = AlexaHandler;