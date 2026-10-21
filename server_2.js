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

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const scryptAsync = promisify(scrypt);
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const uploadDirectory = path.join(__dirname, "uploads");
const usersFilePath = path.join(__dirname, "users.json");
const reportsFilePath = path.join(__dirname, "reports.json");
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
    const temporaryPath = `${usersFilePath}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(users, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, usersFilePath);
}

function loadUsers() {
    if (fs.existsSync(usersFilePath)) {
        const storedUsers = JSON.parse(fs.readFileSync(usersFilePath, "utf8"));
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
    if (!fs.existsSync(reportsFilePath)) return [];
    const savedReports = JSON.parse(fs.readFileSync(reportsFilePath, "utf8"));
    if (!Array.isArray(savedReports)) {
        throw new Error("reports.json tiene un formato inválido. Corrige el archivo antes de iniciar.");
    }
    return savedReports;
}

let reports = loadReports();

function saveReports() {
    const temporaryPath = `${reportsFilePath}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(reports, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, reportsFilePath);
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
        "SameSite=Strict",
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
app.use(express.json({ limit: "32kb" }));
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
        const mimeType = typeof file.mimetype === "string" ? file.mimetype.toLowerCase() : "";
        const validMimeTypes = new Set([
            "", "application/octet-stream", "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "text/csv", "text/plain"
        ]);
        if (!allowedExtensions.has(extension) || !validMimeTypes.has(mimeType)) {
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
        const updatedUser = activeSockets.get(socket.id) || user;
        updatedUser.status = data.status;
        user.status = data.status;
        socket.data.user = updatedUser;
        io.to("management").emit("operator:status", { username: user.username, status: updatedUser.status });
        publishOnlineUsers();
        reply({ success: true, status: updatedUser.status });
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
            const message = { type: "general", sender: user.username, text, sentAt: new Date().toISOString() };
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
        const senderIsManagement = ["admin", "supervisor"].includes(user.role);
        const targetIsManagement = ["admin", "supervisor"].includes(targetUser.role);
        if ((!senderIsManagement && !targetIsManagement) ||
            (senderIsManagement && !targetIsManagement && targetUser.role !== "operador")) {
            reply({ success: false, message: "No tienes permiso para iniciar este chat privado." });
            return;
        }
        const online = [...activeSockets.values()].some(
            item => normalizeUsername(item.username) === normalizeUsername(targetName)
        );
        if (!online) {
            reply({ success: false, message: "El destinatario no está conectado." });
            return;
        }
        const sentAt = new Date().toISOString();
        io.to(userRoom(user.username)).emit("chat:message", {
            type: "private", sender: user.username, target: targetName, text, sentAt
        });
        io.to(userRoom(targetName)).emit("chat:message", {
            type: "private", sender: user.username, target: user.username, text, sentAt
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
    console.log(`Evidencia está disponible en http://${HOST}:${PORT}`);
    console.log("Cuentas de prueba iniciales: Humberto Nevado / 123, Alejandro Supervisor / 123 y Directiva Admin / 123");
});
