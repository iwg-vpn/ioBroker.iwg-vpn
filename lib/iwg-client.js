const SERVER = 'iwg-vpn.net';
const PROTOCOL = 'https';
const INTERFACE = 'iwg0';
process.env.NODE_ENV = 'production';
const NodeRSA = require('node-rsa');
const { default: axios } = require('axios');
const path = require('path');
const jwt = require('jwt-simple');
const childProcess = require("child_process");
const os = require('os');
const FileSystemHelper = require('./file-system-helper');
const keyGenerator = new (require(path.join(__dirname, 'key-generator')))();
const Deferred = require(path.join(__dirname, 'deferred'));

let log;
const INITIAL_HEARTBEAT_RATE = 2 * 60 * 1000;
const STOPPED = 'stopped';
const PRIVATE_KEY_PLACEHOLDER = '<private_key>';

class IwgClient {
    get stopped() {
        return this._stopped;
    }

    set stopped(value) {
        this._stopped = value;
    }
    get iptablesInstalled() {
        return this._iptablesInstalled;
    }

    set iptablesInstalled(value) {
        this._iptablesInstalled = value;
    }
    get wgConfigFromServer() {
        return this._wgConfigFromServer;
    }

    set wg(value) {
        this._wg = value;
    }
    get wg_quick() {
        return this._wg_quick;
    }

    set wg_quick(value) {
        this._wg_quick = value;
    }
    get adapter() {
        return this._adapter;
    }

    set adapter(value) {
        this._adapter = value;
    }
    get settings() {
        return this._settings;
    }

    set settings(value) {
        this._settings = value;
    }
    static keys = {};
    /**
     * @type {string}
     */
    static token;
    /**
     * @type {string}
     */
    static id;
    constructor(adapter) {
        log = adapter.log;
        this._settings = {};
        this._adapter = adapter;
        this._wg_quick = null;
        this._wg = null;
        this._stopped = new Deferred();
        this._wgConfigFromServer = {};
        this._iptablesInstalled = false;
    }

    async start() {
        try {
            this.isLinux = ['freebsd', 'linux', 'openbsd'].indexOf(process.platform) !== -1;
            try {
                let wg;
                if (this.isLinux) {
                    wg = await this.run('which wg-quick');
                } else {
                    wg = await this.run('where wireguard')
                }

                if (!wg) {
                    log.error(`Couldn't find wg-quick. please follow the adapter's How-To documentation`);
                    return;
                }

                this.wg_quick = wg.replace(os.EOL, '');
            } catch (e) {
                log.error(`Ups... Something went wrong while looking for wg-quick`);
                return;
            }

            try {
                let ipTables = await this.run('which iptables');

                if (!ipTables) {
                    log.warn(`iptables package is not found. NAT functionality will not be available. Please follow the adapter's How-To documentation if NAT required.`);
                } else {
                    this.iptablesInstalled = true;
                }
            } catch {
                // nop
            }

            if (this.isLinux) {
                try {
                    const wg = await this.run('which wg');
                    this.wg = wg.replace(os.EOL, '');

                } catch (e) {
                    log.error(`Couldn't find wg. Please follow the adapter How-To documentation`);
                    return;
                }

                if (!FileSystemHelper.exists(`/etc/sudoers.d/iobroker_iwg`)) {
                    log.error(`The ioBroker hasn't got required permissions assigned. Please follow the adapter How-To documentation`);
                    return;
                }
            }

            await IwgClient.generateClientKeys();

            await this.autoGenerateKeysForPeers();

            IwgClient.id = await this.getClientId();

            if (IwgClient.id) {
                await this.callWithExponentialBackoff(this.register.bind(this));
                if (this.registered) {
                    const respond = await this.createLocalPeer();
                    const localIp = respond.config.assigned_cidrs[0].split('/')[0];
                    // intentionally not awaiting the promise to be resolved
                    this.adapter.setLocalPeerAddress(localIp);

                    await this.publishPeers();

                    // intentionally not awaiting the promise to be resolved
                    this.adapter.setConnectionStatus(true);
                    // intentionally not awaiting the promise to be resolved
                    this.sync();
                    // intentionally not awaiting the promise to be resolved
                    this.updateWgInfo();
                } else {
                    log.error(`Could not register. Suspending...`)
                }
            } else {
                log.error(`Could not get ioBroker id. Suspending...`)
            }
        }
        catch (e) {
            log.error(`Ups... something went wrong. ${e}`);
        }
    }

