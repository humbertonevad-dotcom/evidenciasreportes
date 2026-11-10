"use strict";

// # AQUI SE CONFIGURA EXPRESS, SOCKET.IO Y EL ALMACENAMIENTO LOCAL
const express = require("express");
const http = require("http");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const {
    randomBytes,
    randomUUID,
    scrypt,
    scryptSync,
    timingSafeEqual
} = require("crypto");
const { promisify } = require("util");
const { Server } = require("socket.io");
const { readJsonFile, saveJsonFile } = require("./src/storage/jsonFile");
const { createDailyReportsWorkbook } = require("./src/reports/dailyWorkbook");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const scryptAsync = promisify(scrypt);
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_DAILY_REPORT_LENGTH = 12000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const uploadDirectory = path.join(__dirname, "uploads");
const usersFilePath = path.join(__dirname, "users.json");
const reportsFilePath = path.join(__dirname, "reports.json");
const messagesFilePath = path.join(__dirname, "messages.json");
const dailyReportsFilePath = path.join(__dirname, "daily_reports.json");
const dailyReportFilesDirectory = path.join(__dirname, "daily_reports_files");
const incidencesFilePath = path.join(__dirname, "incidencias.json");
const notificationsFilePath = path.join(__dirname, "notifications.json");
const activeSockets = new Map();
const sessions = new Map();
const loginFailures = new Map();
const allowedRoles = new Set(["operador", "supervisor", "admin"]);
const allowedStatuses = new Set(["Activo", "En Receso", "Desactivo"]);
const allowedExtensions = new Set([".csv", ".xls", ".xlsx"]);
const cookieName = "evidencia_session";
const dummyPasswordSalt = randomBytes(16).toString("hex");

fs.mkdirSync(uploadDirectory, { recursive: true });

function normalizeUsername(username) {
    return username.trim().normalize("NFKC").toLocaleLowerCase("es");
}

function publicUser(user) {
    return { username: user.username, role: user.role };
}

function hashPassword(password, salt) {
    return scryptSync(password, salt, 64).toString("hex");
}

function saveUsers(users) {
    saveJsonFile(usersFilePath, users);
}

function loadUsers() {
    if (fs.existsSync(usersFilePath)) {
        const storedUsers = readJsonFile(usersFilePath, []);
        if (!Array.isArray(storedUsers)) {
            throw new Error("users.json tiene un formato inválido. Corrige el archivo antes de iniciar.");
        }
        let migrated = false;
        const users = storedUsers.map(user => {
            if (!user || typeof user.username !== "string" || !allowedRoles.has(user.role)) {
                throw new Error("users.json tiene un formato inválido. Corrige el archivo antes de iniciar.");
            }
            if (typeof user.passwordHash === "string" && typeof user.salt === "string") {
                if (!/^[a-f\d]{128}$/i.test(user.passwordHash) || !/^[a-f\d]{32}$/i.test(user.salt)) {
                    throw new Error("Una cuenta de users.json tiene un hash inválido.");
                }
                return {
                    username: user.username,
                    role: user.role,
                    salt: user.salt,
                    passwordHash: user.passwordHash
                };
            }
            if (typeof user.password !== "string" || !user.password || user.password.length > 256) {
                throw new Error("Una cuenta de users.json no tiene una credencial válida.");
            }
            migrated = true;
            const salt = randomBytes(16).toString("hex");
            return {
                username: user.username,
                role: user.role,
                salt,
                passwordHash: hashPassword(user.password, salt)
            };
        });
        if (new Set(users.map(user => normalizeUsername(user.username))).size !== users.length) {
            throw new Error("users.json contiene nombres duplicados.");
        }
        if (migrated) {
            saveUsers(users);
            console.warn("Se migraron las credenciales de users.json a hashes scrypt.");
        }
        return users;
    }

    const defaults = [
        { username: "Humberto Nevado", role: "operador" },
        { username: "Alejandro Supervisor", role: "supervisor" },
        { username: "Directiva Admin", role: "admin" }
    ].map(user => {
        const salt = randomBytes(16).toString("hex");
        return { ...user, salt, passwordHash: hashPassword("123", salt) };
    });
    saveUsers(defaults);
    console.warn("Se crearon usuarios locales de prueba. Cambia sus contraseñas antes de exponer el portal a una red.");
    return defaults;
}

let users = loadUsers();

function loadReports() {
    const savedReports = readJsonFile(reportsFilePath, []);
    if (!Array.isArray(savedReports)) {
        throw new Error("reports.json tiene un formato inválido. Corrige el archivo antes de iniciar.");
    }
    return savedReports;
}

let reports = loadReports();

function saveReports() {
    saveJsonFile(reportsFilePath, reports);
}

function loadMessages() {
    const savedMessages = readJsonFile(messagesFilePath, []);
    if (!Array.isArray(savedMessages) || savedMessages.some(message =>
        !message || !["general", "private"].includes(message.type) ||
        typeof message.sender !== "string" || typeof message.text !== "string" ||
        typeof message.sentAt !== "string" ||
        (message.type === "private" && typeof message.target !== "string")
    )) {
        throw new Error("messages.json tiene un formato inválido. Corrige el archivo antes de iniciar.");
    }
    return savedMessages;
}

let messages = loadMessages();

function saveMessages(updatedMessages) {
    saveJsonFile(messagesFilePath, updatedMessages);
}

