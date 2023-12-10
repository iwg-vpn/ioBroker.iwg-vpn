'use strict';
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, './lib/.env') })

const IwgClient = require("./lib/iwg-client");
const HttpServer = require("./lib/http-server");
// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const FileSystemHelper = require('./lib/file-system-helper');
const AdapterProvider = require('./lib/adapter-provider');
const HttpClient = require('./lib/http-client');
const AlexaClient = require('./lib/alx-client');

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
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.clientId = null;
    }

    async onMessage(msg) {
        this.log.silly(`message received: ${JSON.stringify(msg)}`);

        if (!this.client) {
            return this.sendTo(msg.from, msg.command, { error: 'Not connected yet' }, msg.callback);
        }

        switch (msg.command) {
            case 'get-hosts':
                this.sendTo(msg.from, msg.command, this.client.getHosts(), msg.callback);
                break;

            case 'validate-config':
                let params = null;
                if (typeof (msg.message) === 'string') {
                    try {
                        // hack to extract nested json objects
                        params = JSON.parse((msg.message || '{}').replace('"{', '{').replace('}"', '}')).config;
                    } catch (e) {
                        const response = `Error parsing ${msg.message}`;
                        this.log.warn(response)
                        this.sendTo(msg.from, msg.command, { error: response }, msg.callback);
                        return;
                    }
                }
                if (params) {
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
        await AdapterProvider.start(this);
        FileSystemHelper.start();
        await HttpClient.start();
        this.client = new IwgClient();
        await this.client.start();
        this.httpServer = new HttpServer();
        await this.httpServer.start();
        await AlexaClient.start(this.config?.params?.alexaEnabled)
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
            if (this.httpServer) {
                this.httpServer.stop();
            }

            AlexaClient.cleanup();

            callback();
        } catch (e) {
            callback();
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