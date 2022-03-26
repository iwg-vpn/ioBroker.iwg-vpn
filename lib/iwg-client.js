const SERVER = 'iwg-vpn.net';
const PROTOCOL = 'https';
const INTERFACE = 'iwg0';
process.env.NODE_ENV = 'production';
const NodeRSA = require('node-rsa');
const { default: axios } = require('axios');
const fs = require('fs');
const path = require('path');
const jwt = require('jwt-simple');
const childProcess = require("child_process");
const os = require('os');
const keyGenerator = new (require(path.join(__dirname, 'key-generator')))();

let log;
const keysDir = path.join(__dirname, '/../keys/');
const wgConfigDir = path.join(__dirname, '/../wg-config/');
const wgConfigDirIob = path.join(__dirname, '/../wg-config-iob/');
const INITIAL_HEARTBEAT_RATE = 2 * 60 * 1000;
const STOPPED = 'stopped';
const PRIVATE_KEY_PLACEHOLDER = '<private_key>';

class Deferred {
    constructor() {
        this.promise = new Promise((resolve, reject) => {
            this.reject = reject
            this.resolve = resolve
        })
    }
}

class IwgClient {
    constructor(adapter) {
        log = adapter.log;
        this.settings = {};
        this.adapter = adapter;
        this.wg_quick = null;
        this.wg = null;
        this.stopped = new Deferred();
        this.wgConfigFromServer = {};
    }

    async start() {
        try {
            this.isLinux = ['freebsd', 'linux', 'openbsd'].indexOf(process.platform) != -1;
            try {
                let wg = null;
                if (this.isLinux) {
                    wg = await this.run('which wg-quick');
                } else {
                    wg = await this.run('where wireguard')
                }

                if (!wg) {
                    throw new Error();
                }

                this.wg_quick = wg.replace(os.EOL, '');
            } catch (e) {
                log.error(`Couldn't find wg-quick. please follow the adapter How-To documentation`);
                return;
            }

            if (this.isLinux) {
                try {
                    const wg = await this.run('which wg');
                    this.wg = wg.replace(os.EOL, '');

                } catch (e) {
                    log.error(`Couldn't find wg. Please follow the adapter How-To documentation`);
                    return;
                }

                if (!fs.existsSync(`/etc/sudoers.d/iobroker_iwg`)) {
                    log.error(`The iobroker hasn't got required permissions assigned. Please follow the adapter How-To documentation`);
                    return;
                }
            }

            await this.generateClientKeys();

            await this.autoGenerateKeysForPeers();

            this.id = await this.getClientId();

            if (this.id) {
                await this.callWithExponentialBackoff(this.register.bind(this));
                if (this.registered) {
                    const respond = await this.createLocalPeer();
                    const localIp = respond.config.assigned_cidrs[0].split('/')[0];
                    this.adapter.setLocalPeerAddress(localIp);

                    await this.publishPeers();

                    this.adapter.setConnectionStatus(true);
                    this.sync();
                    this.updateWgInfo();
                } else {
                    log.error(`Could not register. Suspending...`)
                }
            } else {
                log.error(`Could not get iobroker id. Suspending...`)
            }
        }
        catch (e) {
            log.error(`Ups... something went wrong. ${e}`);
        }
    }