function loadDailyReports() {
    const savedReports = readJsonFile(dailyReportsFilePath, []);
    if (!Array.isArray(savedReports) || savedReports.some(report =>
        !report || typeof report.id !== "string" || !/^[a-f\d-]{36}$/i.test(report.id) ||
        typeof report.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(report.date) ||
        typeof report.operator !== "string" || typeof report.content !== "string" ||
        typeof report.submittedAt !== "string"
    )) {
        throw new Error("daily_reports.json tiene un formato inválido. Corrige el archivo antes de iniciar.");
    }
    for (const report of savedReports) {
        if (report.details != null) report.details = normalizeDailyReportDetails(report.details);
    }
    let migrated = false;
    for (const report of savedReports) {
        const fileName = reportFileName(report);
        const filePath = path.join(dailyReportFilesDirectory, fileName);
        if (!fs.existsSync(filePath)) {
            report.fileName = saveDailyReportFile(report);
            migrated = true;
        } else if (report.fileName !== fileName) {
            report.fileName = fileName;
            migrated = true;
        }
    }
    if (migrated) saveDailyReports(savedReports);
    return savedReports;
}

let dailyReports = loadDailyReports();

function saveDailyReports(updatedReports) {
    saveJsonFile(dailyReportsFilePath, updatedReports);
}

function loadIncidences() {
    const savedIncidences = readJsonFile(incidencesFilePath, []);
    if (!Array.isArray(savedIncidences) || savedIncidences.some(incidence =>
        !incidence || typeof incidence.id !== "string" ||
        !["RECLAMO", "CONVENIO"].includes(incidence.type) ||
        typeof incidence.date !== "string" || typeof incidence.operator !== "string" ||
        typeof incidence.razonSocial !== "string" || typeof incidence.cc !== "string" ||
        typeof incidence.municipio !== "string" || typeof incidence.submittedAt !== "string" ||
        (incidence.amount != null && (!Number.isFinite(incidence.amount) || incidence.amount < 0)) ||
        (incidence.contact && (typeof incidence.contact.name !== "string" ||
            typeof incidence.contact.phone !== "string"))
    )) {
        throw new Error("incidencias.json tiene un formato inválido. Corrige el archivo antes de iniciar.");
    }
    return savedIncidences;
}

let incidences = loadIncidences();

function saveIncidences(updatedIncidences) {
    saveJsonFile(incidencesFilePath, updatedIncidences);
}

function loadNotifications() {
    const savedNotifications = readJsonFile(notificationsFilePath, []);
    if (!Array.isArray(savedNotifications) || savedNotifications.some(notification =>
        !notification || typeof notification.id !== "string" ||
        typeof notification.recipient !== "string" || typeof notification.title !== "string" ||
        typeof notification.text !== "string" || typeof notification.createdAt !== "string" ||
        (notification.readAt != null && typeof notification.readAt !== "string") ||
        (notification.action != null && (!notification.action ||
            notification.action.type !== "private-chat" || typeof notification.action.target !== "string"))
    )) {
        throw new Error("notifications.json tiene un formato inválido. Corrige el archivo antes de iniciar.");
    }
    return savedNotifications;
}

let notifications = loadNotifications();

function saveNotifications(updatedNotifications) {
    saveJsonFile(notificationsFilePath, updatedNotifications);
}

function publicNotification(notification) {
    return {
        id: notification.id,
        title: notification.title,
        text: notification.text,
        action: notification.action || null,
        createdAt: notification.createdAt,
        readAt: notification.readAt
    };
}

function notifyUsers(recipients, title, text, action = null) {
    const uniqueRecipients = new Map();
    for (const user of recipients) {
        const key = normalizeUsername(user.username);
        if (!uniqueRecipients.has(key)) uniqueRecipients.set(key, user);
    }
    if (!uniqueRecipients.size) return;

    const createdAt = new Date().toISOString();
    const additions = [...uniqueRecipients.values()].map(user => ({
        id: randomUUID(),
        recipient: user.username,
        title,
        text,
        action,
        createdAt,
        readAt: null
    }));
    const updatedNotifications = [...notifications, ...additions];
    saveNotifications(updatedNotifications);
    notifications = updatedNotifications;
    for (const notification of additions) {
        io.to(userRoom(notification.recipient)).emit("notification:new", publicNotification(notification));
    }
}

function reportFileName(report) {
    return `${report.date}_${report.id}.txt`;
}

function saveDailyReportFile(report) {
    fs.mkdirSync(dailyReportFilesDirectory, { recursive: true });
    const fileName = reportFileName(report);
    const filePath = path.join(dailyReportFilesDirectory, fileName);
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, report.content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    return fileName;
}

function safeUnlink(filePath) {
    try {
        fs.unlinkSync(filePath);
    } catch (error) {
        if (error.code !== "ENOENT") console.error("No se pudo limpiar un archivo:", error.message);
    }
}

function currentReportDate() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Caracas",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(new Date());
    const dateParts = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
}