    stop() {
        log.silly(`adapter stopped`);
        this.stopped.resolve(STOPPED);
        // intentionally not awaiting the promise to be resolved
        this.adapter.setConnectionStatus(false);
        if (this.configFile) {
            // intentionally not awaiting the promise to be resolved
            this.down();
        }
    }

    /**
     * @param {number} ms
     */
    sleep(ms) {
        log.silly(`sleeping for ${ms}ms`);
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    /**
     * @param {string} cmd
     */
    async run(cmd) {
        return new Promise((resolve, reject) => {
            childProcess.exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                }
                if (stderr) {
                    reject(stderr);
                }
                resolve(stdout);
            });
        });
    }


    /**
     * @param {string} cmd
     * @param args
     * @param input
     */
    async runInShell(cmd, args = [], input = '') {
        return new Promise((resolve, reject) => {
            const result = childProcess.spawnSync(cmd, args, { input: input, shell: true });
            if (result.error || result.status !== 0) {
                reject(result);
            } else {
                resolve(result);
            }
        });
    }

    isWarning(e) {
        const message = typeof (e) == 'string' ? e : (e && e.hasOwnProperty('message') && typeof (e.message === 'string') ? e.message : '')
        return message.indexOf('Warning') !== -1;
    }

    interface() {
        return `${this.wgConfigFromServer.interface || INTERFACE}`;
    }

    async interfaceExists() {
        let output = null;
        try {
            const cmd = this.isLinux ? `ip link show` : `ipconfig`;
            log.silly('checking interface existence');
            output = await this.run(cmd);
        } catch (e) {
            log.silly(e);
        }
        return output && output.indexOf(this.interface()) !== -1;
    }

    async down() {
        try {
            if (await this.interfaceExists()) {
                const cmd = this.isLinux ? `sudo ${this.wg_quick} down ${this.configFile}` : `"${this.wg_quick}" /uninstalltunnelservice ${this.interface()}`;
                log.silly('getting interface down');
                await this.run(cmd);
            }
        } catch (e) {
            if (!this.isWarning(e)) {
                log.debug('failed to get WireGuard interface down')
                log.silly(e);
            }
        }
    }

    async up() {
        try {
            if (!(await this.interfaceExists())) {
                const cmd = this.isLinux ? `sudo ${this.wg_quick} up ${this.configFile}` : `"${this.wg_quick}" /installtunnelservice "${this.configFile}"`;
                log.silly('getting interface up');
                await this.run(cmd);
            }
        } catch (e) {
            if (!this.isWarning(e)) {
                log.error('Failed to get WireGuard interface up')
                throw e;
            }
        }
    }

    async restartInterface() {
        await this.down();
        await this.up();
    }

    async applyConfig(wgConfigFromServer) {
        try {
            if (typeof (wgConfigFromServer) == 'string') {
                wgConfigFromServer = JSON.parse(wgConfigFromServer);
            }
        } catch (e) {
            log.error(`Error parsing config ${wgConfigFromServer}. ${e}`);
            return;
        }

        // messages from server
        const messages = (wgConfigFromServer.meta || {}).messages || [];
        messages.forEach((/** @type {{ text: string; severity: string; }} */ message) => {
            if (message.severity in log && typeof log[message.severity] === "function") {
                log[message.severity](message.text);
            }
        });

        try {
            // replace placeholder with data
            wgConfigFromServer.local = wgConfigFromServer.local.replace(PRIVATE_KEY_PLACEHOLDER, IwgClient.keys.localPeerPrivateKey);

            if (this.wgConfigFromServer.local !== wgConfigFromServer.local) {
                log.debug('local peer config changed or started with no config');

                this.configFile = path.join(FileSystemHelper.wgConfigFolder(), `${wgConfigFromServer.interface}.conf`);

                try {
                    // write to file
                    await FileSystemHelper.createFolder(FileSystemHelper.wgConfigFolder())

                    log.silly('persisting new config');
                    await FileSystemHelper.write(this.configFile, wgConfigFromServer.local);

                } catch (err) {
                    log.warning(`Error while writing local peer config file`);
                    log.error(err);
                    log.info(`Giving it another try...`);

                    // write to file
                    await FileSystemHelper.createFolder(FileSystemHelper.wgConfigIobFolder())

                    this.configFile = path.join(FileSystemHelper.wgConfigIobFolder(), `${wgConfigFromServer.interface}.conf`);

                    log.debug('persisting new config');
                    await FileSystemHelper.write(this.configFile, wgConfigFromServer.local);
                }

                // apply changes to interface
                await this.restartInterface();

                // store the server wireguard config as latest local own
                this.wgConfigFromServer.local = wgConfigFromServer.local;

                // TODO: update adapters states ?
            }
        } catch (e) {
            log.error(`Error while applying local peer config`);
            log.error(e);
        }

        // PEERS

        try {
            // check whether the local remotes cache corresponds to the server's remotes
            if (this.wgConfigFromServer.rawRemotesConfig !== JSON.stringify(wgConfigFromServer.remotes)) {

                log.debug('remotes config changed or started with no config');
                this.wgConfigFromServer.rawRemotesConfig = JSON.stringify(wgConfigFromServer.remotes);
                // add names
                const self = this;
                const keys = Object.keys(wgConfigFromServer.remotes);
                keys.forEach(key => wgConfigFromServer.remotes[key].name = wgConfigFromServer.remotes[key].id.replace(`${IwgClient.id}-`, ''));

                // store the remotes config got from server als the latest known one
                this.wgConfigFromServer.remotesConfig = wgConfigFromServer.remotes;

                // replace <private_key> placeholders with auto generated keys
                const activePeers = this.activePeers();
                keys
                    .filter(key => {
                        const ip = self.wgConfigFromServer.remotesConfig[key].address;
                        return activePeers.filter(p => p.ip === ip && p.isAutoGenerateKeys).length > 0;
                    })
                    .forEach(key => {
                        const ip = self.wgConfigFromServer.remotesConfig[key].address;
                        const privateKeyFile = self.privateKeyFileName(ip);
                        if (FileSystemHelper.exists(privateKeyFile)) {
                            try {
                                let config = self.wgConfigFromServer.remotesConfig[key].config;
                                if (config) {
                                    const privateKey = FileSystemHelper.readSync(privateKeyFile).replace(os.EOL, '');
                                    self.wgConfigFromServer.remotesConfig[key].config = config.replace(PRIVATE_KEY_PLACEHOLDER, privateKey);
                                }
                            } catch {
                                // nop
                            }
                        } else {
                            log.error(`Cannot ingest private key. File ${privateKeyFile} not found.`)
                        }
                    });

                // set peers' states
                // intentionally not awaiting the promise to be resolved
                this.adapter.setPeerStates(this.wgConfigFromServer.remotesConfig);
            }
        } catch (e) {
            log.error(`Error while applying PEERS config`);
            log.error(e);
            // reset remote states
            // intentionally not awaiting the promise to be resolved
            this.adapter.setPeerStates({});
        }

        // cache the rest of the server's config
        this.wgConfigFromServer.assigned_cidrs = wgConfigFromServer.assigned_cidrs;
    }

    /**
     * @param {number} ms
     */
    async stoppedBefore(ms) {
        const stopped = await Promise.race([this.stopped.promise, this.sleep(ms)]);
        return stopped === STOPPED;
    }

    async callWithExponentialBackoff(fn, depth = 0) {
        try {
            return await fn();
        } catch (e) {
            if (depth > 4) {
                throw e;
            }
            if (!(await this.stoppedBefore(2 ** depth * INITIAL_HEARTBEAT_RATE))) {
                return this.callWithExponentialBackoff(fn, depth + 1);
            }
        }
    }

    async sync() {
        let failedTriesCount = 0;
        let nextHeartBeat;
        do {
            let response;
            try {
                // sync client
                response = await IwgClient.get(`/clients/${IwgClient.id}`);
                let config;
                if (response.status === 200) {
                    log.silly(`successfully synced with server`);
                    config = (response.data || {}).config;
                    await this.applyConfig(config);
                } else {
                    log.error(`Got respond with code ${response.status} while syncing with server`);
                }

                // this.adapter.setConnectionStatus(true);

                failedTriesCount = 0;
                nextHeartBeat = ((config || {}).meta || {}).next_heartbeat || INITIAL_HEARTBEAT_RATE;
            } catch (e) {
                log.error(e);
                // intentionally not awaiting the promise to be resolved
                this.adapter.setConnectionStatus(false);
                failedTriesCount = failedTriesCount > 4 ? 5 : failedTriesCount + 1;
                nextHeartBeat = INITIAL_HEARTBEAT_RATE;
            }

            nextHeartBeat = 2 ** failedTriesCount * nextHeartBeat;

        } while (!(await this.stoppedBefore(nextHeartBeat)))
    }

    async updateWgInfo() {
        const infoUpdateInterval = 60 * 1000;
        let pingErrorsCounter = 0;
        do {
            try {
                const vpnServer = '10.0.0.1';
                const cmd = this.isLinux ? `ping -c1 ${vpnServer}` : `ping -n 1 ${vpnServer}`;
                await this.run(cmd);
                pingErrorsCounter = 0;
                // intentionally not awaiting the promise to be resolved
                this.adapter.setConnectionStatus(true);
            } catch (e) {
                
                log.silly(`error pinging server`);
                log.silly(e);
                pingErrorsCounter++;
                if (pingErrorsCounter > 2) {
                    // intentionally not awaiting the promise to be resolved
                    this.adapter.setConnectionStatus(false);
                }
            }

            // not supported on windows yet
            if (this.isLinux) {
                try {
                    const info = await this.run(`sudo ${this._wg} show`)
                    const lines = info.split(os.EOL);
                    const handshake = lines.filter((/** @type {string} */ l) => l.indexOf('handshake') !== -1)[0];

                    if (handshake) {
                        const time = (handshake.split(':')[1] || '').trim();
                        log.silly(`latest handshake: ${time}`)
                        // intentionally not awaiting the promise to be resolved
                        this.adapter.setLatestHandshake(time);
                    }

                    const transfer = lines.filter((/** @type {string} */ l) => l.indexOf('transfer') !== -1)[0];
                    if (transfer) {
                        const received = ((transfer.split(':')[1] || '').split(' received')[0] || '').trim();
                        log.silly(`received: ${received}`);
                        // intentionally not awaiting the promise to be resolved
                        this.adapter.setTransferReceived(received);
                        const sent = (((transfer.split(':')[1] || '').split(',')[1] || '').split(' sent')[0] || '').trim();
                        log.silly(`sent: ${sent}`);
                        // intentionally not awaiting the promise to be resolved
                        this.adapter.setTransferSent(sent);
                    }
                } catch (e) {
                    log.silly(`error while updating wg info`);
                    log.silly(e);
                }
            }
        } while (!(await this.stoppedBefore(infoUpdateInterval)))
    }

    async getClientId() {
        const adapter = this.adapter;
        if (adapter.id) {
            return adapter.id;
        }
        return new Promise((resolve) => {
            adapter.getForeignObject('system.meta.uuid', (err, uuidObj) => {
                if (uuidObj && uuidObj.native && uuidObj.native.uuid) {
                    adapter.getForeignObject('system.adapter.' + adapter.namespace, (err, obj) => {
                        if (obj) {
                            log.info('Set id to: ' + uuidObj.native.uuid);
                            resolve(uuidObj.native.uuid);
                        } else {
                            log.error('Could not get system.adapter namespace');
                            resolve(null);
                        }
                    });
                } else {
                    log.error('Could not get system.meta.uuid');
                    resolve(null);
                }
            });
        });
    }

    static generateToken() {
        if (!IwgClient.token) {
            const payload = {
                iss: IwgClient.id
            };
            IwgClient.token = jwt.encode(payload, IwgClient.keys.private, 'RS256');
        }

        return IwgClient.token;
    }

    static async generateClientKeys() {
        let publicKeyFileName = path.join(FileSystemHelper.keysFolder() + 'public.pem');
        let privateKeyFileName = path.join(FileSystemHelper.keysFolder() + 'private.pem');

        if (!FileSystemHelper.exists(publicKeyFileName)) {
            log.debug(`no keys found. generating...`);

            await FileSystemHelper.createFolder(FileSystemHelper.keysFolder());
            const rsa = new NodeRSA();
            rsa.generateKeyPair(2048);
            IwgClient.keys = {
                publicPem: rsa.exportKey('pkcs8-public-pem') + '\n',
                private: rsa.exportKey('pkcs1-private-pem') + '\n'
            };
            log.debug(`persisting generated keys...`);

            await FileSystemHelper.write(publicKeyFileName, rsa.exportKey('pkcs8-public-pem') + '\n');
            await FileSystemHelper.write(privateKeyFileName, rsa.exportKey('pkcs1-private-pem') + '\n');
        } else {
            log.debug(`keys found. importing...`);
            IwgClient.keys = {
                publicPem: FileSystemHelper.readSync(publicKeyFileName),
                private: FileSystemHelper.readSync(privateKeyFileName)
            };
        }
    }

    /**
     * @param {string} ip
     */
    privateKeyFileName(ip) {
        const ipAsLong = this.ip2long(ip);
        return path.join(FileSystemHelper.keysFolder(), `privatekey${ipAsLong}`);
    }

    /**
     * @param {string} ip
     */
    publicKeyFileName(ip) {
        const ipAsLong = this.ip2long(ip);
        return path.join(FileSystemHelper.keysFolder(), `publickey${ipAsLong}`);
    }

    async autoGenerateKeysForPeers(peers) {
        const self = this;
        try {
            peers = peers || this.activePeers().filter(p => p.isAutoGenerateKeys);
            await peers.reduce(async (memo, peer) => {
                await memo;
                const privateKeyFileName = self.privateKeyFileName(peer.ip);
                const publicKeyFileName = self.publicKeyFileName(peer.ip);

                if (!FileSystemHelper.exists(`${privateKeyFileName}`)) {
                    log.silly(`generating keys for ${peer.name} peer...`);
                    const keyPair = keyGenerator.generateKeypair();
                    FileSystemHelper.writeSync(`${privateKeyFileName}`, keyPair.privateKey);
                    FileSystemHelper.writeSync(`${publicKeyFileName}`, keyPair.publicKey);
                }
            }, undefined);
        } catch (e) {
            log.error(`Error while generating keys for a peer`);
            throw e;
        }

        // delete keys of non-active peers and peers with provided keys
        try {
            // all inactive peers
            let peersToDeleteKeysOf = this.inactivePeers();

            // add peers with provided keys
            peersToDeleteKeysOf = peersToDeleteKeysOf.concat(this.activePeers().filter(p => !p.isAutoGenerateKeys));

            await peersToDeleteKeysOf.reduce(async (memo, peer) => {
                await memo;
                const privateKeyFileName = self.privateKeyFileName(peer.ip);
                const publicKeyFileName = self.publicKeyFileName(peer.ip);

                if (FileSystemHelper.exists(`${privateKeyFileName}`)) {
                    log.silly(`deleting private key for ${peer.name} peer...`);
                    await FileSystemHelper.delete(`${privateKeyFileName}`);
                }
                if (FileSystemHelper.exists(`${publicKeyFileName}`)) {
                    log.silly(`deleting public key for ${peer.name} peer...`);
                    await FileSystemHelper.delete(`${publicKeyFileName}`);
                }
            }, undefined);
        } catch {
            // nop
        }
    }

    /**
     * @param {string} ip
     */
    isValidIP(ip) {
        return /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ip);
    }

    /**
     * @param {string} key
     */
    async isValidKey(key) {
        try {
            const cmd = `sudo ${this._wg} pubkey`;
            await this.runInShell(cmd, [], key || '');
            return true;
        } catch {
            return false;
        }
    }

    async validateConfig(peers, nats) {
        const overlap = nats.filter(nat => peers.some(peer => peer.ip === nat.src)).length > 0;
        if (overlap) {
            throw new Error(`PEERS configuration overlaps with NAT configuration`);
        }

        const uniqueRemoteIps = [...new Set(peers.map(r => r.ip))]
        if (uniqueRemoteIps.length !== peers.length) {
            throw new Error(`PEERS configuration contains non-unique IP addresses`);
        }

        const hosts = this.getHosts().map(h => h.value);
        if (hosts.length) {
            const ipNotIncluded = uniqueRemoteIps.filter(ip => !hosts.includes(ip)).length > 0;
            if (ipNotIncluded) {
                const msg = `PEERS configuration contains IP addresses from non-available subnets`;
                throw new Error(msg);
            }
        }

        const peersWithNotAutoGeneratedKeys = peers.filter(p => !p.isAutoGenerateKeys);
        const uniqueRemoteKeys = [...new Set(peersWithNotAutoGeneratedKeys.map(p => p.publicKey))]
        if (uniqueRemoteKeys.length !== peersWithNotAutoGeneratedKeys.length) {
            throw new Error(`PEERS configuration contains non-unique public keys`);
        }

        const self = this;

        await peersWithNotAutoGeneratedKeys.reduce(async (memo, remote) => {
            await memo;
            if (!(await self.isValidKey(remote.publicKey))) {
                throw new Error(`Invalid public key ${remote.publicKey}`)
            }
        }, undefined);

        nats.forEach(nat => {
            if (!self.isValidIP(nat.dst)) {
                throw new Error(`Invalid IP address ${nat.dst}`);
            }

            if (hosts.includes(nat.dst)) {
                throw new Error(`Destination IP ${nat.dst} must not be from VPN address space`);
            }
        })

        const uniqueNats = [...new Set(nats.map(n => n.src))]
        if (uniqueNats.length !== nats.length) {
            throw new Error(`NAT configuration contains non-unique IP addresses`);
        }
    }

    activePeers() {
        return (((this.adapter.config || {}).params || {}).remotes || []).filter(lr => lr.isActive);
    }

    inactivePeers() {
        return (((this.adapter.config || {}).params || {}).remotes || []).filter(lr => !lr.isActive);
    }

    activeNats() {
        // nat not supported on windows yet
        if (!this.isLinux) {
            return [];
        }

        // no iptables - no NAT
        if (!this.iptablesInstalled) {
            return [];
        }

        return (((this.adapter.config || {}).params || {}).nats || []).filter(n => n.isActive);
    }

    async publishPeers() {
        // take only active peers
        const activePeers = this.activePeers();

        try {
            await this.validateConfig(activePeers, this.activeNats())
        }
        catch (e) {
            if (e instanceof Error) {
                log.error(e.message);
            }
            log.error(`Skipped publishing PEERS to server due to invalid config`);
            return;
        }

        try {
            const self = this;
            // auto generate keys for peers
            // intentionally not awaiting the promise to be resolved
            self.autoGenerateKeysForPeers();

            const payload = {
                remotes: activePeers.map(peer => {
                    let publicKey;
                    if (peer.isAutoGenerateKeys) {
                        publicKey = FileSystemHelper.readSync(self.publicKeyFileName(peer.ip)).replace(os.EOL, '');
                    } else {
                        publicKey = peer.publicKey;
                    }
                    return {
                        name: peer.name,
                        address: peer.ip,
                        public_key: publicKey
                    }
                })
            }

            // send peers to server   
            log.silly(`publishing peers configuration...`);
            const response = await IwgClient.post(`/clients/${IwgClient.id}/sync_remotes`, payload);
            if (response.status === 200) {
                log.debug(`successfully published PEERS to server`);
                log.silly(`got response: ${JSON.stringify(response.data)}`)
            } else {
                log.error(`Got respond with code ${response.status} while publishing PEERS to server`);
                // set state showing error
            }

            // TODO: set state with remote config

        } catch (e) {
            log.error(`Error while publishing PEERS`);
            throw e;
        }
    }

    async createLocalPeer() {
        try {
            let localPeerPublicKey = path.join(FileSystemHelper.keysFolder(), 'publickey');
            let localPeerPrivateKey = path.join(FileSystemHelper.keysFolder(), 'privatekey');
            if (!FileSystemHelper.exists(localPeerPrivateKey)) {
                log.silly(`generating keys for the local peer...`);
                const keyPair = keyGenerator.generateKeypair();
                await FileSystemHelper.write(localPeerPrivateKey, keyPair.privateKey);
                await FileSystemHelper.write(localPeerPublicKey, keyPair.publicKey);
            }
            const publicKey = (await FileSystemHelper.read(localPeerPublicKey)).replace(os.EOL, '');
            IwgClient.keys.localPeerPrivateKey = (await FileSystemHelper.read(localPeerPrivateKey)).replace(os.EOL, '');

            const activeNats = this.activeNats();

            await this.validateConfig(this.activePeers(), activeNats);

            log.silly(`creating a local peer...`);
            const response = await IwgClient.post(`/clients/${IwgClient.id}/local_peer`, { public_key: publicKey, nats: activeNats });
            if (response.status === 201) {
                log.silly(`successfully created a local peer; config: ${JSON.stringify(response.data)}`);
                return response.data;
            } else {
                log.error(`Got respond with code ${response.status} while creating a local peer`);
            }
        } catch (e) {
            log.error(`Error while creating a local peer`);
            throw e;
        }
    }

    async register() {
        let payload = {
            client_id: IwgClient.id,
            public_key: IwgClient.keys.publicPem,
            version: (this.adapter.common || {}).installedVersion || '0.0.0',
            platform: process.platform
        };

        log.debug('registering client at ' + SERVER);
        let response;
        try {
            // register or update client
            response = await IwgClient.post('/clients', payload);
            if (response.status === 201) {
                log.info(`Successfully registered client`);
                this.registered = true;
            } else {
                log.error(`Got respond with code ${response.status} while registering client`);
            }
        } catch (e) {
            log.error(e);
            throw e;
        }
    }

    /**
     * @param {string} url
     * @param payload
     */
    static async post(url, payload) {
        const absoluteUrl = IwgClient.composeAbsoluteUrl(url);
        const body = JSON.stringify(payload);
        log.silly(`POST ${absoluteUrl}; body: ${body}`)
        return axios.post(absoluteUrl, body, { headers: IwgClient.headers() });
    }

    /**
     * @param {string} url
     * @param payload
     */
    static async put(url, payload) {
        const absoluteUrl = IwgClient.composeAbsoluteUrl(url);
        const body = JSON.stringify(payload);
        log.silly(`PUT ${absoluteUrl}; body: ${body}`)
        return axios.put(absoluteUrl, body, { headers: IwgClient.headers() });
    }

    /**
     * @param {string} url
     */
    static async get(url) {
        const absoluteUrl = IwgClient.composeAbsoluteUrl(url);
        log.silly(`GET ${absoluteUrl}`)
        return axios.get(absoluteUrl, { headers: IwgClient.headers() });
    }

    static headers() {
        return {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + IwgClient.generateToken()
        }
    }

    /**
     * @param {string} path
     */
    static composeAbsoluteUrl(path) {
        return `${PROTOCOL}://${SERVER}/api/v1${path}`;
    }

    /**
     * @param {string} ip
     */
    ip2long(ip) {
        const o = ip.split('.').map(s => parseInt(s))
        return (16777216 * o[0]) + (65536 * o[1]) + (256 * o[2]) + o[3]
    }

    getHosts() {
        const self = this;
        /**
         * @param {number} proper_address
         */
        function long2ip(proper_address) {
            let output = '';
            if (!isNaN(proper_address) && (proper_address >= 0 || proper_address <= 4294967295)) {
                output = Math.floor(proper_address / Math.pow(256, 3)) + '.' +
                    Math.floor((proper_address % Math.pow(256, 3)) / Math.pow(256, 2)) + '.' +
                    Math.floor(((proper_address % Math.pow(256, 3)) % Math.pow(256, 2)) / Math.pow(256, 1)) + '.' +
                    Math.floor((((proper_address % Math.pow(256, 3)) % Math.pow(256, 2)) % Math.pow(256, 1)) / Math.pow(256, 0));
            }
            return output;
        }

        /**
         * @param {string } cidr
         */
        function cidrToHosts(cidr) {
            let hosts = [];
            const parts = cidr.split('/');
            const start = self.ip2long(parts[0]);
            const end = Math.pow(2, 32 - parseInt(parts[1])) + start - 1;
            for (let i = start + 1; i <= end; i++) {
                const ip = long2ip(i);
                hosts.push({ label: ip, value: ip });
            }
            return hosts;
        }

        let hosts = [];

        if (this.wgConfigFromServer) {
            (this.wgConfigFromServer.assigned_cidrs || []).forEach((/** @type {string} */ cidr) => hosts = hosts.concat(cidrToHosts(cidr)));
        }

        return hosts;
    }
}

module.exports = IwgClient;