    stop() {
        log.silly(`adapter stopped`);
        this.stopped.resolve(STOPPED);
        this.adapter.setConnectionStatus(false);
        if (this.configFile) {
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
     */
    async runInShell(cmd, args = [], input = '') {
        return new Promise((resolve, reject) => {
            const result = childProcess.spawnSync(cmd, args, { input: input, shell: true });
            if (result.error || result.status != 0) {
                reject(result);
            } else {
                resolve(result);
            }
        });
    }

    isWarning(e) {
        const message = typeof (e) == 'string' ? e : (e && e.hasOwnProperty('message') && typeof (e.message == 'string') ? e.message : '')
        return message.indexOf('Warning') != -1;
    }

    interface() {
        return `${this.wgConfigFromServer.interface || INTERFACE}`;
    }

    async interfaceExists() {
        let output = null;
        try {
            const cmd = this.isLinux ? `ip link show` : `ipconfig`;
            log.silly('checking interface existance');
            output = await this.run(cmd);
        } catch (e) {
            log.silly(e);
        } finally {
            return output && output.indexOf(this.interface()) != -1;
        }
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

    /**
     * @param { string } file
     */
    read(file) {
        try {
            return fs.readFileSync(file, 'utf-8');
        } catch (e) {
            log.error(e);
            throw e;
        }
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

        log.silly(`applying config ${JSON.stringify(wgConfigFromServer)}`);

        // messages from server
        const messages = (wgConfigFromServer.meta || {}).messages || [];
        messages.forEach((/** @type {{ text: string; severity: string; }} */ message) => {
            if (message.severity in log && typeof log[message.severity] === "function") {
                log[message.severity](message.text);
            }
        });

        try {
            // replace placeholder with data
            wgConfigFromServer.local = wgConfigFromServer.local.replace(PRIVATE_KEY_PLACEHOLDER, this.settings.keys.localPeerPrivateKey);

            if (this.wgConfigFromServer.local != wgConfigFromServer.local) {
                log.debug('local peer config changed or started with no config');

                this.configFile = `${wgConfigDir}${wgConfigFromServer.interface}.conf`;

                try {
                    // write to file
                    if (!fs.existsSync(wgConfigDir)) {
                        fs.mkdirSync(wgConfigDir);
                    }

                    log.silly('persisting new config');
                    fs.writeFileSync(this.configFile, wgConfigFromServer.local);
                } catch (err) {
                    log.warning(`Error while writing local peer config file`);
                    log.error(err);
                    log.info(`Giving it another try...`);

                    // write to file
                    if (!fs.existsSync(wgConfigDirIob)) {
                        fs.mkdirSync(wgConfigDirIob);
                    }

                    this.configFile = `${wgConfigDirIob}${wgConfigFromServer.interface}.conf`;

                    log.debug('persisting new config');
                    fs.writeFileSync(this.configFile, wgConfigFromServer.local);
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
            if (JSON.stringify(this.wgConfigFromServer.remotesConfig || {}) != JSON.stringify(wgConfigFromServer.remotes)) {
                log.debug('remotes config changed or started with no config');

                // add names
                const self = this;
                const keys = Object.keys(wgConfigFromServer.remotes);
                keys.forEach(key => wgConfigFromServer.remotes[key].name = wgConfigFromServer.remotes[key].id.replace(`${self.id}-`, ''));

                // store the remotes config got from server als latest known one
                this.wgConfigFromServer.remotesConfig = wgConfigFromServer.remotes;

                // replace <private_key> placeholders with auto generated keys
                const activePeers = this.activePeers();
                keys
                    .filter(key => {
                        const ip = self.wgConfigFromServer.remotesConfig[key].address;
                        return activePeers.filter(p => p.ip == ip && p.isAutoGenerateKeys).length > 0;
                    })
                    .forEach(key => {
                        const ip = self.wgConfigFromServer.remotesConfig[key].address;
                        const privateKeyFile = self.privateKeyFileName(ip);
                        if (fs.existsSync(privateKeyFile)) {
                            try {
                                let config = self.wgConfigFromServer.remotesConfig[key].config;
                                if (config) {
                                    const privateKey = self.read(privateKeyFile).replace(os.EOL, '');
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
                this.adapter.setPeerStates(this.wgConfigFromServer.remotesConfig);
            }
        } catch (e) {
            log.error(`Error while applying PEERS config`);
            log.error(e);
            // reset remote states
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
        return stopped == STOPPED;
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
                response = await this.get(`/clients/${this.id}`);
                let config;
                if (response.status == 200) {
                    log.silly(`successfuly syncked with server`);
                    config = (response.data || {}).config;
                    await this.applyConfig(config);
                } else {
                    log.error(`Got respond with code ${response.status} while syncking with server`);
                }

                this.adapter.setConnectionStatus(true);

                failedTriesCount = 0;
                nextHeartBeat = ((config || {}).meta || {}).next_heartbeat || INITIAL_HEARTBEAT_RATE;
            } catch (e) {
                log.error(e);
                this.adapter.setConnectionStatus(false);
                failedTriesCount = failedTriesCount > 4 ? 5 : failedTriesCount + 1;
                nextHeartBeat = INITIAL_HEARTBEAT_RATE;
            }

            nextHeartBeat = 2 ** failedTriesCount * nextHeartBeat;

        } while (!(await this.stoppedBefore(nextHeartBeat)))
    }

    async updateWgInfo() {
        const infoUpdateInterval = 1 * 60 * 1000;
        do {
            try {
                const vpnServer = '10.0.0.1';
                const cmd = this.isLinux ? `ping -c1 ${vpnServer}` : `ping -n 1 ${vpnServer}`;
                await this.run(cmd);
            } catch (e) {
                log.silly(`error pinging server`);
                log.silly(e);
            }

            // not supported on windows yet
            if (this.isLinux) {
                try {
                    const info = await this.run(`sudo ${this.wg} show`)
                    const lines = info.split(os.EOL);
                    const handshake = lines.filter((/** @type {string} */ l) => l.indexOf('handshake') != -1)[0];

                    if (handshake) {
                        const time = (handshake.split(':')[1] || '').trim();
                        log.silly(`latest handshake: ${time}`)
                        this.adapter.setLatestHandshake(time);
                    }

                    const transfer = lines.filter((/** @type {string} */ l) => l.indexOf('transfer') != -1)[0];
                    if (transfer) {
                        const received = ((transfer.split(':')[1] || '').split(' received')[0] || '').trim();
                        log.silly(`received: ${received}`);
                        this.adapter.setTransferReceived(received);
                        const sent = (((transfer.split(':')[1] || '').split(',')[1] || '').split(' sent')[0] || '').trim();
                        log.silly(`sent: ${sent}`);
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

    generateToken() {
        if (!this.token) {
            const payload = {
                iss: this.id
            };
            this.token = jwt.encode(payload, this.settings.keys.private, 'RS256');
        }

        return this.token;
    }

    async generateClientKeys() {
        const self = this;

        return new Promise((resolve) => {
            if (!fs.existsSync(keysDir + 'public.pem')) {
                log.debug(`no keys found. generating...`);
                if (!fs.existsSync(keysDir)) {
                    fs.mkdirSync(keysDir);
                }
                const rsa = new NodeRSA();
                rsa.generateKeyPair(2048);
                self.settings.keys = {
                    publicPem: rsa.exportKey('pkcs8-public-pem') + '\n',
                    private: rsa.exportKey('pkcs1-private-pem') + '\n'
                };
                log.debug(`persisting generated keys...`);
                fs.writeFileSync(keysDir + 'public.pem', rsa.exportKey('pkcs8-public-pem') + '\n');
                fs.writeFileSync(keysDir + 'private.pem', rsa.exportKey('pkcs1-private-pem') + '\n');
            } else {
                log.debug(`keys found. importing...`);
                self.settings.keys = {
                    publicPem: self.read(keysDir + 'public.pem'),
                    private: self.read(keysDir + 'private.pem')
                };
            }

            resolve(0);
        })
    }

    /**
     * @param {string} ip
     */
    privateKeyFileName(ip) {
        const ipAsLong = this.ip2long(ip);
        return `${keysDir}privatekey${ipAsLong}`;
    }

    /**
     * @param {string} ip
     */
    publicKeyFileName(ip) {
        const ipAsLong = this.ip2long(ip);
        return `${keysDir}publickey${ipAsLong}`;
    }

    async autoGenerateKeysForPeers(peers) {
        try {
            peers = peers || this.activePeers().filter(p => p.isAutoGenerateKeys);
            const self = this;
            await peers.reduce(async (memo, peer) => {
                await memo;
                const privateKeyFileName = self.privateKeyFileName(peer.ip);
                const publicKeyFileName = self.publicKeyFileName(peer.ip);

                if (!fs.existsSync(`${privateKeyFileName}`)) {
                    log.silly(`generating keys for ${peer.name} peer...`);
                    const keyPair = keyGenerator.generateKeypair();
                    fs.writeFileSync(`${privateKeyFileName}`, keyPair.privateKey);
                    fs.writeFileSync(`${publicKeyFileName}`, keyPair.publicKey);
                }
            }, undefined);
        } catch (e) {
            log.error(`Error while generating keys for a peer`);
            throw e;
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
            const cmd = `sudo ${this.wg} pubkey`;
            await this.runInShell(cmd, [], key || '');
            return true;
        } catch {
            return false;
        }
    }

    async validateConfig(peers, nats) {
        const overlap = nats.filter(nat => peers.some(peer => peer.ip == nat.src)).length > 0;
        if (overlap) {
            throw new Error(`PEERS configuration overlaps with NAT configuration`);
        }

        const uniqueRemoteIps = [...new Set(peers.map(r => r.ip))]
        if (uniqueRemoteIps.length != peers.length) {
            throw new Error(`PEERS configuration contains non-unique IP addresses`);
        }

        const peersWithNotAutoGeneratedKeys = peers.filter(p => !p.isAutoGenerateKeys);
        const uniqueRemoteKeys = [...new Set(peersWithNotAutoGeneratedKeys.map(p => p.publicKey))]
        if (uniqueRemoteKeys.length != peersWithNotAutoGeneratedKeys.length) {
            throw new Error(`PEERS configuration contains non-unique public keys`);
        }

        const self = this;

        await peersWithNotAutoGeneratedKeys.reduce(async (memo, remote) => {
            await memo;
            if (!(await self.isValidKey(remote.publicKey))) {
                throw new Error(`Invalid public key ${remote.publicKey}`)
            }
        }, undefined);

        const hosts = this.getHosts().map(h => h.value);

        nats.forEach(nat => {
            if (!self.isValidIP(nat.dst)) {
                throw new Error(`Invalid IP address ${nat.dst}`);
            }

            if (hosts.includes(nat.dst)) {
                throw new Error(`Destination IP ${nat.dst} must not be from VPN address space`);
            }
        })

        const uniqueNats = [...new Set(nats.map(n => n.src))]
        if (uniqueNats.length != nats.length) {
            throw new Error(`NAT configuration contains non-unique IP addresses`);
        }
    }

    activePeers() {
        return (((this.adapter.config || {}).params || {}).remotes || []).filter(lr => lr.isActive);
    }

    activeNats() {
        // nat not supported on windows yet
        if (!this.isLinux) {
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
            self.autoGenerateKeysForPeers();

            const payload = {
                remotes: activePeers.map(peer => {
                    let publicKey = null;
                    if (peer.isAutoGenerateKeys) {
                        publicKey = self.read(self.publicKeyFileName(peer.ip)).replace(os.EOL, '');
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
            const response = await this.post(`/clients/${this.id}/sync_remotes`, payload);
            if (response.status == 200) {
                log.debug(`successfuly published PEERS to server`);
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
            if (!fs.existsSync(`${keysDir}privatekey`)) {
                log.silly(`generating keys for the local peer...`);
                const keyPair = keyGenerator.generateKeypair();
                fs.writeFileSync(`${keysDir}privatekey`, keyPair.privateKey);
                fs.writeFileSync(`${keysDir}publickey`, keyPair.publicKey);
            }
            const publicKey = this.read(`${keysDir}publickey`).replace(os.EOL, '');
            this.settings.keys.localPeerPrivateKey = this.read(`${keysDir}privatekey`).replace(os.EOL, '');
            const activeNats = this.activeNats();

            await this.validateConfig(this.activePeers(), activeNats);

            log.silly(`creating a local peer...`);
            const response = await this.post(`/clients/${this.id}/local_peer`, { public_key: publicKey, nats: activeNats });
            if (response.status == 201) {
                log.silly(`successfuly created a local peer; config: ${JSON.stringify(response.data)}`);
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
            client_id: this.id,
            public_key: this.settings.keys.publicPem,
            version: (this.adapter.common || {}).installedVersion || '0.0.0',
            platform: process.platform
        };

        log.debug('registering client at ' + SERVER);
        let response;
        try {
            // register or update client
            response = await this.post('/clients', payload);
            if (response.status == 201) {
                log.info(`Successfuly registered client`);
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
     */
    async post(url, payload) {
        const absoluteUrl = await this.composeAbsoluteUrl(url);
        const body = JSON.stringify(payload);
        log.silly(`POST ${absoluteUrl}; body: ${body}`)
        return axios.post(absoluteUrl, body, { headers: this.headers() });
    }

    /**
     * @param {string} url
     */
    async get(url) {
        const absoluteUrl = await this.composeAbsoluteUrl(url);
        log.silly(`GET ${absoluteUrl}`)
        return axios.get(absoluteUrl, { headers: this.headers() });
    }

    headers() {
        return {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + this.generateToken()
        }
    }

    /**
     * @param {string} path
     */
    async composeAbsoluteUrl(path) {
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