function optionalCount(value, fieldName) {
    if (value == null || value === "" || (typeof value === "string" && !value.trim())) return null;
    if (!["number", "string"].includes(typeof value)) {
        throw new Error(`${fieldName} debe ser numérico.`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10000000) {
        throw new Error(`${fieldName} debe ser un número entero entre 0 y 10000000.`);
    }
    return parsed;
}

function optionalAmount(value, fieldName) {
    if (value == null || value === "" || (typeof value === "string" && !value.trim())) return null;
    if (!["number", "string"].includes(typeof value)) {
        throw new Error(`${fieldName} debe ser numérico.`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1000000000000) {
        throw new Error(`${fieldName} debe ser un monto válido y no negativo.`);
    }
    if (Math.abs(parsed * 100 - Math.round(parsed * 100)) > 1e-8) {
        throw new Error(`${fieldName} no puede tener más de dos decimales.`);
    }
    return Math.round(parsed * 100) / 100;
}

function boundedText(value, fieldName, maxLength, required = false) {
    if (value == null && !required) return "";
    if (typeof value !== "string") {
        throw new Error(`${fieldName} debe ser texto.`);
    }
    const text = value.trim();
    if ((required && !text) || text.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
        throw new Error(`${fieldName} ${required ? "es obligatorio" : `no puede superar ${maxLength} caracteres`}.`);
    }
    return text;
}

function normalizeDailyReportDetails(value) {
    if (value == null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Los datos estructurados del reporte no son válidos.");
    }
    const stats = value.callStats && typeof value.callStats === "object" && !Array.isArray(value.callStats)
        ? value.callStats
        : {};
    if (value.callStats != null && stats !== value.callStats) {
        throw new Error("Las métricas de llamadas no son válidas.");
    }
    const effectiveByZone = value.effectiveByZone == null ? [] : value.effectiveByZone;
    const payments = value.payments == null ? [] : value.payments;
    if (!Array.isArray(effectiveByZone) || effectiveByZone.length > 50 ||
        !Array.isArray(payments) || payments.length > 100) {
        throw new Error("El reporte excede el máximo de zonas o pagos permitidos.");
    }
    return {
        callStats: {
            callsMade: optionalCount(stats.callsMade, "Llamadas realizadas"),
            callsNotEffective: optionalCount(stats.callsNotEffective, "Llamadas no efectivas"),
            solventesNotLoaded: optionalCount(stats.solventesNotLoaded, "Solventes no cargadas"),
            collectionTotal: optionalAmount(stats.collectionTotal, "Total de cobranza")
        },
        effectiveByZone: effectiveByZone.map((item, index) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                throw new Error(`La zona ${index + 1} no es válida.`);
            }
            const count = optionalCount(item.count, `Llamadas efectivas de la zona ${index + 1}`);
            if (count == null) {
                throw new Error(`Indica el número de llamadas efectivas de la zona ${index + 1}.`);
            }
            return {
                zone: boundedText(item.zone, `Zona ${index + 1}`, 80, true),
                count
            };
        }),
        payments: payments.map((item, index) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                throw new Error(`El pago expedito ${index + 1} no es válido.`);
            }
            const amount = optionalAmount(item.amount, `Monto del pago ${index + 1}`);
            if (amount == null) {
                throw new Error(`Indica el monto del pago expedito ${index + 1}.`);
            }
            return {
                razonSocial: boundedText(item.razonSocial, `Razón social del pago ${index + 1}`, 160, true),
                cc: boundedText(item.cc, `CC del pago ${index + 1}`, 50),
                amount
            };
        })
    };
}

function formatDailyReportContent(details) {
    const lines = ["Reporte detallado de llamadas"];
    const stats = details.callStats;
    if (stats.callsMade != null) lines.push(`Llamadas realizadas: ${stats.callsMade}`);
    for (const zone of details.effectiveByZone) {
        lines.push(`Llamadas efectivas - ${zone.zone}: ${zone.count}`);
    }
    if (stats.callsNotEffective != null) lines.push(`Llamadas no efectivas: ${stats.callsNotEffective}`);
    if (stats.solventesNotLoaded != null) lines.push(`Solventes no cargadas: ${stats.solventesNotLoaded}`);
    if (details.payments.length) {
        lines.push("Pagos expeditos:");
        details.payments.forEach(payment => {
            lines.push(`${payment.razonSocial}${payment.cc ? ` (CC ${payment.cc})` : ""}: ${payment.amount.toFixed(2)}`);
        });
    }
    if (stats.collectionTotal != null) lines.push(`Total cobranza: ${stats.collectionTotal.toFixed(2)}`);
    return lines.join("\n");
}

function persistChatMessage(message, reply) {
    try {
        const updatedMessages = [...messages, message];
        saveMessages(updatedMessages);
        messages = updatedMessages;
        return true;
    } catch (error) {
        console.error("No se pudo guardar el mensaje:", error.message);
        reply({ success: false, message: "No se pudo guardar el mensaje." });
        return false;
    }
}

function readCookie(requestOrSocket, name) {
    const header = requestOrSocket.headers?.cookie || "";
    const cookie = header.split(";").map(part => part.trim())
        .find(part => part.startsWith(`${name}=`));
    if (!cookie) return "";
    try {
        return decodeURIComponent(cookie.slice(name.length + 1));
    } catch {
        return "";
    }
}

function currentSession(token) {
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        sessions.delete(token);
        return null;
    }
    const user = users.find(item => normalizeUsername(item.username) === session.usernameKey);
    if (!user) {
        sessions.delete(token);
        return null;
    }
    return { session, user };
}

function requireAuth(request, response, next) {
    const token = readCookie(request, cookieName);
    const auth = currentSession(token);
    if (!auth) {
        response.status(401).json({ success: false, message: "Inicia sesión para continuar." });
        return;
    }
    request.auth = { token, ...auth };
    next();
}

function requireRole(...roles) {
    return (request, response, next) => {
        if (!roles.includes(request.auth.user.role)) {
            response.status(403).json({ success: false, message: "No tienes permiso para realizar esta acción." });
            return;
        }
        next();
    };
}

