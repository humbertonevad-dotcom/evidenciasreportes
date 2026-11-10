"use strict";

const fs = require("fs");
const { randomUUID } = require("crypto");

function readJsonFile(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJsonFile(filePath, value) {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
        fs.renameSync(temporaryPath, filePath);
    } catch (error) {
        if (!["EPERM", "EEXIST", "ENOTEMPTY"].includes(error.code) || !fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(temporaryPath);
            } catch (cleanupError) {
                if (cleanupError.code !== "ENOENT") {
                    console.error("No se pudo limpiar un archivo temporal:", cleanupError.message);
                }
            }
            throw error;
        }
        try {
            fs.copyFileSync(temporaryPath, filePath);
            fs.unlinkSync(temporaryPath);
        } catch (copyError) {
            try {
                fs.unlinkSync(temporaryPath);
            } catch (cleanupError) {
                if (cleanupError.code !== "ENOENT") {
                    console.error("No se pudo limpiar un archivo temporal:", cleanupError.message);
                }
            }
            throw copyError;
        }
    }
}

module.exports = { readJsonFile, saveJsonFile };
