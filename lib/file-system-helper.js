const fs = require('fs');
const path = require('path');
const utils = require('@iobroker/adapter-core');

class FileSystemHelper {
    /**
     * @type {string}
     */
    static rootFolder;
    static init(adapter) {
        FileSystemHelper.rootFolder = utils.getAbsoluteInstanceDataDir(adapter);
    }

    static async createFolder(path) {
        return new Promise((resolve, reject) => {
            fs.access(path, (error) => {
                if (error) {
                    // If the directory does not exist, then create it
                    fs.mkdir(path, { recursive: true }, (error) => {
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

    static absolutePath(path) {
        return path.join(FileSystemHelper.rootFolder + path)
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

    static exists(file) {
        return fs.existsSync(file);
    }

    static async read(file) {
        return fs.promises.readFile(file, 'utf-8');
    }

    static readSync(file) {
        return fs.readFileSync(file, 'utf-8');
    }

    static async write(file, content) {       
        return fs.promises.writeFile(file, content);
    }

    static async writeSync(file, content) {       
        return fs.writeFileSync(file, content);
    }
}

module.exports = FileSystemHelper;