function cookieOptions(maxAge) {
    return [
        `${cookieName}=`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${maxAge}`,
        ...(process.env.NODE_ENV === "production" ? ["Secure"] : [])
    ];
}

function setSessionCookie(response, token) {
    const parts = cookieOptions(Math.floor(SESSION_TTL_MS / 1000));
    parts[0] = `${cookieName}=${encodeURIComponent(token)}`;
    response.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(response) {
    const parts = cookieOptions(0);
    parts[0] = `${cookieName}=`;
    response.setHeader("Set-Cookie", parts.join("; "));
}

function userRoom(username) {
    return `user:${encodeURIComponent(normalizeUsername(username))}`;
}

function canChatPrivately(firstRole, secondRole) {
    return firstRole !== "operador" || secondRole !== "operador";
}

function publicOnlineUser(user) {
    return {
        username: user.username,
        role: user.role,
        status: user.status,
        connectedAt: user.connectedAt
    };
}

function getOnlineUsers() {
    const uniqueUsers = new Map();
    for (const user of activeSockets.values()) {
        const key = normalizeUsername(user.username);
        if (!uniqueUsers.has(key)) uniqueUsers.set(key, user);
    }
    return [...uniqueUsers.values()].map(publicOnlineUser);
}

function publishOnlineUsers() {
    io.to("management").emit("users:update", getOnlineUsers());
}

function expireSessions() {
    const expired = new Set();
    for (const [token, session] of sessions) {
        if (session.expiresAt <= Date.now()) {
            sessions.delete(token);
            expired.add(token);
        }
    }
    if (expired.size === 0) return;
    for (const socket of io.sockets.sockets.values()) {
        if (!expired.has(socket.data.sessionToken)) continue;
        removeSocketUser(socket);
        socket.disconnect(true);
    }
}

const sessionSweep = setInterval(expireSessions, 60 * 1000);
sessionSweep.unref();

function removeSocketUser(socket) {
    const user = activeSockets.get(socket.id);
    if (!user) return;
    activeSockets.delete(socket.id);
    socket.leave("general");
    socket.leave("management");
    socket.leave(userRoom(user.username));
    socket.data.user = null;
    publishOnlineUsers();
}

function isLoginBlocked(key) {
    const entry = loginFailures.get(key);
    if (!entry) return false;
    if (entry.blockedUntil <= Date.now()) {
        loginFailures.delete(key);
        return false;
    }
    return entry.count >= 8;
}

function recordLoginFailure(key) {
    const entry = loginFailures.get(key) || { count: 0, blockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= 8) entry.blockedUntil = Date.now() + 15 * 60 * 1000;
    loginFailures.set(key, entry);
}

function clearLoginFailures(key) {
    loginFailures.delete(key);
}

// # AQUI SE LIMITAN LAS PETICIONES Y SE SIRVE SOLO LA INTERFAZ PUBLICA
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use((request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
});

app.get("/", (request, response) => response.sendFile(path.join(__dirname, "index.html")));
app.get("/api/health", (request, response) => response.json({ success: true, status: "ok" }));

// # AQUI SE AUTENTICAN USUARIOS CON HASH SCRYPT Y SE CREA UNA SESION HTTPONLY
app.post("/api/auth/login", async (request, response, next) => {
    try {
        const username = typeof request.body?.username === "string" ? request.body.username.trim().normalize("NFKC") : "";
        const password = typeof request.body?.password === "string" ? request.body.password : "";
        const key = request.ip;
        if (isLoginBlocked(key)) {
            response.status(429).json({ success: false, message: "Demasiados intentos. Intenta de nuevo en 15 minutos." });
            return;
        }
        const user = users.find(item => normalizeUsername(item.username) === normalizeUsername(username));
        let validPassword = false;
        if (password.length <= 256) {
            const calculated = await scryptAsync(password, user?.salt || dummyPasswordSalt, 64);
            if (user) {
                const expected = Buffer.from(user.passwordHash, "hex");
                validPassword = expected.length === calculated.length && timingSafeEqual(expected, calculated);
            }
        }
        if (!user || !validPassword) {
            recordLoginFailure(key);
            response.status(401).json({ success: false, message: "Usuario o contraseña incorrectos." });
            return;
        }

        clearLoginFailures(key);
        const token = randomBytes(32).toString("base64url");
        sessions.set(token, {
            usernameKey: normalizeUsername(user.username),
            expiresAt: Date.now() + SESSION_TTL_MS
        });
        setSessionCookie(response, token);
        response.json({ success: true, user: publicUser(user) });
    } catch (error) {
        next(error);
    }
});

app.get("/api/auth/me", requireAuth, (request, response) => {
    response.json({ success: true, user: publicUser(request.auth.user) });
});

app.post("/api/auth/logout", requireAuth, (request, response) => {
    sessions.delete(request.auth.token);
    for (const socket of io.sockets.sockets.values()) {
        if (socket.data.sessionToken === request.auth.token) {
            removeSocketUser(socket);
            socket.disconnect(true);
        }
    }
    clearSessionCookie(response);
    response.json({ success: true });
});

app.get("/api/notifications", requireAuth, (request, response) => {
    const userNotifications = notifications
        .filter(notification => normalizeUsername(notification.recipient) === normalizeUsername(request.auth.user.username))
        .map(publicNotification);
    response.json({ success: true, notifications: userNotifications });
});

app.post("/api/notifications/read", requireAuth, (request, response, next) => {
    const usernameKey = normalizeUsername(request.auth.user.username);
    const readAt = new Date().toISOString();
    const updatedNotifications = notifications.map(notification =>
        normalizeUsername(notification.recipient) === usernameKey && !notification.readAt
            ? { ...notification, readAt }
            : notification
    );
    try {
        saveNotifications(updatedNotifications);
    } catch (error) {
        next(error);
        return;
    }
    notifications = updatedNotifications;
    response.json({ success: true });
});

// # AQUI SE PERMITE A ADMINISTRACION CREAR USUARIOS CON ROLES VALIDADOS
app.post("/api/users", requireAuth, requireRole("admin"), (request, response) => {
    const username = typeof request.body?.username === "string" ? request.body.username.trim().normalize("NFKC") : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    const role = request.body?.role;
    if (!username || username.length > 80 || /[\u0000-\u001f\u007f]/.test(username) ||
        password.length < 8 || password.length > 128 || !allowedRoles.has(role)) {
        response.status(400).json({
            success: false,
            message: "Indica un nombre válido, una contraseña de 8 a 128 caracteres y un rol permitido."
        });
        return;
    }
    if (users.some(user => normalizeUsername(user.username) === normalizeUsername(username))) {
        response.status(409).json({ success: false, message: "Ya existe una cuenta con ese nombre." });
        return;
    }
    const salt = randomBytes(16).toString("hex");
    const user = { username, role, salt, passwordHash: hashPassword(password, salt) };
    const updatedUsers = [...users, user];
    saveUsers(updatedUsers);
    users = updatedUsers;
    response.status(201).json({ success: true, user: publicUser(user) });
});

// # AQUI SE GUARDAN LOS REPORTES DIARIOS DE LOS OPERADORES
app.post("/api/daily-reports", requireAuth, requireRole("operador"), (request, response, next) => {
    let details;
    try {
        details = normalizeDailyReportDetails(request.body?.details);
    } catch (error) {
        response.status(400).json({ success: false, message: error.message });
        return;
    }
    const notes = typeof request.body?.content === "string" ? request.body.content.trim() : "";
    const hasStructuredData = details && (
        Object.values(details.callStats).some(value => value != null) ||
        details.effectiveByZone.length > 0 || details.payments.length > 0
    );
    if ((!notes && !hasStructuredData) || notes.length > MAX_DAILY_REPORT_LENGTH) {
        response.status(400).json({
            success: false,
            message: `Incluye notas o datos del reporte; las notas no pueden superar ${MAX_DAILY_REPORT_LENGTH} caracteres.`
        });
        return;
    }

    const structuredContent = hasStructuredData ? formatDailyReportContent(details) : "";
    const report = {
        id: randomUUID(),
        date: currentReportDate(),
        operator: request.auth.user.username,
        content: [notes, structuredContent].filter(Boolean).join("\n\n"),
        submittedAt: new Date().toISOString()
    };
    if (hasStructuredData) report.details = details;
    const updatedReports = [...dailyReports, report];
    let fileName;
    try {
        fileName = saveDailyReportFile(report);
        report.fileName = fileName;
        saveDailyReports(updatedReports);
    } catch (error) {
        if (fileName) safeUnlink(path.join(dailyReportFilesDirectory, fileName));
        next(error);
        return;
    }
    dailyReports = updatedReports;
    try {
        notifyUsers(
            users.filter(user => ["admin", "supervisor"].includes(user.role)),
            "Reporte del día",
            `${report.operator} guardó su reporte del ${report.date}.`
        );
    } catch (error) {
        console.error("No se pudo guardar la notificación del reporte diario:", error.message);
    }
    response.status(201).json({ success: true, report });
});

app.post("/api/incidencias", requireAuth, requireRole("operador"), (request, response, next) => {
    const body = request.body || {};
    let incidence;
    try {
        if (!["RECLAMO", "CONVENIO"].includes(body.tipo)) {
            throw new Error("Selecciona Reclamo por tarifa o Convenio de pago.");
        }
        incidence = {
            id: randomUUID(),
            type: body.tipo,
            date: currentReportDate(),
            operator: request.auth.user.username,
            razonSocial: boundedText(body.razonSocial, "Razón social", 160, true),
            cc: boundedText(body.cc, "CC", 50, true),
            municipio: boundedText(body.municipio, "Municipio", 120),
            description: boundedText(body.descripcion, "Motivo u observaciones", 1000),
            amount: optionalAmount(body.monto, "Monto"),
            contact: {
                name: boundedText(body.contactoNombre, "Nombre del contacto", 120),
                phone: boundedText(body.contactoTelefono, "Teléfono del contacto", 40)
            },
            submittedAt: new Date().toISOString()
        };
    } catch (error) {
        response.status(400).json({ success: false, message: error.message });
        return;
    }
    const updatedIncidences = [...incidences, incidence];
    try {
        saveIncidences(updatedIncidences);
    } catch (error) {
        next(error);
        return;
    }
    incidences = updatedIncidences;

    try {
        notifyUsers(
            users.filter(user => ["admin", "supervisor"].includes(user.role)),
            "Incidencia del día",
            `${incidence.operator} registró ${incidence.type === "RECLAMO" ? "un reclamo por tarifa" : "un convenio de pago"} para ${incidence.razonSocial}.`
        );
    } catch (error) {
        console.error("No se pudo guardar la notificación de la incidencia:", error.message);
    }
    response.status(201).json({ success: true, incidencia: incidence });
});

app.get("/api/incidencias", requireAuth, (request, response) => {
    const visibleIncidences = request.auth.user.role === "operador"
        ? incidences.filter(incidence =>
            normalizeUsername(incidence.operator) === normalizeUsername(request.auth.user.username))
        : incidences;
    response.json({
        success: true,
        incidencias: visibleIncidences,
        reclamos: visibleIncidences.filter(incidence => incidence.type === "RECLAMO"),
        convenios: visibleIncidences.filter(incidence => incidence.type === "CONVENIO")
    });
});

app.get("/api/daily-reports", requireAuth, (request, response) => {
    const visibleReports = request.auth.user.role === "operador"
        ? dailyReports.filter(report => normalizeUsername(report.operator) === normalizeUsername(request.auth.user.username))
        : dailyReports;
    response.json({ success: true, reports: visibleReports });
});

app.get("/api/daily-reports/all/txt", requireAuth, (request, response) => {
    const visibleReports = request.auth.user.role === "operador"
        ? dailyReports.filter(report => normalizeUsername(report.operator) === normalizeUsername(request.auth.user.username))
        : dailyReports;
    if (!visibleReports.length) {
        response.status(404).json({ success: false, message: "No hay reportes diarios para descargar." });
        return;
    }

    const content = [
        "========================================",
        "CONSOLIDADO DE REPORTES DIARIOS - EVIDENCIA",
        `Fecha de exportación: ${new Date().toISOString()}`,
        "========================================",
        "",
        ...visibleReports.flatMap(report => [
            "----------------------------------------",
            `FECHA: ${report.date}`,
            `OPERADOR: ${report.operator}`,
            `ENVIADO: ${report.submittedAt}`,
            "----------------------------------------",
            report.content,
            ""
        ])
    ].join("\r\n");
    response
        .status(200)
        .type("text/plain")
        .set("Content-Disposition", 'attachment; filename="Consolidado_Reportes_Diarios.txt"')
        .send(content);
});

app.delete("/api/daily-reports/:id", requireAuth, requireRole("admin"), (request, response, next) => {
    const report = dailyReports.find(item => item.id === request.params.id);
    if (!report) {
        response.status(404).json({ success: false, message: "No se encontró el reporte solicitado." });
        return;
    }

    const filePath = path.join(dailyReportFilesDirectory, reportFileName(report));
    let fileContents = null;
    try {
        fileContents = fs.readFileSync(filePath);
    } catch (error) {
        if (error.code !== "ENOENT") {
            next(error);
            return;
        }
    }

    try {
        if (fileContents) fs.unlinkSync(filePath);
        const updatedReports = dailyReports.filter(item => item.id !== report.id);
        saveDailyReports(updatedReports);
        dailyReports = updatedReports;
    } catch (error) {
        if (fileContents) {
            try {
                fs.writeFileSync(filePath, fileContents, { mode: 0o600 });
            } catch (restoreError) {
                console.error("No se pudo restaurar el archivo del reporte tras un error de eliminación:", restoreError.message);
            }
        }
        next(error);
        return;
    }

    response.json({ success: true, message: "El reporte diario y su archivo fueron eliminados." });
});

app.delete("/api/incidencias/:id", requireAuth, requireRole("admin"), (request, response, next) => {
    const updatedIncidences = incidences.filter(incidence => incidence.id !== request.params.id);
    if (updatedIncidences.length === incidences.length) {
        response.status(404).json({ success: false, message: "No se encontró la incidencia solicitada." });
        return;
    }
    try {
        saveIncidences(updatedIncidences);
    } catch (error) {
        next(error);
        return;
    }
    incidences = updatedIncidences;
    response.json({ success: true, message: "La incidencia fue eliminada." });
});

app.get("/api/daily-reports/:id/file", requireAuth, (request, response) => {
    const report = dailyReports.find(item => item.id === request.params.id);
    if (!report) {
        response.status(404).json({ success: false, message: "No se encontró el reporte solicitado." });
        return;
    }
    if (request.auth.user.role === "operador" &&
        normalizeUsername(report.operator) !== normalizeUsername(request.auth.user.username)) {
        response.status(403).json({ success: false, message: "No tienes permiso para descargar este reporte." });
        return;
    }
    const fileName = reportFileName(report);
    const filePath = path.join(dailyReportFilesDirectory, fileName);
    if (!fs.existsSync(filePath)) {
        response.status(404).json({ success: false, message: "El archivo de este reporte no está disponible en el servidor." });
        return;
    }
    response.download(filePath, `${report.date}_${report.operator.replace(/[^\w.-]+/g, "_")}.txt`);
});

// # AQUI SE GENERA EL EXCEL CON LOS REPORTES DIARIOS GUARDADOS
app.get("/api/daily-reports/excel", requireAuth, async (request, response, next) => {
    const visibleReports = request.auth.user.role === "operador"
        ? dailyReports.filter(report => normalizeUsername(report.operator) === normalizeUsername(request.auth.user.username))
        : dailyReports;
    try {
        const visibleIncidences = request.auth.user.role === "operador"
            ? incidences.filter(incidence =>
                normalizeUsername(incidence.operator) === normalizeUsername(request.auth.user.username))
            : incidences;
        const excelFile = createDailyReportsWorkbook(visibleReports, visibleIncidences);

        response
            .status(200)
            .set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            .set("Content-Disposition", 'attachment; filename="Reporte_General_Llamadas.xlsx"')
            .send(excelFile);
    } catch (error) {
        next(error);
    }
});

// # AQUI SE CONFIGURA LA CARGA LOCAL SEGURA DE PLANTILLAS CSV Y EXCEL
const storage = multer.diskStorage({
    destination: (request, file, callback) => callback(null, uploadDirectory),
    filename: (request, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        callback(null, `${randomUUID()}${extension}`);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE, files: 1 },
    fileFilter: (request, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        const validMimeTypes = new Set([
            "", "application/octet-stream", "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "text/csv", "text/plain"
        ]);
        if (!allowedExtensions.has(extension) || !validMimeTypes.has(file.mimetype.toLowerCase())) {
            const error = new Error("Formato de archivo no permitido. Usa CSV, XLS o XLSX.");
            error.status = 400;
            callback(error);
            return;
        }
        callback(null, true);
    }
});

app.get("/api/reports", requireAuth, (request, response) => {
    const visibleReports = request.auth.user.role === "operador"
        ? reports.filter(report => normalizeUsername(report.operator) === normalizeUsername(request.auth.user.username))
        : reports;
    response.json({ success: true, reports: visibleReports });
});

app.get("/api/reports/:id/file", requireAuth, (request, response) => {
    const report = reports.find(item => item.id === request.params.id);
    if (!report) {
        response.status(404).json({ success: false, message: "No se encontró el archivo solicitado." });
        return;
    }
    if (request.auth.user.role === "operador" &&
        normalizeUsername(report.operator) !== normalizeUsername(request.auth.user.username)) {
        response.status(403).json({ success: false, message: "No tienes permiso para descargar este archivo." });
        return;
    }
    if (typeof report.fileName !== "string" ||
        path.basename(report.fileName) !== report.fileName ||
        !/^[a-f\d-]{36}\.(csv|xls|xlsx)$/i.test(report.fileName)) {
        response.status(404).json({ success: false, message: "Este reporte es anterior a la descarga de archivos y no tiene un archivo asociado." });
        return;
    }
    const filePath = path.join(uploadDirectory, report.fileName);
    if (!fs.existsSync(filePath)) {
        response.status(404).json({ success: false, message: "El archivo ya no está disponible en el servidor." });
        return;
    }
    response.download(filePath, report.originalName);
});

app.delete("/api/reports/:id", requireAuth, requireRole("admin"), (request, response, next) => {
    const report = reports.find(item => item.id === request.params.id);
    if (!report) {
        response.status(404).json({ success: false, message: "No se encontró el reporte solicitado." });
        return;
    }

    let fileContents = null;
    let filePath = "";
    if (typeof report.fileName === "string" &&
        path.basename(report.fileName) === report.fileName &&
        /^[a-f\d-]{36}\.(csv|xls|xlsx)$/i.test(report.fileName)) {
        filePath = path.join(uploadDirectory, report.fileName);
        try {
            fileContents = fs.readFileSync(filePath);
        } catch (error) {
            if (error.code !== "ENOENT") {
                next(error);
                return;
            }
        }
    }

    try {
        if (fileContents) fs.unlinkSync(filePath);
        const updatedReports = reports.filter(item => item.id !== report.id);
        saveJsonFile(reportsFilePath, updatedReports);
        reports = updatedReports;
    } catch (error) {
        if (fileContents && filePath) {
            try {
                fs.writeFileSync(filePath, fileContents, { mode: 0o600 });
            } catch (restoreError) {
                console.error("No se pudo restaurar el archivo cargado tras un error de eliminación:", restoreError.message);
            }
        }
        next(error);
        return;
    }

    io.to("management").emit("report:deleted", { id: report.id });
    response.json({ success: true, message: "El reporte cargado y su archivo fueron eliminados." });
});

app.post("/api/reports", requireAuth, requireRole("operador"), upload.single("reporte"), (request, response) => {
    if (!request.file) {
        response.status(400).json({ success: false, message: "Selecciona un archivo para subir." });
        return;
    }
    const campaign = (typeof request.body?.campaign === "string"
        ? request.body.campaign.trim().slice(0, 120)
        : "") || "Plantillas Excel";
    const reportDate = typeof request.body?.reportDate === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(request.body.reportDate) ? request.body.reportDate : "";
    const originalName = path.basename(request.file.originalname).slice(0, 180);
    const report = {
        id: randomUUID(),
        operator: request.auth.user.username,
        campaign,
        reportDate,
        originalName,
        fileName: request.file.filename,
        size: request.file.size,
        uploadedAt: new Date().toISOString(),
        status: "En revisión"
    };
    const previousReports = reports;
    reports = [report, ...reports].slice(0, 1000);
    try {
        saveReports();
    } catch (error) {
        reports = previousReports;
        fs.unlink(request.file.path, unlinkError => {
            if (unlinkError) console.error("No se pudo limpiar una carga fallida:", unlinkError.message);
        });
        throw error;
    }
    io.to("management").emit("report:new", report);
    try {
        notifyUsers(
            users.filter(user => ["admin", "supervisor"].includes(user.role)),
            "Reporte nuevo",
            `${report.operator} cargó ${report.originalName}.`
        );
    } catch (error) {
        console.error("No se pudo guardar la notificación de carga:", error.message);
    }
    response.status(201).json({ success: true, report });
});

// # AQUI SE AUTORIZAN LAS CONEXIONES SOCKET.IO USANDO LA SESION HTTP
io.use((socket, next) => {
    const token = readCookie(socket.request, cookieName);
    const auth = currentSession(token);
    if (!auth) {
        next(new Error("AUTH_REQUIRED"));
        return;
    }
    socket.data.sessionToken = token;
    socket.data.user = {
        username: auth.user.username,
        role: auth.user.role,
        status: "Activo",
        connectedAt: new Date().toISOString()
    };
    next();
});

io.on("connection", socket => {
    const user = socket.data.user;
    activeSockets.set(socket.id, user);
    socket.join("general");
    socket.join(userRoom(user.username));
    if (user.role === "admin" || user.role === "supervisor") socket.join("management");
    if (["admin", "supervisor"].includes(user.role)) {
        socket.emit("users:update", getOnlineUsers());
        socket.emit("reports:snapshot", reports);
    }
    publishOnlineUsers();

    socket.on("operator:status", (data, acknowledge) => {
        const reply = typeof acknowledge === "function" ? acknowledge : () => {};
        if (user.role !== "operador") {
            reply({ success: false, message: "Solo un operador puede cambiar su estado." });
            return;
        }
        if (!data || !allowedStatuses.has(data.status)) {
            reply({ success: false, message: "El estado indicado no es válido." });
            return;
        }
        for (const activeUser of activeSockets.values()) {
            if (normalizeUsername(activeUser.username) === normalizeUsername(user.username)) {
                activeUser.status = data.status;
            }
        }
        io.to("management").emit("operator:status", { username: user.username, status: data.status });
        try {
            notifyUsers(
                users.filter(item => ["admin", "supervisor"].includes(item.role)),
                "Estado de operador",
                `${user.username} actualizó su estado: ${data.status}.`
            );
        } catch (error) {
            console.error("No se pudo guardar la notificación de estado:", error.message);
        }
        publishOnlineUsers();
        reply({ success: true });
    });

    socket.on("chat:history:get", (data, acknowledge) => {
        const reply = typeof acknowledge === "function" ? acknowledge : () => {};
        if (data?.type === "general") {
            reply({
                success: true,
                type: "general",
                messages: messages.filter(message => message.type === "general")
            });
            return;
        }
        if (data?.type !== "private" || typeof data.target !== "string") {
            reply({ success: false, message: "La conversación indicada no es válida." });
            return;
        }
        const targetUser = users.find(item =>
            normalizeUsername(item.username) === normalizeUsername(data.target.trim())
        );
        if (!targetUser || normalizeUsername(targetUser.username) === normalizeUsername(user.username) ||
            !canChatPrivately(user.role, targetUser.role)) {
            reply({ success: false, message: "No tienes permiso para consultar esta conversación." });
            return;
        }
        const currentUsername = normalizeUsername(user.username);
        const targetUsername = normalizeUsername(targetUser.username);
        const conversation = messages
            .filter(message => message.type === "private" &&
                ((normalizeUsername(message.sender) === currentUsername &&
                    normalizeUsername(message.target) === targetUsername) ||
                (normalizeUsername(message.sender) === targetUsername &&
                    normalizeUsername(message.target) === currentUsername)))
            .map(message => ({ ...message, target: targetUser.username }));
        reply({ success: true, type: "private", messages: conversation });
    });

    socket.on("chat:send", (data, acknowledge) => {
        const reply = typeof acknowledge === "function" ? acknowledge : () => {};
        if (!data || typeof data.text !== "string") {
            reply({ success: false, message: "El mensaje no es válido." });
            return;
        }
        const text = data.text.trim();
        if (!text || text.length > 500) {
            reply({ success: false, message: "El mensaje debe tener entre 1 y 500 caracteres." });
            return;
        }
        if (data.type === "general") {
            if (data.announcement === true && !["admin", "supervisor"].includes(user.role)) {
                reply({ success: false, message: "No tienes permiso para publicar comunicados." });
                return;
            }
            const message = {
                id: randomUUID(),
                type: "general",
                sender: user.username,
                text,
                sentAt: new Date().toISOString()
            };
            if (!persistChatMessage(message, reply)) return;
            try {
                notifyUsers(
                    users.filter(item => normalizeUsername(item.username) !== normalizeUsername(user.username)),
                    data.announcement === true ? "Comunicado" : "Chat general",
                    `${user.username}: ${text}`
                );
            } catch (error) {
                console.error("No se pudo guardar la notificación del mensaje:", error.message);
            }
            io.to("general").emit("chat:message", message);
            if (data.announcement === true) {
                io.to("management").emit("announcement:new", {
                    sender: user.username,
                    text,
                    sentAt: message.sentAt
                });
            }
            reply({ success: true });
            return;
        }

        if (data.type !== "private" || typeof data.target !== "string") {
            reply({ success: false, message: "El canal de conversación no es válido." });
            return;
        }
        const targetName = data.target.trim().normalize("NFKC");
        const targetUser = users.find(item => normalizeUsername(item.username) === normalizeUsername(targetName));
        if (!targetUser || normalizeUsername(targetName) === normalizeUsername(user.username)) {
            reply({ success: false, message: "El destinatario indicado no es válido." });
            return;
        }
        if (!canChatPrivately(user.role, targetUser.role)) {
            reply({ success: false, message: "No tienes permiso para iniciar este chat privado." });
            return;
        }
        const sentAt = new Date().toISOString();
        const message = {
            id: randomUUID(),
            type: "private",
            sender: user.username,
            target: targetUser.username,
            text,
            sentAt
        };
        if (!persistChatMessage(message, reply)) return;
        try {
            notifyUsers(
                [targetUser],
                "Mensaje privado",
                `${user.username}: ${text}`,
                { type: "private-chat", target: user.username }
            );
        } catch (error) {
            console.error("No se pudo guardar la notificación del mensaje privado:", error.message);
        }
        io.to(userRoom(user.username)).emit("chat:message", {
            ...message,
            target: targetUser.username
        });
        io.to(userRoom(targetName)).emit("chat:message", {
            ...message,
            target: user.username
        });
        reply({ success: true });
    });

    socket.on("report:review", (data, acknowledge) => {
        const reply = typeof acknowledge === "function" ? acknowledge : () => {};
        if (!["admin", "supervisor"].includes(user.role)) {
            reply({ success: false, message: "No tienes permiso para revisar reportes." });
            return;
        }
        if (!data || typeof data.id !== "string" || !["Aprobado", "Rechazado"].includes(data.status)) {
            reply({ success: false, message: "Los datos de revisión no son válidos." });
            return;
        }
        const report = reports.find(item => item.id === data.id);
        if (!report) {
            reply({ success: false, message: "No se encontró el reporte solicitado." });
            return;
        }
        const previousStatus = report.status;
        const previousReviewedAt = report.reviewedAt;
        const previousReviewer = report.reviewer;
        report.status = data.status;
        report.reviewedAt = new Date().toISOString();
        report.reviewer = user.username;
        try {
            saveReports();
        } catch (error) {
            report.status = previousStatus;
            if (previousReviewedAt === undefined) delete report.reviewedAt;
            else report.reviewedAt = previousReviewedAt;
            if (previousReviewer === undefined) delete report.reviewer;
            else report.reviewer = previousReviewer;
            console.error("No se pudo guardar la revisión del reporte:", error.message);
            reply({ success: false, message: "No se pudo guardar la revisión." });
            return;
        }
        io.to("management").emit("report:reviewed", report);
        io.to(userRoom(report.operator)).emit("report:reviewed", report);
        const operator = users.find(item =>
            normalizeUsername(item.username) === normalizeUsername(report.operator)
        );
        if (operator) {
            try {
                notifyUsers(
                    [operator],
                    "Reporte revisado",
                    `Tu reporte fue ${report.status.toLowerCase()}.`
                );
            } catch (error) {
                console.error("No se pudo guardar la notificación de revisión:", error.message);
            }
        }
        reply({ success: true, report });
    });

    socket.on("disconnect", () => {
        activeSockets.delete(socket.id);
        publishOnlineUsers();
    });
});

// # AQUI SE DEVUELVEN ERRORES HTTP SIN EXPONER INFORMACION INTERNA
app.use((error, request, response, next) => {
    if (response.headersSent) {
        next(error);
        return;
    }
    const status = Number.isInteger(error.status)
        ? error.status
        : error instanceof multer.MulterError ? 400 : 500;
    if (status === 500) console.error("Error de petición:", error.message);
    response.status(status).json({
        success: false,
        message: status === 500 ? "Ocurrió un error al procesar la petición." : error.message
    });
});

server.listen(PORT, HOST, () => {
    console.log(`Evidencia está disponible en http://localhost:${PORT}`);
    if (HOST === "0.0.0.0") {
        console.log("El servidor acepta conexiones de la red local; usa la IPv4 de esta PC desde otros dispositivos.");
    }
    console.log("Cuentas de prueba iniciales: Humberto Nevado / 123, Alejandro Supervisor / 123 y Directiva Admin / 123");
});
