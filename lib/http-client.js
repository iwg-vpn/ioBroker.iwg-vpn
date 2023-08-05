const jwt = require('jwt-simple');
const AdapterProvider = require("./adapter-provider");
const FileSystemHelper = require('./file-system-helper');
const path = require('path');
const NodeRSA = require('node-rsa');
const { default: axios } = require('axios');

const SERVER = process.env.SERVER;
const PROTOCOL = process.env.PROTOCOL;

class HttpClient {
    static keys = {};
    static async start() {
        this.log = AdapterProvider.get().log;
        this.keys = await this.generateKeyPair();
        this.token = await this.generateToken();
    }

    static get publicKey() {
        return this.keys.public;
    }

    static async get(url) {
        this.log.silly(`GET ${url}`)
        return axios.get(url, { headers: this.headers });
    }

    static async put(url, payload) {
        const body = JSON.stringify(payload);
        this.log.silly(`PUT ${url}; body: ${body}`)
        return axios.put(url, body, { headers: this.headers });
    }

    static async post(url, payload) {
        const body = JSON.stringify(payload);
        this.log.silly(`POST ${url}; body: ${body}`)
        return axios.post(url, body, { headers: this.headers });
    }

    static composeAbsoluteUrl(path, apiVersion) {
        apiVersion = apiVersion;
        return `${PROTOCOL}://${SERVER}/api/${apiVersion}${path}`;
    }

    static get headers() {
        return {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + this.token
        }
    }

    static async generateKeyPair() {
        let publicKeyFileName = path.join(FileSystemHelper.keysFolder() + 'public.pem');
        let privateKeyFileName = path.join(FileSystemHelper.keysFolder() + 'private.pem');
        let keys = {};
        if (!FileSystemHelper.exists(publicKeyFileName)) {
            this.log.debug(`no keys found. generating...`);

            await FileSystemHelper.createFolder(FileSystemHelper.keysFolder());
            const rsa = new NodeRSA();
            rsa.generateKeyPair(2048);
            keys = {
                public: rsa.exportKey('pkcs8-public-pem') + '\n',
                private: rsa.exportKey('pkcs1-private-pem') + '\n'
            };
            this.log.debug(`persisting generated keys...`);

            await FileSystemHelper.write(publicKeyFileName, rsa.exportKey('pkcs8-public-pem') + '\n');
            await FileSystemHelper.write(privateKeyFileName, rsa.exportKey('pkcs1-private-pem') + '\n');
        } else {
            this.log.debug(`keys found. importing...`);
            keys = {
                public: FileSystemHelper.readSync(publicKeyFileName),
                private: FileSystemHelper.readSync(privateKeyFileName)
            };
        }
        return keys;
    }

    static async generateToken() {
        const payload = {
            iss: await AdapterProvider.clientId()
        };
        return jwt.encode(payload, this.keys.private, 'RS256');
    }
}

module.exports = HttpClient;