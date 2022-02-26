'use strict';

const { adapter } = require('@iobroker/adapter-core');
const iwgClient = require("./lib/iwg-client");
// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

class IwgVpn extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'iwg-vpn',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.clientId = null;
    }

    async onMessage(msg) {

        this.log.silly(`message received: ${JSON.stringify(msg)}`);

        switch (msg.command) {
            case 'get-hosts':
                if (!this.client) {
                    this.sendTo(msg.from, msg.command, [{ label: 'Not connected yet', value: '' }], msg.callback);
                } else {
                    this.sendTo(msg.from, msg.command, this.client.getHosts(), msg.callback);
                }
                break;

            case 'validate-config':
                let params = null;
                try {
                    // hack to extract nested json objects
                    params = JSON.parse(msg.message.replace('"{', '{').replace('}"', '}')).config;
                } catch (e) {
                    this.log.warn(`Error parsing ${msg.message}`)
                }

                if (params) {
                    if (this.client) {
                        try {
                            await this.client.validateConfig((params.remotes || []).filter(r => r.isActive), (params.nats || []).filter(n => n.isActive));
                            this.sendTo(msg.from, msg.command, '', msg.callback);
                        } catch (e) {
                            let response = 'Configuration is invalid';
                            if (e instanceof Error) {
                                response = e.message;
                            }
                            this.sendTo(msg.from, msg.command, { error: response }, msg.callback);
                        }
                    }
                }

                break;
        }
    }

    /**
     * @param {{ [x: string]: any; }} peersObject
     */
    async setPeerStates(peersObject) {
        const device = 'Peers';
        const keys = Object.keys(peersObject);
        const self = this;

        await this.deleteDeviceAsync(device);
        await this.createDeviceAsync(device);

        // create a channel for every peer
        // @ts-ignore
        await keys.reduce(async (memo, key) => {
            await memo;
            const peer = peersObject[key];
            await self.createChannelAsync(device, peer.name);
            const prefix = `${device}.${peer.name}`;

            await self.setObjectNotExistsAsync(`${prefix}.address`, {
                type: 'state',
                common: {
                    name: 'address',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false
                },
                native: {}
            });

            await self.setStateAsync(`${prefix}.address`, peer.address, true);

            await self.setObjectNotExistsAsync(`${prefix}.config`, {
                type: 'state',
                common: {
                    name: 'config',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false
                },
                native: {}
            });

            await self.setStateAsync(`${prefix}.config`, peer.config, true);


        }, undefined);
    }

    async set() {
        return await this.setStateAsync(arguments[0], arguments[1], true);
    }

    async setLocalPeerAddress(...args) {
        return await this.set(`local.address`, ...args);
    }

    async setConnectionStatus(...args) {
        return await this.set('info.connection', ...args);
    }

    async setLatestHandshake(...args) {
        return await this.set(`local.handshake`, ...args);
    }

    async setTransferReceived(...args) {
        return await this.set(`local.received`, ...args);
    }

    async setTransferSent(...args) {
        return await this.set(`local.sent`, ...args);
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Reset the connection indicator during startup
        this.setConnectionStatus(false);

        // Initialize your adapter here
        this.client = new iwgClient(this);

        await this.client.start();
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            if (this.client) {
                this.client.stop();
            }
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val}(ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new IwgVpn(options);
} else {
    // otherwise start the instance directly
    new IwgVpn();
}