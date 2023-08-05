const fs = require('fs');
const path = require('path');
const utils = require('@iobroker/adapter-core');
const AdapterProvider = require('./adapter-provider');

class FileSystemHelper {
    /**
     * @type {string}
     */
    static rootFolder;
    static start() {
        this.rootFolder = utils.getAbsoluteInstanceDataDir(AdapterProvider.get());
    }

    static async createFolder(folderPath) {
        return new Promise((resolve, reject) => {
            fs.access(folderPath, (error) => {
                if (error) {
                    // If the directory does not exist, then create it
                    fs.mkdir(folderPath, { recursive: true }, (error) => {
                        if (error) {
                            reject(error);
                        } else {
                            resolve(0);
                        }
                    });
                } else {
                    resolve(0)
                }
            });
        })
    }

    static absolutePath(relativePath) {
        return path.join(FileSystemHelper.rootFolder, relativePath)
    }

    static keysFolder() {
        return path.join(FileSystemHelper.rootFolder, '/keys/');
    }

    static wgConfigFolder() {
        return path.join(FileSystemHelper.rootFolder, '/wg-config/');
    }

    static wgConfigIobFolder() {
        return path.join(FileSystemHelper.rootFolder, '/wg-config-iob/');
    }

    static exists(fileName) {
        return fs.existsSync(fileName);
    }

    static async read(fileName) {
        return await fs.promises.readFile(fileName, 'utf-8');
    }

    static readSync(fileName) {
        return fs.readFileSync(fileName, 'utf-8');
    }

    static async write(fileName, content) {
        return await fs.promises.writeFile(fileName, content);
    }

    static writeSync(fileName, content) {
        return fs.writeFileSync(fileName, content);
    }

    static async delete(fileName) {
        return await fs.promises.unlink(fileName);
    }

}

module.exports = FileSystemHelper;